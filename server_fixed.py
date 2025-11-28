import os
import random
import mimetypes
import sqlite3
import time
import re
from typing import List, Optional, Literal
from contextlib import contextmanager
from fastapi import FastAPI, HTTPException, Body, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
import uvicorn
from PIL import Image

app = FastAPI()

# --- 配置 ---
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(ROOT_DIR, "gallery_metadata.db")
ALLOWED_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'} # SVG 无法简单获取尺寸，暂忽略

# --- 自然排序工具函数 ---
def natural_sort_key(text: str):
    """
    将字符串转换为自然排序的键
    例如: "img1.jpg" < "img2.jpg" < "img10.jpg"
    """
    def atoi(text):
        return int(text) if text.isdigit() else text.lower()
    
    return [atoi(c) for c in re.split(r'(\d+)', text)]

# --- 数据库模型 ---
# 表结构: path (相对路径, PK), mtime (修改时间), width, height, is_landscape (0/1)

@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    with get_db() as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS images (
                path TEXT PRIMARY KEY,
                mtime REAL,
                width INTEGER,
                height INTEGER,
                is_landscape BOOLEAN
            )
        ''')
        conn.commit()

# --- 核心逻辑: 智能扫描 ---
def scan_library_task():
    print("🔍 开始扫描图库...")
    start_time = time.time()
    changes = 0
    
    # 1. 获取现有文件的当前状态
    fs_files = {} # path -> mtime
    for root, _, files in os.walk(ROOT_DIR):
        for filename in files:
            ext = os.path.splitext(filename)[1].lower()
            if ext in ALLOWED_EXTENSIONS:
                abs_path = os.path.join(root, filename)
                rel_path = os.path.relpath(abs_path, ROOT_DIR).replace('\\', '/')
                mtime = os.path.getmtime(abs_path)
                fs_files[rel_path] = mtime

    with get_db() as conn:
        # 2. 获取数据库里的状态
        cursor = conn.execute("SELECT path, mtime FROM images")
        db_files = {row['path']: row['mtime'] for row in cursor}
        
        # 3. 找出需要新增/更新的文件
        to_upsert = []
        for path, mtime in fs_files.items():
            # 如果不在库里，或者修改时间变了，就需要重新读取
            if path not in db_files or db_files[path] != mtime:
                try:
                    full_path = os.path.join(ROOT_DIR, path)
                    with Image.open(full_path) as img:
                        width, height = img.size
                        is_landscape = width >= height
                        to_upsert.append((path, mtime, width, height, is_landscape))
                except Exception as e:
                    print(f"❌ 无法读取图片 {path}: {e}")

        # 4. 找出需要删除的文件 (库里有，但文件系统里没了)
        to_delete = [path for path in db_files if path not in fs_files]

        # 5. 执行数据库写操作
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
    
    duration = time.time() - start_time
    print(f"✅ 扫描完成，耗时 {duration:.2f}秒。当前总图片数: {len(fs_files)}")

# --- API ---

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class PlaylistRequest(BaseModel):
    paths: List[str]
    sort: str = "shuffle"  # shuffle, name, date, subfolder_random, subfolder_date
    orientation: str = "Both" # Both, Landscape, Portrait
    direction: str = "forward"  # forward, reverse

@app.on_event("startup")
def startup_event():
    init_db()
    # 启动时进行一次全量扫描
    scan_library_task()

@app.post("/api/scan")
async def trigger_scan(background_tasks: BackgroundTasks):
    background_tasks.add_task(scan_library_task)
    return {"status": "scanning_started"}

@app.post("/api/playlist")
async def get_playlist(req: PlaylistRequest):
    # 构建查询
    query = "SELECT path, mtime FROM images WHERE ("
    params = []
    
    # 路径筛选逻辑: 
    # 如果 paths 为空，理论上不选，但为了容错可以全选(或者前端传空时不调用)
    # 这里假设 path 是文件夹路径，我们要找该文件夹下的所有图片
    # WHERE (path LIKE 'folder1/%' OR path LIKE 'folder2/%')
    
    if not req.paths:
        return []
        
    path_conditions = []
    for p in req.paths:
        # 确保只匹配子路径
        if p == "" or p == ".": # 根目录
            path_conditions.append("1=1")
        else:
            path_conditions.append("path LIKE ? || '/%'") # SQLite 字符串拼接
            params.append(p)
            
    query += " OR ".join(path_conditions) + ")"
    
    # 方向筛选
    if req.orientation == 'Landscape':
        query += " AND is_landscape = 1"
    elif req.orientation == 'Portrait':
        query += " AND is_landscape = 0"
    
    # 执行查询
    with get_db() as conn:
        cursor = conn.execute(query, params)
        results = [dict(row) for row in cursor]
    
    # === 核心排序逻辑 ===
    if req.sort == 'shuffle':
        # 完全随机
        random.shuffle(results)
        final_paths = [r['path'] for r in results]
        
    elif req.sort == 'name':
        # 按完整路径自然排序
        results.sort(key=lambda x: natural_sort_key(x['path']))
        final_paths = [r['path'] for r in results]
        
    elif req.sort == 'date':
        # 按修改时间排序（最新的在前）
        results.sort(key=lambda x: x['mtime'], reverse=True)
        final_paths = [r['path'] for r in results]
        
    elif req.sort == 'subfolder_random':
        # 按子文件夹分组：子文件夹随机排序 + 文件夹内按文件名自然排序
        subfolder_map = {}
        for item in results:
            path = item['path']
            # 获取父文件夹路径
            parent = os.path.dirname(path)
            if parent not in subfolder_map:
                subfolder_map[parent] = []
            subfolder_map[parent].append(item)
        
        # 随机打乱子文件夹顺序
        subfolders = list(subfolder_map.keys())
        random.shuffle(subfolders)
        
        # 每个文件夹内按文件名自然排序
        final_paths = []
        for folder in subfolders:
            items = subfolder_map[folder]
            items.sort(key=lambda x: natural_sort_key(x['path']))
            final_paths.extend([item['path'] for item in items])
            
    elif req.sort == 'subfolder_date':
        # 按子文件夹分组：子文件夹按时间戳排序 + 文件夹内按文件名自然排序
        subfolder_map = {}
        subfolder_mtime = {}
        
        for item in results:
            path = item['path']
            parent = os.path.dirname(path)
            if parent not in subfolder_map:
                subfolder_map[parent] = []
                # 获取文件夹的修改时间
                try:
                    folder_full_path = os.path.join(ROOT_DIR, parent) if parent else ROOT_DIR
                    folder_mtime = os.path.getmtime(folder_full_path)
                    subfolder_mtime[parent] = folder_mtime
                except:
                    subfolder_mtime[parent] = 0
            subfolder_map[parent].append(item)
        
        # 按文件夹修改时间排序
        subfolders = sorted(subfolder_map.keys(), key=lambda x: subfolder_mtime[x])
        
        # 每个文件夹内按文件名自然排序
        final_paths = []
        for folder in subfolders:
            items = subfolder_map[folder]
            items.sort(key=lambda x: natural_sort_key(x['path']))
            final_paths.extend([item['path'] for item in items])
    else:
        # 默认按名称自然排序
        results.sort(key=lambda x: natural_sort_key(x['path']))
        final_paths = [r['path'] for r in results]
    
    # 应用方向设置
    if req.direction == 'reverse':
        final_paths.reverse()
        
    return final_paths

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
            if entry.name.startswith('.'): continue
            
            is_dir = entry.is_dir()
            # 简单过滤，如果是文件需要检查扩展名
            if not is_dir:
                ext = os.path.splitext(entry.name)[1].lower()
                if ext not in ALLOWED_EXTENSIONS:
                    continue

            items.append({
                "name": entry.name,
                "path": os.path.relpath(entry.path, ROOT_DIR).replace('\\', '/'),
                "type": "folder" if is_dir else "file"
            })
    
    # 使用自然排序
    items.sort(key=lambda x: (x['type'] != 'folder', natural_sort_key(x['name'])))
    return {"currentPath": path.replace('\\', '/'), "items": items}

@app.get("/{file_path:path}")
async def serve_file(file_path: str):
    full_path = os.path.join(ROOT_DIR, file_path)
    if not os.path.exists(full_path):
        return JSONResponse(status_code=404, content={"message": "File not found"})
    return FileResponse(full_path, headers={"Cache-Control": "public, max-age=3600"})

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
    print(f"\n🚀 数据库增强版服务器已启动: http://{ip}:4860")
    uvicorn.run(app, host="0.0.0.0", port=4860)
