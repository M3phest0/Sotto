# Sotto · Win11 桌面便签组件设计方案

> 产品名称：Sotto
> 目标平台：Windows 11 x64（22H2 及以上）
> 方案版本：v0.7
> 更新日期：2026-10-18
> 当前状态：P0 已通过；M1 前端完成；M2 开始

> P0 执行报告：[docs/P0-REPORT.md](docs/P0-REPORT.md)。焦点模式选 1；桌面层改为 Win32 `set_desktop_layer`；不再使用 `setAlwaysOnBottom`。

---

## 0. 版本摘要

v0.7 把 P0 实测结果写回设计：焦点模式选定 1（`focusable(false)`）；`setAlwaysOnBottom` 因动态壁纸 WorkerW 被废弃，改为 `set_desktop_layer`；亚克力由 `set_acrylic` 命令按主题开关；Win+D 实测组件保持可见；滚轮默认可用，关闭系统“非活动窗口滚动”的交叉验证留作已知风险。

v0.6 只做产品更名：Todo List → Sotto。目录、窗口标题、文档标题、bundle id、默认文件名同步为 Sotto；设计内容与 v0.5 一致。

## 0.1 v0.5 摘要

v0.5 在 v0.4 的基础上补齐了会实际改坏文件的数据完整性设计，并把规格缺口、焦点模式、Win+D、首次运行、编辑页操作、数据位置、CI 和交付文档一起收口。

| 层级 | 内容 | 状态 |
|---|---|---|
| P0 契约 | 文件字节/EOL/BOM/编码、原子替换、保存状态机、任务规范/golden、草稿 revision、备份生命周期、组件只读交互 | 锁定 |
| P1 锁定 | 坐标模型、CSP/权限/导航、设置 schema、自启状态、焦点模式决策流程 | 锁定 |
| P1 参数 | 备份份数、防抖值、首次运行文案、滚轮兼容开关 | 默认值，可调 |

v0.5 的关键新增：

1. 全量保存不再直接把 textarea 的 LF 写回磁盘；Rust 按原文件 BOM/EOL/末尾换行转回，`baseDiskHash` 用原始字节。
2. 原子替换改用 `ReplaceFileW`，保留 ACL、创建时间、属性；临时文件同目录同卷，失败回退 `MoveFileEx`。
3. 保存状态机固定为 idle → saving → ack / conflict / error；在途请求不可取消，pending 只留最新，冲突不自动续传。
4. 备份每源上限改为 41 份，和 10+24+7 对齐；manifest 放在每个备份目录，更新原子；备份与日志放 LocalAppData。
5. 焦点模式改为 P0 定死一种，不静默 fallback；降级模式必须托盘可见。
6. Win+D 默认不自动恢复；托盘增加“显示桌面时保持组件”开关。
7. 首启只手动触发，登录自启不弹；默认文件用 `SHGetKnownFolderPath(FOLDERID_Documents)`。
8. 预览按文件大小/行数静态选择，超过 2000 行或 512KB 直接任务专用视图，保留“加载完整预览”按钮。
9. 补全设置 schema、编辑器快捷键/关闭提示/窗口位置、数据位置、Windows 文件语义、CI 和交付文档。
10. 增加“仍未定”章节，避免实现时翻旧账。

之前没定的 3 项按默认落地：

1. 保存采用编辑器单飞，Rust 串行 + 单槽 pending 兜底。
2. 备份保留 10+24+7=41 份，每源上限 41；全局 1GB 软上限，每源至少 1 份。
3. 滚轮默认接受限制；P0 失败才加 raw input；兼容开关只放托盘；预览降级保留任务专用视图。

---

## 1. 项目定位

做一个常驻 Windows 11 桌面的待办组件：平时像一张贴在壁纸上的便签，展示 Markdown 文件里的前几条任务；需要修改时打开独立编辑窗口，组件本身保持只读。

核心目标：

1. 轻量：Tauri 2 + Rust，不基于 Electron，不携带 Node 运行时。
2. 安静：无标题栏、无任务栏项、不抢焦点、不置顶，普通窗口能盖住它。
3. 一眼可见：紧凑 5 条，展开 15 条，滚轮和“还有 N 条”提示继续查看。
4. 数据属于用户：Markdown 文件可放在任意目录，程序不复制、不锁定格式。
5. 编辑集中：组件只读，编辑、勾选、划线全部在编辑窗口完成。
6. 不破坏原文件：保留编码、BOM、换行和末尾换行；保存失败不猜、不覆盖。

非目标：

- 不做 WorkerW 真壁纸层。
- 不做 Win10、ARM64、云同步、多清单、提醒、移动端。
- 不做组件内编辑、组件内勾选、组件内划线动画。
- 不做自定义字体、颜色、边框、圆角、透明度、快捷键。
- 不做自动更新、代码签名、安装包升级。
- 不做全局鼠标钩子作为默认方案；只在 P0 失败时做 raw input 滚轮兜底。

---

## 2. 需求与实现对照

| 需求 | 实现 |
|---|---|
| 在 Win11 运行 | 目标 Win11 x64 22H2+；WebView2 系统自带；亚克力和圆角走 DWM |
| 尽量轻量化 | Tauri 2 + Rust；组件一个 WebView；编辑窗口按需创建、关闭销毁 |
| 开机自启 | 默认未设置；仅手动首启询问一次；只有启用才写 HKCU Run；登录自启不弹 |
| 锁定桌面移动 | 顶部拖动条 + 锁定；锁定后拖动条消失、加锁图标；全禁移动 |
| 取消桌面编辑和划线交互 | 组件只读；内容区只有铅笔和点击展开两个左键动作 |
| 滚轮查看更多 | 内容区可滚动；底部提示四态；滚到边界不触发展开 |
| 快捷键打开编辑 | `Ctrl+Alt+E` 打开/聚焦编辑窗口 |
| 两套固定主题 | 深色/亚克力；有效主题状态；失败回退通知；手动切换 |
| Markdown 文件自选 | 任意 `.md`；最近 5 个；已知文件夹默认路径 |
| 嵌套任务 | 无序 + 有序；blockquote 排除；代码块跳过；最多显示 3 级 |
| 设置最小化 | 8 项 + 2 个动作；不放开颜色/字体族/边框/圆角/快捷键 |
| 组件只读 | 不能选中、复制、键盘操作；编辑和复制在编辑窗口 |
| 不破坏字节 | 保留 BOM/EOL/末尾换行；原始字节哈希；原子替换保留 ACL/属性 |

---

## 3. P0 契约：文件、任务、保存与备份

### 3.1 文件字节、编码与 EOL

全量保存不能直接把 textarea 的 LF 文本写回磁盘。Rust 负责字节级读写。

读取：

- 读取原始字节，检测 UTF-8 BOM、UTF-16 LE/BE BOM、GBK/GB18030。
- UTF-8 无 BOM 且合法时按 UTF-8 读取。
- UTF-16 可解码则只读展示并提示“请另存为 UTF-8”；不做静默转码。
- GBK/GB18030 检测到后只读展示，提示“请另存为 UTF-8”；不使用替换字符静默解码。
- 无法可靠解码时进入只读错误态，不覆盖原文件。
- 检测主 EOL：统计 CRLF/LF；混合 EOL 时取多数；平票按 CRLF。
- 记录 BOM 存在与否、主 EOL、末尾是否有换行、原始字节哈希。

编辑与保存：

- 编辑器内部统一 LF；textarea 的 value 归一化不会直接落盘。
- 保存前 Rust 读取现有字节，确认 baseDiskHash、编码、BOM、主 EOL、末尾换行。
- 写回时把内部 LF 转回主 EOL；保留原 BOM；保留原末尾换行状态。
- `baseDiskHash` 必须用原始字节哈希，不是归一化文本哈希。
- 混合 EOL 文件保存前给一次性提示，默认归一为主 EOL；记录日志。
- 新文件默认：UTF-8 无 BOM、CRLF、末尾一个换行。
- 只保留一个末尾换行；不擅自增减空行。

异常：

- 只读文件：关闭自动保存，显示只读横幅；保存按钮禁用，允许另存为。
- 文件超过 1MB 或 5000 行：读取允许，显示只读；保存拒绝并提示拆分。
- 文件被移动/删除：组件错误态；编辑窗口提示重新选择；草稿保留。
- 文件在保存前被外部修改：baseDiskHash 冲突，不覆盖。

测试必须覆盖：CRLF、LF、UTF-8 BOM、无 BOM、无末尾换行、混合 EOL、UTF-16、GBK 提示、只读文件。

### 3.2 任务模型与解析规范

文件是唯一数据源。

```md
# 今日待办

- [ ] 写周报
  - [ ] 收集数据
    1. [x] 核对预算
- [x] 买牛奶
- [ ] 看文档
```

任务语法：

- 无序：`- [ ]`、`* [ ]`、`+ [ ]`。
- 有序：`1. [ ]`、`1) [ ]`，序号任意。
- 完成：`[ ]`、`[x]`、`[X]`。
- 缩进任意；Tab 按 4 列 tab stop 展开；用“缩进列 + 列表栈”算深度。
- 跳过 fenced code block、缩进代码块、YAML front matter。
- blockquote 不纳入；组件跳过，编辑预览复选框禁用。
- 续行定义：非空行、缩进到任务内容列、不是新列表项、不是新任务；空行结束续行。续行归属上一条任务，不单独显示、不单独计数。
- 非任务父列表项不计数，但参与列表栈，子任务继承深度。
- 缩进代码块与续行区分：在列表项上下文中，缩进到内容列且不是列表标记的行是续行；不在列表项上下文、缩进 ≥4 列是缩进代码，跳过。
- 表格单元格里的 `[ ]` 不算任务；只识别行首列表项。
- front matter 必须首行 `---` 且有闭合；否则按普通文本。
- 混合 EOL/BOM 先归一后再解析；解析层只看 LF 文本。
- 组件每级缩进 16px，最多 3 级；更深任务仍计数，按第 3 级显示。
- 所有任务计入 5/15 条和进度；进度为已完成/总数（含嵌套）。
- 父子完成状态独立，不级联。
- 隐藏已完成：父项已完成且所有后代完成才连子树隐藏；否则保留父项上下文。
- 任务索引按文档顺序；JS 与 Rust 各自实现同一份规范，跑同一份 golden corpus。

渲染：

- 组件内任务支持行内 Markdown：粗体、斜体、行内代码、删除线；链接只显示文字。
- 编辑窗口完整 GFM 预览；HTML 关闭、图片不加载；blockquote 复选框禁用。
- markdown-it 需要任务列表插件或自定义 renderer；插件版本锁定。
- 自定义 renderer 丢弃图片节点；链接拦截，仅 http/https 交给系统浏览器。

corpus 与 fuzz：

- corpus 放 `shared/corpus/*.json`。
- Rust 与 Vitest 跑同一份；输出任务数组、索引、源行号、完成状态、深度。
- 再加随机文档 fuzz 对比两套解析器，至少覆盖列表、code、blockquote、表格、front matter、EOL 混合。
- 规范是 P0 契约；先改 corpus，再改实现。

### 3.3 编辑器草稿、勾选与撤销

- 编辑器使用非受控 textarea，草稿以 DOM 值为准；不把 1MB 文本塞进 React 受控状态。
- 每次草稿变更递增 `currentRevision`；输入、勾选、撤销、IME 结束都算。
- 预览 250ms 防抖；预览 DOM 提交后才更新 `renderedRevision`。
- JS 解析器按 §3.2 规范解析草稿，为每个复选框生成 `data-task-index`。
- 点击复选框先校验 `renderedRevision === currentRevision`；一致就切换草稿对应行；不一致先刷新预览，不按旧索引改文本。
- 勾选只改草稿；原 `set_task_checked` 从预览路径移除。
- 勾选写回草稿使用 `setRangeText`，维护最小撤销栈；实测 WebView2 是否进入原生撤销。若不进入，自定义撤销只记录复选框操作，并与原生文本撤销互斥，避免 Ctrl+Z 双回退。
- IME：compositionstart 暂停自动保存和预览同步，不主动改写 textarea；compositionend 后读取当前值，递增 revision，刷新预览，重启计时。
- 快捷键：`Ctrl+S` 保存；`Ctrl+Z` / `Ctrl+Y` 撤销/重做；`Tab` 插入 4 空格；`Shift+Tab` 反缩进。
- 状态栏显示“保存中 / 已保存 / 保存失败 / 重试”，并显示只读、超大、冲突状态。

### 3.4 保存状态机、原子替换与冲突

保存请求：

- 参数 `{baseDiskHash, revision, content}`；Rust 只做磁盘冲突检测、原子写、备份。
- 编辑器同一时间只允许一笔保存在途；保存中继续编辑只更新本地最新草稿。
- 收到 ack 后更新 `baseDiskHash`；若 revision 变化再发下一笔。
- Rust 侧串行写入；单槽 pending 只保留最新内容。
- 旧 revision 只在 pending 中丢弃；在途请求不可取消。
- 状态机：idle → saving → ack / conflict / error。
- conflict 状态下停止自动续传，必须用户选择“重新加载 / 覆盖保存”。
- 覆盖保存：用最新草稿 + 重新读取的当前磁盘哈希 + 先备份当前磁盘内容，再发一笔。
- 重新加载前提供“另存草稿”入口；不能直接丢草稿。
- error 状态下保留内容，显示重试/另存为。
- 关闭编辑窗口：saving 时等待 ack 或超时提示；conflict 时三选一“保存并关闭 / 放弃 / 取消”；error 时保持窗口。
- 从托盘退出：同关闭逻辑；`WM_QUERYENDSESSION` 时强制落盘并记录。
- 文件切换：先落盘或提示；加载新文件失败保留旧文件和草稿。
- 编辑器窗口记住大小/位置并夹回屏幕。

原子替换：

- 临时文件放同目录同卷。
- 目标存在时优先 `ReplaceFileW`，保留 ACL、创建时间、属性；失败再退 `MoveFileEx`。
- 新文件用 `MoveFileEx` 或等价安全替换。
- 失败重试并退避；保留原文件。
- 临时文件写入失败不能破坏原文件。

Check-then-replace 覆盖窗口：

- 写前校验 + 原子替换不是跨进程事务。
- 校验后到替换前的外部写入，会被我们的替换覆盖；这是 check-then-replace 覆盖窗口，不承诺外部写入不会被覆盖。
- 记录日志，不引入跨进程文件锁。

### 3.5 文件监听

- 监听父目录，按文件名过滤；150ms 防抖。
- 每次事件重读文件、计算原始字节哈希，和 `lastCommittedHash` 比较；不用 `(mtime, size, hash)` 单条记录命中来忽略。
- 哈希不同视为外部修改：组件重载；编辑窗口有草稿则显示冲突条，干净则同步重载并更新 `baseDiskHash`。
- 原子替换不会让父目录监听失效；不在每次写入后重新挂载。只有监听丢失、目录被删除/重命名时才重挂。
- 外部重命名/移动后，父目录事件触发重新绑定提示；不静默丢失当前文件。
- 网络盘/OneDrive 的 watcher 尽力而为；解锁、聚焦、打开编辑时主动重读。

### 3.6 备份

- 会话 = 应用进程生命周期。
- 首次写入前备份 1 次；之后每 5 分钟或关闭编辑窗口时备份。
- 备份内容：首次/写前备份用写入前磁盘内容；定时/关闭用当时磁盘内容；按原始字节哈希去重。
- 保留：最近 10 份 + 24 小时内每小时 1 份 + 7 天内每天 1 份 = 41 份。
- 每源上限 41 份 / 200MB；全局 1GB 软上限。
- 全局超限时按最旧裁剪，但每个源文件至少保留 1 份；超限记日志。
- 备份写入也走同一写入队列；manifest 更新原子。
- manifest 是每个源文件的备份目录一份：`backups/<pathHash>/manifest.json`，不是用户源文件目录。
- manifest 记录原始路径、规范化路径、时间、原因、内容哈希、大小、BOM/EOL 信息。
- 备份文件名包含时间、原因、哈希短码，便于手动恢复。
- 路径哈希前做 canonicalize、大小写归一、去尾部斜杠。
- 备份和日志放 LocalAppData；设置放 Roaming。
- 备份失败：记日志 + 非阻塞提示，主文件继续保存；主文件写入失败才保留编辑窗口。
- 备份不是设置项；设置页只提供“打开数据目录”入口，文档写手动恢复步骤。

### 3.7 设置 schema

设置文件：`%APPDATA%\com.sotto.widget\settings.json`。

| 字段 | 类型 | 默认 | 范围/说明 |
|---|---|---|---|
| schemaVersion | number | 1 | 迁移版本 |
| theme | enum | dark | dark / acrylic |
| fontSize | number | 14 | 12–20 |
| width | number | 360 | 300–480 |
| compact | number | 5 | 3–10 |
| expanded | number | 15 | 5–30，且 ≥ compact |
| hideCompleted | boolean | false | 隐藏已完成 |
| locked | boolean | false | 锁定位置 |
| autostart | enum | unset | unset / enabled / disabled |
| autostartAsked | boolean | false | 是否已询问 |
| lastFile | string | 已知文件夹默认路径 | 当前 Markdown |
| recentFiles | string[5] | [] | 去重、失效移除 |
| windowPosition | object | null | 物理 x/y + monitorDevicePath |
| editorWindow | object | null | x/y/width/height + monitorDevicePath |
| widgetVisible | boolean | true | 组件是否显示 |
| keepOnShowDesktop | boolean | false | 托盘“显示桌面时保持组件”开关 |

- `autostart` 与 `autostartAsked` 分离；未询问是 unset，不写注册表。
- 迁移：按 schemaVersion 逐级迁移；未知字段保留或忽略，记录日志。
- 损坏：备份损坏文件到 `settings.corrupt.json`，恢复默认，记录日志，不阻塞启动。
- 启动时校验范围；expanded 小于 compact 时夹到 compact。
- 设置页只暴露 8 项：theme、fontSize、width、compact、expanded、hideCompleted、locked、autostart。
- 其余是内部字段，不出现在设置页。

### 3.8 Windows 文件语义

- 支持 UNC、长路径 `\\?\`、OneDrive 按需下载、只读文件、符号链接/junction。
- 原子替换保留 ACL、创建时间、属性；临时文件同目录同卷。
- 外部重命名后，watcher 提示重新绑定；不静默丢当前文件。
- 只读文件：读取允许，自动保存关闭，横幅提示；保存按钮禁用。
- OneDrive 未下载文件：读取时触发下载或提示；失败进入错误态。
- 文件被占用：重试退避，保留草稿。
- 磁盘满、权限拒绝、编码错误：明确提示，不覆盖原文件。

---

## 4. 组件（只读）

### 4.1 交互

内容区只有两个左键动作：

1. 点铅笔：打开编辑窗口，不触发展开/收起。
2. 点其余位置：紧凑/展开切换。

另外三个操作：

- 滚轮：滚动任务列表；紧凑/展开都可用。
- 顶部拖动条：紧凑/展开都可移动窗口；锁定后消失。
- 锁定：托盘、编辑窗口、`Ctrl+Alt+L`；只影响移动。

明确不做：

- 无复选框、hover 工具栏、右键菜单。
- 无内联编辑、双击编辑、整行点击完成。
- 内容区永远不能拖动窗口；顶部条是唯一移动入口。
- 链接只显示文字，不生成 href。
- 无手动缩放；宽度/条数在编辑窗口设置。
- 无焦点时不能选中/复制/键盘操作。

### 4.2 显示与计数

- 紧凑默认 5 条；展开默认 15 条；高度公式见 §4.3。
- 每条固定单行，超出省略号；标题同样单行省略。
- 所有任务（含嵌套）计入 5/15 和进度；进度例如 3/7。
- 嵌套每级 16px，最多 3 级；更深按第 3 级显示并计数。
- 已完成删除线 + 降低透明度；组件无勾选入口。
- 隐藏已完成父项规则同 §3.2。
- “还有 N 条”不包含被隐藏的已完成任务；进度仍按全量。
- 全部隐藏时显示“全部完成”。

### 4.3 展开、底部提示与手势

展开高度：

`height = min(expanded 条数对应高度, 工作区 60%, 窗口下方可用空间)`。

- 下方不足 3 条时改为向上展开。
- 展开后仍只读；内容区不拖动。
- 底部提示预留固定高度，避免出现/消失时窗口跳动。
- 底部提示四态：
  1. 紧凑有溢出：“还有 N 条”。
  2. 紧凑无溢出：“点击展开”。
  3. 展开无溢出：“点击收起”。
  4. 滚到底 N=0：“已到底”。
- N 按当前视口之后还能滚动到的任务计算，排除隐藏已完成。
- 滚轮滚到边界不触发展开。
- 双击或 300ms 内二次点击只算一次；第二次不叠加展开/收起。
- 滚轮在标题/拖动条上同样滚动列表，不触发展开。
- 锁定后显示锁图标，并预留拖动条空间，标题不跳位。

### 4.4 空状态与首次运行

| 状态 | 组件显示 |
|---|---|
| 无任务 | 没有任务 · 点铅笔打开编辑器 |
| 空文件 | 文件为空 · 点铅笔打开编辑器 |
| 文件缺失 | 文件不存在 · 请重新选择 |
| 无 H1 | 标题用文件名；编辑器提示 |
| 读取错误 | 无法读取文件 · 打开编辑器查看详情 |
| 全部完成 | 全部完成 |

首次运行：

- 默认文件用 `SHGetKnownFolderPath(FOLDERID_Documents)` 定位 Documents，再拼 `Sotto.md`；不写死 `%USERPROFILE%`。
- 若文件已存在直接使用，不覆盖；不存在则创建 UTF-8 无 BOM、CRLF、末尾一个换行的示例。
- 仅手动首启弹一次自启询问；登录自启永不弹。
- 对话框优先不抢焦点；若系统强制激活，记录为一次性行为。键盘可操作。
- 关闭对话框或未选择按不启用处理；不再追问。
- 选择结果和 asked 标志写入 settings；只有启用才写 HKCU Run。
- 手动启动立即显示组件；2 秒延迟只用于登录自启。
- 编辑窗口未开时，亚克力回退提示用托盘通知；编辑窗口开着时用状态栏提示。

### 4.5 界面草案

```text
┌──────────────────────────────────┐
│ 今日待办（过长标题自动省略…） 3/7  ✎ │
│ ● 写周报                           │
│   ● 收集数据                       │
│     ● 核对预算                     │
│ ✓ ~~买牛奶~~                       │
│ ● 看文档                           │
│ 还有 2 条                          │
└──────────────────────────────────┘
```

首次运行对话框：

```text
┌─ 首次运行 ─────────────────────┐
│ 是否开机自动启动 Sotto？    │
│                                │
│ [启用]      [暂不启用]          │
│ [打开编辑器]                    │
│ 之后可在托盘或设置中修改。      │
└────────────────────────────────┘
```

---

## 5. 编辑窗口

- 独立普通窗口，约 960×640，可缩放，最小 760×520；深色。
- 顶部显示文件名/路径；选择已有 `.md` 或新建；最近 5 个。
- 最近文件去重；失效路径自动移除；切换前处理未保存草稿。
- 编辑页左源码、右预览；预览 250ms 防抖。
- 预览模式：
  - 打开文件时静态判断：>2000 行或 >512KB 直接任务专用视图。
  - 任务专用视图：只显示任务 + 复选框 + 缩进；blockquote 复选框禁用；标题/表格/代码块不渲染。
  - 提供“加载完整预览”按钮；不等待渲染卡顿后再降级。
  - 完整预览基准：5000 行 / 1MB、4 核/8GB/SSD、平衡电源、当前 WebView2，目标 <300ms；不达标保留任务视图。
- 快捷键：`Ctrl+S`、`Ctrl+Z`、`Ctrl+Y`、`Tab` 4 空格、`Shift+Tab` 反缩进。
- 状态栏：保存中/已保存/保存失败/重试；只读/超大/冲突。
- 只读文件关闭自动保存，显示横幅；超大文件读取允许、保存拒绝。
- 关闭窗口三选一：保存并关闭 / 放弃 / 取消。
- 编辑窗口记住大小/位置并夹回屏幕；任务栏自动隐藏改变工作区时重夹。
- 关闭编辑窗口不退出程序；组件/托盘继续运行。
- 设置页 8 项：theme、fontSize、width、compact、expanded、hideCompleted、locked、autostart。
- 设置页两个动作：打开数据目录、重置位置。
- 快捷键说明只读；不提供自定义。
- 已删除设置：字体族、文字/完成/强调色、背景透明度、边框宽度/颜色、圆角、恢复主题默认、备份数量/恢复、快捷键自定义。
- 保存/冲突/草稿/IME/撤销按 §3.3、§3.4 执行。
- 状态栏显示只读、超大、冲突三种异常。

---

## 6. 窗口、系统与主题

### 6.1 焦点模式：P0 选定模式 1

2026-10-17 P0 结论：模式 1，`focusable(false)` 原生可用。点击不抢焦点，非前台滚轮可滚动，顶部条拖动正常。

实现：

- 前端 `setupDesktopLayer(theme)` 调用 `setFocusable(false)`、`set_desktop_layer` 和 `set_acrylic`。
- 不在运行期自动切换模式；不启用 raw input 滚轮。
- 模式 3（可聚焦降级）只保留为文档化兜底。未来若在别的机器滚轮失效，明确切换并在托盘提示，不得静默降级。
- 不做点击聚焦作为默认行为。
- P0 证据见 `docs/P0-REPORT.md`。

### 6.2 滚轮矩阵

P0 已测：默认系统设置下，组件非前台时滚轮可用，`scrollTop` 0→72，焦点未变。

- 第 7 项“关闭系统非活动窗口滚动”需要重启 Explorer 才生效，本轮未完成交叉验证；已恢复系统原值，不阻塞默认路径。
- 实现依赖 WebView2 在 `WS_EX_NOACTIVATE` 下的默认滚动行为；不加全局鼠标钩子，不做 raw input。
- 若后续在关闭该设置的机器上确认失效，再按模式 3 或一次性提示处理；不得静默改变焦点模式。
- 系统设置关闭时，设置页给一次性提示，文档写明限制。

### 6.3 拖动与锁定

- 顶部拖动条紧凑/展开都可用。
- 内容区永不可拖；锁定后拖动条消失、显示锁图标、全禁移动。
- 锁定只影响移动，不影响展开/滚动/编辑。
- 锁定状态持久化；托盘、编辑窗口、`Ctrl+Alt+L` 切换。

### 6.4 坐标与显示器

- 保存物理像素位置 + 稳定显示器标识。
- 优先 `monitorDevicePath`；不可用时设备名 + 几何最近匹配。
- 启动/DPI/拔插时按当前工作区物理矩形夹回。
- 拔掉夹回最近工作区；插回不自动跳回；可拖动或重置位置。
- 设置位置时按目标屏 scale 转一次；禁止跨屏复用逻辑坐标。
- 混合 DPI 下位置用物理值，宽度/行高用逻辑值。
- 任务栏自动隐藏改变工作区时重夹位置。
- 重置位置：当前主屏右下角 24px 边距。

### 6.5 Win+D 与生命周期

- P0 实测：Win+D 后组件保留在桌面层可见，不进入最小化，也不挡桌面图标（它在图标层之上、普通窗口之下）。
- 因此不需要“显示桌面时保持组件”开关，也不需要自动恢复逻辑。
- 会话解锁/唤醒：重读文件、重挂 watcher、重应用效果、重算位置/最大高度。
- RDP 重连：同上；亚克力按手动设置决定是否重试。
- Explorer 重启：组件独立；重注册托盘，必要时处理 TaskbarCreated。
- 显示器/DPI 变化：重算位置和展开最大高度。
- 文件移动/删除：组件错误态；编辑窗口重新选择。
- 网络盘/OneDrive：解锁、聚焦、打开编辑时重读。
- 全屏应用：组件在最底层，被自然覆盖。
- 虚拟桌面：组件停留原桌面，已知限制。
- `WM_QUERYENDSESSION`：强制落盘；失败记录日志。
- 单实例启动竞态：等待/重试，不新开进程。
- 崩溃草稿恢复：可选，不列入 v0.5 必做。

### 6.6 首启、自启与托盘

- 自启默认未设置；仅手动首启询问；登录自启不弹。
- 2 秒延迟只用于登录自启；手动启动立即显示。
- 对话框优先不抢焦点；键盘可操作；若系统强制激活，记录一次性行为。
- 自启注册失败：显示错误，不标记已启用；asked 保留，不再自动追问。
- 读 `StartupApproved\Run`，显示“已被系统禁用”；不强行改回。
- 注册表被外部删除但设置仍启用：下次启动重新注册。
- 托盘菜单：打开编辑、显示/隐藏组件、锁定位置、主题切换、开机自启、退出。
- 托盘左键：切换组件显示；右键：菜单。
- 单实例：重复启动唤出编辑窗口。
- 退出只能从托盘或编辑窗口；组件无关闭按钮。

### 6.7 主题

| 主题 | 表现 | 说明 |
|---|---|---|
| 深色（默认） | 近黑卡片、浅色文字、细边框、圆角 | 稳定 |
| 亚克力 | 透明窗口 + DWM 亚克力 + 深色半透明覆盖层 | `set_acrylic` 命令按主题开关；失败回退深色 |

- 固定配色；无自定义字体族/颜色/边框/圆角/透明度。
- 启动读取 `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize` 的 `EnableTransparency`；为 0 直接用深色。
- P0 实测：系统透明关闭 + 亚克力 ON 时不模糊但仍为灰色背景，无黑底；设置已恢复。
- RDP/运行中失败不可靠自动探测；手动切换；不承诺自动检测变化。
- 设置页显示 effective theme：如“当前主题：深色（亚克力不可用）”。
- 首次回退：编辑窗口开着用状态栏；没开用托盘通知。组件不弹窗。
- 系统透明改回后用户手动重选。
- 编辑窗口始终深色，不跟随亚克力。
- 圆角优先 DWM；毛边时回退圆角裁剪 + 细边框。

---

## 7. 架构、接口与安全

### 7.1 结构

```text
Sotto/
├─ src-tauri/                 Rust 主进程
│  ├─ src/lib.rs              启动、插件、托盘、快捷键
│  ├─ src/window.rs           置底、焦点模式、展开尺寸、亚克力
│  ├─ src/bytes.rs            BOM/EOL/编码检测与转换
│  ├─ src/atomic.rs           ReplaceFileW / MoveFileEx
│  ├─ src/markdown.rs         任务解析/golden corpus 适配
│  ├─ src/files.rs             单写入队列、状态机、冲突检测
│  ├─ src/backup.rs           备份、manifest、41 份裁剪
│  ├─ src/watcher.rs          父目录监听、重读哈希
│  ├─ src/settings.rs         schema、迁移、损坏回退
│  ├─ src/lifecycle.rs        解锁/唤醒/RDP/DPI
│  └─ src/commands.rs         前端命令
├─ src/widget/                组件页
├─ src/editor/                编辑页
├─ src/shared/                类型、命令参数、任务规范
├─ shared/corpus/*.json       JS/Rust 共用 corpus
├─ src-tauri/capabilities/    权限白名单
├─ scripts/build.ps1          Windows 构建
├─ rust-toolchain.toml        Rust 版本
└─ .github/workflows/         可选 CI
```

### 7.2 命令

- `get_snapshot`：文件 + 任务 + 设置 + 字节元数据。
- `save_markdown`：`{baseDiskHash, revision, content}`；状态机、冲突、原子写、备份。
- `set_desktop_layer`：Win32 桌面层定位（P0 已实现）。
- `set_acrylic`：按主题开关 DWM 亚克力（P0 已实现）。
- `open_editor`、`pick_markdown_file`、`set_expanded`、`set_locked`、`save_settings`、`set_theme`、`reset_position`、`open_data_dir`。
- 已移除 `set_task_checked`；预览不直接写磁盘。
- 事件：`file-changed`、`settings-changed`、`editor-opened`、`backup-failed`、`save-state`。

### 7.3 数据位置

- 设置：`%APPDATA%\com.sotto.widget\settings.json`（Roaming，小）。
- 备份：`%LOCALAPPDATA%\com.sotto.widget\backups\<pathHash>\`（Local，大）。
- 日志：`%LOCALAPPDATA%\com.sotto.widget\logs\`。
- Markdown：用户任意路径。
- 免安装 exe，数据仍在 AppData；不做真便携模式。文档明确写“免安装 exe（数据在 AppData）”。

### 7.4 安全

- CSP：
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'none'; connect-src ipc: http://ipc.localhost; object-src 'none'`
- markdown-it `html:false`、`linkify:false`；renderer 丢弃图片。
- 链接仅 http/https；组件不生成可点击 href。
- 拦截导航、`window.open`、`target=_blank`；禁止 file:// 和内部跳转。
- 文件读写只走 Rust command；不开 fs 宽 scope；不引入 shell 插件。
- 路径 canonicalize、存在性、`.md` 类型、大小校验；读取允许超限，保存拒绝。
- opener 只放行 http/https；无网络请求、无遥测。

### 7.5 版本与构建

- 锁定 tauri crate、`@tauri-apps/api`、`Cargo.lock`、`pnpm-lock.yaml`；CI frozen。
- rust-toolchain.toml 固定验证过的 stable；Node engines `>=20`。
- `setFocusable` 与 Tauri 版本绑定；P0 已在本机验证模式 1 可用。
- `src-tauri/Cargo.toml` 使用 `crate-type = ["rlib"]`；这是 windows-gnu + rust-lld 下桌面构建的限制，已由 P0 构建验证。
- 构建/原生验收在 Win11；Linux DSH 用于前端、Rust 核心单测、Playwright 截图和文档。
- Windows P0 使用隔离的 GNU 工具链；详见 `docs/DEV-ENV.md`。

---

## 8. 难点与对策

| 难点 | 风险 | 对策 |
|---|---|---|
| EOL/BOM/末尾换行 | 全量保存改坏行尾/丢 BOM | 原始字节哈希；Rust 按原 EOL/BOM/末尾换行写回；混合 EOL 一次性提示 |
| 编码 | UTF-16/GBK 静默变替换字符 | BOM/编码检测；只读提示；建议另存 UTF-8；不静默转码 |
| 原子替换 | rename 丢 ACL/属性/创建时间 | ReplaceFileW；临时同目录同卷；MoveFileEx 回退；ACL/属性/UNC/长路径测试 |
| 保存状态机 | 在途取消、假冲突、丢最后一笔 | idle/saving/ack/conflict/error；单飞；pending 最新；在途不取消；冲突停自动保存 |
| 外部写入覆盖窗口 | 校验后替换前外部写入被覆盖 | 明确 check-then-replace 覆盖窗口；记日志；不承诺外部写入不被覆盖 |
| 备份 41/40 | 保留规则和上限冲突 | 每源 41；10+24+7；200MB/1GB；每源至少 1；manifest 原子 |
| 解析 JS/Rust 分叉 | 嵌套/续行/代码块/表格错位 | 同一规范 + `shared/corpus` + fuzz；续行/非任务父项/缩进代码定义 |
| 焦点模式 | 静默 fallback 破坏桌面体验 | P0 选定模式 1；降级模式只文档化；不运行时自动切换 |
| 动态壁纸 / WorkerW | `setAlwaysOnBottom` 被壁纸盖住 | 自定义 `set_desktop_layer`，插到含 `SHELLDLL_DefView` 的 WorkerW 之上；找不到回退 Progman |
| Win+D | 自动恢复挡住桌面图标 | P0 实测保持可见；无恢复开关 |
| 非活动窗口滚动关闭 | 第 7 项未完成交叉验证 | 默认路径已通过；重测需重启 Explorer；不预置 raw input |
| 首启 | OneDrive 重定向/登录弹窗 | known folder；仅手动首启；登录不弹；2s 仅登录 |
| 预览性能 | 1MB/5000 行卡顿 | >2000 行/512KB 静态任务视图；“加载完整预览”按钮；不卡后降级 |
| 无焦点能力 | 不能复制/键盘 | 明确边界；编辑窗口输入；托盘提示 |
| CI 不能驱动 WebView2 | 原生行为漏测 | Playwright 只跑前端+mock IPC；windows-latest 测 Rust/文件/窗口；P0 手工矩阵；tauri-driver 可选 |

---

## 9. 测试与验收

### 9.1 测试分层

| 层 | 内容 |
|---|---|
| golden/fuzz | JS/Rust 同一 corpus；任务数组/索引/行号/完成/深度；随机文档 fuzz |
| Rust 单测 | BOM/EOL/末尾换行、编码、ReplaceFileW/ACL/属性、UNC/长路径、状态机、备份 41/manifest、watcher |
| 前端 Vitest/Playwright | Vite + mock IPC；两个内容交互、5/15、底部四态、revision、IME、快捷键、设置 8、预览模式 |
| Windows CI | Rust/文件/窗口测试跑 windows-latest；corpus Linux + Windows |
| Windows 实机 | P0 焦点/滚轮矩阵、置底、Alt+Tab、DPR/多屏、RDP、Explorer、Win+D、首启；P0 已完成，见 `docs/P0-REPORT.md` |
| 安全 | CSP、图片不请求、导航/window.open 拦截、协议白名单 |
| 构建 | 锁文件、exe、图标、版本、WebView2 最低版本 |

Playwright 不能驱动 WebView2；它只负责 Vite + mock IPC 的前端测试和截图。原生交互用 P0 手工矩阵；tauri-driver 可选。

Windows 11 22H2 只作最低 API 声明；实机验收覆盖 24H2/25H2。M1 用 mock IPC；M2 接真后端。

### 9.2 Windows 验收清单

1. 启动无标题栏/任务栏项；普通窗口能盖住它。
2. 内容区只有铅笔和点击展开；展开只读；内容区不可拖动。
3. 5/15 条；长标题/任务省略；完整内容在编辑窗口。
4. 底部四态正确；滚到边界不展开；高度稳定；双击/300ms 二次点击只算一次。
5. 嵌套显示/计数/勾选/隐藏正确；每级 16px、最多 3 级；非任务父项给深度。
6. 拖动条紧凑/展开可用；锁定后消失、锁图标出现、全禁移动。
7. 焦点模式为 P0 选定的模式 1；降级模式只文档化；无静默切换。
8. 系统非活动滚动开/关矩阵有记录；默认开已通过，关闭项待 Explorer 重启后补测。
9. `Ctrl+Alt+E`/`Ctrl+Alt+L`；UIPI 实测结果记录。
10. 中文 IME 不跳光标；composition 后保存正常。
11. 首启仅手动弹；known folder；未同意无注册表；登录自启不弹；2s 只用于登录。
12. 任意 `.md`；编辑/勾选/保存同步；blockquote 复选框禁用。
13. BOM/EOL/末尾换行保留；混合 EOL 提示；新文件 CRLF/UTF-8 no BOM/单末尾换行。
14. UTF-16/GBK 只读提示；只读文件横幅；超限读取允许、保存拒绝。
15. 保存状态机、单飞、冲突、覆盖保存、重新加载、关闭三选一。
16. 备份 41/manifest/全局 1GB/每源 1 份；备份失败不阻塞主保存。
17. 外部修改/check-then-replace 覆盖窗口有测试记录；watcher 不重复重挂。
18. 深色/亚克力/effective theme/回退通知；RDP 手动。
19. 150%/200% DPI、多屏、任务栏自动隐藏、拔插后夹回；插回不跳屏。
20. Win+D 后组件保持桌面层可见；无恢复开关。
21. 解锁/唤醒/RDP/Explorer/混合 DPI 恢复；WM_QUERYENDSESSION 落盘。
22. 5000 行/1MB 基准或任务专用视图；编辑窗口 bounds 恢复。
23. exe ≤15MB；内存 ≤120MB；CPU <1%；启动 ≤3s。

### 9.3 验收指标

- 组件只有铅笔和点击展开两个内容交互。
- 编辑/划线只在编辑窗口；组件只展示删除线。
- 全量保存不改变原 EOL/BOM/末尾换行；baseDiskHash 用原始字节。
- 嵌套全部计数；进度含嵌套。
- 任意 md 可选；1MB 读取允许、保存拒绝。
- 首启未同意无注册表；登录自启无弹窗。
- 备份 41 份/manifest/全局 1GB/每源 1 份。
- 保存单飞无假冲突；外部冲突不静默覆盖。
- 焦点模式 P0 选 1；Win+D 后保持可见。
- 预览超过 2000 行/512KB 默认任务专用视图；完整预览按钮可用。

---

## 10. 里程碑与工时

| 阶段 | 内容 | 预计 |
|---|---|---|
| P0 | Tauri 探针：焦点模式三选一、滚轮矩阵、置底、亚克力/透明、物理坐标、拖动；构建前置检查 | 3–5 小时 |
| M1 | 组件 UI、固定主题、5/15、底部四态、展开向上、嵌套显示、铅笔、托盘、首启询问、mock IPC、截图 | 6–8 小时 |
| M2 | 字节/EOL/BOM/编码、原子替换、状态机、解析规范/corpus/fuzz、草稿 revision、单飞保存、备份/manifest、watcher、编辑窗口、IME/撤销、设置 schema | 18–23 小时 |
| M3 | 焦点模式落地、Win+D、系统生命周期、Windows 文件语义、CI、测试、构建、文档 | 6–8 小时 |
| 验收 | 按 §9.2 跑 1–2 轮 | 1–2 小时 |
| 合计 | 含风险缓冲 | 34–46 小时，5–6 个工作日 |

v0.4 的 28–38 小时是数据完整性补丁前的估算。v0.5 新增 EOL/BOM/编码、ReplaceFileW、状态机、settings schema、fuzz、Windows 语义和 CI，低端 28 小时不再成立。如果必须压回 28–38，需要砍 fuzz、tauri-driver、崩溃恢复等非核心项，并接受较高风险。

---

## 11. 构建、交付与文档

### 11.1 构建

```powershell
# Win11 构建机，已安装 Node 20+、Rust MSVC、VS Build Tools C++
pnpm install
pnpm tauri dev
pnpm tauri build
```

- 构建前检查 Node、Rust、VS Build Tools、WebView2、锁文件。
- 产物：免安装 exe（数据仍在 AppData）和 NSIS 安装包（可选）。
- 未签名；SmartScreen 提示；不做自动更新。
- bundle identifier：`com.sotto.widget`。
- 应用版本：`0.1.0`；方案版本：v0.5。
- 图标、`rust-toolchain.toml`、Node engines、WebView2 最低版本在 P0/构建时固定并写入文档。
- WebView2 在 Win11 自带；极少数精简系统缺失时提示安装。

### 11.2 CI

- GitHub Actions windows-latest 构建 + Rust/文件/窗口测试；corpus Linux/Windows 各跑一次。
- Playwright 只跑 Vite + mock IPC；不宣称驱动 WebView2。
- 可选 tauri-driver 做原生冒烟，不阻塞 MVP。
- M1 用 mock IPC；M2 接真后端。

### 11.3 交付物

1. 源码、构建脚本、CI 工作流、锁定文件、rust-toolchain.toml。
2. 使用说明：安装、自启、快捷键、文件选择、备份恢复、卸载。
3. Playwright 截图和测试报告。
4. Windows 构建产物在 Win11 或 CI 产出。

### 11.4 文档与卸载

- 卸载说明：删 exe/安装目录、删 HKCU Run、删 `%APPDATA%\com.sotto.widget` 和 `%LOCALAPPDATA%\com.sotto.widget`。
- 备份手动恢复步骤：从 `%LOCALAPPDATA%\com.sotto.widget\backups\<pathHash>\` 按 manifest 找文件，复制回原路径，在编辑窗口重新打开。
- 已知限制：无 WorkerW、无复制/键盘、虚拟桌面、无自定义样式、无自动更新、无签名、高对比度/系统文字缩放不保证。
- 中文 UI only。
- License 未定（见 §14）。

### 11.5 工具与依赖

- 实现：文件读写、终端、Playwright、cargo test、GitHub Actions。
- 运行时/构建：Tauri 2、Rust、React、TypeScript、Vite、markdown-it + 任务列表插件、serde、notify、Tauri 插件（autostart、global-shortcut、dialog、opener、single-instance、log）、WebView2。
- 不启用 fs 宽 scope、不引入 shell；文件读写走 Rust command。
- Windows API：ReplaceFileW、MoveFileEx、SetWindowPos、SetWindowLongPtr、DWM、raw input（仅 P0 失败时）。

---

## 12. 边界与假设

- 仅 Windows 11 x64 22H2+；不支持 Win10/ARM64。
- 组件是桌面层，不是 WorkerW；会盖住桌面图标。
- 组件只读；无焦点时不能复制/键盘操作。
- 编辑窗口是唯一编辑入口；组件链接不响应。
- 组件停留原虚拟桌面。
- 嵌套组件最多 3 级；更深计数、按第 3 级显示。
- blockquote 不纳入；代码块跳过；有序任务纳入。
- 预览不渲染图片/HTML；任务专用视图不渲染标题/表格/代码块。
- 首启必须手动；登录自启不弹；未同意不写注册表。
- 固定双主题；无自定义字体/颜色/边框/圆角/透明度。
- 设置页只有 8 项 + 2 动作。
- 1MB 读取允许、保存拒绝；5000 行同理。
- 备份 41 份/200MB/1GB 软上限；LocalAppData。
- 设置 Roaming；免安装 exe；无真便携模式。
- 保存 check-then-replace 有覆盖窗口；记录日志，不承诺外部写入不被覆盖。
- 无云同步、多清单、提醒、自动更新、签名。
- WebView2 内存下限高于原生 UI。
- 版本/路径/快捷键/主题可在实现前调整；P0 契约/P1 锁定除外。

---

## 13. P1 可调参数

| 参数 | 默认 | 说明 |
|---|---|---|
| 备份保留 | 最近 10 份 + 24h 每小时 1 份 + 7 天每天 1 份 | 每源 41 份 / 200MB；全局 1GB 软上限；至少每源 1 份 |
| 自动保存防抖 | 1 秒；大文件/网络盘 2 秒 | 512KB 阈值 |
| 预览防抖 | 250ms | revision 校验 |
| watcher 防抖 | 150ms | 父目录监听 |
| 首次运行文案 | 见 §4.5 | 可改 |
| 滚轮兼容开关 | 默认不显示 | 需要时放托盘，不进设置页 |

其他默认值在对应章节：5/15 条、宽度 360、1MB/5000 行、16px 缩进、最近 5 个、2000 行/512KB 预览阈值、5000 行 <300ms 基准。调整不改变 P0 结构。

不放入可调项：P0 任务语法、任务索引、保存 payload、`baseDiskHash` 语义、备份 manifest 结构、设置页 8 项范围。

---

## 14. 仍未定

- 第 7 项滚轮矩阵的“关闭系统非活动窗口滚动”分支：需要重启 Explorer 后补测；默认路径不阻塞。
- WebView2 最低版本：P0 实测 155.0.4283.60，最低版本待固定。
- License：MIT / Apache-2.0 / 私有，尚未定。
- 可选 tauri-driver 原生冒烟是否纳入 CI。
- 崩溃草稿恢复是否做；当前不列入必做。
- 高对比度/系统文字缩放支持：当前不保证，若要做另开需求。
- MSVC 与 windows-gnu 双构建是否都保留；P0 使用 GNU，GitHub CI 使用 MSVC，待验证。

---

## 15. 变更记录

| 版本 | 日期 | 变化 |
|---|---|---|
| v0.7 | 2026-10-18 | 写入 P0 结果：焦点模式 1；`setAlwaysOnBottom` 改为 `set_desktop_layer`（WorkerW/Progman 锚点）；`set_acrylic` 按主题开关；Win+D 保持可见；滚轮默认可用，第 7 项待补测 |
| v0.6 | 2026-10-17 | 产品更名为 Sotto：标题、README、bundle id `com.sotto.widget`、默认文件 `Sotto.md`、localStorage/通道前缀同步；设计内容不变 |
| v0.5 | 2026-10-17 | 补 P0 数据完整性：EOL/BOM/末尾换行、编码检测、ReplaceFileW、状态机、备份 41/manifest/LocalAppData、settings schema、解析边界/fuzz、预览静态阈值、焦点模式 P0、Win+D 默认、首启 known folder、编辑页快捷键/关闭提示、数据位置、Windows 语义、CI/交付文档；工时 34–46 小时；仍未定章节 |
| v0.4 | 2026-10-17 | P0 契约/P1 锁定/P1 参数分层；草稿 revision 与单飞保存；watcher 重读哈希；备份 manifest/裁剪；坐标 monitorDevicePath；JS/Rust golden；非受控 textarea；安全导航；28–38 小时 |
| v0.3 | 2026-10-17 | A–E 意见：备份/写入/任务索引、嵌套规则、5/15 条、物理坐标、IME、生命周期、CSP/权限、1MB、异常态、首次运行/自启、设置精简、固定主题、验收与工时 |
| v0.2 | 2026-10-17 | Tauri 2；组件只读；编辑/划线移入编辑窗口；锁定、滚轮、快捷键、深色/亚克力、任意 Markdown 文件 |
| v0.1 | 2026-10-17 | Electron 方案，组件内编辑/勾选，已废弃 |
