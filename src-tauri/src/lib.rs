use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

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
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| serde_json::json!({}))
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

#[tauri::command]
fn get_snapshot(state: tauri::State<'_, AppState>) -> Result<SnapshotDto, String> {
    let file = ensure_current(&state)?;
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
    settings: serde_json::Value,
) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(&settings).map_err(|err| err.to_string())?;
    sotto_core::atomic::write_atomic(&state.settings_path, &json)?;
    let _ = app.emit("file-changed", ());
    Ok(())
}

#[tauri::command]
fn open_editor(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("editor") {
        window.show().map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
        return Ok(());
    }
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "editor",
        tauri::WebviewUrl::App("editor.html".into()),
    )
    .title("Sotto · 编辑")
    .inner_size(980.0, 680.0)
    .min_inner_size(720.0, 480.0)
    .build()
    .map_err(|err| err.to_string())?;
    window.set_focus().map_err(|err| err.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            set_acrylic,
            set_desktop_layer,
            get_snapshot,
            open_markdown_file,
            save_markdown,
            get_settings,
            save_settings,
            open_editor,
        ])
        .setup(|app| {
            let state = AppState::new(app.handle())
                .map_err(|err| Box::<dyn std::error::Error>::from(err))?;
            app.manage(state);
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
            window.show()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Sotto");
}
