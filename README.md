# OpenCode Config Manager

VSCode 扩展：管理 [opencode](https://opencode.ai) 与 [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) 的配置文件 — 结构化修改、备份、恢复、命名模板一键切换。

## 功能

- **配置面板**（活动栏侧边栏）：模型 / 配置文件 / 模板 / 插件 / 备份分区树形视图
  - 自动识别本机生效的 agent 配置：新版 `~/.omo/omo.jsonc` 的 `[opencode]` 块，或旧版 `oh-my-opencode.json[c]` / `oh-my-openagent.json[c]`（与 oh-my-openagent 运行时同序）
  - `opencode.json`（JSONC，保留注释与尾逗号；`opencode.jsonc` 亦可识别）、`AGENTS.md`（全局+项目级）、`command/`、`skills/`
  - skills 兼容主流 agent 目录约定，家目录下显示为「全局」：全局扫描 `~/.agents/skills`、`~/.claude/skills`、配置目录 `skills/` 等，项目级扫描 `.agents/`、`.claude/`、`.opencode/` 等下的 `skills/`（完整候选序见 AGENTS.md）；跟随符号链接，需含 `SKILL.md`，仅显示实际存在的目录
  - agent/category 节点点击 → QuickPick 选模型与 variant，程序化写回（omo 目标写 `reasoning` 键，同时清理冲突的 `variant`/`models` 链）
- **模板**：从当前配置捕获；Webview 矩阵编辑器（批量设模型、逐行 variant）；应用采用合并语义（模板未列出的键不动）
- **插件**：列出 opencode.json `plugin` 数组声明的插件（npm 包名可带 `@版本`，或 `~/` `./` `/` `file://` 本地路径），按 opencode 运行时缓存布局解析（兼容旧版平铺缓存），回退配置目录；展示安装版本 / 未安装 / 本地路径 / 缺失状态；点击标题打开配置文件，展开浏览插件目录文件（排除嵌套 `node_modules` 与 `.git`），单击文件即可预览编辑
- **备份**：手动「立即备份」会要求输入备份名称（名称仅用于展示，时间戳自动附带且不入名称）；历史备份可右键「重命名备份」；manifest 记录原因；与当前配置 diff 对比；恢复时明确警告覆盖（应用/恢复不自动产生备份）
  - **导入/导出**：备份可导出为 zip（跨平台纯 JS 实现三平台通用，含中文名时置 UTF-8 标志位）；导入时校验 manifest、防目录遍历/zip 炸弹（解压前按头部声明尺寸限流），同名已存在时自动加 `-import-N` 后缀
- **状态栏**：显示当前模板，点击快速切换（`Ctrl+Alt+P`）
- **Coding Plan 额度**（状态栏右侧）：实时显示 Kimi / GLM / MiMo / DeepSeek 剩余额度（5 小时额度、周额度；MiMo 为月额度+余额；DeepSeek 为按量计费余额）
  - Kimi / GLM / DeepSeek 自动读取 opencode 凭据（`~/.local/share/opencode/auth.json`），无需额外配置；DeepSeek 官方仅提供余额接口，状态栏显示 `DeepSeek ¥余额`，点击查看币种明细
  - MiMo 官方仅提供 Dashboard API：执行「Coding Plan 额度：配置 MiMo Cookie…」粘贴 `platform.xiaomimimo.com` 的浏览器 Cookie（存入 `quota.json`）
  - 点击查看各窗口详情与重置时间；网络故障时自动指数退避（30s → 最长 2 分钟），恢复后回到正常间隔，详情中可随时「刷新」立即重试
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

内置清单定义在 `src/core/builtinModels.ts`（数据来源 models.dev），首次调用模型列表时写入 `~/.config/opencode/models.json`（可手动编辑，损坏自愈，重建前原文件备份为 `models.json.bak`）。展示顺序：`opencode.json` 条目优先，按 id 排序去重。

### 设置

| 键 | 默认 | 说明 |
|---|---|---|
| `opencodeConfigManager.configDirOverride` | — | 配置目录覆盖（默认与 opencode 运行时一致：`OPENCODE_CONFIG_DIR` > `XDG_CONFIG_HOME/opencode` > `~/.config/opencode`，三平台相同） |
| `opencodeConfigManager.quota.refreshSeconds` | 30 | Coding Plan 额度自动刷新间隔（秒，0 = 关闭） |

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
src/ui/        命令 / QuickPick / 状态栏（模板 + 额度）/ 保存守护
src/webview/   模板编辑器宿主（CSP + nonce + postMessage 协议）
webview-ui/    React 矩阵表单（Vite 单 bundle，VSCode CSS 变量主题）
```

数据位置：模板 `~/.config/opencode/presets/*.json`；备份 `~/.config/opencode/backups/<ISO时间戳>-manual/`（含 `manifest.json` 与展示名称，覆盖检测到的实际配置文件与 `~/.agents/skills`）。模板应用/捕获的写入目标由本机检测结果决定（`~/.omo/omo.jsonc` 或旧版 `oh-my-opencode.json[c]`）。

## 测试

```bash
npm test              # vitest：根套件（单元+集成，纯 Node）+ webview-ui 套件
./scripts/e2e.sh      # @vscode/test-electron e2e（Linux headless 自动套 xvfb）
```

设计文档：`docs/plans/2026-08-21-vscode-opencode-config-manager-design.md`（立项时的历史设计记录）；开发约定见 `AGENTS.md`，版本历史见 `CHANGELOG.md`。
