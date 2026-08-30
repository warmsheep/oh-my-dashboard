# 管理面板选项卡重构：OMO / OpenCode / 技能 设计方案

日期：2026-08-30。目标：管理面板从四选项卡（配置/额度/设置/模板）重构为六选项卡：

```
OMO · OpenCode · 额度 · 设置 · 模板 · 技能
 ①      ②                     ⑥（最后）
```

1. 「配置」更名「OMO」：保留智能体模型配置，新增 oh-my-openagent 常用功能设置的可视化编辑。
2. 新增第二选项卡「OpenCode」：可视化编辑 opencode.json 常用设置。
3. Skills 只读清单从「配置」选项卡拆出为末位「技能」选项卡。

## 调研结论（决策依据）

### oh-my-openagent（code-yeongyu/oh-my-openagent，npm latest 4.19.4 / beta 5.0.0）

- 配置面：`~/.omo/omo.jsonc` 的 `[opencode]` 块（5.0+）或 legacy `oh-my-opencode.json[c]`/`oh-my-openagent.json[c]` 顶层（4.x，npm latest 仍读）——与本扩展 `resolveAgentConfig()` 的双目标检测完全一致。
- 高频设置（按 GitHub issue 讨论量与文档篇幅排序）：
  1. per-agent / per-category `model` + `reasoning`（枚举 `off|minimal|low|medium|high|xhigh|max|auto`，另有自由字符串槽位）——**现有「模型配置」区已覆盖**；
  2. `telemetry`（布尔，默认 true；关闭是隐私刚需，issue 讨论多）；
  3. `team_mode.enabled`（布尔，默认 false）与 `team_mode.tmux_visualization`（布尔，默认 false）——本扩展 README 已要求用户手改此键；
  4. `tmux.enabled`（布尔，默认 false）；
  5. `hashline_edit`（布尔，默认 false，README 重点功能）；
  6. `experimental.task_system`（布尔，默认 false）；
  7. `sisyphus_agent`：`disabled`/`planner_enabled`/`default_builder_enabled`/`replace_plan`/`tdd`（恢复原生 build/plan 行为的常用开关）；
  8. `runtime_fallback.enabled`（布尔，默认 false；讨论热度最高的行为类设置）；
  9. `background_task.defaultConcurrency`（数字，默认 5，0=不限）。
- 写入规则：omo 目标 → `[opencode].<path>`；legacy 目标 → 顶层 `<path>`（同一键名，两代运行时同义）。

### opencode（anomalyco/opencode，schema：opencode.ai/config.json）

- 适合可视化的高频键（issue 讨论量 + 文档专页）：
  1. `model`、`small_model`（`provider/model`，可复用本扩展模型清单做选择器）；
  2. `share`：枚举 `manual|auto|disabled`（默认 manual）；
  3. `autoupdate`：三态 `true|false|"notify"`；
  4. `default_agent`（默认 build；须为 primary agent）；
  5. `snapshot`（布尔，默认 true，关闭即失去撤销）；
  6. `username`（字符串）；
  7. `disabled_providers`（字符串数组；覆盖 `enabled_providers`）；
  8. `agent.build.model` / `agent.plan.model`（opencode 原生智能体模型覆写，与 OMO 的 oh-my-openagent 智能体是两套体系）。
- **红线**：`theme`/`keybinds`/`tui`/`layout`/`mode`/`autoshare` 已废弃，opencode 加载时**静默删除**这些键（写入无效）——UI 一律不做。`permission`/`mcp`/`command`/`provider`/`formatter`/`lsp` 为深层嵌套，v1 不做。
- 事实细节：schema 声明 `allowComments/allowTrailingCommas`（本扩展 JSONC 编辑路线与官方契约一致）；缺 `$schema` 时 opencode 会在加载时自行改写文件注入——编辑须保留 `$schema`，且要预期 opencode 自身作为文件变更来源；`default_agent` 非法值回退 build。

## 架构设计

### 选项卡与路由

- `ManagerTab` 扩为 `"config" | "opencode" | "quota" | "settings" | "preset" | "skills"`。
- `MANAGER_TABS = ["config", "opencode", "quota", "settings", "preset", "skills"]`；`TAB_LABELS`：config→`OMO`、opencode→`OpenCode`、skills→`技能`（其余不变）。**config 选项卡 id 不改名**（持久化 webview state 与 e2e 断言零迁移成本，仅改显示标签）。
- `normalizeManagerTab` 接受两个新 id；历史持久化值仍合法。

### 协议（src/shared/protocol.ts）

1. `ManagerTab` 联合类型扩展（见上）。
2. **OMO 功能设置**（数据驱动，不硬编码）：
   - `OmoMiscSetting`：`{ key, path: string[], kind: "boolean" | "number", label, hint?, group, default }`；
   - `OMO_MISC_SETTINGS: readonly OmoMiscSetting[]`（上节 2–9 项，path 如 `["team_mode","enabled"]`，写入时前缀 `sectionPath`）；
   - `OmoMiscValues = Record<string, boolean | number | null>`（null=文件未设置，UI 显示默认值并允许「恢复默认」删除键）；
   - `ConfigInitPayload` 增加 `omo: OmoMiscValues`（同 channel 搭车，宿主/监视器推送路径复用）。
3. **OpenCode 设置**：
   - `OpencodeSetting`：`{ key, path: string[], kind: "model" | "enum" | "tristate" | "boolean" | "string" | "providers", label, hint?, options?: string[] }`；
   - `OPENCODE_SETTINGS: readonly OpencodeSetting[]`（上节 1–8 项；`model`/`small_model`/`agent.build.model`/`agent.plan.model` 为 `model` 类，`share` 为 enum，`autoupdate` 为 tristate，`disabled_providers` 为 providers 多选）；
   - `OpencodeSettingValue = string | boolean | number | string[] | null`；`OpencodeSettingsPayload = { values: Record<string, OpencodeSettingValue>, configPath: string, models: ModelOption[] }`。
4. 新消息：
   - ExtToWebview：`opencodeInit`（payload=OpencodeSettingsPayload，boot + 监视器变更推送 + 写后重推）、`opencodeSettingSaved { ok, key, error? }`、`omoSettingSaved { ok, key, error? }`；
   - WebviewToExt：`opencodeSetSetting { key, value }`、`omoSetSetting { key, value }`（value 含 null=删除键）。
5. `SkillSummary` 与 skills 数据**继续随 configInit 推送**（技能选项卡与 OMO 选项卡各取所需，零宿主管道改动）。

### 核心层（src/core/，禁止 import vscode）

新模块 `src/core/opencodeSettings.ts`：

- `readOpencodeSettingValues(text): Record<string, OpencodeSettingValue>`——按 `OPENCODE_SETTINGS` 描述符逐键 `getValue`（复用 jsoncEditor 读）。
- `opencodeSettingEdits(setting, value): JsoncEdit[]`——set 或 remove（null）。模型类值须过 `MODEL_ID_PATTERN`；enum/tristate 校验选项；providers 值为受白名单约束的 string[]。

新模块 `src/core/omoSettings.ts`：

- `readOmoMiscValues(text, sectionPath): OmoMiscValues`——按 `OMO_MISC_SETTINGS` 描述符读（omo 目标先查 `sectionPath+path`，legacy 查顶层 path；兼容历史 `variant` 型扁平键不适用——这些全是 omo 4/5 两代同名键）。
- `omoMiscEdits(sectionPath, setting, value): JsoncEdit[]`。

`ConfigStore` 薄封装（对齐 `setAgentModel` 既有契约：`readTextForEdit` → modify 链 → mkdir → `writeAtomic`；目标不存在则创建）：

- `opencodeSettingValues(): Record<string, OpencodeSettingValue>`（读 `resolveOpencodeConfigPath()`，展示路径用 `readTextOrEmpty` 容错）；
- `setOpencodeSetting(key, value)`；
- `omoMiscValues(): OmoMiscValues`（读 `resolveAgentConfig().path`）；
- `setOmoMiscSetting(key, value)`（omo 目标写 `[opencode].<path>`，legacy 写顶层）。

### 宿主（src/webview/managerPanelHost.ts + src/extension.ts）

- `parseMessage` 新增 `opencodeSetSetting`/`omoSetSetting` 分支：key 必须在描述符集合内、value 按描述符 kind 校验（防任意 JSONC 写入）；拒绝时走既有「类型匹配但校验失败」回执兜底模式（新增对应 isXxxTyped 探测，防 UI 永久 pending）。
- 写成功：回执 ok + 重推 `opencodeInit`/`configInit` + `deps.refreshAll()`；失败：`errorMessage()` 中文回执。
- boot（ready 分支）与 `postNavigateMessages` 增加 `opencodeInit` 推送；`configInit` 载荷带上 `omo` 值。
- `notifyManagerPanelOpencodeChanged()`：与 `notifyManagerPanelConfigChanged` 同模式，extension.ts 在配置目录监视刷新时联动推送。

### Webview（webview-ui/）

- `manager/helpers.ts`：`MANAGER_TABS` 顺序与 `normalizeManagerTab` 扩展。
- `ManagerApp.tsx`：标签表更新；新增两个常驻 tabpanel：`<OpenCodeApp/>`、`<SkillApp/>`（复用现有 CSS-toggle 常驻挂载模式，草稿/pending 状态跨选项卡存活）。
- `webview-ui/src/skills/SkillApp.tsx`（新）：整体搬迁 `ConfigApp` 的 Skills 区（`SkillLocationGroup`、`groupSkillsByLocation` 等助手随迁到 `src/skills/`），监听 `configInit` 取 `skills` 字段。只读语义不变。
- `ConfigApp.tsx`（OMO 选项卡）：删 Skills 区；新增「功能设置」区——按 `OMO_MISC_SETTINGS` 描述符渲染（bool → 开关、number → 数字输入），即时写（`omoSetSetting`，乐观更新 + 失败回滚 + 12s 无响应守卫，复用模型配置区既有模式）；显示写入目标不变。
- `webview-ui/src/opencode/OpenCodeApp.tsx`（新）：按 `OPENCODE_SETTINGS` 描述符渲染——model 类用供应商分组下拉（复用 `groupModelsByProvider`）、enum/tristate 用下拉、boolean 用开关、string 用输入框、providers 用复选 chips；「未设置」选项将键删除（value=null）；监听 `opencodeInit`/`opencodeSettingSaved`；顶部显示 opencode 配置文件路径。
- CSS：优先复用 `s-section/s-row/ctl/cfg-block/block` 等既有类；仅补 6 选项卡行的换行/滚动样式。
- UI 文案全中文；注释英文。

### 文档

- README「设置」「架构」节、AGENTS.md 概述中选项卡描述同步更新。

## 测试计划

- 单测（根 vitest）：
  - `test/unit/opencodeSettings.test.ts`：读/写/删（含 JSONC 注释保真、`$schema` 保留、enum/tristate/model 校验拒绝、providers 白名单、语法错误中止）；
  - `test/unit/omoSettings.test.ts`：omo `[opencode]` 嵌套路径与 legacy 顶层路径写、默认值读取、number 边界、键删除；
  - `configStore.test.ts` 增补两个新方法；`managerPanelHost.test.ts` 增补新消息校验与回执。
- webview-ui vitest：`manager/helpers.test.ts` 更新；新增 OMO 功能设置区与 OpenCodeApp 的 helpers 测试（描述符渲染分组、乐观更新、dirty/pending）。
- 集成：`pipeline.test.ts` 视需要补一条 opencode 设置写回链。
- e2e：boot `opencodeInit` 断言、`opencodeSetSetting`/`omoSetSetting` 写回与刷新推送断言、六选项卡导航断言；保持既有 config tab 断言不回归。
- 全量验证命令：`npm test`、`npx tsc --noEmit`、`npm run package` 前置检查（不实际打包则不升版本）。

## 范围外（v1 不做）

- opencode `permission`/`mcp`/`command`/`provider`/`formatter`/`lsp`/`instructions`/`compaction` 等嵌套或低频键；
- `theme`/`keybinds`/`tui` 等已废弃键（写入即被 opencode 丢弃，绝不进 UI）；
- oh-my-openagent 的 `agent_order`/`disabled_agents`/`models` 目录/`runtime_fallback` 细粒度参数等低频或复杂项；
- Skills 管理操作（仍只读清单）。
