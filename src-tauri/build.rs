fn main() {
    tauri_build::build();

    // tauri-build 只把 Windows 资源（含 Common Controls v6 manifest）链接到 bin。
    // `cargo test --lib` 的测试 exe 没有 manifest，会解析到 comctl32 5.82，
    // 而新依赖引入的 TaskDialogIndirect 只存在于 v6，导致进程以 0xc0000139 退出。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo");
        let resource = if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
            "resource.lib"
        } else {
            "libresource.a"
        };
        println!("cargo:rustc-link-arg={out_dir}/{resource}");
    }
}
