# P0 探针：Win11 原生窗口

目标：在 Win11 上验证 Tauri 壳的桌面层行为，决定焦点模式和滚轮兜底，避免后面返工。

当前探针只包含组件页，编辑窗口/托盘/热键/自启/Rust 文件后端尚未接入，这是预期状态。

2026-10-17 已在这台机器上执行完毕，结果、截图与判定见 [P0-REPORT.md](P0-REPORT.md)。

## 准备

以下操作在 Win11 上执行；构建环境使用项目内隔离环境，不依赖全局 Rust/MSVC，详见 [DEV-ENV.md](DEV-ENV.md)。Linux 工作区不能直接套用。

```bash
. env/activate.sh
pnpm install
export WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
pnpm tauri dev
```

首次启动会弹自启询问，P0 选“暂不启用”，避免影响测试。

自动化探针（2026-10-17 实际执行时使用）：

- `tools/p0/inspect.ps1`：窗口样式、z 序、矩形、前台窗口。
- `tools/p0/cdp.mjs`：通过 CDP 读写页面状态（`127.0.0.1:9222`）。
- `tools/p0/input.ps1`：点击、双击、拖动、滚轮、Win+D、Alt+Tab、截图。
- `tools/p0/appwindow.ps1`：普通前台窗口，用于覆盖与焦点测试。

## 主题切换

在 Tauri 调试窗口打开 DevTools（F12 / 右键 Inspect）：

```js
const key = 'sotto:settings'
const current = JSON.parse(localStorage.getItem(key) || '{}')
localStorage.setItem(key, JSON.stringify({ ...current, theme: 'acrylic', autostartAsked: true }))
location.reload()
```

切回深色把 `acrylic` 改成 `dark`。

## P0 矩阵

| 编号 | 操作 | 记录 |
|---|---|---|
| 1 | 打开记事本盖住组件 | 组件是否始终在普通窗口下方 |
| 2 | 查看任务栏 / Alt+Tab | 是否有组件项 |
| 3 | 记事本在前台时点击组件 | 组件是否抢焦点/上浮 |
| 4 | 点击组件内容 | 是否展开/收起；双击是否只算一次 |
| 5 | 拖动顶部条 | 窗口是否移动；锁定后是否完全不能拖 |
| 6 | 滚轮（系统“非活动窗口滚动”开） | 列表是否滚动 |
| 7 | 滚轮（系统设置关） | 是否失效；记录提示 |
| 8 | 切换亚克力，透明效果开/关 | 是否模糊；回退深色是否正常 |
| 9 | 关闭系统透明效果 / RDP 重连 | 是否黑底；手动切回深色是否可用 |
| 10 | Win+D | 组件是否被隐藏；当前版本默认不自动恢复 |
| 11 | 终端/VS Code 等普通窗口置于组件上 | 组件是否被覆盖 |
| 12 | 点击铅笔 | 当前预期不打开编辑窗口；记录，不阻塞 P0 |

## 结果归档

请回传：

- Win11 版本与 WebView2 版本。
- 1–12 的结果，附 3–5 张截图或一段录屏。
- 3、5、6、7 的明确结论：是否抢焦点、是否可拖、滚轮是否可用。
- 8、9 的亚克力实际表现。

## 判定

- 焦点模式必须 P0 三选一，不静默 fallback：
  1. `focusable(false)` 原生可用。
  2. `focusable(false)` + raw input 滚轮。
  3. 可聚焦降级模式，托盘可见、文档写明。
- 系统设置开启时 WebView2 仍收不到滚轮 → 升 P0 缺陷，raw input 兜底。
- 亚克力失败 → 深色 + effective theme；不承诺自动检测系统透明变化。
- 本探针的托盘/Win+D 开关在 M2 接入；拖拽由顶部条触发。
