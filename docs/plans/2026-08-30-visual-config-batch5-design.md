# 可视化配置第五批设计方案（收官批）

日期：2026-08-30。前四批已交付六选项卡、13 个描述符 kind 与全部基础控件。本批为探索报告剩余工作项的**收官批**：OMO 智能体级覆写矩阵与 prompt 编辑、OpenCode `mcp` 完整条目编辑器（替换批量二的开关列表）、其余高频浅件，并在文末**清账宣布不做项**——此后探索报告的全部工作任务项闭环。

## 项次清单

### OMO 选项卡（omo `[opencode]`/legacy，plugin scope）

| # | 项 | 键路径 | kind | 说明 |
|---|---|---|---|---|
| 1 | 超级工作覆写 | `agents.<name>.ultrawork` | **agentPairMap**（新） | `Record<agent, {model, reasoning?}\|null>`，键集=KNOWN_AGENTS；每行 模型下拉+reasoning 下拉（OMO_REASONING_LEVELS）+未设置 |
| 2 | 压缩覆写 | `agents.<name>.compaction` | agentPairMap | 同上 |
| 3 | 系统提示词 | `agents.<name>.prompt` | **agentTextMap**（新） | `Record<agent, string\|null>`，每 agent 可展开 textarea（≤8000）；hint 支持 file:// 由用户手写，UI 纯文本 |
| 4 | 提示词追加 | `agents.<name>.prompt_append` | agentTextMap | 同上 |
| 5 | Claude Code 兼容层 | `claude_code.{mcp,commands,skills,agents,hooks,plugins}` | shallowObject | 6 布尔默认 true；hint 关闭对应兼容层 |
| 6 | 关键词展开 | `keyword_detector.enabled_expansions` | enumChips | options `[ultrawork,team,hyperplan,hyperplan-ultrawork]` |
| 7 | 目标循环 | `goal.{enabled,auto_start,default_max_iterations}` | shallowObject | bool/bool/int 1–1000 默认 100 |
| 8 | CodeGraph | `codegraph.{auto_init,auto_provision,daemon,enabled}` | shallowObject | 4 布尔默认 true |
| 9 | 监视器 | `monitor.{enabled,live_mode_enabled}` | shallowObject | 默认 false |
| 10 | 强制通知 | `notification.force_enable` | boolean | 默认 false |
| 11 | 界面语言 | `i18n.locale` | string | ≤16；hint 如 en/zh |

### OpenCode 选项卡（opencode.json）

| # | 项 | 键路径 | kind | 说明 |
|---|---|---|---|---|
| 12 | MCP 服务器完整编辑 | `mcp` | recordEditor（**替换批量二 mcpServers 开关 UI**） | fields：`type` enum `[local,remote]`（必填）、`url` text（**跨字段规则：type=remote 时必填**，core 内联校验+注释）、`command` stringList（local 命令）、`enabled` boolean；payload 并入 `records.mcp` 聚合槽（删除旧 `mcp` 独立槽与 `mcpServers` kind/McpToggleList——面板内无外部消费者，整体迁移，e2e 旧用例随迁）；红线不变：条目级 diff，缺席名/破损条目不触碰 |
| 13 | 实验开关 | `experimental.{batch_tool,openTelemetry,continue_loop_on_deny,disable_paste_summary}` | shallowObject | 4 布尔默认 false |

## 新 kind 契约

- **agentPairMap**：值 `Record<string, {model: string; reasoning: string | null} | null>`（null=删除该 agent 的键）。读：`agents.<name>.<leafKey>` 逐 agent 取（非对象/坏 model → 省略该 agent）；写：逐 agent set/remove（`{model}` 或 `{model,reasoning}`；全 null 值 → 删整组? 否——逐 agent 删除，整值 null → remove `agents` 下属? 不动 agents 本身——**整值 null → 无编辑**（防误删 agents 配置块；与 mcp「整键永不删」同理）；描述符元数据 `agents: { leafKey: string }` + options=KNOWN_AGENTS 复用 enumChips 的 options 字段语义。校验：键 ∈ KNOWN_AGENTS、model 过 MODEL_ID_PATTERN、reasoning ∈ OMO_REASONING_LEVELS|null、≤键集大小天然封顶。
- **agentTextMap**：值 `Record<string, string | null>`。读：逐 agent 取字符串（非串/空串/超长 → 省略）；写：逐 agent set/remove；整值 null → 无编辑（同上防误删）。校验：键 ∈ KNOWN_AGENTS、trim 非空 ≤8000。
- 两 kind 均复用 RecordEditor 的「缺席名不触碰」哲学；UI 控件 `AgentPairMapEditor`（固定 agent 行：模型下拉+reasoning 下拉+未设置，全量快照提交）与 `AgentTextMapEditor`（固定 agent 行展开 textarea，同提交语义）。

## 测试计划

- 单测：两新 kind 读/写/校验矩阵（坏值省略、逐 agent 删、整值 null 无编辑、KNOWN_AGENTS 外键拒）；mcp recordEditor 化（type=remote 缺 url 拒、local 缺 command 容忍、enabled 切换落盘、旧 mcpServers 消息路径移除后回执兜底）；其余描述符正反例；configStore 往返抽样。
- webview：两矩阵控件 helpers（行状态/快照组装/未设置）、mcp 编辑器接入、分组渲染钉测更新。
- e2e：agentPairMap 写回（ultrawork 覆写 + 删）、agentPromptAppend 写回、mcp 新编辑器增改删（迁移旧 mcpServers 用例）、experimental 写回、boot 载荷断言更新（records.mcp 槽位）。

## 清账：宣布不做（探索报告闭环）

| 项 | 不做理由 |
|---|---|
| opencode `provider`（apiKey） | 敏感凭据红线：不明文回显 webview；文件内手改 |
| opencode `server`/`enterprise`/`references`/`skills`/`watcher` 细项 | 运维/企业/低频面，非日常配置 |
| tui.json `keybinds` | 键描述符结构复杂（string/对象双形态+录制），收益低；theme 已覆盖 tui 面 |
| OMO `mcp_env_allowlist`/`playwright_mcp_args` | 安全面 + 仅 user layer 生效，只读都易误导 |
| OMO 每 agent `permission` 矩阵 / `temperature`/`top_p`/`maxTokens` / `displayName`/`color` | 低频且易误配（采样参数影响输出质量）；文件内手改更安全 |
| OMO `background_task` 细参（并发映射表/circuitBreaker 等） | 调优面，默认值已覆盖；defaultConcurrency 已暴露 |
| OMO `fallback_models`（deprecated）/`models` 链对象形态 | 上游已弃用，正向 `models`/`runtime_fallback` 迁移 |
| opencode `attachment` 细项扩展 / `compaction` 细参扩展 / `logLevel` 之外的日志面 | 已覆盖高频子集，余项低频 |

## 红线（沿用）

mcp 条目级 diff、缺席名不触碰；agentPairMap/agentTextMap 整值 null 永不删 `agents` 配置块；废弃键永不写；apiKey 永不回显。
