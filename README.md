# Sotto v2.3.0

Windows 11 桌面便签 + 番茄记录。便签常驻桌面层，显示待办和番茄；编辑器负责任务管理、统计、设置与数据备份。

## 功能

### 便签

- 贴在桌面层：Win+D 后仍可见，被普通窗口覆盖，不在 Alt+Tab / 任务栏出现
- 拖动记忆位置、滚轮浏览、单击任务打开编辑器并定位
- 番茄逐颗显示：左键 +1 / 右键 −1，带爆汁粒子、冲击波、整堆弹跳和音效
- 完成任务：绿色光带横扫、整行与文字抖动、3px 删除线、粒子、双环星芒、大字 ✓、外框绿光和提示音
- 涨潮：点番茄时底部涌起双层波浪，峰值停留、横向涌动、上下呼吸后缓慢退去
- 顶部显示今日番茄数，跨天自动刷新

### 编辑器

- `Ctrl+Alt+E` 或托盘打开，`Ctrl+W` / `Esc` 收起；最小化后快捷键/托盘可恢复
- 任务列表与详情：标题、DDL（日期 + 可选时间）、详情、番茄计数
- 键盘：↑↓ 选择、Shift+↑↓ 多选、Delete 删除、F2 改标题、Ctrl+N 新建
- 排序：指针拖拽调整顺序；一键“按 DDL 排序”，过期置顶、越早到期越靠前、无 DDL 沉底
- 完成动画：粗绿色光带、整行/文字抖动、删除线、粒子、双环星芒、大字 ✓、删除线火花、提示音；已完成计数脉冲
- 统计：今天/昨天与本周/上周切换，按任务分色的堆叠条，日视图 12 个 2h 番茄时间轴，各任务用时
- 缩放：Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+滚轮，记在 localStorage

### 设置

主题三色自定义、便签宽高、音效开关/音量/自定义音频、全局快捷键、开机自启、导出/导入、备份列表与恢复、打开数据目录。

## 数据与备份

- 数据文件：`%APPDATA%\Sotto\data.json`，番茄按 `{ taskId, ts }` 独立记录，一颗按 0.5 小时计
- 原子写入：先写 `data.json.tmp` 再 rename
- 每日备份：`%APPDATA%\Sotto\backups\day-*.json`，保留 7 份
- 导入/恢复前自动快照，各保留 5 份
- `data.json` 损坏时移到 `backups/corrupt-*.json`，并自动从最近可用备份恢复

## 技术栈与结构

Tauri 2 + React 19 + TypeScript + Vite。Rust 持有唯一数据源，前端两个页面通过命令读写。

```
index.html          → src/main-widget.tsx → src/widget/Widget.tsx
editor.html         → src/main-editor.tsx → src/editor/Editor.tsx
src/shared/api.ts        Tauri invoke / event 封装
src/shared/types.ts      Task / Tomato / Settings / AppData
src/shared/sound.ts      番茄音效 + WebAudio 完成提示音
src/shared/tokens.css    跨界面设计 token
src/shared/doneSeeds.ts  完成粒子生成
src-tauri/src/lib.rs    数据、命令、窗口、托盘、桌面层、自启
```

- 两个窗口在 `lib.rs` 的 `create_windows()` 里运行时创建；`main` 常显，`editor` 初始隐藏
- 所有写操作保存后 emit `state-changed`，两端重新拉取 `get_data`
- 便签桌面层通过 Win32 `SetWindowPos` 挂到桌面 Shell 窗口之后
- 编辑器完成状态延迟 800ms 提交，让动画播完再移到“已完成”

## 开发

```bash
./start-dev.sh
```

首次启动会编译 Rust 依赖（约 5–10 分钟），之后秒开。`env/` 是项目内虚拟环境（Rust 工具链 + cargo 缓存 + pnpm shim），不写系统目录。

```bash
npm run build   # 仅前端：tsc + vite，产物到 dist/
npm run dev     # 仅 Vite，127.0.0.1:5173；没有 Tauri IPC
```

当前没有自动化测试；`scripts/` 里是调试用 PowerShell 脚本（截图、点击、拖拽、DPI 诊断、图标生成），不影响应用本身。

## 发布

```bash
./build-release.sh
```

产物在 `src-tauri/target/release/bundle/nsis/`。整理后的 v2.3.0 产物在 `release/Sotto_v2.3/`（该目录 gitignore）：

- `Sotto_2.3.0_x64-setup.exe` — NSIS 安装包
- `Sotto_v2.3.exe` — 免安装可执行文件
- `Sotto_v2.3-portable.zip` — 便携包（exe + WebView2Loader.dll + 说明）

发布时需同步版本号：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`，以及编辑器“关于”里的显示文本。

## v2.3 更新

- 编辑器增加一键 DDL 排序；拖拽改为指针拖拽，WebView2 下稳定可用
- 编辑器和便签统一完成动画：光带、抖动、删除线、粒子、双环星芒、大字 ✓、火花、提示音
- 便签番茄增加爆汁、冲击波、整堆弹跳；新增底部涨潮动效
- 抽出共享设计 token 和完成粒子工具，编辑器与便签共用
- 修复编辑器最小化后无法从快捷键/托盘恢复的问题
- 版本升至 2.3.0，生成 NSIS 安装包与便携版

## 已知限制

- 仅单显示器
- 无“隐藏便签”快捷键
- 无自动计时番茄，番茄为手动记录

## 仓库

已推送到 `M3phest0/Sotto` 的 `v2.3` 分支（`main` 未改动）。
