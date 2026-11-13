# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Sotto 是 Windows 11 桌面便签 + 番茄记录应用：Tauri 2 + React 19 + TypeScript。界面文案为中文。

## 常用命令

```bash
./start-dev.sh      # 开发模式：激活 env/ 后跑 tauri dev（Vite + Rust）
./build-release.sh  # release 构建，产物在 src-tauri/target/release/bundle/nsis/
```

两个脚本都先 `. ./env/activate.sh`，把 `RUSTUP_HOME`/`CARGO_HOME` 指向项目内的 `env/`（已被 gitignore），并把 `env/cargo/bin`、`/d/Software/Dev/w64devkit/bin` 加入 PATH。**不要**直接调用 `cargo`/`npm run tauri`，先激活环境。首次编译 Rust 依赖约 5–10 分钟。

前端单独构建/预览：

```bash
npm run build   # tsc -b && vite build → dist/
npm run dev     # 仅 Vite，127.0.0.1:5173；没有 Tauri IPC，invoke 全部失败
```

当前没有测试目录、测试运行器或 vitest 配置（`tsconfig.json` 的 `include` 里有 `tests`，但目录不存在）。不要假设存在单测命令。

## 架构

两个独立页面、两个窗口，共享同一份 Rust 侧数据：

- `index.html` → `src/main-widget.tsx` → `src/widget/Widget.tsx`：桌面便签窗口 `main`
- `editor.html` → `src/main-editor.tsx` → `src/editor/Editor.tsx`：编辑窗口 `editor`

`vite.config.ts` 把这两个 HTML 都配成多页入口。窗口不是在 `tauri.conf.json` 里声明的（`app.windows` 为空），而是在 `src-tauri/src/lib.rs` 的 `create_windows()` 里运行时创建：widget 常显、editor 初始隐藏，由全局快捷键 / 托盘 / 单实例二次启动唤起。editor 的 `CloseRequested` 被拦截为隐藏。

数据流是单向的：Rust 的 `AppState` 持有唯一真相，所有读写走 `#[tauri::command]`；前端只在 `src/shared/api.ts` 封装 invoke。每个修改命令保存后 `emit("state-changed")`，两个窗口收到后重新 `get_data` 全量刷新。新增命令时必须同时改：`AppState` 逻辑、`invoke_handler!` 列表、`api.ts`。

`Editor.tsx` 是单文件多视图：`tasks`（列表 + 详情）、`stats`（统计）、`settings`（设置），视图状态是组件内 `useState<View>`。键盘操作（↑↓ 选择、Shift 多选、Delete、F2、Ctrl+N、Ctrl+W/Esc）在组件内的 keydown effect 里处理。编辑器缩放比例存在 localStorage（`sotto.editorZoom`），其余设置存在 `data.json`。

统计全部在 `Editor.tsx` 里由番茄时间戳前端计算：一颗番茄 = 0.5 小时（`hoursText`），一周从周一开始；日视图把 24 小时分成 12 个 2 小时区间，番茄在区间内纵向堆叠。

## 数据与持久化（src-tauri/src/lib.rs）

- `%APPDATA%\Sotto\data.json`：`{ version, tasks, tomatoes, settings }`，Rust 结构体用 `#[serde(rename_all = "camelCase", default)]`，新增字段必须给 `Default`，否则旧数据反序列化失败。
- 番茄是 `{ id, taskId, ts }` 的独立记录，删任务会级联删其番茄。
- 保存方式：先写 `data.json.tmp` 再 rename；每天首次保存写 `backups/day-{epoch 天数}.json`，保留 7 份。
- 导入/恢复前写 `pre-import-*` / `pre-restore-*` 快照，各保留 5 份。`data.json` 解析失败时移到 `backups/corrupt-*.json`，并从最新可用备份恢复，启动警告通过 `get_startup_warning` 交给前端。
- 自定义音效复制到 `%APPDATA%\Sotto\assets\tomato-custom.<ext>`，前端用 `convertFileSrc` 播放（CSP 只允许 `asset:` + `$APPDATA/Sotto/**`）。

## 窗口与平台细节

- 位置/尺寸以**物理像素**存盘（`PhysicalPosition`/`PhysicalSize`）；`WebviewWindowBuilder` 的 `position`/`inner_size` 是逻辑像素，200% DPI 下会错位，所以恢复时单独 `set_position`/`set_size`。改动窗口几何代码时保持这个区分。
- 便签"贴桌面层"是 Win32 直接操作：`set_desktop_layer()` 用 `SetWindowPos` 把 `main` 挂到 `SHELLDLL_DefView`（找不到则 `Progman`）之后，并清除 `WS_EX_TRANSPARENT`/`WS_EX_NOACTIVATE`、设置 `WS_EX_TOOLWINDOW`。`show()` 之后要重新调用一次，防止 Explorer 重排 Z 序。
- 移动/缩放事件延迟 700ms 落盘，避免拖拽期间频繁写文件；分辨率或缩放变化后会把窗口夹回工作区（`clamp_to_work_area`）。
- autostart 写在 HKCU Run 键；**debug 构建默认不写注册表**，需要测试时设 `SOTTO_AUTOSTART_FORCE=1`。release 启动时会校正注册表路径。
- `Cargo.toml` 里 `crate-type = ["rlib"]` 是刻意的：windows-gnu + rust-lld 下 cdylib 会因导出符号超限失败。
- 版本号需同时改 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`。

## 其他

- 已知限制：仅单显示器；无自动计时番茄；无隐藏便签快捷键。
- `scripts/` 是调试用 PowerShell（截图、点击、DPI 诊断、图标生成），与运行时无关，可整体删除。
- 发布产物整理在 `release/Sotto_vX.Y/`（已 gitignore）；备份说明见 `RELEASE.md`。
