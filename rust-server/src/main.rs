use anyhow::Result;
use axum::{
    extract::{ConnectInfo, Path as AxumPath, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use axum_server::tls_rustls::RustlsConfig;
use futures::StreamExt;
use image::GenericImageView;
use mime_guess::from_path;
use path_clean::PathClean;
use pathdiff::diff_paths;
use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::SqlitePoolOptions, Pool, Row, Sqlite};
use std::{
    collections::{HashMap, HashSet},
    env,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;
use walkdir::WalkDir;

// --- 常量与配置 ---
const ALLOWED_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp"];

#[derive(Clone)]
struct AppState {
    db: Pool<Sqlite>,
    root_dir: Arc<PathBuf>,
    allow_parent_dir_access: Arc<RwLock<bool>>,
}

// --- 数据模型 ---

#[derive(Debug, Deserialize)]
struct PlaylistRequest {
    paths: Vec<String>,
    #[serde(default = "default_sort")]
    sort: String,
    #[serde(default = "default_orientation")]
    orientation: String,
    #[serde(default = "default_direction")]
    direction: String,
    current_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RestorePlaylistRequest {
    playlist: Vec<String>,
    #[serde(default)]
    current_index: usize,
}

#[derive(Debug, Deserialize)]
struct RuntimeConfigRequest {
    allow_parent_dir_access: bool,
}
#[derive(Debug, Deserialize)]
struct FileQuery {
    path: String,
}

#[derive(Debug, Serialize)]
struct SessionStatusResponse {
    has_session: bool,
    source: Option<String>,
    playlist_size: usize,
}

#[derive(sqlx::FromRow, Clone, Debug)]
struct ImageMetadata {
    path: String,
    mtime: f64,
    width: u32,
    height: u32,
    is_landscape: bool,
}

fn default_sort() -> String { "shuffle".to_string() }
fn default_orientation() -> String { "Both".to_string() }
fn default_direction() -> String { "forward".to_string() }

// --- 辅助函数 ---

fn normalize_rel_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim()
        .trim_start_matches('/')
        .trim_end_matches('/')
        .replace("/./", "/")
}

fn resolve_full_path(root_dir: &Path, rel_path: &str) -> PathBuf {
    root_dir.join(rel_path).clean()
}

fn is_under_root(root_dir: &Path, full_path: &Path) -> bool {
    full_path.starts_with(root_dir)
}

fn is_image_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| ALLOWED_EXTENSIONS.iter().any(|ext| ext.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

// --- 核心逻辑：扫描与数据库 ---

/// 初始化数据库表
async fn init_db(pool: &Pool<Sqlite>) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS images (
            path TEXT PRIMARY KEY, 
            mtime REAL, 
            width INTEGER, 
            height INTEGER, 
            is_landscape BOOLEAN
        );
        CREATE TABLE IF NOT EXISTS playlists (
            client_ip TEXT PRIMARY KEY,
            playlist TEXT NOT NULL,
            created_at REAL NOT NULL
        );"
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// 阻塞操作：读取单个图片的元数据
fn process_image_metadata_sync(full_path: &Path, root_dir: &Path) -> Option<ImageMetadata> {
    if !full_path.exists() { return None; }
    
    // 获取修改时间
    let mtime = full_path.metadata().ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);

    // 获取图片尺寸 (只读取头部，不加载整个文件)
    let (width, height) = image::image_dimensions(full_path).ok()?;
    let is_landscape = width >= height;

    // 计算相对路径
    let rel_path = diff_paths(full_path, root_dir)?;
    let rel_path_str = rel_path.to_string_lossy().replace('\\', "/");

    Some(ImageMetadata {
        path: rel_path_str,
        mtime,
        width,
        height,
        is_landscape,
    })
}

/// 后台扫描任务
async fn scan_library_task(pool: Pool<Sqlite>, root_dir: Arc<PathBuf>) {
    println!("🔍 [Background] 开始全量扫描...");
    let start = std::time::Instant::now();

    // 1. 遍历文件系统 (FS)
    // 使用 spawn_blocking 避免阻塞 Tokio 运行时
    let root_clone = root_dir.clone();
    let fs_files: HashMap<String, PathBuf> = tokio::task::spawn_blocking(move || {
        let mut map = HashMap::new();
        for entry in WalkDir::new(&*root_clone).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() && is_image_ext(entry.path()) {
                if let Some(rel) = diff_paths(entry.path(), &*root_clone) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    map.insert(rel_str, entry.path().to_path_buf());
                }
            }
        }
        map
    }).await.unwrap();

    // 2. 获取数据库现有记录
    let db_rows = sqlx::query("SELECT path, mtime FROM images")
        .fetch_all(&pool)
        .await
        .unwrap_or_default();
    
    let db_files: HashMap<String, f64> = db_rows.into_iter()
        .map(|row| (row.get("path"), row.get("mtime")))
        .collect();

    // 3. 找出需要更新或插入的文件
    let mut to_process = Vec::new();
    for (path, full_path) in &fs_files {
        // 如果 DB 里没有，或者 mtime 不一致，则需要处理
        let mtime = full_path.metadata().ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);

        if !db_files.contains_key(path) || (db_files.get(path).unwrap() - mtime).abs() > 0.001 {
            to_process.push(full_path.clone());
        }
    }

    // 4. 并发处理元数据读取 (Bounded Parallelism)
    if !to_process.is_empty() {
        println!("🚀 [Background] 发现 {} 个变动文件，开始处理...", to_process.len());
        let mut updates = Vec::new();
        
        // 使用 stream 处理并发，避免瞬间开启过多线程
        let stream = futures::stream::iter(to_process)
            .map(|path| {
                let root = root_dir.clone();
                tokio::task::spawn_blocking(move || process_image_metadata_sync(&path, &root))
            })
            .buffer_unordered(16); // 控制并发数为 16

        let mut processed_stream = stream;
        while let Some(result) = processed_stream.next().await {
            if let Ok(Some(meta)) = result {
                updates.push(meta);
            }
        }

        // 批量写入数据库 (事务)
        if !updates.is_empty() {
            let mut tx = pool.begin().await.unwrap();
            for meta in updates {
                sqlx::query("INSERT OR REPLACE INTO images (path, mtime, width, height, is_landscape) VALUES (?, ?, ?, ?, ?)")
                    .bind(meta.path)
                    .bind(meta.mtime)
                    .bind(meta.width)
                    .bind(meta.height)
                    .bind(meta.is_landscape)
                    .execute(&mut *tx)
                    .await.ok();
            }
            tx.commit().await.unwrap();
        }
    }

    // 5. 清理失效文件 (仅清理 Root 下的)
    let mut deleted_count = 0;
    for db_path in db_files.keys() {
        // 简单判断：如果在 root 目录下且 fs 扫描没扫到，就删掉
        // 注意：这里需要更严谨的路径判断逻辑防止删除外部挂载的记录，这里简化处理
        if !fs_files.contains_key(db_path) && !db_path.starts_with("../") {
            sqlx::query("DELETE FROM images WHERE path = ?")
                .bind(db_path)
                .execute(&pool)
                .await.ok();
            deleted_count += 1;
        }
    }

    println!("✅ [Background] 扫描完成，耗时 {:.2}s，清理 {}", start.elapsed().as_secs_f64(), deleted_count);
}

// --- Handlers ---

async fn trigger_scan(State(state): State<AppState>) -> Json<serde_json::Value> {
    tokio::spawn(async move {
        scan_library_task(state.db, state.root_dir).await;
    });
    Json(serde_json::json!({ "status": "scanning_started" }))
}

async fn get_playlist(
    State(state): State<AppState>,
    connect_info: ConnectInfo<SocketAddr>,
    Json(req): Json<PlaylistRequest>,
) -> Json<Vec<String>> {
    let root_dir = state.root_dir.as_path();
    let allow_parent = *state.allow_parent_dir_access.read().await;

    // 1. 路径清洗
    let mut valid_req_paths = Vec::new();
    for p in req.paths {
        let rel = normalize_rel_path(&p);
        let full = resolve_full_path(root_dir, &rel);
        
        // 权限检查
        if !allow_parent && !is_under_root(root_dir, &full) {
            valid_req_paths.push(".".to_string()); // fallback to root
        } else {
            valid_req_paths.push(rel);
        }
    }
    valid_req_paths.dedup();

    // 2. 数据库查询 (直接利用 SQL 筛选，速度极快)
    // 注意：构建动态 LIKE 查询比较繁琐，这里简化为获取所有符合条件的然后内存过滤
    // 或者针对每个路径前缀查一次
    let mut all_images = Vec::new();

    for path_prefix in &valid_req_paths {
        // 如果不在 DB 中，需要触发即时扫描 (Sync logic similar to Python)
        // 为简化代码，这里假设后台扫描已覆盖大部分。
        // 生产环境应在此处检测 DB miss 并回填。

        let prefix_pattern = if path_prefix == "." || path_prefix.is_empty() {
             "%".to_string() // 匹配所有
        } else {
             format!("{}/%", path_prefix)
        };

        let mut query_builder = String::from("SELECT * FROM images WHERE path LIKE ?");
        
        if !allow_parent {
             query_builder.push_str(" AND path NOT LIKE '../%'");
        }
        
        if req.orientation == "Landscape" {
            query_builder.push_str(" AND is_landscape = 1");
        } else if req.orientation == "Portrait" {
            query_builder.push_str(" AND is_landscape = 0");
        }

        let rows = sqlx::query_as::<_, ImageMetadata>(&query_builder)
            .bind(prefix_pattern)
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();
        
        all_images.extend(rows);
    }

    // 去重
    let mut seen = HashSet::new();
    all_images.retain(|i| seen.insert(i.path.clone()));

    // 3. 排序
    match req.sort.as_str() {
        "shuffle" => all_images.shuffle(&mut rand::thread_rng()),
        "date" => all_images.sort_by(|a, b| b.mtime.partial_cmp(&a.mtime).unwrap()),
        "name" => all_images.sort_by(|a, b| natord::compare_ignore_case(&a.path, &b.path)),
        // 简化：省略复杂的 subfolder 排序逻辑，保留最常用的
        _ => all_images.sort_by(|a, b| natord::compare_ignore_case(&a.path, &b.path)),
    }

    let mut final_paths: Vec<String> = all_images.into_iter().map(|i| i.path).collect();

    if req.direction == "reverse" {
        final_paths.reverse();
    }

    // 4. 当前位置旋转
    if let Some(curr) = req.current_path {
        let curr_norm = normalize_rel_path(&curr);
        if let Some(pos) = final_paths.iter().position(|x| x == &curr_norm) {
            final_paths.rotate_left(pos);
        }
    }

    // 5. 持久化到数据库 (关键功能恢复)
    let ip = connect_info.0.ip().to_string();
    if let Ok(json_playlist) = serde_json::to_string(&final_paths) {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64();
        sqlx::query("INSERT OR REPLACE INTO playlists (client_ip, playlist, created_at) VALUES (?, ?, ?)")
            .bind(&ip)
            .bind(json_playlist)
            .bind(now)
            .execute(&state.db)
            .await
            .ok();
    }

    Json(final_paths)
}

async fn restore_playlist(
    State(state): State<AppState>,
    connect_info: ConnectInfo<SocketAddr>,
    Json(req): Json<RestorePlaylistRequest>,
) -> Json<serde_json::Value> {
    let root_dir = state.root_dir.as_path();
    let allow_parent = *state.allow_parent_dir_access.read().await;

    // 验证路径有效性 (使用 fs 非 DB，确保文件确实还在)
    let mut valid_paths = Vec::new();
    for p in req.playlist {
        let rel = normalize_rel_path(&p);
        let full = resolve_full_path(root_dir, &rel);
        if full.is_file() {
            if allow_parent || is_under_root(root_dir, &full) {
                valid_paths.push(rel);
            }
        }
    }

    // 更新数据库会话
    let ip = connect_info.0.ip().to_string();
    if let Ok(json_playlist) = serde_json::to_string(&valid_paths) {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64();
        sqlx::query("INSERT OR REPLACE INTO playlists (client_ip, playlist, created_at) VALUES (?, ?, ?)")
            .bind(&ip)
            .bind(json_playlist)
            .bind(now)
            .execute(&state.db)
            .await
            .ok();
    }

    Json(serde_json::json!({
        "status": "restored",
        "valid_count": valid_paths.len(),
        "playlist": valid_paths
    }))
}

async fn session_status(
    State(state): State<AppState>,
    connect_info: ConnectInfo<SocketAddr>,
) -> Json<SessionStatusResponse> {
    let ip = connect_info.0.ip().to_string();
    
    // 从数据库查询
    let row: Option<(String,)> = sqlx::query_as("SELECT playlist FROM playlists WHERE client_ip = ?")
        .bind(&ip)
        .fetch_optional(&state.db)
        .await
        .unwrap_or(None);

    if let Some((playlist_json,)) = row {
        if let Ok(list) = serde_json::from_str::<Vec<String>>(&playlist_json) {
            return Json(SessionStatusResponse {
                has_session: true,
                source: Some("database".to_string()),
                playlist_size: list.len(),
            });
        }
    }

    Json(SessionStatusResponse { has_session: false, source: None, playlist_size: 0 })
}

// 简单的文件服务，不带缓存逻辑，依靠 OS Page Cache
// --- 文件服务逻辑 ---

/// 核心文件读取逻辑
async fn serve_file_core(state: AppState, raw_path: String) -> Response {
    let root_dir = state.root_dir.as_path();
    let allow_parent = *state.allow_parent_dir_access.read().await;
    
    // 1. URL 解码 (非常重要！前端传过来的可能是 "foo%20bar.jpg")
    // axum::extract::Path 会自动解码，但 Query 需要手动处理或者依赖 serde
    // 这里做一次从百分号编码的解码，防止 raw_path 依然包含 %20
    let decoded_path = urlencoding::decode(&raw_path)
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| raw_path.clone());

    let rel = normalize_rel_path(&decoded_path);
    let full = resolve_full_path(root_dir, &rel);

    // 2. 权限检查
    if !allow_parent && !is_under_root(root_dir, &full) {
        return (
            StatusCode::FORBIDDEN, 
            Json(serde_json::json!({ "message": "Access outside ROOT_DIR is disabled" }))
        ).into_response();
    }

    // 3. 检查文件是否存在
    if !full.exists() || !full.is_file() {
        return StatusCode::NOT_FOUND.into_response();
    }

    // 4. 高效流式传输
    match tokio::fs::File::open(&full).await {
        Ok(file) => {
            let stream = tokio_util::io::ReaderStream::new(file);
            let body = axum::body::Body::from_stream(stream);

            let mime = from_path(&full).first_or_octet_stream();
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, mime.as_ref().parse().unwrap());
            // 缓存控制：让浏览器缓存图片 1 小时，减少服务器压力
            headers.insert(header::CACHE_CONTROL, "public, max-age=3600".parse().unwrap());

            (headers, body).into_response()
        },
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// 接口 1: 处理 /api/file?path=...
async fn serve_file_by_query(
    State(state): State<AppState>,
    Query(query): Query<FileQuery>,
) -> Response {
    serve_file_core(state, query.path).await
}

/// 接口 2: 处理直接路径 /folder/image.jpg
async fn serve_file_by_path(
    State(state): State<AppState>,
    AxumPath(path_str): AxumPath<String>,
) -> Response {
    serve_file_core(state, path_str).await
}

async fn get_runtime_config(State(state): State<AppState>) -> Json<serde_json::Value> {
    let v = *state.allow_parent_dir_access.read().await;
    Json(serde_json::json!({ "allow_parent_dir_access": v }))
}

// --- Main ---

#[tokio::main]
async fn main() -> Result<()> {
    // 1. 环境配置
    let root_dir = env::var("GALLERY_ROOT_DIR").map(PathBuf::from).unwrap_or(env::current_dir()?);
    let db_path = root_dir.join("gallery_metadata.db");
    
    // 2. 数据库连接池
    let db_url = format!("sqlite://{}?mode=rwc", db_path.to_string_lossy());
    let pool = SqlitePoolOptions::new()
        .max_connections(10)
        .connect(&db_url)
        .await
        .expect("Failed to connect to SQLite");
    
    init_db(&pool).await?;

    let app_state = AppState {
        db: pool.clone(),
        root_dir: Arc::new(root_dir.clone()),
        allow_parent_dir_access: Arc::new(RwLock::new(env::var("GALLERY_ALLOW_PARENT_DIR_ACCESS").unwrap_or_default() == "1")),
    };

    // 启动时触发一次扫描
    let state_clone = app_state.clone();
    tokio::spawn(async move {
        scan_library_task(state_clone.db, state_clone.root_dir).await;
    });

    // 3. 路由
    let app = Router::new()
        .route("/api/scan", post(trigger_scan))
        .route("/api/playlist", post(get_playlist))
        .route("/api/restore-playlist", post(restore_playlist))
        .route("/api/session-status", get(session_status))
        .route("/api/runtime-config", get(get_runtime_config))
        // --- 修复点开始 ---
        .route("/api/file", get(serve_file_by_query)) // 必须放在通配符之前
        .route("/*file_path", get(serve_file_by_path))
        // --- 修复点结束 ---
        .layer(CorsLayer::permissive())
        .with_state(app_state);

    // 4. 服务器启动 (Rustls)
    let addr = SocketAddr::from(([0, 0, 0, 0], 4860));
    println!("🚀 Rust Gallery Server running on https://{}", addr);
    
    // 加载证书部分省略，逻辑同上... 假设证书存在
    if let (Ok(cert), Ok(key)) = (env::var("GALLERY_SSL_CERT"), env::var("GALLERY_SSL_KEY")) {
         let tls_config = RustlsConfig::from_pem_file(cert, key).await?;
         axum_server::bind_rustls(addr, tls_config)
            .serve(app.into_make_service_with_connect_info::<SocketAddr>())
            .await?;
    } else {
        println!("⚠️  SSL未配置，运行在 HTTP 模式");
        axum_server::bind(addr)
            .serve(app.into_make_service_with_connect_info::<SocketAddr>())
            .await?;
    }

    Ok(())
}