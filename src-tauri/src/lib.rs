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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_acrylic, set_desktop_layer])
        .setup(|app| {
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
