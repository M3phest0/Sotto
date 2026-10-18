use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

/// WebView2 默认常驻 GPU/网络/辅助进程；组件只渲染本地静态页面。
/// 关闭 GPU、把 GPU 折进浏览器进程并启用低内存模式后，实测私有工作集合计
/// 从约 150MB 降到约 77MB（应用 + 全部 WebView2 子进程）。
/// 两个窗口必须使用相同参数，才能共享同一个 WebView2 环境。
const WEBVIEW2_ARGS: &str = "--disable-gpu --in-process-gpu --enable-low-end-device-mode \
--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
--disable-background-networking --disable-component-update --disable-sync \
--disable-extensions --no-first-run --no-default-browser-check";

/// 桌面层布局：放在壁纸之上、普通窗口之下。
/// Tauri 的 setAlwaysOnBottom 使用 HWND_BOTTOM，遇到动态壁纸（WorkerW）会被壁纸盖住，
/// 因此这里直接把窗口插到桌面图标宿主（含 SHELLDLL_DefView 的 WorkerW）之上。
/// 同时加 WS_EX_TOOLWINDOW，确保任务栏和 Alt+Tab 都不显示。
#[cfg(target_os = "windows")]
#[tauri::command]
fn set_desktop_layer(window: tauri::WebviewWindow) -> Result<(), String> {
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_TOOLWINDOW: isize = 0x00000080;
    const WS_EX_APPWINDOW: isize = 0x00040000;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOACTIVATE: u32 = 0x0010;

    unsafe extern "system" {
        fn FindWindowW(class: *const u16, name: *const u16) -> isize;
        fn FindWindowExW(parent: isize, after: isize, class: *const u16, name: *const u16) -> isize;
        fn EnumWindows(cb: unsafe extern "system" fn(isize, isize) -> i32, lparam: isize) -> i32;
        fn SetWindowPos(hwnd: isize, after: isize, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
        fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    struct Ctx {
        anchor: isize,
    }

    unsafe extern "system" fn enum_cb(hwnd: isize, lparam: isize) -> i32 {
        let ctx = &mut *(lparam as *mut Ctx);
        let def_view = wide("SHELLDLL_DefView");
        if FindWindowExW(hwnd, 0, def_view.as_ptr(), std::ptr::null()) != 0 {
            ctx.anchor = hwnd;
        }
        1
    }

    let hwnd = window.hwnd().map_err(|err| err.to_string())?.0 as isize;
    unsafe {
        let mut ctx = Ctx { anchor: 0 };
        EnumWindows(enum_cb, &mut ctx as *mut Ctx as isize);
        let mut anchor = ctx.anchor;
        if anchor == 0 {
            anchor = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
        }
        if anchor == 0 {
            return Err("desktop window not found".into());
        }
        SetWindowPos(hwnd, anchor, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);

        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            (ex_style | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW,
        );
        // 样式变更后重新声明位置，让任务栏/Alt+Tab 重新读取。
        SetWindowPos(hwnd, anchor, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn set_desktop_layer(_window: tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// Win11 会给无边框窗口画一圈 1px 系统边框。深色主题下卡片只占窗口一角，
/// 这圈灰线会把整个 384x520 的透明窗口框出来，看起来像一块空板子。
/// DWMWA_COLOR_NONE 让 DWM 不画边框。
#[cfg(target_os = "windows")]
fn clear_native_border(window: &tauri::WebviewWindow) {
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;

    // 运行时解析，避免 GNU 工具链找不到 dwmapi 的 import library。
    type DwmSetWindowAttributeFn = unsafe extern "system" fn(isize, u32, *const u32, u32) -> i32;

    unsafe extern "system" {
        fn LoadLibraryW(name: *const u16) -> isize;
        fn GetProcAddress(module: isize, name: *const u8) -> isize;
        fn FreeLibrary(module: isize) -> i32;
    }

    let Ok(hwnd) = window.hwnd() else { return };
    let dll: Vec<u16> = "dwmapi.dll\0".encode_utf16().collect();
    unsafe {
        let module = LoadLibraryW(dll.as_ptr());
        if module == 0 {
            return;
        }
        let proc = GetProcAddress(module, b"DwmSetWindowAttribute\0".as_ptr());
        if proc != 0 {
            let set_attr: DwmSetWindowAttributeFn = std::mem::transmute(proc);
            let value = DWMWA_COLOR_NONE;
            let _ = set_attr(hwnd.0 as isize, DWMWA_BORDER_COLOR, &value, 4);
        }
        let _ = FreeLibrary(module);
    }
}

#[cfg(not(target_os = "windows"))]
fn clear_native_border(_window: &tauri::WebviewWindow) {}

#[tauri::command]
fn set_acrylic(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{apply_acrylic, clear_acrylic};
        if enabled {
            apply_acrylic(&window, Some((18, 22, 30, 180))).map_err(|err| err.to_string())
        } else {
            clear_acrylic(&window).map_err(|err| err.to_string())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, enabled);
        Ok(())
    }
}


#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WidgetPosition {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct EditorBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone)]
struct OpenFile {
    path: PathBuf,
    text: String,
    meta: sotto_core::bytes::ByteMeta,
    read_only_reason: Option<String>,
    /// 路径当前不存在（被移动/删除）；与“空文件”区分，避免静默重建。
    missing: bool,
    /// 有缓存但本次读取失败；继续展示缓存，同时让前端提示错误。
    read_error: Option<String>,
}

const FIRST_RUN_MARKDOWN: &str = "# 今日待办\n\n- [ ] 写周报\n  - [ ] 收集数据\n- [ ] 买牛奶\n- [ ] 看文档\n- [ ] 整理桌面\n";

#[derive(Clone)]
struct DraftState {
    path: PathBuf,
    text: String,
    base_hash: String,
    meta: sotto_core::bytes::ByteMeta,
    missing: bool,
}

struct AppState {
    current: Mutex<Option<OpenFile>>,
    settings_path: PathBuf,
    backups_dir: PathBuf,
    default_file: PathBuf,
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched_path: Mutex<Option<PathBuf>>,
    last_hash: Arc<Mutex<String>>,
    /// 编辑窗口草稿镜像；WM_QUERYENDSESSION 时同步落盘。
    draft: Mutex<Option<DraftState>>,
    /// 编辑窗口最近一次可见的物理 bounds，用于移动/缩放后的防抖落盘。
    editor_bounds: Mutex<Option<EditorBounds>>,
    editor_bounds_gen: Arc<AtomicU64>,
    editor_bounds_flushing: Arc<AtomicBool>,
    widget_position: Mutex<Option<WidgetPosition>>,
    widget_position_gen: Arc<AtomicU64>,
    widget_position_flushing: Arc<AtomicBool>,
    tray: Mutex<Option<tauri::tray::TrayIcon>>,
}

impl AppState {
    fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let config_dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
        let local_dir = app.path().app_local_data_dir().map_err(|err| err.to_string())?;
        let documents = app.path().document_dir().map_err(|err| err.to_string())?;
        fs::create_dir_all(&config_dir).map_err(|err| err.to_string())?;
        fs::create_dir_all(&local_dir).map_err(|err| err.to_string())?;
        let settings_path = config_dir.join("settings.json");
        let default_file = documents.join("Sotto.md");
        // 首次运行（还没有设置文件）且默认文件不存在时创建示例。
        // 用户主动删除文件后 settings.json 仍在，此时不重建，走“文件不存在”状态。
        if !settings_path.exists() && !default_file.exists() {
            if let Err(err) =
                sotto_core::atomic::write_atomic(&default_file, &sotto_core::bytes::encode_new(FIRST_RUN_MARKDOWN))
            {
                eprintln!("sotto first-run sample failed: {err}");
            }
        }
        Ok(Self {
            current: Mutex::new(None),
            settings_path,
            backups_dir: local_dir.join("backups"),
            default_file,
            watcher: Mutex::new(None),
            watched_path: Mutex::new(None),
            last_hash: Arc::new(Mutex::new(String::new())),
            draft: Mutex::new(None),
            editor_bounds: Mutex::new(None),
            editor_bounds_gen: Arc::new(AtomicU64::new(0)),
            editor_bounds_flushing: Arc::new(AtomicBool::new(false)),
            widget_position: Mutex::new(None),
            widget_position_gen: Arc::new(AtomicU64::new(0)),
            widget_position_flushing: Arc::new(AtomicBool::new(false)),
            tray: Mutex::new(None),
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotDto {
    text: String,
    path: String,
    settings: serde_json::Value,
    meta: Option<sotto_core::bytes::ByteMeta>,
    read_only_reason: Option<String>,
    missing: bool,
    read_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    status: &'static str,
    disk_hash: Option<String>,
    meta: Option<sotto_core::bytes::ByteMeta>,
    message: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_settings(path: &Path) -> serde_json::Value {
    let Ok(bytes) = fs::read(path) else {
        return serde_json::json!({});
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            let corrupt = path.with_file_name("settings.corrupt.json");
            let _ = fs::copy(path, corrupt);
            serde_json::json!({})
        }
    }
}

fn load_file(path: &Path) -> Result<OpenFile, String> {
    let bytes = fs::read(path).map_err(|err| format!("读取文件失败: {err}"))?;
    let mut decoded = sotto_core::bytes::decode(&bytes)?;
    // Windows 只读属性会让原子替换失败；提前按只读展示，避免保存时才报错。
    if decoded.read_only_reason.is_none()
        && fs::metadata(path).map(|meta| meta.permissions().readonly()).unwrap_or(false)
    {
        decoded.read_only_reason = Some("文件为只读属性；请取消只读后保存".into());
    }
    Ok(OpenFile {
        path: path.to_path_buf(),
        text: decoded.text,
        meta: decoded.meta,
        read_only_reason: decoded.read_only_reason,
        missing: false,
        read_error: None,
    })
}

fn empty_file(path: PathBuf) -> Result<OpenFile, String> {
    let decoded = sotto_core::bytes::decode(&[])?;
    Ok(OpenFile {
        path,
        text: decoded.text,
        meta: decoded.meta,
        read_only_reason: decoded.read_only_reason,
        missing: true,
        read_error: None,
    })
}

fn ensure_current(state: &AppState) -> Result<OpenFile, String> {
    let mut guard = state.current.lock().map_err(|_| "文件状态锁失效".to_string())?;
    let path = guard
        .as_ref()
        .map(|file| file.path.clone())
        .unwrap_or_else(|| state.default_file.clone());
    // 每次都从磁盘重读：外部修改后 watcher 只能发事件，缓存必须在这里失效。
    let file = if path.exists() {
        match load_file(&path) {
            Ok(mut file) => {
                file.missing = false;
                file.read_error = None;
                file
            }
            Err(err) => {
                // 外部写入瞬间可能读到半截/被占用，暂时沿用上一份缓存，
                // 但把错误带给前端，避免用户把旧内容当成最新状态。
                if let Some(cached) = guard.as_ref() {
                    let mut cached = cached.clone();
                    cached.read_error = Some(format!("无法读取文件：{err}"));
                    return Ok(cached);
                }
                return Err(err);
            }
        }
    } else {
        empty_file(path)?
    };
    *guard = Some(file.clone());
    Ok(file)
}

fn snapshot(state: &AppState, file: &OpenFile) -> SnapshotDto {
    SnapshotDto {
        text: file.text.clone(),
        path: file.path.to_string_lossy().into_owned(),
        settings: read_settings(&state.settings_path),
        meta: Some(file.meta.clone()),
        read_only_reason: file.read_only_reason.clone(),
        missing: file.missing,
        read_error: file.read_error.clone(),
    }
}

fn set_last_hash(state: &AppState, hash: &str) {
    if let Ok(mut guard) = state.last_hash.lock() {
        *guard = hash.to_string();
    }
}

fn ensure_watcher(app: &tauri::AppHandle, state: &AppState, path: &Path) -> Result<(), String> {
    {
        let watched = state.watched_path.lock().map_err(|_| "watcher 锁失效".to_string())?;
        let has_watcher = state.watcher.lock().map_err(|_| "watcher 锁失效".to_string())?.is_some();
        if has_watcher && watched.as_deref() == Some(path) {
            return Ok(());
        }
    }

    let parent = path.parent().ok_or("文件没有父目录")?.to_path_buf();
    let watched_path = path.to_path_buf();
    let last_hash = state.last_hash.clone();
    let app_handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let Ok(event) = result else { return };
        if !event.paths.iter().any(|candidate| candidate == &watched_path) {
            return;
        }
        let next_hash = fs::read(&watched_path)
            .ok()
            .map(|bytes| sotto_core::bytes::text_hash(&bytes));
        let Ok(mut known) = last_hash.lock() else { return };
        let changed = next_hash.as_deref() != Some(known.as_str());
        if let Some(hash) = next_hash {
            *known = hash;
        }
        drop(known);
        if changed {
            let _ = app_handle.emit("file-changed", ());
        }
    })
    .map_err(|err| format!("创建文件监听失败: {err}"))?;
    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|err| format!("监听目录失败: {err}"))?;
    *state.watcher.lock().map_err(|_| "watcher 锁失效".to_string())? = Some(watcher);
    *state.watched_path.lock().map_err(|_| "watcher 锁失效".to_string())? = Some(path.to_path_buf());
    Ok(())
}

#[tauri::command]
fn get_snapshot(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SnapshotDto, String> {
    let file = ensure_current(&state)?;
    set_last_hash(&state, &file.meta.hash);
    ensure_watcher(&app, &state, &file.path)?;
    Ok(snapshot(&state, &file))
}

#[tauri::command]
fn open_markdown_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<SnapshotDto, String> {
    let path = PathBuf::from(path);
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
    if !extension.eq_ignore_ascii_case("md") && !extension.eq_ignore_ascii_case("markdown") {
        return Err("只支持 .md/.markdown 文件".into());
    }
    let file = load_file(&path)?;
    *state.current.lock().map_err(|_| "文件状态锁失效".to_string())? = Some(file.clone());
    set_last_hash(&state, &file.meta.hash);
    ensure_watcher(&app, &state, &file.path)?;
    let _ = app.emit("file-changed", ());
    Ok(snapshot(&state, &file))
}

#[tauri::command]
fn save_markdown(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    base_disk_hash: String,
    revision: u64,
    content: String,
) -> Result<SaveResult, String> {
    let _ = revision;
    let file = ensure_current(&state)?;
    // 文件被外部移动/删除时不要用空基线静默重建；让用户重新选择或另存。
    if file.missing || !file.path.exists() {
        return Ok(SaveResult {
            status: "error",
            disk_hash: Some(file.meta.hash.clone()),
            meta: Some(file.meta),
            message: Some("文件不存在，请重新选择文件；当前草稿仍在编辑器中".into()),
        });
    }
    if file.read_only_reason.is_some() {
        return Ok(SaveResult {
            status: "error",
            disk_hash: Some(file.meta.hash.clone()),
            meta: Some(file.meta),
            message: file.read_only_reason,
        });
    }
    let exists = file.path.exists();
    let disk_bytes = if exists {
        fs::read(&file.path).map_err(|err| format!("读取磁盘文件失败: {err}"))?
    } else {
        Vec::new()
    };
    let disk_hash = sotto_core::bytes::text_hash(&disk_bytes);
    if disk_hash != base_disk_hash {
        return Ok(SaveResult {
            status: "conflict",
            disk_hash: Some(disk_hash),
            meta: None,
            message: Some("磁盘文件已变化，未覆盖".into()),
        });
    }
    if content.len() > 1_048_576 || content.lines().count() > 5000 {
        return Ok(SaveResult {
            status: "error",
            disk_hash: Some(disk_hash),
            meta: None,
            message: Some("文件超过 1MB 或 5000 行，保存已拒绝".into()),
        });
    }
    let encoded = if exists {
        sotto_core::bytes::encode_existing(&content, &file.meta)?
    } else {
        sotto_core::bytes::encode_new(&content)
    };
    if exists {
        if let Err(err) = sotto_core::backup::create_backup(
            &state.backups_dir,
            &file.path,
            &disk_bytes,
            &file.meta,
            sotto_core::backup::BackupReason::BeforeWrite,
            now_ms(),
        ) {
            eprintln!("sotto backup failed: {err}");
        }
    }
    sotto_core::atomic::write_atomic(&file.path, &encoded)?;
    let decoded = sotto_core::bytes::decode(&encoded)?;
    let next = OpenFile {
        path: file.path.clone(),
        text: content,
        meta: decoded.meta.clone(),
        read_only_reason: None,
        missing: false,
        read_error: None,
    };
    *state.current.lock().map_err(|_| "文件状态锁失效".to_string())? = Some(next);
    set_last_hash(&state, &decoded.meta.hash);
    let _ = ensure_watcher(&app, &state, &file.path);
    let _ = app.emit("file-changed", ());
    Ok(SaveResult {
        status: "ok",
        disk_hash: Some(decoded.meta.hash.clone()),
        meta: Some(decoded.meta),
        message: None,
    })
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> serde_json::Value {
    read_settings(&state.settings_path)
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    mut settings: serde_json::Value,
) -> Result<(), String> {
    // 编辑窗口 bounds 由 Rust 跟踪；前端拿到的快照可能晚一拍，不能让旧值覆盖新值。
    if let serde_json::Value::Object(ref mut map) = settings {
        let disk = read_settings(&state.settings_path);
        // windowPosition 由 Rust 在移动后写入；前端快照可能晚一拍，不能覆盖它。
        if let Some(existing) = disk.get("windowPosition") {
            if !existing.is_null() {
                map.insert("windowPosition".into(), existing.clone());
            }
        }
        let missing = map.get("editorWindow").map_or(true, |value| value.is_null());
        if missing {
            if let Some(existing) = disk.get("editorWindow") {
                if !existing.is_null() {
                    map.insert("editorWindow".into(), existing.clone());
                }
            }
        }
    }
    let json = serde_json::to_vec_pretty(&settings).map_err(|err| err.to_string())?;
    sotto_core::atomic::write_atomic(&state.settings_path, &json)?;
    let _ = app.emit("file-changed", ());
    Ok(())
}

#[tauri::command]
fn sync_draft(
    state: tauri::State<'_, AppState>,
    text: String,
    base_disk_hash: String,
) -> Result<(), String> {
    let file = state
        .current
        .lock()
        .map_err(|_| "文件状态锁失效".to_string())?
        .clone()
        .ok_or_else(|| "没有打开的文件".to_string())?;
    *state.draft.lock().map_err(|_| "草稿锁失效".to_string())? = Some(DraftState {
        path: file.path,
        text,
        base_hash: base_disk_hash,
        meta: file.meta,
        missing: file.missing,
    });
    Ok(())
}

#[tauri::command]
fn clear_draft(state: tauri::State<'_, AppState>) -> Result<(), String> {
    *state.draft.lock().map_err(|_| "草稿锁失效".to_string())? = None;
    Ok(())
}

#[tauri::command]
fn backup_current(
    state: tauri::State<'_, AppState>,
    reason: sotto_core::backup::BackupReason,
) -> Result<bool, String> {
    let file = ensure_current(&state)?;
    let bytes = fs::read(&file.path).map_err(|err| format!("读取备份源失败: {err}"))?;
    let meta = sotto_core::bytes::decode(&bytes)?.meta;
    let created = sotto_core::backup::create_backup(
        &state.backups_dir,
        &file.path,
        &bytes,
        &meta,
        reason,
        now_ms(),
    )?;
    Ok(created.is_some())
}

#[tauri::command]
fn pick_markdown_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<SnapshotDto>, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("Markdown", &["md", "markdown"])
        .pick_file()
    else {
        return Ok(None);
    };
    let file = load_file(&path)?;
    *state.current.lock().map_err(|_| "文件状态锁失效".to_string())? = Some(file.clone());
    set_last_hash(&state, &file.meta.hash);
    ensure_watcher(&app, &state, &file.path)?;
    let _ = app.emit("file-changed", ());
    Ok(Some(snapshot(&state, &file)))
}

/// 保存对话框选中的路径补齐 Markdown 扩展名。
fn with_markdown_extension(mut path: PathBuf) -> PathBuf {
    let has_markdown_ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false);
    if !has_markdown_ext {
        path.set_extension("md");
    }
    path
}

/// 新建/另存为共用的“选路径并写入”流程；返回 None 表示用户取消。
fn write_markdown_to_chosen_path(
    app: &tauri::AppHandle,
    state: &AppState,
    suggested_name: &str,
    content: &str,
) -> Result<Option<SnapshotDto>, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name(suggested_name)
        .save_file()
    else {
        return Ok(None);
    };
    let path = with_markdown_extension(path);
    let existing = fs::read(&path).ok();
    let encoded = match existing.as_deref() {
        Some(bytes) => match sotto_core::bytes::decode(bytes) {
            Ok(decoded) => {
                if let Err(err) = sotto_core::backup::create_backup(
                    &state.backups_dir,
                    &path,
                    bytes,
                    &decoded.meta,
                    sotto_core::backup::BackupReason::BeforeWrite,
                    now_ms(),
                ) {
                    eprintln!("sotto backup failed: {err}");
                }
                sotto_core::bytes::encode_existing(content, &decoded.meta)?
            }
            // 目标不是受支持的文本编码时按新文件写入，避免另存失败。
            Err(_) => sotto_core::bytes::encode_new(content),
        },
        None => sotto_core::bytes::encode_new(content),
    };
    sotto_core::atomic::write_atomic(&path, &encoded)?;
    let file = load_file(&path)?;
    *state.current.lock().map_err(|_| "文件状态锁失效".to_string())? = Some(file.clone());
    set_last_hash(state, &file.meta.hash);
    ensure_watcher(app, state, &file.path)?;
    let _ = app.emit("file-changed", ());
    Ok(Some(snapshot(state, &file)))
}

#[tauri::command]
fn new_markdown_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<SnapshotDto>, String> {
    write_markdown_to_chosen_path(&app, &state, "待办.md", "# 今日待办\n\n")
}

#[tauri::command]
fn save_markdown_as(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    content: String,
) -> Result<Option<SnapshotDto>, String> {
    if content.len() > 1_048_576 || content.lines().count() > 5000 {
        return Err("文件超过 1MB 或 5000 行，另存已拒绝".into());
    }
    let suggested = {
        let current = state.current.lock().map_err(|_| "文件状态锁失效".to_string())?;
        current
            .as_ref()
            .and_then(|file| file.path.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or("Sotto.md")
            .to_string()
    };
    write_markdown_to_chosen_path(&app, &state, &suggested, &content)
}

fn read_settings_map(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    match read_settings(path) {
        serde_json::Value::Object(map) => map,
        _ => serde_json::Map::new(),
    }
}

fn write_settings_map(path: &Path, map: serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let value = serde_json::Value::Object(map);
    let json = serde_json::to_vec_pretty(&value).map_err(|err| err.to_string())?;
    sotto_core::atomic::write_atomic(path, &json)
}

fn settings_flag(map: &serde_json::Map<String, serde_json::Value>, key: &str, fallback: bool) -> bool {
    map.get(key).and_then(|value| value.as_bool()).unwrap_or(fallback)
}

fn settings_text<'a>(
    map: &'a serde_json::Map<String, serde_json::Value>,
    key: &str,
    fallback: &'a str,
) -> &'a str {
    map.get(key).and_then(|value| value.as_str()).unwrap_or(fallback)
}

/// 读改写 settings.json，随后广播给组件/编辑窗口并刷新托盘勾选状态。
fn patch_settings<F>(app: &tauri::AppHandle, patch: F)
where
    F: FnOnce(&mut serde_json::Map<String, serde_json::Value>),
{
    let state = app.state::<AppState>();
    let mut map = read_settings_map(&state.settings_path);
    patch(&mut map);
    if let Err(err) = write_settings_map(&state.settings_path, map) {
        eprintln!("sotto settings patch failed: {err}");
        return;
    }
    let _ = app.emit("file-changed", ());
    sync_tray(app);
}

fn sync_tray(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let map = read_settings_map(&state.settings_path);
    let Ok(menu) = build_tray_menu(app, &map) else {
        return;
    };
    if let Ok(guard) = state.tray.lock() {
        if let Some(tray) = guard.as_ref() {
            let _ = tray.set_menu(Some(menu));
        }
    };
}

fn build_tray_menu(
    app: &tauri::AppHandle,
    map: &serde_json::Map<String, serde_json::Value>,
) -> tauri::Result<Menu<tauri::Wry>> {
    let theme = settings_text(map, "theme", "dark");
    let open = MenuItem::with_id(app, "open_editor", "打开编辑", true, None::<&str>)?;
    let toggle = CheckMenuItem::with_id(
        app,
        "toggle_widget",
        "显示组件",
        true,
        settings_flag(map, "widgetVisible", true),
        None::<&str>,
    )?;
    let locked = CheckMenuItem::with_id(
        app,
        "locked",
        "锁定位置",
        true,
        settings_flag(map, "locked", false),
        None::<&str>,
    )?;
    let dark = CheckMenuItem::with_id(app, "theme_dark", "深色", true, theme != "acrylic", None::<&str>)?;
    let acrylic = CheckMenuItem::with_id(
        app,
        "theme_acrylic",
        "亚克力",
        true,
        theme == "acrylic",
        None::<&str>,
    )?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启",
        true,
        settings_text(map, "autostart", "unset") == "enabled",
        None::<&str>,
    )?;
    let exit = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&open, &toggle, &locked, &dark, &acrylic, &autostart, &exit])
}

fn set_widget_visible(app: &tauri::AppHandle, visible: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let result = if visible { window.show() } else { window.hide() };
        if let Err(err) = result {
            eprintln!("sotto widget visibility failed: {err}");
            return;
        }
    }
    patch_settings(app, |map| {
        map.insert("widgetVisible".into(), serde_json::json!(visible));
    });
}

fn toggle_widget_visible(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let map = read_settings_map(&state.settings_path);
    set_widget_visible(app, !settings_flag(&map, "widgetVisible", true));
}

fn toggle_locked(app: &tauri::AppHandle) {
    patch_settings(app, |map| {
        let next = !settings_flag(map, "locked", false);
        map.insert("locked".into(), serde_json::json!(next));
    });
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AutostartStatus {
    registered: bool,
    disabled_by_system: bool,
    command: Option<String>,
}

#[cfg(windows)]
const AUTOSTART_VALUE_NAME: &str = "Sotto";
#[cfg(windows)]
const AUTOSTART_RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(windows)]
const AUTOSTART_APPROVED_KEY: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

#[cfg(windows)]
fn autostart_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|err| format!("无法定位程序路径: {err}"))?;
    Ok(format!("\"{}\" --autostart", exe.display()))
}

#[cfg(windows)]
fn autostart_status() -> AutostartStatus {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let command = hkcu
        .open_subkey_with_flags(AUTOSTART_RUN_KEY, KEY_READ)
        .ok()
        .and_then(|key| key.get_value::<String, _>(AUTOSTART_VALUE_NAME).ok());
    let disabled_by_system = hkcu
        .open_subkey_with_flags(AUTOSTART_APPROVED_KEY, KEY_READ)
        .and_then(|key| key.get_raw_value(AUTOSTART_VALUE_NAME))
        .map(|raw| {
            raw.bytes
                .first()
                .map(|byte| *byte == 0x03 || *byte == 0x07)
                .unwrap_or(false)
        })
        .unwrap_or(false);
    AutostartStatus {
        registered: command.is_some(),
        disabled_by_system,
        command,
    }
}

#[cfg(not(windows))]
fn autostart_status() -> AutostartStatus {
    AutostartStatus {
        registered: false,
        disabled_by_system: false,
        command: None,
    }
}

fn set_autostart(enabled: bool) -> Result<AutostartStatus, String> {
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let run = hkcu
            .open_subkey_with_flags(AUTOSTART_RUN_KEY, KEY_READ | KEY_WRITE)
            .map_err(|err| format!("打开自启注册表失败: {err}"))?;
        if enabled {
            let command = autostart_command()?;
            run.set_value(AUTOSTART_VALUE_NAME, &command)
                .map_err(|err| format!("写入自启注册表失败: {err}"))?;
        } else {
            match run.delete_value(AUTOSTART_VALUE_NAME) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(format!("删除自启注册表失败: {err}")),
            }
        }
    }
    #[cfg(not(windows))]
    let _ = enabled;
    Ok(autostart_status())
}

fn reconcile_autostart(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let map = read_settings_map(&state.settings_path);
    if settings_text(&map, "autostart", "unset") != "enabled" {
        return;
    }
    if let Err(err) = set_autostart(true) {
        eprintln!("sotto autostart reconcile failed: {err}");
    }
}

fn flush_session_draft(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let draft = state
        .draft
        .lock()
        .map_err(|_| "草稿锁失效".to_string())?
        .take();
    let Some(draft) = draft else {
        return Ok(());
    };
    if draft.missing || !draft.path.exists() {
        return Err("文件不存在，会话结束草稿未写入原路径".into());
    }
    let disk_bytes = fs::read(&draft.path).map_err(|err| format!("会话结束读取磁盘失败: {err}"))?;
    let disk_hash = sotto_core::bytes::text_hash(&disk_bytes);
    if disk_hash != draft.base_hash {
        return Err("会话结束发现磁盘冲突，草稿未覆盖".into());
    }
    let encoded = sotto_core::bytes::encode_existing(&draft.text, &draft.meta)?;
    if let Err(err) = sotto_core::backup::create_backup(
        &state.backups_dir,
        &draft.path,
        &disk_bytes,
        &draft.meta,
        sotto_core::backup::BackupReason::EditorClose,
        now_ms(),
    ) {
        eprintln!("sotto session backup failed: {err}");
    }
    sotto_core::atomic::write_atomic(&draft.path, &encoded)?;
    let decoded = sotto_core::bytes::decode(&encoded)?;
    let next = OpenFile {
        path: draft.path.clone(),
        text: draft.text,
        meta: decoded.meta.clone(),
        read_only_reason: None,
        missing: false,
        read_error: None,
    };
    *state.current.lock().map_err(|_| "文件状态锁失效".to_string())? = Some(next);
    set_last_hash(&state, &decoded.meta.hash);
    Ok(())
}

#[cfg(windows)]
static SESSION_APP: OnceLock<tauri::AppHandle> = OnceLock::new();
#[cfg(windows)]
static SESSION_ORIGINAL_WNDPROC: OnceLock<isize> = OnceLock::new();

#[cfg(windows)]
unsafe extern "system" fn session_wndproc(
    hwnd: isize,
    msg: u32,
    wparam: usize,
    lparam: isize,
) -> isize {
    const WM_QUERYENDSESSION: u32 = 0x0011;
    if msg == WM_QUERYENDSESSION {
        if let Some(app) = SESSION_APP.get() {
            if let Err(err) = flush_session_draft(app) {
                eprintln!("sotto WM_QUERYENDSESSION flush failed: {err}");
            }
        }
    }
    let original = SESSION_ORIGINAL_WNDPROC.get().copied().unwrap_or(0);
    if original == 0 {
        return 0;
    }
    unsafe extern "system" {
        fn CallWindowProcW(
            previous: isize,
            hwnd: isize,
            msg: u32,
            wparam: usize,
            lparam: isize,
        ) -> isize;
    }
    CallWindowProcW(original, hwnd, msg, wparam, lparam)
}

#[cfg(windows)]
fn install_session_hook(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    const GWLP_WNDPROC: i32 = -4;
    unsafe extern "system" {
        fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
    }
    let hwnd = window.hwnd().map_err(|err| err.to_string())?.0 as isize;
    let _ = SESSION_APP.set(app.clone());
    let previous = unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWLP_WNDPROC,
            session_wndproc as unsafe extern "system" fn(isize, u32, usize, isize) -> isize as isize,
        )
    };
    if previous == 0 {
        return Err("安装 WM_QUERYENDSESSION 窗口过程失败".into());
    }
    let _ = SESSION_ORIGINAL_WNDPROC.set(previous);
    Ok(())
}

#[cfg(not(windows))]
fn install_session_hook(
    _app: &tauri::AppHandle,
    _window: &tauri::WebviewWindow,
) -> Result<(), String> {
    Ok(())
}

fn clamp_widget_position(
    area_pos: (i32, i32),
    area_size: (u32, u32),
    window_size: (u32, u32),
    position: (i32, i32),
    margin: i32,
) -> (i32, i32) {
    let max_x = area_pos.0 + area_size.0 as i32 - window_size.0 as i32 - margin;
    let max_y = area_pos.1 + area_size.1 as i32 - window_size.1 as i32 - margin;
    (
        position.0.clamp(area_pos.0 + margin, max_x.max(area_pos.0 + margin)),
        position.1.clamp(area_pos.1 + margin, max_y.max(area_pos.1 + margin)),
    )
}

fn written_widget_position(
    state: &AppState,
    position: WidgetPosition,
    monitor_name: Option<String>,
) -> Result<(), String> {
    let mut map = read_settings_map(&state.settings_path);
    let mut value = serde_json::Map::new();
    value.insert("x".into(), serde_json::json!(position.x));
    value.insert("y".into(), serde_json::json!(position.y));
    if let Some(name) = monitor_name {
        value.insert("monitorDevicePath".into(), serde_json::json!(name));
    }
    map.insert("windowPosition".into(), serde_json::Value::Object(value));
    write_settings_map(&state.settings_path, map)
}

fn widget_position_now(app: &tauri::AppHandle) -> Option<WidgetPosition> {
    app.get_webview_window("main")
        .and_then(|window| window.outer_position().ok())
        .map(|position| WidgetPosition {
            x: position.x,
            y: position.y,
        })
}

/// 移动/缩放后 900ms 落盘，避免拖动期间每个事件都写 settings.json。
fn queue_widget_position(app: &tauri::AppHandle) {
    let Some(position) = widget_position_now(app) else {
        return;
    };
    let state = app.state::<AppState>();
    if let Ok(mut guard) = state.widget_position.lock() {
        if *guard == Some(position) {
            return;
        }
        *guard = Some(position);
    }
    state.widget_position_gen.fetch_add(1, Ordering::SeqCst);
    if state.widget_position_flushing.swap(true, Ordering::SeqCst) {
        return;
    }
    let app_handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(450));
        let state = app_handle.state::<AppState>();
        let seen = state.widget_position_gen.load(Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(450));
        if state.widget_position_gen.load(Ordering::SeqCst) != seen {
            continue;
        }
        let position = state.widget_position.lock().ok().and_then(|guard| *guard);
        if let Some(position) = position {
            let monitor_name = app_handle
                .get_webview_window("main")
                .and_then(|window| window.current_monitor().ok().flatten())
                .and_then(|monitor| monitor.name().cloned());
            if let Err(err) = written_widget_position(&state, position, monitor_name) {
                eprintln!("sotto widget position save failed: {err}");
            }
        }
        state.widget_position_flushing.store(false, Ordering::SeqCst);
        break;
    });
}

fn flush_widget_position(app: &tauri::AppHandle) {
    let Some(position) = widget_position_now(app) else {
        return;
    };
    let state = app.state::<AppState>();
    let monitor_name = app
        .get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten())
        .and_then(|monitor| monitor.name().cloned());
    if let Err(err) = written_widget_position(&state, position, monitor_name) {
        eprintln!("sotto widget position flush failed: {err}");
    }
}

fn restore_widget_position(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    let map = read_settings_map(&state.settings_path);
    let Some(value) = map.get("windowPosition").and_then(|value| value.as_object()) else {
        return Ok(());
    };
    let Some(x) = value.get("x").and_then(|value| value.as_i64()) else {
        return Ok(());
    };
    let Some(y) = value.get("y").and_then(|value| value.as_i64()) else {
        return Ok(());
    };
    let preferred = value
        .get("monitorDevicePath")
        .and_then(|value| value.as_str());
    let wanted = (x as i32, y as i32);
    let monitors = window.available_monitors()?;
    let monitor = preferred
        .and_then(|name| monitors.iter().find(|monitor| monitor.name().map(String::as_str) == Some(name)))
        .or_else(|| {
            monitors.iter().find(|monitor| {
                let area = monitor.work_area();
                wanted.0 >= area.position.x
                    && wanted.0 < area.position.x + area.size.width as i32
                    && wanted.1 >= area.position.y
                    && wanted.1 < area.position.y + area.size.height as i32
            })
        })
        .or_else(|| monitors.iter().find(|monitor| monitor.name().is_none()))
        .or_else(|| monitors.first());
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let area = monitor.work_area();
    let size = window.outer_size()?;
    let margin = (12.0 * window.scale_factor()?).round() as i32;
    let (x, y) = clamp_widget_position(
        (area.position.x, area.position.y),
        (area.size.width, area.size.height),
        (size.width, size.height),
        wanted,
        margin,
    );
    window.set_position(PhysicalPosition::new(x, y))?;
    Ok(())
}

/// 把组件窗口夹回当前显示器工作区，留 12 逻辑像素边距。
fn clamp_widget_to_work_area(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    let area = monitor.work_area();
    let margin = (12.0 * window.scale_factor()?).round() as u32;
    let max_width = area.size.width.saturating_sub(margin);
    let max_height = area.size.height.saturating_sub(margin);
    let outer = window.outer_size()?;
    let width = outer.width.min(max_width);
    let height = outer.height.min(max_height);
    if width != outer.width || height != outer.height {
        window.set_size(PhysicalSize::new(width, height))?;
    }
    let pos = window.outer_position()?;
    let max_x = area.position.x + area.size.width as i32 - width as i32;
    let max_y = area.position.y + area.size.height as i32 - height as i32;
    let x = pos.x.clamp(area.position.x, max_x.max(area.position.x));
    let y = pos.y.clamp(area.position.y, max_y.max(area.position.y));
    if x != pos.x || y != pos.y {
        window.set_position(PhysicalPosition::new(x, y))?;
    }
    Ok(())
}

/// 按内容尺寸调整组件窗口：
/// - 高度最多占工作区 60%；
/// - 保持右边缘不动，宽度变化向左扩展；
/// - 底部超出工作区时向上移动。
#[tauri::command]
fn resize_widget(window: tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    resized_widget_bounds(&window, width, height)
        .map(|_| ())
        .map_err(|err| err.to_string())
}

fn resized_widget_bounds(
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> tauri::Result<Option<(PhysicalSize<u32>, PhysicalPosition<i32>)>> {
    let Some(computed) = compute_widget_bounds(
        window,
        width,
        height,
    )? else {
        return Ok(None);
    };
    let (desired, pos) = computed;
    let old_size = window.outer_size()?;
    let old_pos = window.outer_position()?;
    if old_size != desired {
        window.set_size(desired)?;
    }
    if old_pos != pos {
        window.set_position(pos)?;
    }
    Ok(Some((desired, pos)))
}

/// 纯计算部分：输入物理工作区/旧位置/旧尺寸，输出目标尺寸与位置。
fn compute_widget_bounds(
    window: &tauri::WebviewWindow,
    width: f64,
    height: f64,
) -> tauri::Result<Option<(PhysicalSize<u32>, PhysicalPosition<i32>)>> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Ok(None);
    }
    let scale = window.scale_factor()?;
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(None);
    };
    let area = monitor.work_area();
    let old_pos = window.outer_position()?;
    let old_size = window.outer_size()?;
    Ok(Some(calculate_widget_bounds(
        (area.position.x, area.position.y),
        (area.size.width, area.size.height),
        (old_pos.x, old_pos.y),
        (old_size.width, old_size.height),
        width,
        height,
        scale,
    )))
}

#[allow(clippy::too_many_arguments)]
fn calculate_widget_bounds(
    area_pos: (i32, i32),
    area_size: (u32, u32),
    old_pos: (i32, i32),
    old_size: (u32, u32),
    width_logical: f64,
    height_logical: f64,
    scale: f64,
) -> (PhysicalSize<u32>, PhysicalPosition<i32>) {
    let margin = (12.0 * scale).round() as i32;
    let max_width = area_size.0.saturating_sub((margin * 2) as u32).max(1);
    let max_height = ((area_size.1 as f64) * 0.6).floor().max(1.0) as u32;
    let desired = PhysicalSize::new(
        ((width_logical * scale).round() as u32).clamp(1, max_width),
        ((height_logical * scale).round() as u32).clamp(1, max_height),
    );
    let right = old_pos.0 + old_size.0 as i32;
    let mut x = right - desired.width as i32;
    let mut y = old_pos.1;
    let area_right = area_pos.0 + area_size.0 as i32;
    let area_bottom = area_pos.1 + area_size.1 as i32;
    if y + desired.height as i32 > area_bottom {
        y = area_bottom - desired.height as i32;
    }
    let min_x = area_pos.0 + margin;
    let max_x = area_right - margin - desired.width as i32;
    let min_y = area_pos.1 + margin;
    let max_y = area_bottom - margin - desired.height as i32;
    x = x.clamp(min_x, max_x.max(min_x));
    y = y.clamp(min_y, max_y.max(min_y));
    (desired, PhysicalPosition::new(x, y))
}

#[cfg(test)]
mod geometry_tests {
    use super::*;

    #[test]
    fn caps_height_to_sixty_percent_of_work_area() {
        let (size, pos) = calculate_widget_bounds(
            (0, 0),
            (1920, 1040),
            (1000, 100),
            (384, 520),
            384.0,
            670.0,
            1.0,
        );
        assert_eq!(size.height, 624);
        assert_eq!(pos.x + size.width as i32, 1000 + 384);
    }

    #[test]
    fn clamps_restored_widget_position() {
        let (x, y) = clamp_widget_position((0, 0), (1920, 1040), (384, 220), (5000, -50), 12);
        assert_eq!(x, 1920 - 384 - 12);
        assert_eq!(y, 12);
    }

    #[test]
    fn expands_upward_when_bottom_would_overflow() {
        let (size, pos) = calculate_widget_bounds(
            (0, 0),
            (1920, 1040),
            (1000, 700),
            (384, 300),
            384.0,
            500.0,
            1.0,
        );
        assert_eq!(size.height, 500);
        assert_eq!(pos.y + size.height as i32, 1028);
    }

    #[test]
    fn scales_logical_size_and_respects_width_cap() {
        let (size, _) = calculate_widget_bounds(
            (0, 0),
            (1000, 700),
            (10, 10),
            (400, 400),
            900.0,
            200.0,
            2.0,
        );
        assert_eq!(size.width, 952);
        assert_eq!(size.height, 400);
    }
}

/// 打开应用数据目录（备份所在目录的父级）。
#[tauri::command]
fn open_data_dir(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let dir = state
        .backups_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| state.backups_dir.clone());
    fs::create_dir_all(&dir).map_err(|err| format!("创建数据目录失败: {err}"))?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|err| format!("打开数据目录失败: {err}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &dir;
    }
    Ok(())
}

/// 把组件移动到主屏工作区右下角，留 24 逻辑像素边距。
#[tauri::command]
fn reset_widget_position(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    reset_widget_position_impl(&window).map_err(|err| err.to_string())?;
    queue_widget_position(&app);
    Ok(())
}

fn reset_widget_position_impl(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.primary_monitor()?.or(window.current_monitor()?) else {
        return Ok(());
    };
    let area = monitor.work_area();
    let scale = window.scale_factor()?;
    let margin = (24.0 * scale).round() as i32;
    let size = window.outer_size()?;
    let x = area.position.x + area.size.width as i32 - size.width as i32 - margin;
    let y = area.position.y + area.size.height as i32 - size.height as i32 - margin;
    window.set_position(PhysicalPosition::new(x.max(area.position.x), y.max(area.position.y)))?;
    Ok(())
}

fn create_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = {
        let state = app.state::<AppState>();
        let map = read_settings_map(&state.settings_path);
        build_tray_menu(app, &map)?
    };
    let mut builder = TrayIconBuilder::with_id("sotto")
        .tooltip("Sotto")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| tray_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_widget_visible(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    let tray = builder.build(app)?;
    {
        let state = app.state::<AppState>();
        if let Ok(mut guard) = state.tray.lock() {
            *guard = Some(tray);
        };
    }
    Ok(())
}

fn tray_menu_event(app: &tauri::AppHandle, id: &str) {
    match id {
        "open_editor" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = open_editor(app).await;
            });
        }
        "toggle_widget" => toggle_widget_visible(app),
        "locked" => toggle_locked(app),
        "theme_dark" => patch_settings(app, |map| {
            map.insert("theme".into(), serde_json::json!("dark"));
        }),
        "theme_acrylic" => patch_settings(app, |map| {
            map.insert("theme".into(), serde_json::json!("acrylic"));
        }),
        "autostart" => {
            let state = app.state::<AppState>();
            let map = read_settings_map(&state.settings_path);
            let next = settings_text(&map, "autostart", "unset") != "enabled";
            match set_autostart(next) {
                Ok(status) => {
                    let value = if status.registered { "enabled" } else { "disabled" };
                    patch_settings(app, |map| {
                        map.insert("autostart".into(), serde_json::json!(value));
                        map.insert("autostartAsked".into(), serde_json::json!(true));
                    });
                    if status.disabled_by_system {
                        eprintln!("sotto autostart is disabled by Windows StartupApproved");
                    }
                }
                Err(err) => eprintln!("sotto autostart toggle failed: {err}"),
            }
        }
        "exit" => request_exit(app),
        _ => {}
    }
}

fn request_exit(app: &tauri::AppHandle) {
    if let Some(editor) = app.get_webview_window("editor") {
        let _ = editor.show();
        let _ = editor.set_focus();
        let _ = app.emit_to("editor", "exit-requested", ());
    } else {
        quit_app(app.clone());
    }
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    flush_editor_bounds(&app);
    flush_widget_position(&app);
    if let Err(err) = flush_session_draft(&app) {
        eprintln!("sotto quit draft flush failed: {err}");
    }
    app.exit(0);
}

#[tauri::command]
fn get_autostart_status() -> AutostartStatus {
    autostart_status()
}

#[tauri::command]
fn apply_autostart(enabled: bool) -> Result<AutostartStatus, String> {
    set_autostart(enabled)
}

fn saved_editor_bounds(state: &AppState) -> Option<(EditorBounds, Option<String>)> {
    let value = read_settings(&state.settings_path);
    let editor = value.get("editorWindow")?;
    if editor.is_null() {
        return None;
    }
    let x = editor.get("x")?.as_i64()? as i32;
    let y = editor.get("y")?.as_i64()? as i32;
    let width = editor.get("width")?.as_u64()? as u32;
    let height = editor.get("height")?.as_u64()? as u32;
    if width < 200 || height < 150 {
        return None;
    }
    Some((
        EditorBounds {
            x,
            y,
            width,
            height,
        },
        editor
            .get("monitorDevicePath")
            .and_then(|item| item.as_str())
            .map(str::to_owned),
    ))
}

/// 把保存的 bounds 夹回当前显示器工作区；显示器被拔掉时回退到主屏。
fn clamp_editor_bounds(
    app: &tauri::AppHandle,
    mut bounds: EditorBounds,
    preferred_monitor: Option<&str>,
) -> Option<EditorBounds> {
    let monitors = app.available_monitors().ok()?;
    if monitors.is_empty() {
        return None;
    }
    let area = |left: i64, top: i64, right: i64, bottom: i64| -> i64 {
        let x = (right - left).max(0);
        let y = (bottom - top).max(0);
        x * y
    };
    let window_rect = |b: &EditorBounds| {
        (
            b.x as i64,
            b.y as i64,
            b.x as i64 + b.width as i64,
            b.y as i64 + b.height as i64,
        )
    };

    let mut best_index = 0usize;
    let mut best_area = i64::MIN;
    for (index, monitor) in monitors.iter().enumerate() {
        let (left, top, right, bottom) = window_rect(&bounds);
        let wa = monitor.work_area();
        let wa_right = wa.position.x as i64 + wa.size.width as i64;
        let wa_bottom = wa.position.y as i64 + wa.size.height as i64;
        // 用交集面积作为主排序；指定显示器优先。
        let mut score = area(
            left.max(wa.position.x as i64),
            top.max(wa.position.y as i64),
            right.min(wa_right),
            bottom.min(wa_bottom),
        );
        let preferred = preferred_monitor
            .map(|name| monitor.name().map(|value| value == name).unwrap_or(false))
            .unwrap_or(false);
        if preferred {
            score += 1_000_000_000_000;
        }
        if score > best_area {
            best_area = score;
            best_index = index;
        }
    }

    let monitor = &monitors[best_index];
    let wa = monitor.work_area();
    let mx = wa.position.x;
    let my = wa.position.y;
    let mw = wa.size.width as i32;
    let mh = wa.size.height as i32;
    if mw <= 0 || mh <= 0 {
        return None;
    }

    bounds.width = bounds.width.min(mw as u32).max(760.min(mw as u32));
    bounds.height = bounds.height.min(mh as u32).max(520.min(mh as u32));

    // 至少保留 120px 可见，避免窗口完全落在屏幕外。
    let min_visible_x = 120i32.min(bounds.width as i32);
    let min_visible_y = 60i32.min(bounds.height as i32);
    bounds.x = bounds.x.clamp(
        mx - bounds.width as i32 + min_visible_x,
        mx + mw - min_visible_x,
    );
    bounds.y = bounds.y.clamp(my, my + mh - min_visible_y);
    Some(bounds)
}

fn write_editor_bounds(
    state: &AppState,
    bounds: EditorBounds,
    monitor_name: Option<String>,
) -> Result<(), String> {
    let mut map = read_settings_map(&state.settings_path);
    let mut editor = serde_json::Map::new();
    editor.insert("x".into(), serde_json::json!(bounds.x));
    editor.insert("y".into(), serde_json::json!(bounds.y));
    editor.insert("width".into(), serde_json::json!(bounds.width));
    editor.insert("height".into(), serde_json::json!(bounds.height));
    if let Some(name) = monitor_name {
        editor.insert("monitorDevicePath".into(), serde_json::json!(name));
    }
    map.insert("editorWindow".into(), serde_json::Value::Object(editor));
    write_settings_map(&state.settings_path, map)
}

fn editor_bounds_now(app: &tauri::AppHandle) -> Option<(EditorBounds, Option<String>)> {
    let window = app.get_webview_window("editor")?;
    if window.is_maximized().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return None;
    }
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    if size.width < 200 || size.height < 150 {
        return None;
    }
    let monitor_name = window
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|monitor| monitor.name().cloned());
    Some((
        EditorBounds {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        monitor_name,
    ))
}

fn flush_editor_bounds(app: &tauri::AppHandle) {
    let Some((bounds, monitor_name)) = editor_bounds_now(app) else {
        return;
    };
    let state = app.state::<AppState>();
    if let Ok(mut guard) = state.editor_bounds.lock() {
        *guard = Some(bounds);
    }
    if let Err(err) = write_editor_bounds(&state, bounds, monitor_name) {
        eprintln!("sotto editor bounds flush failed: {err}");
    }
}

/// 移动/缩放期间只更新内存，停止 900ms 后落盘，避免每个事件都写 settings.json。
fn queue_editor_bounds(app: &tauri::AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    if window.is_maximized().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return;
    }
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    if size.width < 200 || size.height < 150 {
        return;
    }
    let bounds = EditorBounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };

    let state = app.state::<AppState>();
    if let Ok(mut guard) = state.editor_bounds.lock() {
        if *guard == Some(bounds) {
            return;
        }
        *guard = Some(bounds);
    }
    state.editor_bounds_gen.fetch_add(1, Ordering::SeqCst);
    if state.editor_bounds_flushing.swap(true, Ordering::SeqCst) {
        return;
    }

    let app_handle = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(450));
            let state = app_handle.state::<AppState>();
            let seen = state.editor_bounds_gen.load(Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(450));
            if state.editor_bounds_gen.load(Ordering::SeqCst) != seen {
                continue;
            }
            let bounds = state.editor_bounds.lock().ok().and_then(|guard| *guard);
            if let Some(bounds) = bounds {
                let monitor_name = app_handle
                    .get_webview_window(&label)
                    .and_then(|window| window.current_monitor().ok().flatten())
                    .and_then(|monitor| monitor.name().cloned());
                if let Err(err) = write_editor_bounds(&state, bounds, monitor_name) {
                    eprintln!("sotto editor bounds save failed: {err}");
                }
            }
            state.editor_bounds_flushing.store(false, Ordering::SeqCst);
            break;
        }
    });
}

#[tauri::command]
async fn open_editor(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("editor") {
        window.show().map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
        return Ok(());
    }
    let saved = {
        let state = app.state::<AppState>();
        saved_editor_bounds(&state)
    };
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "editor",
        tauri::WebviewUrl::App("editor.html".into()),
    )
    .title("Sotto · 编辑")
    .inner_size(960.0, 640.0)
    .min_inner_size(760.0, 520.0)
    .additional_browser_args(WEBVIEW2_ARGS)
    .visible(false)
    .build()
    .map_err(|err| err.to_string())?;

    if let Some((bounds, preferred)) = saved {
        if let Some(bounds) = clamp_editor_bounds(&app, bounds, preferred.as_deref()) {
            // set_size 作用于内尺寸，editorWindow 也按内尺寸保存。
            window
                .set_size(PhysicalSize::new(bounds.width, bounds.height))
                .map_err(|err| err.to_string())?;
            window
                .set_position(PhysicalPosition::new(bounds.x, bounds.y))
                .map_err(|err| err.to_string())?;
        }
    }

    let label = window.label().to_string();
    let handle = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            queue_editor_bounds(&handle, &label);
        }
        tauri::WindowEvent::CloseRequested { .. } => {
            flush_editor_bounds(&handle);
        }
        _ => {}
    });

    window.show().map_err(|err| err.to_string())?;
    window.set_focus().map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例插件必须尽早注册；重复启动时唤出编辑窗口。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("editor") {
                let _ = window.show();
                let _ = window.set_focus();
            } else {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = open_editor(app).await;
                });
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    use tauri_plugin_global_shortcut::{Code, Modifiers};
                    if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyE) {
                        if let Some(window) = app.get_webview_window("editor") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        } else {
                            let app = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = open_editor(app).await;
                            });
                        }
                    } else {
                        toggle_locked(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            set_acrylic,
            set_desktop_layer,
            resize_widget,
            reset_widget_position,
            open_data_dir,
            get_snapshot,
            open_markdown_file,
            save_markdown,
            get_settings,
            save_settings,
            backup_current,
            sync_draft,
            clear_draft,
            pick_markdown_file,
            new_markdown_file,
            save_markdown_as,
            open_editor,
            quit_app,
            get_autostart_status,
            apply_autostart,
        ])
        .setup(|app| {
            let state = AppState::new(app.handle())
                .map_err(|err| Box::<dyn std::error::Error>::from(err))?;
            app.manage(state);
            create_tray(app.handle())?;
            reconcile_autostart(app.handle());
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                // 快捷键被其他程序占用时不应该阻止应用启动。
                for shortcut in ["ctrl+alt+l", "ctrl+alt+e"] {
                    if let Err(err) = app.global_shortcut().register(shortcut) {
                        eprintln!("sotto shortcut register failed ({shortcut}): {err}");
                    }
                }
            }
            let autostart_launch = std::env::args().any(|arg| arg == "--autostart");
            if autostart_launch {
                // 登录自启永不弹首启询问：在组件加载前先标记已询问。
                let state = app.state::<AppState>();
                let mut map = read_settings_map(&state.settings_path);
                if map.get("autostartAsked").and_then(|v| v.as_bool()) != Some(true) {
                    map.insert("autostartAsked".into(), serde_json::json!(true));
                    if let Err(err) = write_settings_map(&state.settings_path, map) {
                        eprintln!("sotto autostart launch flag failed: {err}");
                    }
                }
            }
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Sotto")
            .inner_size(384.0, 520.0)
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .additional_browser_args(WEBVIEW2_ARGS)
            .visible(false)
            .build()?;

            // 去掉系统边框，并去掉 tao 为无边框阴影预留的 13px 外扩区域；
            // 深色主题下卡片外不应出现任何可见矩形。
            clear_native_border(&window);
            install_session_hook(app.handle(), &window)
                .map_err(|err| Box::<dyn std::error::Error>::from(err))?;

            // 200% DPI、小屏或任务栏占位时，520 逻辑像素可能超出工作区；
            // 亚克力铺满窗口后必须保证整个面板可见。
            restore_widget_position(app.handle(), &window)?;
            let _ = clamp_widget_to_work_area(&window);
            let position_handle = app.handle().clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    queue_widget_position(&position_handle);
                }
                tauri::WindowEvent::CloseRequested { .. } => {
                    flush_widget_position(&position_handle);
                }
                _ => {}
            });

            // 亚克力由前端按设置主题调用 set_acrylic 开关，避免深色主题下出现半透明闪烁。
            let widget_visible = {
                let state = app.state::<AppState>();
                let map = read_settings_map(&state.settings_path);
                settings_flag(&map, "widgetVisible", true)
            };
            if widget_visible {
                if autostart_launch {
                    // 登录自启延迟 2 秒显示，避免和桌面初始化抢焦点；手动启动立即显示。
                    let window = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        let _ = window.show();
                    });
                } else {
                    window.show()?;
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Sotto");
}
