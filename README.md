# Sotto · Win11 桌面便签组件

当前进度：M1 前端可用（mock IPC + Playwright 截图），Windows 原生壳进入 P0。

设计方案：[Sotto.md](Sotto.md)

## 环境

- `env/`：按你的要求创建的 Python 虚拟环境，用于辅助脚本；应用本身不使用 Python。
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

Windows 构建：

```powershell
pnpm install
pnpm tauri dev
pnpm tauri build
```

## 当前实现

- 只读组件：标题、进度、嵌套任务、单行省略、5/15 条、展开/收起、底部提示、锁定图标、铅笔入口。
- 编辑窗口：源码 + 任务预览、复选框改源码、快捷键、8 项设置、保存状态、关闭确认。
- 主题：深色 / 亚克力 CSS 模拟；Tauri 壳用 window-vibrancy 应用亚克力。
- 数据层：TypeScript 任务解析器、设置校验、mock localStorage；Rust 后端在 M2 接入。
- 测试：16 个 Vitest 用例 + 5 个 Playwright UI 用例。
- 截图：`docs/screenshots/`。

## P0

见 [docs/P0-PROBE.md](docs/P0-PROBE.md)。P0 关注 Win11 原生置底、焦点、滚轮、拖动、亚克力和 Win+D；结果决定焦点模式。

## 下一步

1. 在 Win11 上按 [docs/P0-PROBE.md](docs/P0-PROBE.md) 跑 P0 矩阵。
2. 回传焦点、滚轮、拖动、亚克力和 Win+D 结果。
3. P0 通过后接 M2：Rust 字节/EOL/编码、原子写、状态机、watcher、备份、编辑窗口多窗口。

## 限制

- 当前 Tauri 壳只加载组件页；编辑窗口的 Tauri 多窗口和真实文件读写尚未接入。
- Playwright 只验证 Vite + mock IPC，不驱动 WebView2。
- 未签名，Windows SmartScreen 可能提示。
