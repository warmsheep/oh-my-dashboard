# OpenCode Config Manager

VSCode 扩展：管理 [opencode](https://opencode.ai) 与 [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) 的配置文件 — 结构化修改、备份、恢复、命名模板一键切换。

## 功能

- **配置面板**（活动栏侧边栏）：模型 / 配置文件 / 模板 / 插件 / 备份分区树形视图
  - 自动识别本机生效的 agent 配置：新版 `~/.omo/omo.jsonc` 的 `[opencode]` 块，或旧版 `oh-my-opencode.json[c]` / `oh-my-openagent.json[c]`（与 oh-my-openagent 运行时同序）
  - `opencode.json`（JSONC，保留注释与尾逗号；`opencode.jsonc` 亦可识别）、`AGENTS.md`（全局+项目级）、`command/`、`skills/`
  - skills 兼容主流 agent 目录约定，家目录下显示为「全局」：全局扫描 `~/.agents/skills`、`~/.claude/skills`、配置目录 `skills/` 等，项目级扫描 `.agents/`、`.claude/`、`.opencode/` 等下的 `skills/`（完整候选序见 AGENTS.md）；跟随符号链接，需含 `SKILL.md`，仅显示实际存在的目录
  - agent/category 节点点击 → QuickPick 选模型与 variant，程序化写回（omo 目标写 `reasoning` 键，同时清理冲突的 `variant`/`models` 链）
- **模型**：清单分组展示（opencode.json / models.json 来源标注）；不内置模型，仅内置供应商白名单，激活后自动从 models.dev 联网初始化空清单；「模型」标题右侧行内按钮：添加模型、**更新模型清单**（从 models.dev 获取当前清单所涉供应商的最新模型并合并进来，用户手动添加的模型不会被覆盖删除）、打开清单文件
- **模板**：从当前配置捕获；管理面板「模板」选项卡默认展示模板列表（名称 / 描述 / 创建与应用时间、未保存草稿标记），点击模板即进入矩阵编辑器（批量设模型、逐行 variant），页内可直接「新建模板」，无需依赖侧栏右键菜单；应用采用合并语义（模板未列出的键不动）
- **插件**：列出 opencode.json `plugin` 数组声明的插件（npm 包名可带 `@版本`，或 `~/` `./` `/` `file://` 本地路径），按 opencode 运行时缓存布局解析（兼容旧版平铺缓存），回退配置目录；展示安装版本 / 未安装 / 本地路径 / 缺失状态；点击标题打开配置文件，展开浏览插件目录文件（排除嵌套 `node_modules` 与 `.git`），单击文件即可预览编辑
- **备份**：手动「立即备份」会要求输入备份名称（名称仅用于展示，时间戳自动附带且不入名称），并可勾选仅包含 配置/模板/模型；历史备份可右键「重命名备份」，恢复时可只恢复备份中实际存在的部分范围；manifest 记录原因；与当前配置 diff 对比；恢复时明确警告覆盖（应用/恢复不自动产生备份）
  - **导入/导出**：备份可导出为 zip（跨平台纯 JS 实现三平台通用，含中文名时置 UTF-8 标志位）；导入时校验 manifest、防目录遍历/zip 炸弹（解压前按头部声明尺寸限流），同名已存在时自动加 `-import-N` 后缀
- **状态栏**：显示当前模板，点击快速切换（`Ctrl+Alt+P`）
- **Open Base Opencode**（命令面板）：在编辑器区域新开一个**普通终端**直接运行 opencode TUI——无 tmux 与其环境修正，适用于不需要 agent team 模式或 tmux 的场景；同样**固定一个随机空闲端口**（`opencode --port <P>`，终端环境附带 `OPENCODE_PORT` 兜底），其他终端可 `opencode attach http://127.0.0.1:<P>` 或工具直连。直连 VSCode 终端时 TUI 原生获得 truecolor 配色并经 OSC 背景探测自动跟随明暗主题；**三平台原生支持**（Linux/macOS/本地 Windows——命令仅为 `opencode --port <数字>`，经终端 `cwd` 选项定位工作区，无 shell 方言差异；缺省 opencode 时由终端自身报错）
- **Open Tmux Opencode**（命令面板）：在编辑器区域新开一个终端页，通过 tmux 启动 opencode TUI，并绑定一个随机空闲端口（同时导出 `OPENCODE_PORT` 供 oh-my-openagent 兜底）——这是 oh-my-openagent agent team 模式的兼容启动方式（opencode TUI 必须带 `--port` 才会启用真实 HTTP 服务，team 模式据此用 `opencode attach` 拉起成员窗格）。tmux 会话按工作区命名（`opencode-<项目名>`），重复执行直接 attach 已有会话（保留原端口）；自动修正 pane 颜色环境（TERM 升级至 256 色、旧 tmux 清空泄漏的 COLORTERM，team 成员窗格同样继承），避免 TUI 全黑；**启动主题跟随 VSCode 明暗配色**（亮色主题 → opencode 亮色模式，暗色 → 暗色；tmux 下终端背景探测失效，通过逐次状态目录锁定 TUI 的 `theme_mode_lock` 并写入会话环境实现，主 Agent 与 team 成员窗格一并继承，不改动全局配置）；未安装 tmux 时给出中文安装指引。team 模式本身需在 `~/.omo/omo.jsonc` 开启 `team_mode.enabled`（可视化另需 `tmux_visualization`）。**平台支持**：Linux 与 macOS 原生支持（macOS 需 `brew install tmux`；tmux ≥ 2.1 才有 team 分栏所需的百分比窗格尺寸）；Windows 经 **Remote-WSL** 完整支持（用 WSL 打开工作区、WSL 内安装 tmux 即可，与 Linux 行为一致）——本地 Windows 无 tmux 时命令给出 WSL 指引后降级，不做 PowerShell 原生桥接（team 模式可视化本身依赖 POSIX tmux）
- **Coding Plan 额度**（状态栏右侧）：实时显示 Kimi / GLM / MiMo / DeepSeek 剩余额度（5 小时额度、周额度；MiMo 为月额度+余额；DeepSeek 为按量计费余额）
  - 点击打开**管理面板**（类设置页的编辑器窗口，与「打开设置」同页），「额度/设置」选项卡切换；额度页按供应商分组展示各窗口进度条、剩余百分比与重置时间，每组可单独「刷新」，底部「刷新全部」；面板打开期间跟随自动刷新实时更新
  - 每个供应商分组头部有**「状态栏」开关**：关闭后状态栏不再显示该供应商，也不再定时刷新其额度（仅在管理面板打开期间刷新，节省请求）；开关状态存于 `quota.json` 的 `statusBar` 块
  - Kimi / GLM / DeepSeek 自动读取 opencode 凭据（`~/.local/share/opencode/auth.json`），面板内只读显示检测状态，更换请运行 `opencode auth login`；DeepSeek 官方仅提供余额接口，显示 `¥余额` 与币种
  - MiMo 官方仅提供 Dashboard API：在其分组内粘贴 `platform.xiaomimimo.com` 的浏览器 Cookie 保存（存入 `quota.json`，留空不改动；也可经「Coding Plan 额度：配置 MiMo Cookie…」直达该分组）
  - 网络故障时自动指数退避（30s → 最长 2 分钟），恢复后回到正常间隔，面板内可随时手动重试；**切回窗口时若额度显示异常会自动刷新一轮**（挂机期间熔断的自动刷新随网络恢复即刻自愈；此聚焦刷新不受「0 = 关闭自动刷新」影响——仅额度异常时触发，属于恢复动作）；刷新失败时 30 分钟内沿用最近成功的旧数据并加 `~` 标记（悬停可见数据时间与失败原因），超过 30 分钟才回退为 `?`
  - 请求失败显示友好中文提示，不泄漏原始英文错误；各窗口按剩余量独立着色（≥60% 绿 / 20%–60% 黄 / <20% 红，跟随 VSCode 主题；DeepSeek 余额按绝对值着色）

## 安装

```bash
npm install
npm --prefix webview-ui install
npm run package           # 编译 + webview 构建 + vsce 打包 → build/packages/
code --install-extension build/packages/opencode-config-manager-<版本>.vsix
```

## 使用

1. 点击活动栏 OpenCode 图标打开面板
2. 首次：点「从当前配置捕获…」存一个基线模板
3. 改模型：展开检测到的 agent 配置 → 点任意 agent → 选模型
4. 切换：状态栏或模板区右键「应用」
5. 后悔药：变更前先「立即备份」，需要时备份区右键「恢复」/「对比」

### 模型清单

插件**不内置模型**，仅内置供应商白名单（`src/core/builtinModels.ts` 的 `BUILTIN_PROVIDERS`：GLM / Kimi / MiniMax / MiMo / DeepSeek / GPT / Claude / Grok / Gemini 等）。本地清单存于 `~/.config/opencode/models.json`：为空（新装或被清空）时扩展激活后会自动从 models.dev 按白名单拉取初始化（联网失败则保持为空，之后点「更新模型清单」即可）；已有文件**安装/升级插件不会覆盖**。文件可手动编辑；损坏时降级为空清单（原文件一次性备份为 `models.json.bak`），下次成功的网络更新会重建。展示顺序：`opencode.json` 条目优先，按 id 排序去重。

模型分区标题右侧的「更新模型清单」按钮（或命令面板 `OpenCode: 更新模型清单（从 models.dev）`）会拉取 models.dev 的最新目录，取当前清单所涉供应商的最新模型合并进 `models.json`：新模型追加、同名模型以最新数据刷新、用户手动添加的自定义模型保留不删；清单为空时按内置供应商白名单全量拉取；未收录的供应商会在结果提示中说明。**只收录可用作编码代理的模型**（支持工具调用且未被上游标记弃用——TTS/图像/视频/embedding 及已退役旧世代一律过滤），上游已标记弃用的存量条目也会在更新时自动清理。

### 设置

入口：侧边栏面板标题栏的齿轮按钮（或命令面板「OpenCode: 打开设置」），打开「OpenCode 管理」面板并落在首个**配置选项卡**（与状态栏额度点击打开的额度选项卡同页，页面顶部选项卡随时切换，设置项在「设置」选项卡）。**配置选项卡**（排在最前）分两块：当前 OMO 的 agent/分类模型配置——页内下拉即时修改并写入检测到的目标文件（`~/.omo/omo.jsonc` 或旧版），显示写入目标路径；Skills 只读清单——列出全部已发现技能的名称与描述（读取各 SKILL.md 的 frontmatter），按目录分组并标注 全局/项目：

- **分区自动刷新**：配置 / 模板 / 备份 / 模型 / 插件五个分区各自独立开关（切换按钮），开启后可配置轮询间隔（秒，默认 30，范围 1–3600）；关闭（默认）时仅保留文件变更监听 + 手动刷新
- **Coding Plan 额度刷新频率**：默认 30 秒（0 = 关闭自动刷新），与状态栏/额度页同源生效，更改后立即按新频率查询
- 修改为本地编辑：点击「保存设置」才一次性写入全部设置（未保存时按钮禁用并提示）

| 键 | 默认 | 说明 |
|---|---|---|
| `opencodeConfigManager.configDirOverride` | — | 配置目录覆盖（默认与 opencode 运行时一致：`OPENCODE_CONFIG_DIR` > `XDG_CONFIG_HOME/opencode` > `~/.config/opencode`，三平台相同） |
| `opencodeConfigManager.quota.refreshSeconds` | 30 | Coding Plan 额度自动刷新间隔（秒，0 = 关闭） |
| `opencodeConfigManager.autoRefresh.<分区>.enabled` | false | 对应分区（config/presets/backups/models/plugins）定时自动刷新开关 |
| `opencodeConfigManager.autoRefresh.<分区>.intervalSeconds` | 30 | 对应分区自动刷新间隔（秒，1–3600） |

## 架构

```
src/core/      纯逻辑（无 vscode 依赖，vitest 单测）
  configStore      路径发现 / 读写 / 模型目录
  jsoncEditor      JSONC 保留注释编辑（jsonc-parser modify()）
  presetService    模板 CRUD + 合并应用
  backupService    快照 / 恢复 / 保留策略 / zip 导入导出
  pluginResolver / skillScanner / agentAssignment / quotaService
                   插件与 skills 发现、agent 分配、额度查询
  atomicFile / pathSafety / errors / watchManager  基础设施
src/tree/      树节点纯构建器 + 单一分区 Explorer
src/ui/        命令 / QuickPick / 状态栏（模板 + 额度）/ 设置读写
src/webview/   Webview 宿主（管理面板〔配置/额度/设置/模板选项卡〕+ 模板会话控制器；CSP + postMessage 协议）
webview-ui/    React 前端（Vite 单入口管理页：配置 + 额度 + 设置 + 模板四选项卡，VSCode CSS 变量主题）
```

数据位置：模板 `~/.config/opencode/presets/*.json`；备份 `~/.config/opencode/backups/<ISO时间戳>-manual/`（含 `manifest.json` 与展示名称，覆盖检测到的实际配置文件与 `~/.agents/skills`）。模板应用/捕获的写入目标由本机检测结果决定（`~/.omo/omo.jsonc` 或旧版 `oh-my-opencode.json[c]`）。

## 测试

```bash
npm test              # vitest：根套件（单元+集成，纯 Node）+ webview-ui 套件
./scripts/e2e.sh      # @vscode/test-electron e2e（Linux headless 自动套 xvfb）
```

设计文档：`docs/plans/2026-08-21-vscode-opencode-config-manager-design.md`（立项历史）、`docs/plans/2026-08-25-quota-webview-panel-design.md`（额度面板）；开发约定见 `AGENTS.md`，版本历史见 `CHANGELOG.md`。
