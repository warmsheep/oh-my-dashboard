# 可视化配置第二批设计方案（P0 批次 + tui.json theme）

日期：2026-08-30。前序：`2026-08-30-manager-tabs-omo-opencode-skills-design.md`（六选项卡与描述符体系已落地）。本批在既有 OpenCode/OMO 选项卡内新增 11 个配置项，引入 5 个新描述符 kind，并开辟 tui.json 独立编辑面。范围外：`recordEditor` 大件（mcp/command/formatter/lsp/provider 完整表单）、keybinds、prompt/prompt_append、`retry_on_errors`（HTTP 码数组，默认值覆盖常见场景）。

## 项次清单（逐项验收）

### OpenCode 选项卡（opencode.json）

| # | 项 | 键路径 | kind | 说明 |
|---|---|---|---|---|
| 1 | 权限-全局简写 | `permission`（字符串形态） | enum `allow\|ask\|deny` | 对象形态存在时禁用（hint：已按工具设置），防覆写丢失每工具规则 |
| 2 | 权限-按工具 | `permission.<tool>` × 15 工具 | permissionTools | 工具集：`bash/edit/read/glob/grep/list/task/skill/lsp/webfetch/websearch/todowrite/question/external_directory/doom_loop`；值仅 allow/ask/deny/null；某工具值为 pattern 对象（如 `bash:{"rm *":"deny"}`）→ 该行显示「高级规则」徽标且不可下拉（保护用户手写规则；写其他工具键经 jsonc modify 不触碰它）；字符串简写存在时整组禁用 |
| 3 | 规则文件 | `instructions` | stringList | 1–16 条，每条 trim 后非空 ≤256 字符，去重；hint 注明项目级文件会按并集叠加 |
| 4 | MCP 启用开关 | `mcp` | mcpServers | 载荷列出已声明服务器（`entry.enabled === false` → 已禁用）；写为快照 `Record<name, disabled>`：true→set `mcp.<name>.enabled=false`，false→remove `mcp.<name>.enabled`（保留条目其余字段）；null 永不写（绝不整键删除 mcp）；≤32 名；「打开配置文件」按钮复用既有打开命令 |
| 5 | 上下文压缩 | `compaction` | shallowObject | `auto`(bool, 默认 true)、`prune`(bool, 默认 false)、`tail_turns`(int 0–100, 默认 2) |
| 6 | 智能体扩展 | `agent.{build,plan}.{disable,temperature}`、`agent.{general,explore}.model` | boolean/number(float 0–2)/model | 复用现有下拉；分组「智能体」 |
| 7 | TUI 主题 | tui.json `theme` | string（file: "tui"） | **独立文件面**：读写 `configDir/tui.json`（JSONC 安全，缺省创建）；值 ≤64 字符；载荷含 tui.json 路径；hint 列示例主题名；opencode.json 内废弃 theme 键永不写 |

### OMO 选项卡（omo.jsonc `[opencode]` / legacy，按 scope）

| # | 项 | 键路径 | scope | kind | 说明 |
|---|---|---|---|---|---|
| 8 | 智能体开关 | `disabled_agents` | plugin | enumChips | 选项 = 协议表 `KNOWN_AGENTS`；值 string[]（去重 ≤32） |
| 9 | 模型别名目录 | `models`（**共享顶层键，两代目标都在顶层**） | shared | modelCatalog | `Record<alias, {model, reasoning?}\|null>`；别名 `/^[A-Za-z0-9._-]+$/` ≤32 字符、≤32 条；model 过 MODEL_ID_PATTERN；reasoning 枚举 `off\|minimal\|low\|medium\|high\|xhigh\|max\|auto` 或 null；null=删该别名 |
| 10 | 回退细参 | `runtime_fallback` | plugin | shallowObject | `max_fallback_attempts`(int 1–20)、`cooldown_seconds`(int 1–3600)、`timeout_seconds`(int 1–600)、`notify_on_fallback`(bool)、`restore_primary_after_cooldown`(bool)；并入现有「稳定性」组 |
| 11 | 默认模式 + 实验三件套 | `default_mode.{ultrawork,goal}`；`experimental.{disable_omo_env,aggressive_truncation,truncate_all_tool_outputs}` | plugin | shallowObject / boolean | default_mode 新组；三件套并入现有「实验特性」组（`disable_omo_env` hint：可提升 prompt 缓存命中） |

## 协议扩展（src/shared/protocol.ts）

- 新值类型：`StringListValue = string[]`；`ShallowObjectValue = Record<string, boolean | number | null>`；`PermissionToolsValue = Record<string, "allow" | "ask" | "deny" | null>`；`McpServersValue = Record<string, boolean>`；`ModelCatalogValue = Record<string, { model: string; reasoning: string | null } | null>`。
- `OpencodeSettingValue = string | boolean | number | null | StringListValue | ShallowObjectValue | PermissionToolsValue | McpServersValue`；`OmoSettingValue = boolean | number | null | StringListValue | ShallowObjectValue | ModelCatalogValue`（omoSetSetting 消息载荷类型随之扩容）。
- 描述符新字段：`kind` 扩为 `"model" | "enum" | "tristate" | "boolean" | "string" | "providers" | "stringList" | "enumChips" | "shallowObject" | "permissionTools" | "mcpServers" | "modelCatalog"`；`fields?: { key; kind: "boolean" | "number"; label; hint?; min?; max?; integer?; default? }[]`（shallowObject）；`options?: string[]`（enumChips）；`file?: "tui"`（tui.json 面）；OmoMiscSetting 增 `scope?: "plugin" | "shared"`（默认 plugin；shared=两代目标都写顶层）。
- `OpencodeSettingsPayload` 增：`permission: { shorthand: "allow" | "ask" | "deny" | null; tools: PermissionToolsValue; advancedTools: string[] }`（读写分离聚合）、`mcp: { name: string; disabled: boolean }[]`、`tui: { theme: string | null; path: string }`。
- 常量收口：`OPENCODE_PERMISSION_TOOLS: readonly string[]`（15 工具，按重要性排序）、`OMO_REASONING_LEVELS: readonly string[]`（8 枚举）。

## 核心层（src/core/）

- `opencodeSettings.ts`：新增按 kind 的读取（stringList 原样数组校验、shallowObject 按 fields 抽取、permission 聚合 shorthand/tools/advancedTools、mcpServers 列表、tui 不在此模块）；`opencodeSettingEdits` 扩展（mcpServers 快照 → 每名 set/remove `enabled` 子键）；`isValidOpencodeSettingValue` 按 kind 校验（stringList 条目规则、shallowObject 按 fields 边界与 integer 标志（number 允许小数当且仅当 `integer !== true`）、permissionTools 键 ∈ 15 工具集且值合法、mcpServers 键名 sanitize ≤32）。
- `omoSettings.ts`：`readOmoMiscValues` 按 scope 取路径（shared=顶层）；modelCatalog 读取（shape 破损条目跳过）与编辑（别名条目 set/remove：`{model, reasoning}` 序列化时 reasoning null 则只写 model）；`isValidOmoMiscValue` 扩（enumChips ⊆ options 去重 ≤32；modelCatalog 别名/模型/reasoning 规则；shallowObject 同上）。
- 新模块 `src/core/tuiSettings.ts`：`readTuiTheme(text)`、`tuiThemeEdits(theme: string | null)`、`isValidTuiTheme`（trim ≤64）。纯函数，无 fs。
- `ConfigStore`：`tuiConfigPath()`（`configDir/tui.json`）、`tuiTheme(): string | null`（readTextOrEmpty 容错）、`setTuiTheme(theme: string | null)`（readTextForEdit → modify → writeAtomic，缺省文件创建 `{\n}\n` 形态）；`opencodeSettingValues`/`setOpencodeSetting` 扩展承载新 kind（file:"tui" 描述符路由到 tui 路径）；`buildOpencodeInitPayload` 聚合 permission/mcp/tui 字段。

## 宿主（managerPanelHost / extension）

- `parseMessage` 两消息的 value 校验改为按描述符 kind 走 core 校验器（自动覆盖新 kind）；`file:"tui"` 键路由 `setTuiTheme`；mcpServers 快照写后重推 opencodeInit。
- boot/navigate 推送扩容后的 `OpencodeSettingsPayload`；configInit 的 omo 值随 `readOmoMiscValues` 扩容。

## Webview（webview-ui/）

- 新共享控件目录 `webview-ui/src/controls/`（纯展示组件 + helpers，全部可测）：
  - `StringListEditor`（行式增删 + 输入提交，非法条目就地红字不提交）；
  - `ChipsEditor`（泛化 provider-chips：固定选项多选，选中集即值）；
  - `ShallowObjectFields`（按 fields 渲染开关/数字；数字支持小数（integer!==true），空=未设置）；
  - `ModelCatalogEditor`（别名行：别名输入 + 模型下拉（复用分组）+ reasoning 下拉 + 删除；新增行在本地草稿，提交时整表快照发送）；
  - `PermissionEditor`（简写下拉 + 15 工具行下拉 + 「高级规则」徽标；互斥禁用逻辑）；
  - `McpToggleList`（服务器行 + 开关 + 打开配置文件按钮）。
- OpenCode 选项卡新分组：权限 / 规则文件 / MCP 服务器 / 上下文 / 智能体 / 终端界面（theme 输入 + tui.json 路径展示）；OMO 选项卡新分组：智能体开关 / 模型目录 / 默认模式，并入 稳定性、实验特性。
- 所有写仍走 opencodeSetSetting/omoSetSetting 单键即时通道（乐观更新/回滚/12s 守卫复用）；ModelCatalogEditor 与 StringListEditor 的「整表快照」提交语义在组件内聚合成单值。

## 测试计划（逐项）

- 单测：每 kind 校验器正反例（opencodeSettings/omoSettings/tuiSettings）；mcp 快照 diff 写（禁用 set enabled:false、启用 remove enabled、null 不写）；permission 聚合（字符串/对象/混合/高级规则保护——写其他键后 pattern 对象字节不变）；modelCatalog scope（omo [opencode] vs 顶层 vs legacy 顶层）与破损条目跳过；tui 读写（含 JSONC 注释保真、缺省文件创建、null 删键）；configStore 新方法往返。
- webview：控件 helpers（stringList 增删校验、chips 值集、shallowObject 边界、catalog 行状态机、permission 互斥）。
- e2e：每新 kind 至少一条写回断言——permission 工具写、instructions 增条、mcp 开关翻转（含 enabled 键移除）、compaction 字段、disabled_agents、models 目录条目、tui theme 写入 tui.json；boot 载荷新字段断言。
- 全量链：`npm test`、`npx tsc --noEmit`、`npm --prefix webview-ui run build`、`./scripts/e2e.sh`、prettier。

## 红线（沿用）

opencode.json 废弃键（theme/keybinds/tui/layout/mode/autoshare）永不写；`mcp` 整键永不删除；`mcp_env_allowlist`/`playwright_mcp_args` 不做；`provider.options.apiKey` 不回显。
