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
