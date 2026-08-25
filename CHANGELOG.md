# Changelog

> 版本与日期以 git 历史为准；0.8.0–0.14.0、0.16.x、0.18.0 等中间版本为本地打包、版本号未入库，相关变更归并入下一个入库版本。

## 0.21.1 (2026-08-24)

- 额度文案措辞统一（5小时窗口→5小时额度，月度额度→月额度）

## 0.21.0 (2026-08-24)

- 额度自动刷新指数退避（30s → 60s → 最长 2 分钟）与全中文错误提示
- 核心层正确性与安全加固，模块拆分（pluginResolver / skillScanner / agentAssignment / watchManager）
- 模板编辑器协议加固与渲染性能优化
- 命令程序化参数与路径守卫、错误映射迁移、configDirOverride 修复
- e2e 套件扩容至 33 步；prettier 风格门禁、webview-ui 测试接入 `npm test`

## 0.20.1 (2026-08-23)

- 「导入备份」命令补图标（inline 菜单与保存图标对齐）

## 0.20.0 (2026-08-23)

- 备份导入/导出（zip 格式，三平台通用；导入校验 manifest、防目录遍历/zip 炸弹）

## 0.19.0 (2026-08-22)

- 跨平台兼容与安全加固（Linux/Windows/macOS）；备份/恢复原子化

## 0.18.0 – 0.18.1 (2026-08-22)

- DeepSeek 按量余额：余额型 provider 加入额度 QuickPick 与 tooltip，按绝对值独立着色

## 0.17.2 (2026-08-22)

- 活动栏图标改为线性 open-book 风格（全尺寸 codicon 墨色）

## 0.16.0 – 0.17.0 (2026-08-22)

- 用户可见术语统一：预设 → 模板、config file → 配置
- 跨工具 skills 发现（全局/项目多目录约定）与插件列示（npm / 本地路径，运行时缓存布局解析）
- skills 备份 extraDirs；插件与 skills 目录变更自动刷新

## 0.15.0 (2026-08-22)

- 「重命名备份」命令与右键菜单

## 0.8.0 – 0.14.1 (2026-08-22)

- Coding Plan 额度：Kimi/GLM/MiMo 额度服务 + 状态栏分窗口独立着色与详情 QuickPick
- 四个树视图合并为单一分区 Explorer；启动性能优化（按需激活、warmup、内容检查的监视管线）
- 命名备份：备份时输入名称（仅展示），列表显示「名称 · 时间戳」

## 0.7.2 (2026-08-22)

- 仅监视受管路径，毫秒级激活

## 0.7.1 (2026-08-22)

- 打包产物卫生；确立「打包前必须递增版本号」规则

## 0.7.0 (2026-08-22)

- agent 配置目标自动检测：按 oh-my-openagent 运行时同序检测 `~/.omo/omo.jsonc` → 旧版 `oh-my-opencode.json[c]` / `oh-my-openagent.json[c]`，模板应用/命令/激活全部路由到检测目标，树中显示检测到的配置文件
- 备份服务支持显式受管文件清单
- Webview 模板行 variant 拓宽
- 修复：批量设模型覆盖模板从未配置过的行；MiMo provider id 修正并扩充内置清单

## 0.6.0 (2026-08-21)

- 侧边栏「模型」栏移至最上方
- 配置文件栏的 command/ skills/ 目录可展开预览子目录与文件树，单击文件直接打开编辑
- 预设节点单击即打开预设编辑器（应用仍走右键菜单，防误触）
- 备份范围纳入 presets/（预设模板随备份保存，恢复时一并还原）

## 0.5.0 (2026-08-21)

- 新增「模型」配置栏：展示合并后的模型清单（opencode.json + models.json，同名合一，标注来源），
  支持自定义添加/删除本地模型（写入 models.json，无需升级插件）
- 预设编辑器实时同步：模型清单变更时，已打开的预设编辑器自动刷新下拉选项（modelsUpdated 推送）
- 新命令：添加模型… / 删除模型 / 打开模型清单文件

## 0.4.2 (2026-08-21)

- GPT 系列补齐 GPT-5.6 全部变体：gpt-5.6 / Sol / Luna / Terra（models.dev 2026-07-09 发布）

## 0.4.1 (2026-08-21)

- Kimi 系列改走 kimi-for-coding 通道（k3 / k3-256k / kimi-for-coding-highspeed）
- 安装脚本在安装后自动重置本地 models.json，确保每次升级后内置模型清单刷新到最新版本

## 0.4.0 (2026-08-21)

- 内置模型清单按 models.dev（opencode 官方模型目录）2026-08-21 数据全量刷新，15 → 33 项，
  每系列收录最新主力：GLM-5.3、Kimi K3、MiniMax M3、MiMo v2.5 Pro、DeepSeek V4、
  GPT-5.6、Claude Opus 5 / Sonnet 5、Grok 4.6、Gemini 3.7 Flash 等

## 0.3.0 (2026-08-21)

- 内置常用模型清单（GLM/Kimi/MiniMax/MiMo/DeepSeek/GPT/Claude/Grok/Gemini 共 15 项），
  首次使用时生成 `~/.config/opencode/models.json`（可手动编辑，损坏自愈）
- 模型列表双源合并：opencode.json providers + 本地清单，同名 id 合并为一（opencode.json 优先）
- 构建产物统一输出到 `build/packages/`（`npm run package`）

## 0.2.0 (2026-08-21)

- 移除所有自动备份（应用预设前 / 保存前 / 恢复前）：仅保留手动「立即备份」
  - 应用预设直接写入；恢复前弹窗明确警告覆盖且不可撤销
  - 移除 `autoBackupOnSave` / `maxAutoBackups` 设置
- 界面全面中文化：命令面板标题、侧边栏视图名、活动栏容器、备份原因标签、Webview 分区标题等

## 0.1.0 (2026-08-21)

初始版本。

- 侧边栏三区面板：配置文件 / 预设 / 备份
- JSONC 结构化编辑（保留注释、尾逗号、缩进风格）
- agent/category 模型与 variant QuickPick 编辑
- 预设：捕获 / 矩阵编辑器 / 合并语义应用 / 重命名 / 删除 / 导出
- 备份：手动 / pre-apply / pre-save / pre-restore，保留策略，diff 对比，恢复
- 状态栏当前预设显示与快速切换（Ctrl+Alt+P）
- 85 项单元+集成测试，e2e 冒烟（test-electron）
