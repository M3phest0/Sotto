# Sotto v2.0.0

Windows 11 桌面便签 + 番茄记录。

## 产物

- `release/Sotto_v2.0/Sotto_2.0.0_x64-setup.exe` — NSIS 安装包
- `release/Sotto_v2.0/Sotto_v2.0.exe` — 免安装可执行文件
- `release/Sotto_v2.0/Sotto_v2.0-portable.zip` — 便携包（exe + 说明）

## 构建

```bash
./build-release.sh
```

依赖项目内虚拟环境 `env/`（Rust GNU 工具链 + cargo 缓存），不写系统目录。

## 功能

- 便签贴在桌面层：Win+D 后仍可见、被普通窗口覆盖、Alt+Tab/任务栏不显示
- 拖动记忆位置、滚轮浏览、勾选完成
- 番茄：每 0.5h 一颗，逐颗显示；左键 +1 / 右键 −1，动画 + 音效
- 编辑器：`Ctrl+Alt+E` 或托盘打开，`Esc`/`Ctrl+W` 收起；进行中/已完成分区；标题、DDL（日期+可选时间）、详情；拖拽排序；多选删除；F2 改标题
- 统计：今天/昨天对比、本周/上周 7 天柱状图、本周按任务投入排行
- 设置：主题三色自定义、便签宽高、音效开关/音量/自定义音频、快捷键、开机自启、导出/导入、打开数据目录
- 数据：`%APPDATA%\Sotto\data.json`（番茄按 `{taskId, ts}` 记录），每天自动备份 7 份

## 已验证（release 包）

- 启动后便签出现在记忆位置，单实例生效
- 编辑器：任务列表/详情渲染、番茄 +1/−1、Esc 收起、`Ctrl+Alt+E` 全局唤起
- 拖动便签 100px 后位置写入 `data.json`，重启读取
- 自动启动路径校正：release 启动时把 Run 键指向当前 exe（测试后已恢复原值）
- 200% DPI、720×1040 物理像素窗口、WebView2 加载本地打包资源、内置音效随包

## 备份

- 本地：`E:\share\Claude\Sotto.0.0.2-backup\sotto-2.0-final-20261113.bundle`（git bundle）与 `sotto-2.0-final-src-20261113.zip`（源码）
- GitHub：未推送。需要确认仓库（现有远端为 `M3phest0/Sotto`）与分支/可见性后执行 `git push -u origin v2.0`。

## 已知限制

- 仅单显示器
- 无"隐藏便签"快捷键（按需求暂不做）
- 无自动计时番茄
