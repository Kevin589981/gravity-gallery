import os
import random
import mimetypes
import sqlite3
import time
import json
from pathlib import Path
from typing import List, Optional
from contextlib import contextmanager, asynccontextmanager
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor, as_completed

from fastapi import FastAPI, HTTPException, BackgroundTasks, Response, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from PIL import Image
from natsort import natsort_key
from cachetools import LRUCache

# --- 配置 ---
ROOT_DIR = os.environ.get("GALLERY_ROOT_DIR", os.path.dirname(os.path.abspath(__file__)))
CERT_DIR = os.environ.get("GALLERY_CERT_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "certificates"))
SSL_CERT_FILE = os.environ.get("GALLERY_SSL_CERT")
SSL_KEY_FILE = os.environ.get("GALLERY_SSL_KEY")
DB_PATH = os.path.join(ROOT_DIR, "gallery_metadata.db")
ALLOWED_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'}
PLAYLIST_MAX_AGE_DAYS = 365  # Playlist 在数据库中保留的最大天数

def env_to_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")

def env_to_int(name: str, default: int, minimum: int, maximum: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))

DEFAULT_SCAN_WORKERS = min(16, max(1, (os.cpu_count() or 4) * 2))
SCAN_WORKERS = env_to_int("GALLERY_SCAN_WORKERS", DEFAULT_SCAN_WORKERS, 1, 32)

def allow_parent_dir_access() -> bool:
    """热读取父目录访问开关。"""
    return env_to_bool("GALLERY_ALLOW_PARENT_DIR_ACCESS", True)

# --- Pydantic 模型 ---
class PlaylistRequest(BaseModel):
    paths: List[str]
    sort: str = "shuffle"
    orientation: str = "Both"
    direction: str = "forward"
    current_path: Optional[str] = None

class RestorePlaylistRequest(BaseModel):
    """用于前端主动恢复 playlist 的请求模型"""
    playlist: List[str]
    current_index: int = 0

class RuntimeConfigRequest(BaseModel):
    allow_parent_dir_access: bool

# --- 全局缓存与会话 ---
class UserSession:
    """用户会话，存储播放列表用于后续的图片请求判断"""
    def __init__(self, playlist: List[str]):
        self.playlist = playlist
        self.request_count = 0

user_sessions = LRUCache(maxsize=600)
external_synced_paths_this_boot = set()

@lru_cache(maxsize=2000)
def get_image_content(path: str) -> bytes:
    """从磁盘读取图片文件内容并缓存。"""
    print(f"📦 [Image Cache MISS] 正在从磁盘加载: {os.path.basename(path)}")
    with open(path, "rb") as f:
        return f.read()

# --- 数据库操作 ---
@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    """初始化数据库，创建必要的表"""
    with get_db() as conn:
        # 图片元数据表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS images (
                path TEXT PRIMARY KEY, mtime REAL, width INTEGER,
                height INTEGER, is_landscape BOOLEAN
            )''')
        # 【新增】播放列表持久化表
        conn.execute('''
            CREATE TABLE IF NOT EXISTS playlists (
                client_ip TEXT PRIMARY KEY,
                playlist TEXT NOT NULL,
                created_at REAL NOT NULL
            )''')
        conn.commit()
        print("📊 数据库表初始化完成 (images, playlists)")

def save_playlist_to_db(client_ip: str, playlist: List[str]):
    """将播放列表保存到数据库"""
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO playlists (client_ip, playlist, created_at) VALUES (?, ?, ?)",
            (client_ip, json.dumps(playlist), time.time())
        )
        conn.commit()

def load_playlist_from_db(client_ip: str) -> Optional[List[str]]:
    """从数据库加载播放列表"""
    with get_db() as conn:
        cursor = conn.execute(
            "SELECT playlist FROM playlists WHERE client_ip = ?", 
            (client_ip,)
        )
        row = cursor.fetchone()
        if row:
            try:
                return json.loads(row['playlist'])
            except json.JSONDecodeError:
                return None
    return None

def iter_image_files_safe(directory: str):
    """
    使用 pathlib 做鲁棒遍历：
    - 遇到异常目录/条目时跳过，不中断全局扫描
    - 忽略隐藏目录（名称以 . 开头）
    """
    base_dir = Path(directory)
    if not base_dir.is_dir():
        return

    stack = [base_dir]
    while stack:
        current = stack.pop()
        try:
            entries = list(current.iterdir())
        except Exception as e:
            print(f"⚠️ 跳过无法访问目录: {current} ({e})")
            continue

        for entry in entries:
            try:
                entry_name = entry.name
            except Exception as e:
                print(f"⚠️ 跳过异常目录项: {current} ({e})")
                continue

            try:
                if entry.is_dir():
                    if not entry_name.startswith('.'):
                        stack.append(entry)
                    continue
            except Exception as e:
                print(f"⚠️ 跳过无法判断目录项: {entry} ({e})")
                continue

            try:
                if not entry.is_file():
                    continue
            except Exception as e:
                print(f"⚠️ 跳过无法判断文件项: {entry} ({e})")
                continue

            if entry.suffix.lower() in ALLOWED_EXTENSIONS:
                yield entry

def process_image_metadata(file_path: Path, root_dir: str) -> Optional[dict]:
    """线程池任务：读取单张图片元数据。"""
    try:
        stat = file_path.stat()
        mtime = stat.st_mtime

        with Image.open(file_path) as img:
            width, height = img.size
            is_landscape = width >= height

        rel_path = os.path.relpath(str(file_path), root_dir).replace('\\', '/')
        return {
            'path': rel_path,
            'mtime': mtime,
            'width': width,
            'height': height,
            'is_landscape': is_landscape
        }
    except Exception as e:
        print(f"⚠️ 无法读取图片 {file_path}: {e}")
        return None

def scan_directory_for_images_lazy(directory: str) -> List[tuple[str, str]]:
    """
    轻量级扫描：仅列出文件名，返回相应的图片文件路径。
    用于浏览时快速响应，不加载元数据。
    返回: [(文件名, 相对路径), ...]
    """
    full_dir = os.path.abspath(directory)
    if not os.path.isdir(full_dir):
        return []
    
    results = []
    try:
        for file_path in iter_image_files_safe(full_dir):
            rel_path = os.path.relpath(str(file_path), ROOT_DIR).replace('\\', '/')
            results.append((file_path.name, rel_path))
    except Exception as e:
        print(f"❌ 轻量级扫描 {full_dir} 失败: {e}")
    
    return results

def scan_directory_for_images_heavy(directory: str) -> List[dict]:
    """
    完整扫描：列出文件并加载元数据（宽度、高度、方向等）。
    用于用户确认播放时，将结果存入数据库。
    返回: [{'path': 相对路径, 'mtime': 修改时间, 'width': 宽, 'height': 高, 'is_landscape': 布尔}, ...]
    """
    full_dir = os.path.abspath(directory)
    if not os.path.isdir(full_dir):
        return []

    try:
        all_files = list(iter_image_files_safe(full_dir))
    except Exception as e:
        print(f"❌ 完整扫描 {full_dir} 失败: {e}")
        return []

    if not all_files:
        return []

    results = []
    max_workers = min(SCAN_WORKERS, len(all_files))
    print(f"🧵 并发扫描目录: {full_dir} | 文件数 {len(all_files)} | 线程数 {max_workers}")

    if max_workers <= 1:
        for file_path in all_files:
            metadata = process_image_metadata(file_path, ROOT_DIR)
            if metadata:
                results.append(metadata)
        return results

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(process_image_metadata, file_path, ROOT_DIR) for file_path in all_files]
        for future in as_completed(futures):
            try:
                metadata = future.result()
                if metadata:
                    results.append(metadata)
            except Exception as e:
                print(f"⚠️ 并发任务异常（已忽略）: {e}")
    
    return results

def save_images_to_db(images: List[dict]):
    """将扫描到的图片元数据保存到数据库"""
    if not images:
        return
    
    with get_db() as conn:
        conn.executemany(
            "INSERT OR REPLACE INTO images (path, mtime, width, height, is_landscape) VALUES (?, ?, ?, ?, ?)",
            [(img['path'], img['mtime'], img['width'], img['height'], img['is_landscape']) for img in images]
        )
        conn.commit()
    print(f"💾 已保存 {len(images)} 张图片到数据库")

def is_path_in_root_dir(path: str) -> bool:
    """检查路径是否在 ROOT_DIR 范围内"""
    try:
        if not path or path == "." or path == "":
            return True
        full_path = os.path.abspath(os.path.join(ROOT_DIR, path))
        common = os.path.commonpath([ROOT_DIR, full_path])
        return common == ROOT_DIR
    except (ValueError, TypeError):
        return False

def is_db_path_under_root(db_path: str) -> bool:
    """判断数据库中的相对路径是否位于 ROOT_DIR 内。"""
    try:
        full_path = os.path.abspath(os.path.join(ROOT_DIR, db_path))
        return os.path.commonpath([ROOT_DIR, full_path]) == ROOT_DIR
    except (ValueError, TypeError):
        return False

def normalize_rel_path(path: str) -> str:
    return (path or "").replace('\\', '/').strip('/').replace('/./', '/')

def sanitize_playlist_paths(paths: List[str]) -> List[str]:
    """
    对 playlist 请求路径做标准化。
    当不允许访问父目录时，所有越界路径都回退为 '.'，从而返回 ROOT_DIR 结果。
    """
    normalized = []
    for path in paths:
        if not path or path == ".":
            normalized.append(".")
            continue
        rel = normalize_rel_path(path)
        if not allow_parent_dir_access() and not is_path_in_root_dir(rel):
            normalized.append(".")
        else:
            normalized.append(rel)
    return list(dict.fromkeys(normalized))

def escape_like_pattern(value: str) -> str:
    return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')

def sync_external_path_to_db(path: str):
    """
    对 ROOT_DIR 外路径做按需同步：
    - 扫描当前目录树并 upsert
    - 清理该路径前缀下已失效的数据库记录
    """
    normalized = normalize_rel_path(path)
    if not normalized:
        return

    full_path = os.path.abspath(os.path.join(ROOT_DIR, normalized))
    scanned = scan_directory_for_images_heavy(full_path)
    scanned_paths = {item['path'] for item in scanned}

    like_prefix = f"{escape_like_pattern(normalized)}/%"

    with get_db() as conn:
        if scanned:
            conn.executemany(
                "INSERT OR REPLACE INTO images (path, mtime, width, height, is_landscape) VALUES (?, ?, ?, ?, ?)",
                [(img['path'], img['mtime'], img['width'], img['height'], img['is_landscape']) for img in scanned]
            )

        cursor = conn.execute(
            "SELECT path FROM images WHERE path LIKE ? ESCAPE '\\'",
            (like_prefix,)
        )
        existing_paths = [row['path'] for row in cursor]
        to_delete = [p for p in existing_paths if p not in scanned_paths]

        if to_delete:
            conn.executemany("DELETE FROM images WHERE path = ?", [(p,) for p in to_delete])

        conn.commit()

    print(f"🔄 外部路径同步完成: {normalized} | 扫描 {len(scanned)} | 清理失效 {len(to_delete)}")

def clean_old_playlists():
    """清理过期的播放列表记录"""
    cutoff_time = time.time() - (PLAYLIST_MAX_AGE_DAYS * 24 * 3600)
    with get_db() as conn:
        cursor = conn.execute(
            "DELETE FROM playlists WHERE created_at < ?", 
            (cutoff_time,)
        )
        deleted_count = cursor.rowcount
        conn.commit()
        if deleted_count > 0:
            print(f"🧹 已清理 {deleted_count} 条过期的播放列表记录")

def clear_all_playlists():
    """清空所有播放列表记录（当文件发生变动时调用）"""
    with get_db() as conn:
        conn.execute("DELETE FROM playlists")
        conn.commit()
    print("🗑️ 已清空数据库中的所有播放列表记录")

# --- 后台预加载任务 ---
def preload_surrounding_images(playlist: List[str], current_index: int):
    """后台任务，用于预加载当前图片周围的图片，并支持列表回绕。"""
    playlist_len = len(playlist)
    if playlist_len == 0:
        return

    preload_window = 100 # 300
    print(f"🔥 后台回绕预加载任务启动: 当前索引 {current_index}, 窗口大小 ±{preload_window}")
    
    loaded_count = 0
    for i in range(current_index - preload_window, current_index + preload_window + 1):
        wrapped_index = i % playlist_len
        try:
            image_path_full = os.path.join(ROOT_DIR, playlist[wrapped_index])
            if os.path.exists(image_path_full):
                get_image_content(image_path_full)
                loaded_count += 1
        except Exception:
            pass  # 忽略单张图片加载失败
            
    print(f"✅ 后台回绕预加载任务完成, 已缓存 {loaded_count} 张图片")

# --- 扫描任务 ---
def scan_library_task():
    print("🔍 开始扫描图库...")
    start_time = time.time()
    changes = 0
    
    fs_files = {}
    for file_path in iter_image_files_safe(ROOT_DIR):
        try:
            rel_path = os.path.relpath(str(file_path), ROOT_DIR).replace('\\', '/')
            mtime = file_path.stat().st_mtime
            fs_files[rel_path] = (file_path, mtime)
        except Exception as e:
            print(f"⚠️ 跳过无法读取文件状态: {file_path} ({e})")

    with get_db() as conn:
        cursor = conn.execute("SELECT path, mtime FROM images")
        db_files = {row['path']: row['mtime'] for row in cursor}

        files_to_update = [
            file_path
            for path, (file_path, mtime) in fs_files.items()
            if path not in db_files or db_files[path] != mtime
        ]

        to_upsert = []
        if files_to_update:
            max_workers = min(SCAN_WORKERS, len(files_to_update))
            print(f"🚀 检测到 {len(files_to_update)} 个变动文件，开始并发解析（线程数 {max_workers}）...")

            if max_workers <= 1:
                for file_path in files_to_update:
                    metadata = process_image_metadata(file_path, ROOT_DIR)
                    if metadata:
                        to_upsert.append((
                            metadata['path'],
                            metadata['mtime'],
                            metadata['width'],
                            metadata['height'],
                            metadata['is_landscape']
                        ))
            else:
                with ThreadPoolExecutor(max_workers=max_workers) as executor:
                    futures = [executor.submit(process_image_metadata, file_path, ROOT_DIR) for file_path in files_to_update]
                    for future in as_completed(futures):
                        try:
                            metadata = future.result()
                            if metadata:
                                to_upsert.append((
                                    metadata['path'],
                                    metadata['mtime'],
                                    metadata['width'],
                                    metadata['height'],
                                    metadata['is_landscape']
                                ))
                        except Exception as e:
                            print(f"⚠️ 并发任务异常（已忽略）: {e}")

        # 仅清理 ROOT_DIR 内失效文件。ROOT_DIR 外的条目保持不动，等待用户再次访问该目录时按需刷新。
        to_delete = [
            path for path in db_files
            if is_db_path_under_root(path) and path not in fs_files
        ]

        if to_upsert:
            conn.executemany(
                "INSERT OR REPLACE INTO images (path, mtime, width, height, is_landscape) VALUES (?, ?, ?, ?, ?)", 
                to_upsert
            )
            changes += len(to_upsert)
            print(f"✨ 新增/更新了 {len(to_upsert)} 张图片")
        
        if to_delete:
            conn.executemany("DELETE FROM images WHERE path = ?", [(p,) for p in to_delete])
            changes += len(to_delete)
            print(f"🗑️ 移除了 {len(to_delete)} 张失效图片")

        conn.commit()

    if len(to_delete) > 0:
        print("🔄 文件发生删除，清空所有缓存...")
        user_sessions.clear()
        get_image_content.cache_clear()
        clear_all_playlists()  # 【新增】同时清空持久化的播放列表
    
    duration = time.time() - start_time
    print(f"✅ 扫描完成，耗时 {duration:.2f}秒。当前总图片数: {len(fs_files)}")


# --- FastAPI 应用生命周期 ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("🚀 应用启动，开始初始化...")
    external_synced_paths_this_boot.clear()
    init_db()
    # clean_old_playlists()  # 清理过期的播放列表
    scan_library_task()
    yield
    print("👋 应用已关闭。")

app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, 
    allow_origins=["*"], 
    allow_credentials=True, 
    allow_methods=["*"], 
    allow_headers=["*"]
)

# --- API 接口 ---
@app.post("/api/scan")
async def trigger_scan(background_tasks: BackgroundTasks):
    background_tasks.add_task(scan_library_task)
    return {"status": "scanning_started"}

@app.get("/api/runtime-config")
async def get_runtime_config():
    return {
        "allow_parent_dir_access": allow_parent_dir_access(),
        "env_value": os.environ.get("GALLERY_ALLOW_PARENT_DIR_ACCESS", "<unset>")
    }

@app.post("/api/runtime-config")
async def set_runtime_config(req: RuntimeConfigRequest):
    os.environ["GALLERY_ALLOW_PARENT_DIR_ACCESS"] = "1" if req.allow_parent_dir_access else "0"
    return {
        "status": "ok",
        "allow_parent_dir_access": allow_parent_dir_access(),
        "env_value": os.environ.get("GALLERY_ALLOW_PARENT_DIR_ACCESS", "<unset>")
    }

@app.post("/api/runtime-config/toggle")
async def toggle_runtime_config():
    new_value = not allow_parent_dir_access()
    os.environ["GALLERY_ALLOW_PARENT_DIR_ACCESS"] = "1" if new_value else "0"
    return {
        "status": "ok",
        "allow_parent_dir_access": allow_parent_dir_access(),
        "env_value": os.environ.get("GALLERY_ALLOW_PARENT_DIR_ACCESS", "<unset>")
    }

@app.post("/api/playlist")
async def get_playlist(req: PlaylistRequest, request: Request, background_tasks: BackgroundTasks):
    
    if not req.paths:
        return []

    req_paths = sanitize_playlist_paths(req.paths)

    # --- 步骤 1: 外部路径先做按需同步（确保第二次访问时能清理失效记录） ---
    external_paths = [normalize_rel_path(p) for p in req_paths if p not in ("", ".") and not is_path_in_root_dir(p)]
    external_paths = list(dict.fromkeys(external_paths))
    for ext_path in external_paths:
        if ext_path not in external_synced_paths_this_boot:
            sync_external_path_to_db(ext_path)
            external_synced_paths_this_boot.add(ext_path)

    # --- 步骤 2: 先查数据库，缺失路径才扫描并回填 ---
    def query_images_from_db(paths: List[str]) -> List[dict]:
        query = "SELECT path, mtime, is_landscape FROM images WHERE ("
        params = []
        path_conditions = []

        for p in paths:
            if p == "" or p == ".":
                path_conditions.append("path NOT LIKE '../%'")
            else:
                path_conditions.append("path LIKE ? || '/%'")
                params.append(p)

        query += " OR ".join(path_conditions) + ")"
        if req.orientation == 'Landscape':
            query += " AND is_landscape = 1"
        elif req.orientation == 'Portrait':
            query += " AND is_landscape = 0"

        with get_db() as conn:
            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor]

    def get_missing_paths_from_db(paths: List[str]) -> List[str]:
        """在 SQL 层判断哪些路径在 images 表中没有任何命中。"""
        missing = []
        with get_db() as conn:
            for p in paths:
                if p == "" or p == ".":
                    continue
                cursor = conn.execute(
                    "SELECT 1 FROM images WHERE path LIKE ? || '/%' LIMIT 1",
                    (p,)
                )
                if cursor.fetchone() is None:
                    missing.append(p)
        return missing

    results = query_images_from_db(req_paths)
    print(f"📚 数据库查询完成，获得 {len(results)} 张图片")

    # 仅对“数据库无任何命中”的路径执行扫描（SQL 层判断），避免 Python 层大列表遍历
    # 已同步过的外部路径不再重复扫描
    missing_paths = get_missing_paths_from_db(req_paths)
    if external_paths:
        external_set = {normalize_rel_path(p) for p in external_paths}
        missing_paths = [p for p in missing_paths if normalize_rel_path(p) not in external_set]

    if missing_paths:
        print(f"🔍 以下路径在数据库中无记录，开始一次性扫描并回填: {missing_paths}")
        scanned_results = []
        for p in missing_paths:
            full_path = os.path.abspath(os.path.join(ROOT_DIR, p))
            images = scan_directory_for_images_heavy(full_path)
            scanned_results.extend(images)
            print(f"📁 扫描目录 {full_path}: 找到 {len(images)} 张图片")

        if scanned_results:
            save_images_to_db(scanned_results)

        # 扫描回填后再查一次数据库，确保排序/过滤逻辑一致
        results = query_images_from_db(req_paths)
        print(f"📚 回填后数据库查询完成，获得 {len(results)} 张图片")

    # 去重：防止用户选择重叠目录时重复图片进入播放列表
    dedup_results = {}
    for item in results:
        dedup_results[item['path']] = item
    results = list(dedup_results.values())
    
    # --- 步骤 3: 根据请求进行排序 ---
    if req.sort == 'shuffle':
        random.shuffle(results)
        final_paths = [r['path'] for r in results]
    elif req.sort == 'name':
        results.sort(key=lambda x: natsort_key(x['path']))
        final_paths = [r['path'] for r in results]
    elif req.sort == 'date':
        results.sort(key=lambda x: x['mtime'], reverse=True)
        final_paths = [r['path'] for r in results]
    elif req.sort == 'subfolder_random':
        subfolder_map = {}
        for item in results:
            path = item['path']
            parent = os.path.dirname(path)
            if parent not in subfolder_map:
                subfolder_map[parent] = []
            subfolder_map[parent].append(item)
        
        subfolders = list(subfolder_map.keys())
        random.shuffle(subfolders)
        
        final_paths = []
        for folder in subfolders:
            items = subfolder_map[folder]
            items.sort(key=lambda x: natsort_key(x['path']))
            final_paths.extend([item['path'] for item in items])
    elif req.sort == 'subfolder_date':
        subfolder_map = {}
        subfolder_mtime = {}
        
        for item in results:
            path = item['path']
            parent = os.path.dirname(path)
            if parent not in subfolder_map:
                subfolder_map[parent] = []
                try:
                    folder_full_path = os.path.join(ROOT_DIR, parent) if parent else ROOT_DIR
                    folder_mtime = os.path.getmtime(folder_full_path)
                    subfolder_mtime[parent] = folder_mtime
                except:
                    subfolder_mtime[parent] = 0
            subfolder_map[parent].append(item)
        
        subfolders = sorted(subfolder_map.keys(), key=lambda x: subfolder_mtime[x])
        
        final_paths = []
        for folder in subfolders:
            items = subfolder_map[folder]
            items.sort(key=lambda x: natsort_key(x['path']))
            final_paths.extend([item['path'] for item in items])
    else:
        results.sort(key=lambda x: natsort_key(x['path']))
        final_paths = [r['path'] for r in results]
        
    if req.direction == 'reverse':
        final_paths.reverse()

    # --- 步骤 3: 如果前端提供了当前位置，就旋转列表 ---
    current_path = normalize_rel_path(req.current_path) if req.current_path else None
    if current_path and (allow_parent_dir_access() or is_path_in_root_dir(current_path)) and current_path in final_paths:
        try:
            print(f"🔄 检测到 current_path='{os.path.basename(current_path)}', 正在旋转列表...")
            start_index = final_paths.index(current_path)
            final_paths = final_paths[start_index:] + final_paths[:start_index]
        except ValueError:
            pass

    # --- 步骤 4: 更新用户会话并持久化到数据库 ---
    client_ip = request.client.host
    session = UserSession(playlist=final_paths)
    user_sessions[client_ip] = session
    
    # 【核心】持久化播放列表到数据库，确保服务器重启后可恢复
    save_playlist_to_db(client_ip, final_paths)
    
    if final_paths:
        print("🚀 为新列表立即触发一次预加载...")
        background_tasks.add_task(preload_surrounding_images, final_paths, 0)

    print(f"📝 已为IP {client_ip} 创建/更新播放列表，包含 {len(final_paths)} 张图片 (已持久化)")
    return final_paths

@app.post("/api/restore-playlist")
async def restore_playlist(req: RestorePlaylistRequest, request: Request, background_tasks: BackgroundTasks):
    """
    【新增API】让前端可以主动恢复已缓存的 playlist。
    用于服务器重启后，前端检测到服务器无会话时调用。
    """
    client_ip = request.client.host
    playlist = req.playlist
    
    if not playlist:
        raise HTTPException(status_code=400, detail="Playlist cannot be empty")
    
    # 验证 playlist 中的路径是否仍然有效
    valid_paths = []
    for path in playlist:
        full_path = os.path.join(ROOT_DIR, path)
        if os.path.exists(full_path) and os.path.isfile(full_path):
            valid_paths.append(path)
    
    if not valid_paths:
        raise HTTPException(status_code=400, detail="No valid paths in playlist")
    
    # 创建/更新 session
    session = UserSession(playlist=valid_paths)
    user_sessions[client_ip] = session
    
    # 持久化到数据库
    save_playlist_to_db(client_ip, valid_paths)
    
    # 触发预加载
    current_index = max(0, min(req.current_index, len(valid_paths) - 1))
    background_tasks.add_task(preload_surrounding_images, valid_paths, current_index)
    
    print(f"🔄 IP {client_ip} 已通过 restore-playlist 恢复播放列表，"
          f"有效: {len(valid_paths)}/{len(playlist)} 张图片")
    
    return {
        "status": "restored",
        "valid_count": len(valid_paths),
        "original_count": len(playlist),
        "playlist": valid_paths  # 返回验证后的有效列表
    }

@app.get("/api/session-status")
async def get_session_status(request: Request):
    """
    【新增API】让前端检查当前是否有有效的 session。
    前端可以在页面加载时调用此接口，决定是否需要恢复 playlist。
    """
    client_ip = request.client.host
    
    # 首先检查内存
    session = user_sessions.get(client_ip)
    if session:
        return {
            "has_session": True,
            "source": "memory",
            "playlist_size": len(session.playlist)
        }
    
    # 检查数据库
    playlist = load_playlist_from_db(client_ip)
    if playlist:
        return {
            "has_session": True,
            "source": "database",
            "playlist_size": len(playlist)
        }
    
    return {
        "has_session": False,
        "source": None,
        "playlist_size": 0
    }

@app.get("/api/browse")
async def browse_folder(path: str = ""):
    # 支持访问 ROOT_DIR 外的目录（向上浏览 ..），可由开关控制
    if not path or path == ".":
        target_path = ROOT_DIR
        rel_path = ""
    else:
        normalized = normalize_rel_path(path)
        target_path = os.path.abspath(os.path.join(ROOT_DIR, normalized))
        if not allow_parent_dir_access() and not is_path_in_root_dir(normalized):
            target_path = ROOT_DIR
            rel_path = ""
        else:
            rel_path = os.path.relpath(target_path, ROOT_DIR)
    
    if not os.path.exists(target_path) or not os.path.isdir(target_path):
        raise HTTPException(status_code=404, detail="Folder not found")
    
    items = []
    with os.scandir(target_path) as it:
        for entry in it:
            if entry.name.startswith('.'):
                continue
            is_dir = entry.is_dir()
            if not is_dir and os.path.splitext(entry.name)[1].lower() not in ALLOWED_EXTENSIONS:
                continue
            
            # 计算返回给前端的路径（用于后续请求）
            entry_full_path = os.path.abspath(entry.path)
            entry_rel_from_root = os.path.relpath(entry_full_path, ROOT_DIR)
            
            items.append({
                "name": entry.name,
                "path": entry_rel_from_root.replace('\\', '/'),
                "type": "folder" if is_dir else "file"
            })
    
    items.sort(key=lambda x: (x['type'] != 'folder', natsort_key(x['name'])))
    return {"currentPath": rel_path.replace('\\', '/'), "items": items}

def resolve_relative_file_path(path_value: str) -> str:
    """将传入路径标准化为相对于 ROOT_DIR 的可回溯相对路径（可包含 ../）。"""
    raw = (path_value or "").strip().replace('\\', '/')
    if raw.startswith('/'):
        raw = raw[1:]
    return raw

def resolve_full_file_path(path_value: str) -> tuple[str, str]:
    """返回 (relative_path, absolute_full_path)。"""
    rel_path = resolve_relative_file_path(path_value)
    full_path = os.path.abspath(os.path.join(ROOT_DIR, rel_path))
    return rel_path, full_path

async def serve_file_core(path_value: str, request: Request, background_tasks: BackgroundTasks):
    rel_path, full_path = resolve_full_file_path(path_value)
    if not allow_parent_dir_access() and not is_path_in_root_dir(rel_path):
        return JSONResponse(status_code=403, content={"message": "Access outside ROOT_DIR is disabled"})
    if not os.path.exists(full_path) or not os.path.isfile(full_path):
        return JSONResponse(status_code=404, content={"message": "File not found"})

    client_ip = request.client.host
    session: UserSession = user_sessions.get(client_ip)

    if session is None:
        playlist = load_playlist_from_db(client_ip)
        if playlist:
            print(f"🔄 [Session Recovery] 从数据库恢复 IP {client_ip} 的播放列表 ({len(playlist)} 张图片)")
            session = UserSession(playlist=playlist)
            user_sessions[client_ip] = session

            if rel_path in playlist:
                try:
                    current_index = playlist.index(rel_path)
                    print(f"🚀 [Session Recovery] 触发预加载，当前索引: {current_index}")
                    background_tasks.add_task(preload_surrounding_images, playlist, current_index)
                except ValueError:
                    pass

    if session:
        session.request_count += 1
        if session.request_count % 90 == 1:
            session.request_count = 1
            try:
                current_index = session.playlist.index(rel_path)
                background_tasks.add_task(preload_surrounding_images, session.playlist, current_index)
            except ValueError:
                pass

    try:
        content = get_image_content(full_path)
        media_type, _ = mimetypes.guess_type(full_path)
        return Response(content=content, media_type=media_type or "application/octet-stream")
    except Exception as e:
        print(f"❌ 处理文件请求时出错 {rel_path}: {e}")
        raise HTTPException(status_code=500, detail="Error processing file request")

@app.get("/api/file")
async def serve_file_by_query(path: str, request: Request, background_tasks: BackgroundTasks):
    return await serve_file_core(path, request, background_tasks)

@app.get("/{file_path:path}")
async def serve_file(file_path: str, request: Request, background_tasks: BackgroundTasks):
    return await serve_file_core(file_path, request, background_tasks)


# # --- 启动方式 ---
# if __name__ == "__main__":
#     import socket
#     def get_ip():
#         s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
#         try:
#             s.connect(('10.255.255.255', 1))
#             IP = s.getsockname()[0]
#         except Exception:
#             IP = '127.0.0.1'
#         finally:
#             s.close()
#         return IP
    
#     ip = get_ip()
#     port = 4860
#     print("\n🚀 数据库增强版服务器已准备就绪 (支持 Playlist 持久化)")
#     print(f"   请在终端中使用以下命令启动:")
#     print(f"\n   uvicorn main:app --host 0.0.0.0 --port {port} --workers 1 --reload\n")
#     print(f"   本地访问: http://127.0.0.1:{port}")
#     print(f"   局域网访问: http://{ip}:{port}")

import asyncio
from hypercorn.config import Config
from hypercorn.asyncio import serve

if __name__ == "__main__":
    import socket

    def get_ip():
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(('10.255.255.255', 1))
            IP = s.getsockname()[0]
        except Exception:
            IP = '127.0.0.1'
        finally:
            s.close()
        return IP

    ip = get_ip()
    port = 4860

    # Hypercorn 配置
    config = Config()
    config.bind = [f"0.0.0.0:{port}"]
    config.keyfile = SSL_KEY_FILE
    config.certfile = SSL_CERT_FILE
    
    # 强制启用 HTTP/2
    config.alpn_protocols = ["h2", "http/1.1"]

    print(f"\n🚀 Hypercorn HTTP/2 服务器启动中...")
    print(f"   局域网访问: https://{ip}:{port}")

    # 使用 asyncio 运行 Hypercorn
    asyncio.run(serve(app, config))