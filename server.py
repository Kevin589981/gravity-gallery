import os
import random
import mimetypes
import sqlite3
import time
import json
from typing import List, Optional
from contextlib import contextmanager, asynccontextmanager
from functools import lru_cache

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
SSL_CERT_FILE = os.environ.get("GALLERY_SSL_CERT", os.path.join(CERT_DIR, "<hostname>.local+2.pem"))
SSL_KEY_FILE = os.environ.get("GALLERY_SSL_KEY", os.path.join(CERT_DIR, "<hostname>.local+2-key.pem"))
DB_PATH = os.path.join(ROOT_DIR, "gallery_metadata.db")
ALLOWED_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'}
PLAYLIST_MAX_AGE_DAYS = 365  # Playlist 在数据库中保留的最大天数

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

# --- 全局缓存与会话 ---
class UserSession:
    """用户会话，存储播放列表用于后续的图片请求判断"""
    def __init__(self, playlist: List[str]):
        self.playlist = playlist
        self.request_count = 0

user_sessions = LRUCache(maxsize=600)

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

    preload_window = 300
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
    for root, _, files in os.walk(ROOT_DIR):
        for filename in files:
            ext = os.path.splitext(filename)[1].lower()
            if ext in ALLOWED_EXTENSIONS:
                abs_path = os.path.join(root, filename)
                rel_path = os.path.relpath(abs_path, ROOT_DIR).replace('\\', '/')
                mtime = os.path.getmtime(abs_path)
                fs_files[rel_path] = mtime

    with get_db() as conn:
        cursor = conn.execute("SELECT path, mtime FROM images")
        db_files = {row['path']: row['mtime'] for row in cursor}
        
        to_upsert = []
        for path, mtime in fs_files.items():
            if path not in db_files or db_files[path] != mtime:
                try:
                    full_path = os.path.join(ROOT_DIR, path)
                    with Image.open(full_path) as img:
                        width, height = img.size
                        is_landscape = width >= height
                        to_upsert.append((path, mtime, width, height, is_landscape))
                except Exception as e:
                    print(f"❌ 无法读取图片 {path}: {e}")

        to_delete = [path for path in db_files if path not in fs_files]

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

@app.post("/api/playlist")
async def get_playlist(req: PlaylistRequest, request: Request, background_tasks: BackgroundTasks):
    
    # --- 步骤 1: 从数据库获取数据 ---
    query = "SELECT path, mtime FROM images WHERE ("
    params = []
    if not req.paths:
        return []
    path_conditions = []
    for p in req.paths:
        if p == "" or p == ".":
            path_conditions.append("1=1")
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
        results = [dict(row) for row in cursor]
    
    # --- 步骤 2: 根据请求进行排序 ---
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
    if req.current_path and req.current_path in final_paths:
        try:
            print(f"🔄 检测到 current_path='{os.path.basename(req.current_path)}', 正在旋转列表...")
            start_index = final_paths.index(req.current_path)
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
    target_path = os.path.join(ROOT_DIR, path)
    if not os.path.commonpath([ROOT_DIR, target_path]).startswith(ROOT_DIR):
        target_path = ROOT_DIR
        path = ""
    if not os.path.exists(target_path):
        raise HTTPException(status_code=404, detail="Folder not found")
    items = []
    with os.scandir(target_path) as it:
        for entry in it:
            if entry.name.startswith('.'):
                continue
            is_dir = entry.is_dir()
            if not is_dir and os.path.splitext(entry.name)[1].lower() not in ALLOWED_EXTENSIONS:
                continue
            items.append({
                "name": entry.name,
                "path": os.path.relpath(entry.path, ROOT_DIR).replace('\\', '/'),
                "type": "folder" if is_dir else "file"
            })
    items.sort(key=lambda x: (x['type'] != 'folder', natsort_key(x['name'])))
    return {"currentPath": path.replace('\\', '/'), "items": items}

@app.get("/{file_path:path}")
async def serve_file(file_path: str, request: Request, background_tasks: BackgroundTasks):
    full_path = os.path.join(ROOT_DIR, file_path)
    if not os.path.exists(full_path) or not os.path.isfile(full_path):
        return JSONResponse(status_code=404, content={"message": "File not found"})

    client_ip = request.client.host
    session: UserSession = user_sessions.get(client_ip)

    # 【核心修复】如果内存中没有 session，尝试从数据库恢复
    if session is None:
        playlist = load_playlist_from_db(client_ip)
        if playlist:
            print(f"🔄 [Session Recovery] 从数据库恢复 IP {client_ip} 的播放列表 ({len(playlist)} 张图片)")
            session = UserSession(playlist=playlist)
            user_sessions[client_ip] = session
            
            # 恢复后立即触发一次预加载（以当前请求的图片为中心）
            if file_path in playlist:
                try:
                    current_index = playlist.index(file_path)
                    print(f"🚀 [Session Recovery] 触发预加载，当前索引: {current_index}")
                    background_tasks.add_task(preload_surrounding_images, playlist, current_index)
                except ValueError:
                    pass

    # 如果找到了该用户的播放列表会话，则周期性触发预加载
    if session:
        session.request_count += 1
        # 每 280 次请求触发一次预加载（避免频繁预加载）
        if session.request_count % 280 == 1:
            session.request_count = 1
            try:
                current_index = session.playlist.index(file_path)
                background_tasks.add_task(preload_surrounding_images, session.playlist, current_index)
            except ValueError:
                # 如果请求的图片不在用户的播放列表里，不进行预加载
                pass

    try:
        content = get_image_content(full_path)
        media_type, _ = mimetypes.guess_type(full_path)
        return Response(content=content, media_type=media_type or "application/octet-stream")
    except Exception as e:
        print(f"❌ 处理文件请求时出错 {file_path}: {e}")
        raise HTTPException(status_code=500, detail="Error processing file request")


# --- 启动方式 ---
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
    print("\n🚀 数据库增强版服务器已准备就绪 (支持 Playlist 持久化)")
    print(f"   请在终端中使用以下命令启动:")
    print(f"\n   uvicorn main:app --host 0.0.0.0 --port {port} --workers 1 --reload\n")
    print(f"   本地访问: http://127.0.0.1:{port}")
    print(f"   局域网访问: http://{ip}:{port}")