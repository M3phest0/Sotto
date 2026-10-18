use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

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
}

struct AppState {
    current: Mutex<Option<OpenFile>>,
    settings_path: PathBuf,
    backups_dir: PathBuf,
    default_file: PathBuf,
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched_path: Mutex<Option<PathBuf>>,
    last_hash: Arc<Mutex<String>>,
    /// 编辑窗口最近一次可见的物理 bounds，用于移动/缩放后的防抖落盘。
    editor_bounds: Mutex<Option<EditorBounds>>,
    editor_bounds_gen: Arc<AtomicU64>,
    editor_bounds_flushing: Arc<AtomicBool>,
    tray: Mutex<Option<tauri::tray::TrayIcon>>,
}

impl AppState {
    fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let config_dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
        let local_dir = app.path().app_local_data_dir().map_err(|err| err.to_string())?;
        let documents = app.path().document_dir().map_err(|err| err.to_string())?;
        fs::create_dir_all(&config_dir).map_err(|err| err.to_string())?;
        fs::create_dir_all(&local_dir).map_err(|err| err.to_string())?;
        Ok(Self {
            current: Mutex::new(None),
            settings_path: config_dir.join("settings.json"),
            backups_dir: local_dir.join("backups"),
            default_file: documents.join("Sotto.md"),
            watcher: Mutex::new(None),
            watched_path: Mutex::new(None),
            last_hash: Arc::new(Mutex::new(String::new())),
            editor_bounds: Mutex::new(None),
            editor_bounds_gen: Arc::new(AtomicU64::new(0)),
            editor_bounds_flushing: Arc::new(AtomicBool::new(false)),
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
    let decoded = sotto_core::bytes::decode(&bytes)?;
    Ok(OpenFile {
        path: path.to_path_buf(),
        text: decoded.text,
        meta: decoded.meta,
        read_only_reason: decoded.read_only_reason,
    })
}

fn empty_file(path: PathBuf) -> Result<OpenFile, String> {
    let decoded = sotto_core::bytes::decode(&[])?;
    Ok(OpenFile {
        path,
        text: decoded.text,
        meta: decoded.meta,
        read_only_reason: decoded.read_only_reason,
    })
}

fn ensure_current(state: &AppState) -> Result<OpenFile, String> {
    let mut guard = state.current.lock().map_err(|_| "文件状态锁失效".to_string())?;
    if let Some(file) = guard.as_ref() {
        return Ok(file.clone());
    }
    let path = state.default_file.clone();
    let file = if path.exists() {
        load_file(&path)?
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
        let missing = map.get("editorWindow").map_or(true, |value| value.is_null());
        if missing {
            let disk = read_settings(&state.settings_path);
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
    .inner_size(980.0, 680.0)
    .min_inner_size(720.0, 480.0)
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
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_locked(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            set_acrylic,
            set_desktop_layer,
            get_snapshot,
            open_markdown_file,
            save_markdown,
            get_settings,
            save_settings,
            backup_current,
            pick_markdown_file,
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
                if let Err(err) = app.global_shortcut().register("ctrl+alt+l") {
                    eprintln!("sotto shortcut register failed: {err}");
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
            .resizable(false)
            .skip_taskbar(true)
            .visible(false)
            .build()?;

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
