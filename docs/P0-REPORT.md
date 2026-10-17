# P0 执行报告

日期：2026-10-17  
机器：Windows 11 Home China 10.0.26200 x64  
WebView2：155.0.4283.60  
Node：24.18.0 / npm：11.16.0  
Tauri：2.12.4 / tao 0.37.1 / window-vibrancy 0.6.0  
显示：2880×1800 物理，1440×900 逻辑，DPI 200%

## 结论

**P0 执行通过，焦点模式定为模式 1（`focusable(false)` 原生可用）。** 12 项中 11 项明确通过，1 项（第 7 项，关闭系统“非活动窗口滚动”后的对比）因注册表改动需重启 Explorer 才生效而未完成交叉验证；默认系统设置下滚轮可用，判定标准中“系统设置开启时收不到滚轮”的 P0 缺陷条件未触发，因此不阻塞。

**必须记录的架构变更：Tauri 的 `setAlwaysOnBottom(true)` 在本机不可用。** 它映射到 `HWND_BOTTOM`，而本机启用了动态壁纸（WorkerW），组件会被壁纸盖住完全不可见。已改为自定义 Win32 桌面层定位（见第三节），这是 M2 的既定基础，不是临时绕过。

M2 的 P0 阻塞解除。

## 一、结果矩阵

| 编号 | 目标 | 结果 | 证据 |
|---|---|---|---|
| 1 | 普通窗口置底覆盖 | 通过：普通窗口始终覆盖组件，组件不上浮 | `p0-19-normal-overlap.png`、`p0-26-normal-covers.png` |
| 2 | 任务栏 / Alt+Tab 隐藏 | 通过：Alt+Tab 切换器 5 个窗口，无 Sotto；exstyle `0x08000190` 含 `WS_EX_TOOLWINDOW`，无 `WS_EX_APPWINDOW` | `p0-27-alttab.png` |
| 3 | 点击不抢焦点 | 通过：前台保持测试窗口（hwnd `0x80D64`），组件内容照常响应 | 窗口检查 + `p0-20-click-expand.png` |
| 4 | 展开 / 收起 / 双击 | 通过：单击 5→10 行；双击 10→5，只切换一次（300ms 守卫生效） | `p0-20-click-expand.png` |
| 5 | 顶部条拖动 / 锁定 | 通过：逻辑坐标 (25,25)→(225,175)；`locked:true` 后拖动无位移 | `p0-21-drag.png` |
| 6 | 默认系统设置下滚轮 | 通过：组件非前台时滚轮滚动列表，`scrollTop` 0→72，焦点未变 | 运行时读取 |
| 7 | 关闭“非活动窗口滚动”后滚轮 | **未完成交叉验证**：`MouseWheelRouting` 0→仍滚动，注册表改动未热生效，需重启 Explorer/重新登录。已恢复原值 2 | 见第四节 |
| 8 | 亚克力开关 | 通过：ON 为灰色半透明背景，OFF 卡片外完全透明；切换深色主题无闪烁 | `p0-22-acrylic-on-desktop.png`、`p0-23-acrylic-off-desktop.png` |
| 9 | 系统透明效果关闭 | 通过（有保留）：`EnableTransparency=0` + 亚克力 ON 时不模糊，但仍为灰色背景，无黑底；设置已恢复为 1 | `p0-24-transparency-off-acrylic.png` |
| 10 | Win+D | 通过（优于预期）：组件保留在桌面层可见，不进入最小化状态 | `p0-25-wind.png` |
| 11 | 普通窗口覆盖（终端/VS Code 类） | 通过：同第 1 项 | `p0-26-normal-covers.png` |
| 12 | 点击铅笔 | 符合预期：不打开编辑窗口，无新 CDP target；记录不阻塞 | CDP target 列表 |

## 二、焦点模式判定

**选定模式 1：`focusable(false)` 原生可用。**

依据：

- 第 3 项：点击组件不夺焦点，前台窗口保持不变。
- 第 6 项：非前台状态下滚轮仍能滚动列表，无需 raw input 转发。
- 第 4 项：点击、双击交互在无焦点窗口内正常工作。
- 第 5 项：拖动可用。

模式 2（raw input 滚轮）不启用。模式 3（可聚焦降级）作为产品级兜底保留在文档中：若后续在别的机器上发现滚轮失效，再切模式 3，不得静默降级。

## 三、桌面层实现变更（M2 基础）

问题：`setAlwaysOnBottom(true)` 在 tao 中把 `hwndInsertAfter` 强制写成 `HWND_BOTTOM`，在 `WM_WINDOWPOSCHANGING` 里反复回写。本机动态壁纸宿主（WorkerW）位于其下，组件被遮住；`IsWindowVisible` 仍为真、PrintWindow 也有内容，只有屏幕上看不到。

现在的实现（`src-tauri/src/lib.rs` 的 `set_desktop_layer`）：

1. 枚举顶层窗口，找到含有 `SHELLDLL_DefView` 子窗口的 WorkerW 作为锚点；找不到时回退 `Progman`。
2. `SetWindowPos(hwnd, anchor, ...)` 把组件插到锚点正上方：在壁纸/桌面图标之上、普通窗口之下。
3. 设置 `WS_EX_TOOLWINDOW`、清除 `WS_EX_APPWINDOW`，并从配置保留 `skip_taskbar(true)`。
4. 再次 `SetWindowPos`，让任务栏和 Alt+Tab 重新读取样式。

前端在 `src/shared/desktop.ts` 的 `setupDesktopLayer(theme)` 中一次调用完成三件事：`set_desktop_layer`、`setFocusable(false)`、`set_acrylic`。主题变化时重跑。

未使用 `setAlwaysOnBottom`，也不要再启用它。

## 四、未完成项与风险

1. **第 7 项未做对比。** `HKCU\Control Panel\Desktop\MouseWheelRouting` 改为 0 后需要 Explorer 重启或重新登录才生效，本次未重启。默认值 2（系统“悬停滚动非活动窗口”开启）下行为正常，故不触发 P0 缺陷判定。若后续要关闭该功能并验证，需安排一次 Explorer 重启；组件侧不需要改代码，除非届时发现滚轮失效。
2. **亚克力不保证在系统透明关闭时生效。** 第 9 项显示无模糊但不黑屏。M2 应使用 effective theme：系统透明关闭时自动降级为深色，不承诺自动检测系统设置变化。
3. **Playwright 缺 `webServer` 配置。** 与本轮 P0 无关，仍是 M1 收尾项（`pnpm screenshot` 需先手动启动 dev server）。

## 五、系统状态变更与恢复

| 设置 | 原值 | 测试值 | 现状 |
|---|---|---|---|
| `HKCU\Control Panel\Desktop\MouseWheelRouting` | 2 | 0 | 已恢复 2 |
| `HKCU\...\Themes\Personalize\EnableTransparency` | 1 | 0 | 已恢复 1 |

测试期间最小化的用户窗口（Chrome、VMware、Windows Terminal）在收尾时恢复。

## 六、复现方式

隔离环境与构建方法见 [DEV-ENV.md](DEV-ENV.md)。测试工具与操作步骤见 [P0-PROBE.md](P0-PROBE.md) 与 `tools/p0/`。

关键命令：

```bash
. env/activate.sh
export WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
pnpm tauri dev
```

## 七、对 M2 的影响

- M2 可以开始。
- 窗口层：直接基于 `set_desktop_layer` 扩展，不再依赖 `setAlwaysOnBottom`。
- 焦点模式：模式 1，不做可聚焦降级。
- 滚轮：依赖 WebView2 在 `WS_EX_NOACTIVATE` 下的默认滚动行为；第 7 项留作已知风险，不预置 raw input 代码。
- 亚克力：按主题显式开关；系统透明关闭时降级为深色。
- Win+D：无需额外恢复逻辑。
