# Windows 验收报告（§9.2）

日期：2026-10-17
环境：Windows 11 26200，Tauri 2.12.4，WebView2 155，release 构建（未签名）。
测试文件：`%USERPROFILE%\Documents\Sotto.md`，验收后已恢复为空文件。

## 结果

| # | 验收项 | 结果 | 证据 / 说明 |
| --- | --- | --- | --- |
| 1 | 无标题栏/任务栏项；普通窗口可覆盖 | 通过 | P0 矩阵 + M2 实机 |
| 2 | 内容区仅铅笔与展开；展开只读；内容区不可拖动 | 通过 | CDP DOM 检查；P0 拖动矩阵 |
| 3 | 5/15 条；长标题省略；完整内容在编辑器 | 通过 | 紧凑 5 行、展开 15 行、单行省略 |
| 4 | 底部四态；边界不展开；高度稳定；双击去重 | 通过 | “还有 N 条/已到底”实测；P0 双击 300ms |
| 5 | 嵌套显示/计数/勾选/隐藏；16px/最多 3 级 | 通过 | 5 级输入实测缩进 8/24/40/56/56，封顶 3 级；进度含嵌套 |
| 6 | 拖动条两种状态；锁定后隐藏并禁止移动 | 通过 | M2 托盘/快捷键实机 |
| 7 | 焦点模式 1 | 通过 | P0 结论；`focusable(false)` |
| 8 | 非活动窗口滚动矩阵 | 部分 | 默认开启通过；关闭项仍需重启 Explorer 后补测 |
| 9 | `Ctrl+Alt+E` / `Ctrl+Alt+L`；UIPI | 通过（UIPI 未单独记录） | 两个热键实测；`Ctrl+Alt+E` 在验收中补上；UIPI 未用提权窗口复测 |
| 10 | 中文 IME 不跳光标 | 未复测 | 代码有 composition 保护；本轮无输入法自动化 |
| 11 | 首启/自启/known folder/无弹窗 | 通过 | M2 实机；`--autostart` 启动前标记已询问 |
| 12 | 任意 `.md`；编辑/勾选/保存同步；blockquote 禁用 | 通过 | 组件与编辑器同步；blockquote/代码块任务被忽略 |
| 13 | BOM/EOL/末尾换行；混合 EOL 提示；新文件规则 | 通过（本轮修复提示） | 字节级往返保持；混合 EOL 加载时一次性 toast，保存归一为多数 EOL；新文件 CRLF/UTF-8 no BOM/单换行 |
| 14 | UTF-16/GBK 只读；只读文件横幅；超限只读 | 通过（本轮修复两项） | UTF-16 LE / GBK 只读提示；Windows 只读属性横幅 + 保存禁用；>1MB/5000 行只读横幅 + 保存拒绝 |
| 15 | 保存状态机/单飞/冲突/覆盖/重载/关闭三选一 | 通过 | M2 实机；外部修改冲突不覆盖 |
| 16 | 备份 41/manifest/1GB/每源 1 份 | 通过 | Rust 单测 3 项；manifest 含 encoding/eol/hasBom |
| 17 | 外部修改/check-then-replace/watcher | 通过（修复缓存） | `ensure_current` 每次从磁盘重读；外部编辑在组件可见；watcher 不重复重挂 |
| 18 | 深色/亚克力/effective theme/回退通知 | 部分 | 双主题与亚克力实机通过；未读取系统 `EnableTransparency`，无 effective theme 回退通知 |
| 19 | 150%/200% DPI、多屏、拔插夹回 | 部分 | 本机单屏 bounds 恢复通过；缩放/拔插矩阵未复测 |
| 20 | Win+D 后保持桌面层可见 | 通过 | P0 结论 |
| 21 | 解锁/唤醒/RDP/Explorer 恢复；`WM_QUERYENDSESSION` | 部分 | 未实现 `WM_QUERYENDSESSION` 处理器；其余场景未复测 |
| 22 | 5000 行/1MB 基准或任务视图；bounds 恢复 | 通过 | >2000 行/512KB 直接任务视图；1.26MB/5201 行读取成功并只读；bounds 精确恢复 |
| 23 | exe ≤15MB；内存 ≤120MB；CPU <1%；启动 ≤3s | 通过（按私有工作集口径） | exe 3.96MB；启动 102ms（热）/899ms（冷）；空闲 CPU 0.055%；应用 + WebView2 私有工作集 74MB（仅组件）/ 108MB（编辑窗口打开），私有字节 112MB；整树 WS 340MB（含共享 DLL 重复计数） |

## 验收中修复

1. 外部文件修改后组件不刷新：`ensure_current` 改为每次从磁盘重读，读失败才回退缓存（`src-tauri/src/lib.rs`）。
2. 混合 EOL 无提示：`ByteMeta` 新增 `mixedEol`，编辑器加载时显示一次性提示，保存按多数 EOL 归一（`src-tauri/core/src/bytes.rs`、`src/editor/EditorApp.tsx`、`src/shared/types.ts`）。
3. Windows 只读属性未识别：读取时检查 `permissions().readonly()`，显示横幅并禁用保存（`src-tauri/src/lib.rs`）。
4. 超过 1MB/5000 行未显示只读：编辑器按快照 meta 进入只读态（`src/editor/EditorApp.tsx`）。
5. `Ctrl+Alt+E` 未注册：已注册并打开/聚焦编辑窗口（`src-tauri/src/lib.rs`）。
6. WebView2 常驻内存偏高：关闭 GPU、将 GPU 折入浏览器进程并启用低内存模式；应用 + 全部子进程私有工作集从 150MB 降到 74MB（`src-tauri/src/lib.rs`）。

## 未完成 / 建议

- 内存口径：按 Task Manager 的私有工作集计 74MB，达标；整树 WS 340MB 仍偏高是因为共享 DLL 在每个进程中重复计数。若验收要求整树 WS ≤120MB，需要换原生 UI。
- 只读提示文案已去掉“另存为”；当前不提供另存为入口。
- 系统透明关闭时未读取 `EnableTransparency` 切换 effective theme。
- 未处理 `WM_QUERYENDSESSION`；关机前不会主动落盘。
- 中文 IME、150%/200% DPI、多屏拔插、UIPI、休眠/RDP 恢复未在本轮复测。
