use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, LogicalSize, PhysicalPosition, PhysicalSize};

/// WebView2 常驻 GPU/网络等子进程；组件只渲染本地页面，压低内存占用。
const WEBVIEW2_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
--disable-background-networking --disable-component-update --disable-sync \
--disable-extensions --no-first-run --no-default-browser-check";

static ID_SEQ: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_id() -> String {
    format!("{}-{}", now_ms(), ID_SEQ.fetch_add(1, Ordering::Relaxed))
}

// ---------------------------------------------------------------- data model

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub bg: String,
    pub text: String,
    pub accent: String,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            bg: "#FFF9F2".into(),
            text: "#2A2622".into(),
            accent: "#E8563F".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: Theme,
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub sound_path: Option<String>,
    pub hotkey: String,
    pub autostart: bool,
    pub widget_width: f64,
    pub widget_height: f64,
    pub widget_x: Option<i32>,
    pub widget_y: Option<i32>,
    pub editor_x: Option<i32>,
    pub editor_y: Option<i32>,
    pub editor_width: Option<u32>,
    pub editor_height: Option<u32>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::default(),
            sound_enabled: true,
            sound_volume: 0.7,
            sound_path: None,
            hotkey: "ctrl+alt+e".into(),
            autostart: true,
            widget_width: 360.0,
            widget_height: 520.0,
            widget_x: None,
            widget_y: None,
            editor_x: None,
            editor_y: None,
            editor_width: None,
            editor_height: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub ddl: Option<String>,
    pub detail: String,
    pub order: f64,
    pub created_at: u64,
    pub completed_at: Option<u64>,
}

impl Default for Task {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            ddl: None,
            detail: String::new(),
            order: 0.0,
            created_at: 0,
            completed_at: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Tomato {
    pub id: String,
    pub task_id: String,
    pub ts: u64,
}

impl Default for Tomato {
    fn default() -> Self {
        Self {
            id: String::new(),
            task_id: String::new(),
            ts: 0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Data {
    pub version: u32,
    pub tasks: Vec<Task>,
    pub tomatoes: Vec<Tomato>,
    pub settings: Settings,
}

impl Default for Data {
    fn default() -> Self {
        Self {
            version: 1,
            tasks: Vec::new(),
            tomatoes: Vec::new(),
            settings: Settings::default(),
        }
    }
}

struct AppState {
    data: Mutex<Data>,
    dir: PathBuf,
    data_path: PathBuf,
}

impl AppState {
    fn new() -> Self {
        let dir = std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("Sotto");
        let _ = fs::create_dir_all(&dir);
        let data_path = dir.join("data.json");
        let data = fs::read_to_string(&data_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Data>(&text).ok())
            .unwrap_or_default();
        Self {
            data: Mutex::new(data),
            dir,
            data_path,
        }
    }

    fn snapshot(&self) -> Data {
        self.data.lock().map(|d| d.clone()).unwrap_or_default()
    }

    /// 调用方必须已经持有数据锁；这里不再加锁，避免 std::sync::Mutex 重入死锁。
    fn save_data(&self, data: &Data) -> Result<(), String> {
        let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        let tmp = self.data_path.with_extension("json.tmp");
        fs::write(&tmp, text).map_err(|e| format!("写入失败: {e}"))?;
        fs::rename(&tmp, &self.data_path).map_err(|e| format!("保存失败: {e}"))?;
        self.backup_daily(data);
        Ok(())
    }

    /// 每天首次保存时留一份快照，保留最近 7 天。
    fn backup_daily(&self, data: &Data) {
        let day = {
            let secs = now_ms() / 1000;
            let days = secs / 86_400;
            // 1970-01-01 起的天数换算成日期字符串代价较高；用简单序号文件名即可。
            format!("day-{days}")
        };
        let backup_dir = self.dir.join("backups");
        if fs::create_dir_all(&backup_dir).is_err() {
            return;
        }
        let file = backup_dir.join(format!("{day}.json"));
        if file.exists() {
            return;
        }
        if let Ok(text) = serde_json::to_string_pretty(data) {
            let _ = fs::write(file, text);
        }
        if let Ok(entries) = fs::read_dir(&backup_dir) {
            let mut names: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
                .collect();
            names.sort();
            if names.len() > 7 {
                for old in &names[..names.len() - 7] {
                    let _ = fs::remove_file(old);
                }
            }
        }
    }
}

fn notify(app: &tauri::AppHandle) {
    let _ = app.emit("state-changed", ());
}

fn with_state<R>(app: &tauri::AppHandle, f: impl FnOnce(&AppState) -> R) -> R {
    let state = app.state::<AppState>();
    f(&state)
}

// ------------------------------------------------------------- desktop layer

#[cfg(target_os = "windows")]
fn set_desktop_layer(window: &tauri::WebviewWindow) -> Result<(), String> {
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
    const WS_EX_APPWINDOW: isize = 0x0004_0000;
    // Tauri 的透明窗口带这两个样式：TRANSPARENT 会让鼠标点击穿透，
    // NOACTIVATE 会吞掉 WebView2 的点击；桌面层窗口不需要它们。
    const WS_EX_TRANSPARENT: isize = 0x0000_0020;
    const WS_EX_NOACTIVATE: isize = 0x0800_0000;
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
            (ex_style | WS_EX_TOOLWINDOW)
                & !WS_EX_APPWINDOW
                & !WS_EX_TRANSPARENT
                & !WS_EX_NOACTIVATE,
        );
        SetWindowPos(hwnd, anchor, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn set_desktop_layer(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn clear_native_border(window: &tauri::WebviewWindow) {
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;

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

// ---------------------------------------------------------------- autostart

#[cfg(windows)]
const AUTOSTART_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(windows)]
const AUTOSTART_NAME: &str = "Sotto";

fn autostart_registered() -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
        use winreg::RegKey;
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(AUTOSTART_KEY, KEY_READ)
            .ok()
            .and_then(|key| key.get_value::<String, _>(AUTOSTART_NAME).ok())
            .is_some()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 开发构建不写注册表，避免把 target\debug\sotto.exe 注册成开机启动项。
/// 需要测试时设置 SOTTO_AUTOSTART_FORCE=1。
fn autostart_allowed() -> bool {
    !cfg!(debug_assertions) || std::env::var("SOTTO_AUTOSTART_FORCE").as_deref() == Ok("1")
}

fn apply_autostart(enabled: bool) -> Result<bool, String> {
    if !autostart_allowed() {
        return Ok(enabled);
    }
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let run = hkcu
            .open_subkey_with_flags(AUTOSTART_KEY, KEY_READ | KEY_WRITE)
            .map_err(|err| format!("打开自启注册表失败: {err}"))?;
        if enabled {
            let exe = std::env::current_exe().map_err(|err| err.to_string())?;
            let command = format!("\"{}\" --autostart", exe.display());
            run.set_value(AUTOSTART_NAME, &command)
                .map_err(|err| format!("写入自启注册表失败: {err}"))?;
        } else {
            let _ = run.delete_value(AUTOSTART_NAME);
        }
        Ok(autostart_registered())
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Ok(false)
    }
}

// --------------------------------------------------------------- sound file

#[tauri::command]
fn pick_sound_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = rfd::FileDialog::new()
        .add_filter("音频", &["wav", "mp3", "ogg", "m4a"])
        .pick_file();
    let Some(path) = picked else {
        return Ok(None);
    };
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("wav")
        .to_string();
    let dir = with_state(&app, |s| s.dir.join("assets"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(format!("tomato-custom.{ext}"));
    fs::copy(&path, &target).map_err(|e| format!("复制音效失败: {e}"))?;
    Ok(Some(target.to_string_lossy().to_string()))
}

// ------------------------------------------------------------------ commands

#[tauri::command]
fn get_data(app: tauri::AppHandle) -> Data {
    with_state(&app, |s| s.snapshot())
}

#[tauri::command]
fn add_task(app: tauri::AppHandle, title: String, ddl: Option<String>) -> Result<Task, String> {
    let task = with_state(&app, |state| {
        let mut data = state.data.lock().map_err(|_| "状态锁失效".to_string())?;
        let order = data
            .tasks
            .iter()
            .map(|t| t.order)
            .fold(0.0_f64, f64::max)
            + 1.0;
        let task = Task {
            id: new_id(),
            title,
            ddl: ddl.filter(|d| !d.is_empty()),
            detail: String::new(),
            order,
            created_at: now_ms(),
            completed_at: None,
        };
        data.tasks.push(task.clone());
        state.save_data(&data)?;
        Ok::<Task, String>(task)
    })?;
    notify(&app);
    Ok(task)
}

#[tauri::command]
fn save_task(app: tauri::AppHandle, task: Task) -> Result<(), String> {
    with_state(&app, |state| {
        let mut data = state.data.lock().map_err(|_| "状态锁失效".to_string())?;
        let Some(existing) = data.tasks.iter_mut().find(|t| t.id == task.id) else {
            return Err("任务不存在".into());
        };
        *existing = task;
        state.save_data(&data)
    })?;
    notify(&app);
    Ok(())
}

#[tauri::command]
fn delete_task(app: tauri::AppHandle, id: String) -> Result<(), String> {
    with_state(&app, |state| {
        let mut data = state.data.lock().map_err(|_| "状态锁失效".to_string())?;
        data.tasks.retain(|t| t.id != id);
        data.tomatoes.retain(|t| t.task_id != id);
        state.save_data(&data)
    })?;
    notify(&app);
    Ok(())
}

#[tauri::command]
fn delete_tasks(app: tauri::AppHandle, ids: Vec<String>) -> Result<(), String> {
    with_state(&app, |state| {
        let mut data = state.data.lock().map_err(|_| "状态锁失效".to_string())?;
        data.tasks.retain(|t| !ids.contains(&t.id));
        data.tomatoes.retain(|t| !ids.contains(&t.task_id));
        state.save_data(&data)
    })?;
    notify(&app);
    Ok(())
}

#[tauri::command]
fn set_done(app: tauri::AppHandle, id: String, done: bool) -> Result<(), String> {
    with_state(&app, |state| {
        let mut data = state.data.lock().map_err(|_| "状态锁失效".to_string())?;
        if let Some(task) = data.tasks.iter_mut().find(|t| t.id == id) {
            task.completed_at = if done { Some(now_ms()) } else { None };
        }
        state.save_data(&data)
    })?;
    notify(&app);
    Ok(())
}

#[tauri::command]
fn add_tomato(app: tauri::AppHandle, task_id: String) -> Result<Tomato, String> {
    let tomato = with_state(&app, |state| {
        let mut data = state.data.lock().map_err(|_| "状态锁失效".to_string())?;
        if !data.tasks.iter().any(|t| t.id == task_id) {
            return Err("任务不存在".into());
        }
        let tomato = Tomato {
            id: new_id(),
            task_id,
            ts: now_ms(),
        };
        data.tomatoes.push(tomato.clone());
        state.save_data(&data)?;
        Ok::<Tomato, String>(tomato)
    })?;
    notify(&app);
    Ok(tomato)
}

#[tauri::command]
fn undo_tomato(app: tauri::AppHandle, task_id: String) -> Result<bool, String> {
    let removed = with_state(&app, |state| {
        let mut data = state.data.lock().map_err(|_| "状态锁失效".to_string())?;
        let latest = data
            .tomatoes
            .iter()
            .enumerate()
            .filter(|(_, t)| t.task_id == task_id)
            .max_by_key(|(_, t)| t.ts)
            .map(|(index, _)| index);
        let Some(index) = latest else {
            return Ok::<bool, String>(false);
        };
        data.tomatoes.remove(index);
        state.save_data(&data)?;
        Ok(true)
    })?;
    notify(&app);
    Ok(removed)
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    with_state(&app, |state| {
        let mut data = state.data.lock().map_err(|_| "状态锁失效".to_string())?;
        data.settings = settings;
        state.save_data(&data)
    })?;
    notify(&app);
    Ok(())
}

#[tauri::command]
fn set_widget_size(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    let width = width.clamp(240.0, 720.0);
    let height = height.clamp(240.0, 1000.0);
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        // 变大后可能顶出屏幕，夹回当前显示器工作区。
        if let (Ok(Some(monitor)), Ok(pos), Ok(size)) = (
            window.current_monitor(),
            window.outer_position(),
            window.outer_size(),
        ) {
            let area = monitor.work_area();
            let max_x = area.position.x + area.size.width as i32 - size.width as i32;
            let max_y = area.position.y + area.size.height as i32 - size.height as i32;
            let x = pos.x.clamp(area.position.x, max_x.max(area.position.x));
            let y = pos.y.clamp(area.position.y, max_y.max(area.position.y));
            if (x, y) != (pos.x, pos.y) {
                let _ = window.set_position(PhysicalPosition::new(x, y));
            }
        }
    }
    with_state(&app, |state| {
        let mut data = state.data.lock().map_err(|_| "状态锁失效".to_string())?;
        data.settings.widget_width = width;
        data.settings.widget_height = height;
        state.save_data(&data)
    })?;
    notify(&app);
    Ok(())
}

#[tauri::command]
fn set_hotkey(app: tauri::AppHandle, hotkey: String) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let old = with_state(&app, |state| state.snapshot().settings.hotkey);
    if hotkey != old {
        if !hotkey.trim().is_empty() {
            // 先注册新的，失败时旧快捷键仍然有效。
            app.global_shortcut()
                .register(hotkey.as_str())
                .map_err(|e| format!("快捷键注册失败: {e}"))?;
        }
        if !old.trim().is_empty() {
            let _ = app.global_shortcut().unregister(old.as_str());
        }
    }
    with_state(&app, |state| {
        let mut data = state.data.lock().map_err(|_| "状态锁失效".to_string())?;
        data.settings.hotkey = hotkey;
        state.save_data(&data)
    })?;
    Ok(())
}

#[tauri::command]
fn open_editor(app: tauri::AppHandle, task_id: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("editor") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        if let Some(id) = task_id {
            let _ = app.emit_to("editor", "focus-task", id);
        }
    }
    Ok(())
}

#[tauri::command]
fn hide_editor(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("editor") {
        save_editor_bounds(&app, &window);
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let status = apply_autostart(enabled)?;
    with_state(&app, |state| {
        let mut data = state.data.lock().map_err(|_| "状态锁失效".to_string())?;
        data.settings.autostart = enabled;
        state.save_data(&data)
    })?;
    notify(&app);
    Ok(status)
}

#[tauri::command]
fn get_autostart() -> bool {
    autostart_registered()
}

#[tauri::command]
fn export_data(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let data_json = with_state(&app, |s| {
        serde_json::to_string_pretty(&s.snapshot()).unwrap_or_default()
    });
    let picked = rfd::FileDialog::new()
        .set_file_name("sotto-backup.json")
        .add_filter("JSON", &["json"])
        .save_file();
    let Some(path) = picked else {
        return Ok(None);
    };
    fs::write(&path, data_json).map_err(|e| format!("导出失败: {e}"))?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
fn import_data(app: tauri::AppHandle) -> Result<bool, String> {
    let picked = rfd::FileDialog::new()
        .add_filter("JSON", &["json"])
        .pick_file();
    let Some(path) = picked else {
        return Ok(false);
    };
    let text = fs::read_to_string(&path).map_err(|e| format!("读取失败: {e}"))?;
    let parsed: Data = serde_json::from_str(&text).map_err(|e| format!("格式不正确: {e}"))?;
    with_state(&app, |state| {
        let mut data = state.data.lock().map_err(|_| "状态锁失效".to_string())?;
        *data = parsed;
        state.save_data(&data)
    })?;
    notify(&app);
    Ok(true)
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("editor") {
        save_editor_bounds(&app, &window);
    }
    if let Some(window) = app.get_webview_window("main") {
        save_widget_position(&app, &window);
    }
    app.exit(0);
}

// ------------------------------------------------------------ window layout

fn save_widget_position(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let Ok(pos) = window.outer_position() else {
        return;
    };
    let _ = with_state(app, |state| {
        if let Ok(mut data) = state.data.lock() {
            data.settings.widget_x = Some(pos.x);
            data.settings.widget_y = Some(pos.y);
            let _ = state.save_data(&data);
        }
    });
}

fn save_editor_bounds(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    if window.is_maximized().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return;
    }
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    if size.width < 200 || size.height < 150 {
        return;
    }
    let _ = with_state(app, |state| {
        if let Ok(mut data) = state.data.lock() {
            data.settings.editor_x = Some(pos.x);
            data.settings.editor_y = Some(pos.y);
            data.settings.editor_width = Some(size.width);
            data.settings.editor_height = Some(size.height);
            let _ = state.save_data(&data);
        }
    });
}

/// 移动后延迟落盘，避免拖拽期间每个事件都写文件。
fn queue_position_save(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(700));
        if let Some(window) = app.get_webview_window("main") {
            save_widget_position(&app, &window);
        }
    });
}

fn queue_editor_bounds_save(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(700));
        if let Some(window) = app.get_webview_window("editor") {
            save_editor_bounds(&app, &window);
        }
    });
}

fn default_widget_position(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = window.primary_monitor()? else {
        return Ok(());
    };
    let area = monitor.work_area();
    let scale = window.scale_factor()?;
    let margin = (24.0 * scale).round() as i32;
    let size = window.outer_size()?;
    let x = area.position.x + area.size.width as i32 - size.width as i32 - margin;
    let y = area.position.y + area.size.height as i32 - size.height as i32 - margin;
    window.set_position(PhysicalPosition::new(
        x.max(area.position.x),
        y.max(area.position.y),
    ))
}

// ---------------------------------------------------------------------- tray

fn show_editor(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("editor") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "open_editor", "打开编辑界面", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "open_settings", "设置", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启",
        true,
        with_state(app, |s| s.snapshot().settings.autostart),
        None::<&str>,
    )?;
    let exit = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&open, &settings, &autostart, &exit])
}

fn create_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;

    let mut builder = TrayIconBuilder::with_id("sotto")
        .tooltip("Sotto")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open_editor" => {
                show_editor(app);
                let _ = app.emit_to("editor", "open-view", "tasks");
            }
            "open_settings" => {
                show_editor(app);
                let _ = app.emit_to("editor", "open-view", "settings");
            }
            "autostart" => {
                let next = !with_state(app, |s| s.snapshot().settings.autostart);
                let _ = set_autostart(app.clone(), next);
                // CheckMenuItem 的勾选状态是手动的，切换后重建菜单。
                if let Some(tray) = app.tray_by_id("sotto") {
                    if let Ok(menu) = build_tray_menu(app) {
                        let _ = tray.set_menu(Some(menu));
                    }
                }
            }
            "exit" => quit_app(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                show_editor(app);
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------- run

fn create_windows(app: &tauri::AppHandle) -> tauri::Result<()> {
    let settings = with_state(app, |s| s.snapshot().settings);

    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Sotto")
    .inner_size(settings.widget_width, settings.widget_height)
    .transparent(true)
    .decorations(false)
    .shadow(false)
    .resizable(false)
    .skip_taskbar(true)
    .additional_browser_args(WEBVIEW2_ARGS)
    .visible(false);

    let widget = builder.build()?;
    clear_native_border(&widget);
    if let Err(err) = set_desktop_layer(&widget) {
        eprintln!("sotto desktop layer failed: {err}");
    }
    // 保存的是物理像素，必须用 set_position(PhysicalPosition)；
    // builder.position 按逻辑像素解释，200% 缩放会跑到屏幕外。
    match (settings.widget_x, settings.widget_y) {
        (Some(x), Some(y)) => {
            let _ = widget.set_position(PhysicalPosition::new(x, y));
        }
        _ => {
            let _ = default_widget_position(&widget);
        }
    }

    let widget_handle = app.clone();
    widget.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(_) => queue_position_save(widget_handle.clone()),
        _ => {}
    });

    let editor = tauri::WebviewWindowBuilder::new(
        app,
        "editor",
        tauri::WebviewUrl::App("editor.html".into()),
    )
    .title("Sotto · 编辑")
    .inner_size(980.0, 660.0)
    .min_inner_size(760.0, 520.0)
    .additional_browser_args(WEBVIEW2_ARGS)
    .visible(false)
    .build()?;

    // 保存的是物理尺寸；builder.inner_size 按逻辑像素解释，这里单独恢复。
    if let (Some(w), Some(h)) = (settings.editor_width, settings.editor_height) {
        let _ = editor.set_size(PhysicalSize::new(w, h));
    }
    if let (Some(x), Some(y)) = (settings.editor_x, settings.editor_y) {
        let _ = editor.set_position(PhysicalPosition::new(x, y));
    }

    let editor_handle = app.clone();
    editor.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            queue_editor_bounds_save(editor_handle.clone())
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Some(window) = editor_handle.get_webview_window("editor") {
                save_editor_bounds(&editor_handle, &window);
                let _ = window.hide();
            }
        }
        _ => {}
    });

    widget.show()?;
    // 显示后重新声明一次桌面层，防止 Explorer 在窗口初次显示时重排 Z 序。
    let _ = set_desktop_layer(&widget);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let app = app.clone();
            let inner = app.clone();
            let _ = app.run_on_main_thread(move || show_editor(&inner));
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    show_editor(app);
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_data,
            add_task,
            save_task,
            delete_task,
            delete_tasks,
            set_done,
            add_tomato,
            undo_tomato,
            save_settings,
            set_widget_size,
            set_hotkey,
            open_editor,
            hide_editor,
            set_autostart,
            get_autostart,
            export_data,
            import_data,
            pick_sound_file,
            quit_app,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state = AppState::new();
            let settings = state.snapshot().settings;
            app.manage(state);

            // 首次运行默认开启自启。
            if settings.autostart && !autostart_registered() {
                let _ = apply_autostart(true);
            }

            create_tray(&handle)?;
            create_windows(&handle)?;

            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let hotkey = settings.hotkey.clone();
                if !hotkey.trim().is_empty() {
                    if let Err(err) = handle.global_shortcut().register(hotkey.as_str()) {
                        eprintln!("sotto hotkey register failed ({hotkey}): {err}");
                    }
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Sotto");
}
