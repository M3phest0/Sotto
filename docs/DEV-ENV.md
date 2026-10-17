# 隔离开发环境（Windows / GNU 工具链）

这是 Win11 P0 实测时使用的隔离环境记录。仓库不包含这套工具链；Linux 工作区的 `env/` 是 Python venv，不是这里描述的 Rust/pnpm 环境。

全部 Win11 工具放在项目内 `env/`，不改系统 PATH，不装全局 Rust，不需要管理员权限。删除 `env/` 即可还原。

## 组成

| 组件 | 位置 | 说明 |
|---|---|---|
| Rust 1.99.1 stable | `env/rustup` + `env/cargo` | host 为 `x86_64-pc-windows-gnu` |
| 链接器 | `env/cargo/config.toml` | 使用 Rust 自带 `rust-lld` + self-contained 库 |
| MinGW 工具 | `D:\Software\Dev\w64devkit`（复用系统已有） | 提供 `windres` 等资源工具 |
| pnpm 转发 | `env/bin/pnpm`、`pnpm.cmd` | 机器上没有全局 pnpm，转发到 `corepack pnpm` |
| Cargo 镜像 | `env/cargo/config.toml` | crates.io 索引走 `rsproxy.cn` |

没有安装 Visual Studio / MSVC：Tauri 2 支持 `x86_64-pc-windows-gnu`，P0 只需要 `tauri dev`。

## 激活

Git Bash：

```bash
. env/activate.sh
```

cmd：

```bat
env\activate.cmd
```

PowerShell：

```powershell
. .\env\activate.ps1
```

激活后 `rustc --version`、`cargo --version`、`pnpm --version` 都应可用。

## 运行

```bash
pnpm install
pnpm tauri dev
```

`tauri.conf.json` 的 `beforeDevCommand` 是 `pnpm dev`，由 `env/bin` 里的 shim 解析到 `corepack pnpm`。终端必须先激活环境。

## 两个环境专用补丁

P0 时项目路径含中文（`Win11桌面便签组件`），GNU 工具链对图标路径不适应；更名 `Sotto` 后路径为 ASCII，图标路径覆盖可省略。链接器补丁仍然需要。

1. **图标路径**：`tauri-winres` 会对图标做 `canonicalize`，得到中文绝对路径；`windres` 用 ANSI 文件 API 打不开。P0 时激活脚本把图标复制到 `%LOCALAPPDATA%\TodoListEnv\icon.ico`，并用 `TAURI_CONFIG` 覆盖 `bundle.icon` 为这个 ASCII 路径。
2. **链接器**：w64devkit 的 GCC 16 缺 `libgcc_eh.a`，且作为 proc-macro/cdylib 链接器时找不到 self-contained 系统库。`env/cargo/config.toml` 改用 `rust-lld`，并开启 `-Clink-self-contained=yes`。

另有一处项目配置改动：`src-tauri/Cargo.toml` 的 `crate-type` 改为 `["rlib"]`。cdylib 在 rust-lld 下会因导出符号超过 65535 失败，桌面构建只需要 rlib。

## 已验证

- `rustc -vV` → `host: x86_64-pc-windows-gnu`
- `cargo build`（src-tauri）→ 成功，产出 `target/debug/sotto.exe`
- `pnpm tauri dev` → Vite 启动、Tauri 窗口正常拉起（验证后已关闭）

## 注意

- `env/` 已在 `.gitignore` 中，不会进入版本库；换机器需要重新执行本页步骤。
- 如果以后安装 MSVC 并切回 MSVC 工具链，可以不激活本环境，并删除 `crate-type` 注释里的限制。
- `TAURI_CONFIG` 只覆盖图标，不影响其他配置。
