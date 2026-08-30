# 可视化配置第三批设计方案（P1 轻件批）

日期：2026-08-30。前序：批量二（`2026-08-30-visual-config-batch2-design.md`）已交付 5 个新 kind 与 6 个控件。本批为探索报告中的 P1 项里**零/低新基础设施**的子集：14 个新描述符，全部复用既有 kind，仅两处小扩展（shallowObject 枚举叶、orderedList）。范围外（留批量四 recordEditor 批）：`command`/`formatter`/`lsp` 条目编辑器、每 agent `ultrawork`/`compaction` 覆写矩阵、`prompt`/`prompt_append` 文本域、`provider`/`mcp` 完整表单、keybinds。

## 项次清单

### OpenCode 选项卡（opencode.json，group「高级」/「终端与输出」）

| # | 项 | 键路径 | kind | 校验/默认 |
|---|---|---|---|---|
| 1 | 日志级别 | `logLevel` | enum | options `["DEBUG","INFO","WARN","ERROR"]` |
| 2 | Shell 路径 | `shell` | string | ≤64；hint 由系统自动探测 |
| 3 | 子代理深度 | `subagent_depth` | number | integer 0–16；hint 0=禁止所有子代理 |
| 4 | 工具输出上限 | `tool_output.max_lines` / `max_bytes` | shallowObject | int；默认 2000 / 51200 |
| 5 | 图片附件处理 | `attachment.image` | shallowObject | `auto_resize`(bool 默认 true)、`max_width`/`max_height`(int 默认 2000)、`max_base64_bytes`(int 默认 5242880) |
| 6 | 监视忽略 | `watcher.ignore` | stringList | glob 列表，1–16 条 |

### OMO 选项卡（omo `[opencode]`/legacy，scope 均 plugin）

| # | 项 | 键路径 | kind | 校验/默认 |
|---|---|---|---|---|
| 7 | 停用内置 MCP | `disabled_mcps` | enumChips | options `["websearch","context7","grep_app","lsp","codegraph"]` |
| 8 | 停用内置命令 | `disabled_commands` | enumChips | options `["goal","refactor","ulw-execute","stop-continuation","remove-ai-slops","hyperplan"]`（schema 严格枚举） |
| 9 | 浏览器自动化引擎 | `browser_automation_engine.provider` | enum | options `["playwright","agent-browser","dev-browser","playwright-cli"]` |
| 10 | 网页搜索后端 | `websearch.provider` | enum | options `["exa","tavily"]` |
| 11 | Git 提交署名 | `git_master.commit_footer` / `include_co_authored_by` | shallowObject | bool，默认均 true |
| 12 | tmux 布局参数 | `tmux.layout` / `main_pane_size` / `isolation` | shallowObject（**枚举叶**） | layout enum `["main-vertical","main-horizontal","tiled","even-horizontal","even-vertical"]`；main_pane_size int 20–80 默认 60；isolation enum `["inline","window","session"]` |
| 13 | Team 规模上限 | `team_mode.max_parallel_members` 等 4 字段 | shallowObject | `max_parallel_members`(int 1–8 默认 4)、`max_members`(int 1–8 默认 8)、`max_wall_clock_minutes`(int 1–1440 默认 120)、`max_member_turns`(int 1–10000 默认 500)；hint 并行 ≤ 总数（跨字段约束不强制，运行时自校） |
| 14 | 智能体顺序 | `agent_order` | **orderedList** | string[] ≤64 条、每条 ≤64 字符、去重；hint 未识别名称运行时忽略 |

## 基础设施扩展（仅两处）

1. **shallowObject 枚举叶**：`OpencodeSettingField.kind` 扩为 `"boolean" | "number" | "enum"`，新增 `options?: string[]`。读：叶值 ∈ options 则透出，否则 null；写：enum 叶 set 字符串/remove；校验：叶值 ∈ options。`ShallowObjectFields` 控件为 enum 叶渲染下拉（未设置 + options）。
2. **orderedList kind**：新 kind `"orderedList"`（复用 StringListValue）。core：读=原数组（元素均 string，否则 null）；写=整键 set/remove；校验=≤64 条、每条 trim 非空 ≤64、去重。webview：`OrderedListEditor`（行 + ↑↓ 移动 + 删除 + 底部添加；每变更提交全量快照）。

## 落点

- 协议：OPENCODE_SETTINGS +6 描述符（分组「高级」：1–3、6；「终端与输出」：4–5）；OMO_MISC_SETTINGS +8 描述符（7–8 组「MCP 与命令」；9–10 组「引擎后端」；11 组「Git」；12–13 并入「团队模式」；14 组「智能体开关」）。
- core：opencodeSettings/omoSettings 各 kind 校验器与读/编（按叶 shallowObject 含枚举叶；orderedList）。
- webview：ShallowObjectFields 枚举叶下拉；新 OrderedListEditor；其余描述符由既有控件自动渲染。
- 宿主：零改动（kind 驱动校验与推送已泛化）。

## 测试计划

- 单测：枚举叶读/写/校验（非法值读侧 null、写侧拒）；orderedList 校验（65 条/空条/重名/65 字符）与整键写；每新描述符一组正反例；configStore 往返抽样（logLevel、tmuxParams 枚举叶、gitMaster）。
- webview：ShallowObjectFields 枚举叶渲染与提交、OrderedListEditor 移动/添加/删除/空→null。
- e2e：抽样四条——logLevel 写回、tmux 枚举叶写回（含兄弟键保留）、disabled_mcps chips 写回、agent_order 写回与删键；boot 载荷含新键 null。

## 红线（沿用）

mcp 整键永不删；`theme`/`keybinds` 等 opencode.json 废弃键永不写；`mcp_env_allowlist` 不做。
