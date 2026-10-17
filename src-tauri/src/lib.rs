#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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

            #[cfg(target_os = "windows")]
            {
                use window_vibrancy::apply_acrylic;
                // P0：透明 + 亚克力；失败时回退由前端主题和 P0 记录处理。
                let _ = apply_acrylic(&window, Some((18, 22, 30, 180)));
            }

            window.show()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Sotto");
}
