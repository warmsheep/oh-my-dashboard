# Changelog

## 0.1.0 (2026-08-21)

初始版本。

- 侧边栏三区面板：配置文件 / 预设 / 备份
- JSONC 结构化编辑（保留注释、尾逗号、缩进风格）
- agent/category 模型与 variant QuickPick 编辑
- 预设：捕获 / 矩阵编辑器 / 合并语义应用 / 重命名 / 删除 / 导出
- 备份：手动 / pre-apply / pre-save / pre-restore，保留策略，diff 对比，恢复
- 状态栏当前预设显示与快速切换（Ctrl+Alt+P）
- 85 项单元+集成测试，e2e 冒烟（test-electron）

## 0.2.0 (2026-08-21)

- 移除所有自动备份（应用预设前 / 保存前 / 恢复前）：仅保留手动「立即备份」
  - 应用预设直接写入；恢复前弹窗明确警告覆盖且不可撤销
  - 移除 `autoBackupOnSave` / `maxAutoBackups` 设置
- 界面全面中文化：命令面板标题、侧边栏视图名、活动栏容器、备份原因标签、Webview 分区标题等

## 0.3.0 (2026-08-21)

- 内置常用模型清单（GLM/Kimi/MiniMax/MiMo/DeepSeek/GPT/Claude/Grok/Gemini 共 15 项），
  首次使用时生成 `~/.config/opencode/models.json`（可手动编辑，损坏自愈）
- 模型列表双源合并：opencode.json providers + 本地清单，同名 id 合并为一（opencode.json 优先）
- 构建产物统一输出到 `build/packages/`（`npm run package`）

## 0.4.0 (2026-08-21)

- 内置模型清单按 models.dev（opencode 官方模型目录）2026-08-21 数据全量刷新，15 → 33 项，
  每系列收录最新主力：GLM-5.3、Kimi K3、MiniMax M3、MiMo v2.5 Pro、DeepSeek V4、
  GPT-5.6、Claude Opus 5 / Sonnet 5、Grok 4.6、Gemini 3.7 Flash 等

## 0.4.1 (2026-08-21)

- Kimi 系列改走 kimi-for-coding 通道（k3 / k3-256k / kimi-for-coding-highspeed）
- 安装脚本在安装后自动重置本地 models.json，确保每次升级后内置模型清单刷新到最新版本

## 0.4.2 (2026-08-21)

- GPT 系列补齐 GPT-5.6 全部变体：gpt-5.6 / Sol / Luna / Terra（models.dev 2026-07-09 发布）

## 0.5.0 (2026-08-21)

- 新增「模型」配置栏：展示合并后的模型清单（opencode.json + models.json，同名合一，标注来源），
  支持自定义添加/删除本地模型（写入 models.json，无需升级插件）
- 预设编辑器实时同步：模型清单变更时，已打开的预设编辑器自动刷新下拉选项（modelsUpdated 推送）
- 新命令：添加模型… / 删除模型 / 打开模型清单文件
