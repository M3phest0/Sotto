# M2 完成报告

日期：2026-10-17
环境：Windows 11 26200，Tauri 2.12.4，WebView2 155，隔离 GNU Rust 1.99.1（见 `docs/DEV-ENV.md`）。

## 结论

M2 功能完成并通过本机运行验证。唯一剩余项是推送后触发 GitHub Actions 的 Windows CI。

## 已验证项

| 项 | 结果 | 方式 |
| --- | --- | --- |
| 编辑器窗口创建 | 通过 | 托盘/CDP 调用 `open_editor`，窗口与 CDP target 正常出现 |
| 窗口 bounds 落盘 | 通过 | 移动/缩放后 900ms 写 `editorWindow`（按内尺寸存储） |
| bounds 恢复 | 通过 | 关闭后重开，外框精确回到 500,320 / 1400×1000 |
| 原生关闭拦截 | 通过 | `WM_CLOSE` 弹出“还有未保存修改”，取消/放弃/保存并关闭均正确 |
| 托盘退出 | 通过 | 有未保存修改时先弹确认，确认后整个应用退出 |
| 托盘菜单 | 通过 | 打开编辑、显示/隐藏组件、锁定、深色/亚克力、自启、退出 |
| 快捷键 | 通过 | Ctrl+Alt+L 双向切换 `locked` |
| 开机自启 | 通过 | 启用写 HKCU Run，停用删除；StartupApproved 状态可识别 |
| 单实例 | 通过 | 第二次启动立即退出，并在首实例打开编辑器 |
| 登录自启不弹首启 | 通过 | `--autostart` 启动前标记 `autostartAsked` |
| 设置迁移 | 通过 | v0 字段迁移、旧 `todo-list:*` 键迁移、未知字段/新版本告警 |
| 发布构建 | 通过 | `pnpm tauri build` 产出 NSIS 安装包（1.49 MiB） |

## 自动化与工具

- `tools/p0/cdp.mjs` 触发命令与读取 DOM。
- `tools/p0/movewin1.ps1` 按标题移动窗口（物理像素，已开 DPI 感知）。
- `tools/p0/closewin.ps1` 发送 `WM_CLOSE`，验证关闭拦截。

## 测试

- Vitest：19 通过。
- sotto-core：15 通过。
- `cargo check`：通过。
- `pnpm build`：通过。

## 已知限制

- 托盘图标在被 Windows 11 折叠到溢出区时无法用当前工具定位，菜单项通过内部事件分发逐项验证。
- 本机 GNU 工具链的 `windres` 无法处理含中文的项目路径，构建需 `env/activate.sh` 提供的 ASCII 图标覆盖；CI（MSVC + ASCII 路径）不受影响。
- 未签名，安装包仍可能触发 SmartScreen。
