# Sotto · Win11 桌面便签组件

当前进度：M1/P0 完成；M2 完成，进入 M3 前收尾。

设计方案：[Sotto.md](Sotto.md)  
P0 报告：[docs/P0-REPORT.md](docs/P0-REPORT.md)

## 环境

- `env/`：Linux 工作区的 Python 虚拟环境，用于辅助脚本；应用本身不使用 Python。
- Win11 P0 使用另一套项目内 Rust/pnpm 环境，记录见 [docs/DEV-ENV.md](docs/DEV-ENV.md)；仓库不包含它。
- Node 24 + pnpm 10：应用前端与测试。
- Node 依赖缓存放 `.cache/`，不写用户目录。
- Tauri 的 Windows 构建在 Win11 上执行；Linux 工作区不构建原生壳。

## 命令

```bash
pnpm install
pnpm dev        # http://127.0.0.1:5173/ 与 /editor.html
pnpm test       # Vitest，28 个用例
pnpm build      # tsc + Vite 多页构建
pnpm screenshot # Playwright 截图，使用系统 Chrome
```

Windows 构建（P0/Win11）：

```powershell
pnpm install
pnpm tauri dev
pnpm tauri build
```

Windows P0 的隔离 Rust 环境见 [docs/DEV-ENV.md](docs/DEV-ENV.md)。

## 当前实现

- 只读组件：标题、进度、嵌套任务、单行省略、5/15 条、展开/收起、底部提示、锁定图标、铅笔入口。
- 编辑窗口：源码 + 任务预览、复选框改源码、快捷键、8 项设置、保存状态、关闭确认。
- 主题：深色 / 亚克力；Tauri 用 `set_acrylic` 命令按主题开关，深色下关闭。
- 桌面层：P0 验证的 `set_desktop_layer`，插到 WorkerW 桌面图标层之上、普通窗口之下；不使用 `setAlwaysOnBottom`。
- 焦点：模式 1，`focusable(false)`；点击不抢焦点，非前台滚轮可用。
- 数据层：Rust `sotto-core` 负责字节/EOL/BOM/编码/哈希、原子写和备份；Tauri 命令负责文件、watcher、设置和窗口。
- 测试：15 个 Rust core + 4 个窗口几何 + 28 个 Vitest + 48 个 Playwright UI；P0 真机矩阵见报告。
- 截图：`docs/screenshots/`，含 `p0-*.png` 证据。

## P0 结果

- 12 项中 11 项通过；第 7 项（关闭系统“非活动窗口滚动”）需重启 Explorer 后补测，不阻塞默认路径。
- 焦点模式：模式 1，`focusable(false)`。
- `setAlwaysOnBottom` 被动态壁纸 WorkerW 盖住，已改为 `set_desktop_layer`。
- 亚克力：`set_acrylic` 按主题开关；系统透明关闭时不模糊但不黑底。
- Win+D：组件保持桌面层可见，无需恢复开关。

详见 [docs/P0-REPORT.md](docs/P0-REPORT.md)；操作记录见 [docs/P0-PROBE.md](docs/P0-PROBE.md)。

## M2 状态

已完成：

- 字节/EOL/BOM/编码检测、原始字节哈希、原子替换。
- 单飞保存、pending 最新、冲突 UI、覆盖保存/重新加载。
- 父目录 watcher、文件变化广播、组件自动刷新。
- 写前/5 分钟/关闭编辑窗口备份、41 份裁剪、每源 200MB、全局 1GB。
- 原生文件选择器、设置持久化、只读编码提示。
- 编辑窗口真实 IPC 保存；浏览器仍走 mock。
- 设置 schema 迁移（v0 → v1，含 `todo-list:*` 旧键迁移与未知字段告警）。
- 编辑窗口 bounds 保存/恢复（900ms 防抖、跨屏 clamp、边框修正）。
- 原生关闭拦截（标题栏 X / Alt+F4）、未保存确认、托盘退出走同一流程。
- 托盘菜单（打开编辑/显示组件/锁定/主题/自启/退出）、左键切换组件、Ctrl+Alt+E 打开编辑、Ctrl+Alt+L 锁定。
- 开机自启（HKCU Run + StartupApproved 状态识别、登录启动延迟、单实例）。

Windows CI 已通过（`windows-build`，含单元测试、Rust core/窗口几何测试、前端构建、Tauri 构建与产物上传）。

运行验证记录见 [docs/M2-REPORT.md](docs/M2-REPORT.md)；§9.2 验收结果见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

## 限制

- 编辑窗口已接真实 IPC。
- Playwright 只验证 Vite + mock IPC，不驱动 WebView2。
- `WM_QUERYENDSESSION` 已接入草稿镜像和窗口过程，但尚未在 Win11 关机/注销场景复测。
- 未签名，Windows SmartScreen 可能提示。
