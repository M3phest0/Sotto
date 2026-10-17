# Sotto · Win11 桌面便签组件

当前进度：M1 前端完成；P0 已在 Win11 实机通过；M2 开始。

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
pnpm test       # Vitest，16 个用例
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
- 数据层：TypeScript 任务解析器、设置校验、mock localStorage；Rust 后端在 M2 接入。
- 测试：16 个 Vitest 用例 + 5 个 Playwright UI 用例；P0 真机矩阵见报告。
- 截图：`docs/screenshots/`，含 `p0-*.png` 证据。

## P0 结果

- 12 项中 11 项通过；第 7 项（关闭系统“非活动窗口滚动”）需重启 Explorer 后补测，不阻塞默认路径。
- 焦点模式：模式 1，`focusable(false)`。
- `setAlwaysOnBottom` 被动态壁纸 WorkerW 盖住，已改为 `set_desktop_layer`。
- 亚克力：`set_acrylic` 按主题开关；系统透明关闭时不模糊但不黑底。
- Win+D：组件保持桌面层可见，无需恢复开关。

详见 [docs/P0-REPORT.md](docs/P0-REPORT.md)；操作记录见 [docs/P0-PROBE.md](docs/P0-PROBE.md)。

## 下一步 M2

1. Rust 字节/EOL/BOM/编码检测与原子替换。
2. 保存状态机、单飞、冲突、watcher、备份。
3. 编辑窗口多窗口、真实文件选择、设置持久化。
4. 托盘/热键/自启/首启和 `set_desktop_layer` 生命周期。

## 限制

- P0 仍只加载组件页；编辑窗口的 Tauri 多窗口和真实文件读写尚未接入，这是 M2 范围。
- Playwright 只验证 Vite + mock IPC，不驱动 WebView2。
- 未签名，Windows SmartScreen 可能提示。
