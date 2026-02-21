use anyhow::Result;
use axum::{
    extract::{ConnectInfo, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use axum_server::tls_rustls::RustlsConfig;
use futures::StreamExt;
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
    external_synced_paths_this_boot: Arc<RwLock<HashSet<String>>>,
    user_sessions: Arc<RwLock<HashMap<String, Vec<String>>>>,
    log_api_file_requests: bool,
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
struct BrowseQuery {
    #[serde(default)]
    path: String,
}

#[derive(Debug, Deserialize)]
struct FileQuery {
    path: String,
}

#[derive(Debug, Serialize)]
struct BrowseItem {
    name: String,
    path: String,
    #[serde(rename = "type")]
    item_type: String,
}

#[derive(Debug, Serialize)]
struct BrowseResponse {
    #[serde(rename = "currentPath")]
    current_path: String,
    items: Vec<BrowseItem>,
}

#[derive(Debug, Serialize)]
struct SessionStatusResponse {
    has_session: bool,
    source: Option<String>,
    playlist_size: usize,
}

#[derive(Debug, Serialize)]
struct SessionPlaylistResponse {
    has_session: bool,
    source: Option<String>,
    playlist_size: usize,
    playlist: Vec<String>,
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

fn path_to_rel_string(root_dir: &Path, full_path: &Path) -> String {
    diff_paths(full_path, root_dir)
        .unwrap_or_else(|| PathBuf::from(""))
        .to_string_lossy()
        .replace('\\', "/")
}

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

fn env_flag_enabled(name: &str) -> bool {
    env::var(name)
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
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

fn escape_like_pattern(value: &str) -> String {
    value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

fn parent_folder(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

fn file_stem_from_rel_path(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn strip_trailing_index_suffix(name: &str) -> String {
    if let Some((prefix, suffix)) = name.rsplit_once(" (") {
        if suffix.ends_with(')') {
            let digits = &suffix[..suffix.len() - 1];
            if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
                return prefix.trim_end().to_string();
            }
        }
    }
    name.to_string()
}

fn folder_first_image_prefix(items: &[ImageMetadata]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let stem = file_stem_from_rel_path(&items[0].path);
    strip_trailing_index_suffix(&stem)
}

fn folder_mtime(root_dir: &Path, parent: &str) -> f64 {
    let folder_path = if parent.is_empty() {
        root_dir.to_path_buf()
    } else {
        resolve_full_path(root_dir, parent)
    };

    folder_path
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

async fn sync_external_path_to_db(pool: &Pool<Sqlite>, root_dir: &Path, rel_path: &str) -> Result<()> {
    let normalized = normalize_rel_path(rel_path);
    if normalized.is_empty() {
        return Ok(());
    }

    let full_path = resolve_full_path(root_dir, &normalized);
    let root_clone = root_dir.to_path_buf();

    let scanned: Vec<ImageMetadata> = tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();

        if !full_path.exists() {
            return results;
        }

        if full_path.is_file() {
            if let Some(meta) = process_image_metadata_sync(&full_path, &root_clone) {
                results.push(meta);
            }
            return results;
        }

        for entry in WalkDir::new(&full_path).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() && is_image_ext(entry.path()) {
                if let Some(meta) = process_image_metadata_sync(entry.path(), &root_clone) {
                    results.push(meta);
                }
            }
        }

        results
    })
    .await
    .unwrap_or_default();

    let scanned_paths: HashSet<String> = scanned.iter().map(|x| x.path.clone()).collect();
    let like_prefix = format!("{}/%", escape_like_pattern(&normalized));

    let mut tx = pool.begin().await?;

    for meta in scanned {
        sqlx::query("INSERT OR REPLACE INTO images (path, mtime, width, height, is_landscape) VALUES (?, ?, ?, ?, ?)")
            .bind(meta.path)
            .bind(meta.mtime)
            .bind(meta.width)
            .bind(meta.height)
            .bind(meta.is_landscape)
            .execute(&mut *tx)
            .await?;
    }

    let existing_rows: Vec<(String,)> = sqlx::query_as("SELECT path FROM images WHERE path LIKE ? ESCAPE '\\\\'")
        .bind(like_prefix)
        .fetch_all(&mut *tx)
        .await
        .unwrap_or_default();

    let mut deleted_count = 0;
    for (path,) in existing_rows {
        if !scanned_paths.contains(&path) {
            sqlx::query("DELETE FROM images WHERE path = ?")
                .bind(path)
                .execute(&mut *tx)
                .await?;
            deleted_count += 1;
        }
    }

    tx.commit().await?;
    println!(
        "🔄 [On-demand External Sync] {} | scanned {} | deleted {}",
        normalized,
        scanned_paths.len(),
        deleted_count
    );

    Ok(())
}

async fn upsert_missing_path_to_db(pool: &Pool<Sqlite>, root_dir: &Path, rel_path: &str) -> Result<()> {
    let normalized = normalize_rel_path(rel_path);
    if normalized.is_empty() || normalized == "." {
        return Ok(());
    }

    let full_path = resolve_full_path(root_dir, &normalized);
    if !full_path.exists() {
        return Ok(());
    }

    let root_clone = root_dir.to_path_buf();
    let scanned: Vec<ImageMetadata> = tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();

        if full_path.is_file() {
            if let Some(meta) = process_image_metadata_sync(&full_path, &root_clone) {
                results.push(meta);
            }
            return results;
        }

        for entry in WalkDir::new(&full_path).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() && is_image_ext(entry.path()) {
                if let Some(meta) = process_image_metadata_sync(entry.path(), &root_clone) {
                    results.push(meta);
                }
            }
        }
        results
    })
    .await
    .unwrap_or_default();

    if scanned.is_empty() {
        return Ok(());
    }

    let mut tx = pool.begin().await?;
    for meta in scanned {
        sqlx::query("INSERT OR REPLACE INTO images (path, mtime, width, height, is_landscape) VALUES (?, ?, ?, ?, ?)")
            .bind(meta.path)
            .bind(meta.mtime)
            .bind(meta.width)
            .bind(meta.height)
            .bind(meta.is_landscape)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    Ok(())
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
    let mut seen_req = HashSet::new();
    valid_req_paths.retain(|p| seen_req.insert(p.clone()));

    let mut external_paths = Vec::new();
    let mut external_seen = HashSet::new();
    for p in &valid_req_paths {
        if p.is_empty() || p == "." {
            continue;
        }
        let full = resolve_full_path(root_dir, p);
        if !is_under_root(root_dir, &full) && external_seen.insert(p.clone()) {
            external_paths.push(p.clone());
        }
    }

    for ext_path in external_paths {
        let already_synced = {
            let guard = state.external_synced_paths_this_boot.read().await;
            guard.contains(&ext_path)
        };

        if !already_synced {
            if let Err(err) = sync_external_path_to_db(&state.db, root_dir, &ext_path).await {
                eprintln!("⚠️ External path sync failed for {}: {}", ext_path, err);
            }
            let mut guard = state.external_synced_paths_this_boot.write().await;
            guard.insert(ext_path);
        }
    }

    let mut missing_paths = Vec::new();
    for p in &valid_req_paths {
        if p.is_empty() || p == "." {
            continue;
        }
        let exists_row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM images WHERE path LIKE ? LIMIT 1")
            .bind(format!("{}/%", p))
            .fetch_optional(&state.db)
            .await
            .unwrap_or(None);
        if exists_row.is_none() {
            missing_paths.push(p.clone());
        }
    }

    for missing in missing_paths {
        if let Err(err) = upsert_missing_path_to_db(&state.db, root_dir, &missing).await {
            eprintln!("⚠️ Missing-path upsert failed for {}: {}", missing, err);
        }
    }

    // 2. 数据库查询 (直接利用 SQL 筛选，速度极快)
    // 注意：构建动态 LIKE 查询比较繁琐，这里简化为获取所有符合条件的然后内存过滤
    // 或者针对每个路径前缀查一次
    let mut all_images = Vec::new();

    for path_prefix in &valid_req_paths {
        // 如果不在 DB 中，需要触发即时扫描 (Sync logic similar to Python)
        // 为简化代码，这里假设后台扫描已覆盖大部分。
        // 生产环境应在此处检测 DB miss 并回填。

        let (mut query_builder, maybe_prefix_pattern): (String, Option<String>) = if path_prefix == "." || path_prefix.is_empty() {
            ("SELECT * FROM images WHERE path NOT LIKE '../%'".to_string(), None)
        } else {
            (
                "SELECT * FROM images WHERE path LIKE ?".to_string(),
                Some(format!("{}/%", path_prefix)),
            )
        };

        if !allow_parent && path_prefix != "." && !path_prefix.is_empty() {
            query_builder.push_str(" AND path NOT LIKE '../%'");
        }
        
        if req.orientation == "Landscape" {
            query_builder.push_str(" AND is_landscape = 1");
        } else if req.orientation == "Portrait" {
            query_builder.push_str(" AND is_landscape = 0");
        }

        let rows = if let Some(prefix_pattern) = maybe_prefix_pattern {
            sqlx::query_as::<_, ImageMetadata>(&query_builder)
                .bind(prefix_pattern)
                .fetch_all(&state.db)
                .await
                .unwrap_or_default()
        } else {
            sqlx::query_as::<_, ImageMetadata>(&query_builder)
                .fetch_all(&state.db)
                .await
                .unwrap_or_default()
        };
        
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
        "subfolder_random" => {
            let mut grouped: HashMap<String, Vec<ImageMetadata>> = HashMap::new();
            for item in all_images {
                grouped.entry(parent_folder(&item.path)).or_default().push(item);
            }

            let mut subfolders: Vec<String> = grouped.keys().cloned().collect();
            subfolders.shuffle(&mut rand::thread_rng());

            let mut flattened = Vec::new();
            for folder in subfolders {
                if let Some(mut items) = grouped.remove(&folder) {
                    items.sort_by(|a, b| natord::compare_ignore_case(&a.path, &b.path));
                    flattened.extend(items);
                }
            }
            all_images = flattened;
        }
        "subfolder_date" => {
            let mut grouped: HashMap<String, Vec<ImageMetadata>> = HashMap::new();
            for item in all_images {
                grouped.entry(parent_folder(&item.path)).or_default().push(item);
            }

            let mut subfolders: Vec<String> = grouped.keys().cloned().collect();
            subfolders.sort_by(|a, b| {
                let ma = folder_mtime(root_dir, a);
                let mb = folder_mtime(root_dir, b);
                ma.partial_cmp(&mb).unwrap_or(std::cmp::Ordering::Equal)
            });

            let mut flattened = Vec::new();
            for folder in subfolders {
                if let Some(mut items) = grouped.remove(&folder) {
                    items.sort_by(|a, b| natord::compare_ignore_case(&a.path, &b.path));
                    flattened.extend(items);
                }
            }
            all_images = flattened;
        }
        "subfolder_prefix" => {
            let mut grouped: HashMap<String, Vec<ImageMetadata>> = HashMap::new();
            for item in all_images {
                grouped.entry(parent_folder(&item.path)).or_default().push(item);
            }

            let mut folder_orders: Vec<(String, String)> = Vec::new();
            for (folder, items) in &mut grouped {
                items.sort_by(|a, b| natord::compare_ignore_case(&a.path, &b.path));
                let prefix = folder_first_image_prefix(items);
                folder_orders.push((folder.clone(), prefix));
            }

            folder_orders.sort_by(|(folder_a, prefix_a), (folder_b, prefix_b)| {
                natord::compare_ignore_case(prefix_a, prefix_b)
                    .then_with(|| natord::compare_ignore_case(folder_a, folder_b))
            });

            let mut flattened = Vec::new();
            for (folder, _) in folder_orders {
                if let Some(items) = grouped.remove(&folder) {
                    flattened.extend(items);
                }
            }
            all_images = flattened;
        }
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

    {
        let mut sessions = state.user_sessions.write().await;
        sessions.insert(ip.clone(), final_paths.clone());
    }

    Json(final_paths)
}

async fn restore_playlist(
    State(state): State<AppState>,
    connect_info: ConnectInfo<SocketAddr>,
    Json(req): Json<RestorePlaylistRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let original_count = req.playlist.len();
    println!("🔄 [Restore Playlist] 请求恢复播放列表，原始路径数量: {}", original_count);
    if original_count == 0 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "detail": "Playlist cannot be empty" })),
        ));
    }

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

    if valid_paths.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "detail": "No valid paths in playlist" })),
        ));
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

    {
        let mut sessions = state.user_sessions.write().await;
        sessions.insert(ip.clone(), valid_paths.clone());
    }

    let current_index = req.current_index.min(valid_paths.len().saturating_sub(1));

    Ok(Json(serde_json::json!({
        "status": "restored",
        "valid_count": valid_paths.len(),
        "original_count": original_count,
        "current_index": current_index,
        "playlist": valid_paths
    })))
}

async fn session_status(
    State(state): State<AppState>,
    connect_info: ConnectInfo<SocketAddr>,
) -> Json<SessionStatusResponse> {
    let ip = connect_info.0.ip().to_string();

    {
        let sessions = state.user_sessions.read().await;
        if let Some(playlist) = sessions.get(&ip) {
            return Json(SessionStatusResponse {
                has_session: true,
                source: Some("memory".to_string()),
                playlist_size: playlist.len(),
            });
        }
    }
    
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

async fn session_playlist(
    State(state): State<AppState>,
    connect_info: ConnectInfo<SocketAddr>,
) -> Json<SessionPlaylistResponse> {
    let ip = connect_info.0.ip().to_string();

    {
        let sessions = state.user_sessions.read().await;
        if let Some(playlist) = sessions.get(&ip) {
            return Json(SessionPlaylistResponse {
                has_session: true,
                source: Some("memory".to_string()),
                playlist_size: playlist.len(),
                playlist: playlist.clone(),
            });
        }
    }

    let row: Option<(String,)> = sqlx::query_as("SELECT playlist FROM playlists WHERE client_ip = ?")
        .bind(&ip)
        .fetch_optional(&state.db)
        .await
        .unwrap_or(None);

    if let Some((playlist_json,)) = row {
        if let Ok(list) = serde_json::from_str::<Vec<String>>(&playlist_json) {
            return Json(SessionPlaylistResponse {
                has_session: true,
                source: Some("database".to_string()),
                playlist_size: list.len(),
                playlist: list,
            });
        }
    }

    Json(SessionPlaylistResponse {
        has_session: false,
        source: None,
        playlist_size: 0,
        playlist: Vec::new(),
    })
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
    if state.log_api_file_requests {
        println!("📷 [API /api/file] path={}", query.path);
    }
    serve_file_core(state, query.path).await
}

/// 接口 2: 处理直接路径 /folder/image.jpg
// async fn serve_file_by_path(
//     State(state): State<AppState>,
//     AxumPath(path_str): AxumPath<String>,
// ) -> Response {
//     serve_file_core(state, path_str).await
// }

async fn browse_folder(
    State(state): State<AppState>,
    Query(query): Query<BrowseQuery>,
) -> Result<Json<BrowseResponse>, (StatusCode, Json<serde_json::Value>)> {
    let root_dir = state.root_dir.as_path();
    let allow_parent = *state.allow_parent_dir_access.read().await;

    let mut rel_path = normalize_rel_path(&query.path);
    let mut target_path = if rel_path.is_empty() || rel_path == "." {
        root_dir.to_path_buf()
    } else {
        resolve_full_path(root_dir, &rel_path)
    };

    if !allow_parent && !is_under_root(root_dir, &target_path) {
        target_path = root_dir.to_path_buf();
        rel_path.clear();
    } else {
        rel_path = path_to_rel_string(root_dir, &target_path);
        if rel_path == "." {
            rel_path.clear();
        }
    }

    if !target_path.exists() || !target_path.is_dir() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "detail": "Folder not found" })),
        ));
    }

    let mut items = Vec::new();
    let entries = std::fs::read_dir(&target_path).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "detail": "Failed to read folder" })),
        )
    })?;

    for entry in entries.flatten() {
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        let Ok(ft) = entry.file_type() else {
            continue;
        };

        let is_dir = ft.is_dir();
        if !is_dir && !is_image_ext(&entry_path) {
            continue;
        }

        items.push(BrowseItem {
            name,
            path: path_to_rel_string(root_dir, &entry_path),
            item_type: if is_dir { "folder" } else { "file" }.to_string(),
        });
    }

    items.sort_by(|a, b| {
        let rank_a = if a.item_type == "folder" { 0 } else { 1 };
        let rank_b = if b.item_type == "folder" { 0 } else { 1 };
        rank_a
            .cmp(&rank_b)
            .then_with(|| natord::compare_ignore_case(&a.name, &b.name))
    });

    Ok(Json(BrowseResponse {
        current_path: rel_path,
        items,
    }))
}

async fn get_runtime_config(State(state): State<AppState>) -> Json<serde_json::Value> {
    let v = *state.allow_parent_dir_access.read().await;
    Json(serde_json::json!({
        "allow_parent_dir_access": v,
        "env_value": env::var("GALLERY_ALLOW_PARENT_DIR_ACCESS").unwrap_or_else(|_| "<unset>".to_string())
    }))
}

async fn set_runtime_config(
    State(state): State<AppState>,
    Json(req): Json<RuntimeConfigRequest>,
) -> Json<serde_json::Value> {
    {
        let mut guard = state.allow_parent_dir_access.write().await;
        *guard = req.allow_parent_dir_access;
    }
    env::set_var(
        "GALLERY_ALLOW_PARENT_DIR_ACCESS",
        if req.allow_parent_dir_access { "1" } else { "0" },
    );

    Json(serde_json::json!({
        "status": "ok",
        "allow_parent_dir_access": req.allow_parent_dir_access,
        "env_value": env::var("GALLERY_ALLOW_PARENT_DIR_ACCESS").unwrap_or_else(|_| "<unset>".to_string())
    }))
}

async fn toggle_runtime_config(State(state): State<AppState>) -> Json<serde_json::Value> {
    let new_value = {
        let mut guard = state.allow_parent_dir_access.write().await;
        *guard = !*guard;
        *guard
    };

    env::set_var(
        "GALLERY_ALLOW_PARENT_DIR_ACCESS",
        if new_value { "1" } else { "0" },
    );

    Json(serde_json::json!({
        "status": "ok",
        "allow_parent_dir_access": new_value,
        "env_value": env::var("GALLERY_ALLOW_PARENT_DIR_ACCESS").unwrap_or_else(|_| "<unset>".to_string())
    }))
}

// --- Main ---

#[tokio::main]
async fn main() -> Result<()> {
        let host = env::var("GALLERY_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
        let port = env::var("GALLERY_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(4860);

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
        external_synced_paths_this_boot: Arc::new(RwLock::new(HashSet::new())),
        user_sessions: Arc::new(RwLock::new(HashMap::new())),
        log_api_file_requests: env_flag_enabled("GALLERY_LOG_API_FILE_REQUESTS"),
    };

    println!(
        "📝 API /api/file request logging: {}",
        if app_state.log_api_file_requests { "ON" } else { "OFF" }
    );

    // 启动时触发一次扫描
    let state_clone = app_state.clone();
    tokio::spawn(async move {
        scan_library_task(state_clone.db, state_clone.root_dir).await;
    });

    // 3. 路由
    let app = Router::new()
        .route("/api/scan", post(trigger_scan))
        .route("/api/browse", get(browse_folder))
        .route("/api/playlist", post(get_playlist))
        .route("/api/restore-playlist", post(restore_playlist))
        .route("/api/session-status", get(session_status))
        .route("/api/session-playlist", get(session_playlist))
        .route("/api/runtime-config", get(get_runtime_config).post(set_runtime_config))
        .route("/api/runtime-config/toggle", post(toggle_runtime_config))
        // --- 修复点开始 ---
        .route("/api/file", get(serve_file_by_query)) // 必须放在通配符之前
        // .route("/*file_path", get(serve_file_by_path))
        // --- 修复点结束 ---
        .layer(CorsLayer::permissive())
        .with_state(app_state);

    // 4. 服务器启动 (Rustls)
    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .unwrap_or_else(|_| SocketAddr::from(([0, 0, 0, 0], 4860)));
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