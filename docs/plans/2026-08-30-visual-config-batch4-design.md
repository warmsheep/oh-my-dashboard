# 可视化配置第四批设计方案（recordEditor 批：command / formatter / lsp）

日期：2026-08-30。前序三批已交付六选项卡、5+2 个 kind 与全部控件。本批交付探索报告 P1 中最后的大件：**通用命名条目编辑器（recordEditor）基础设施**及其三个应用——opencode.json 的 `command`（自定义斜杠命令）、`formatter`（代码格式化器）、`lsp`（语言服务器）。范围外（留后续批次）：OMO 每 agent `ultrawork`/`compaction` 覆写矩阵、`mcp` 完整 local/remote 表单、`prompt`/`prompt_append` 文本域、`provider`（apiKey 敏感，永不回显）。

## 项次清单（全部 OpenCode 选项卡）

| # | 项 | 键路径 | 形态 |
|---|---|---|---|
| 1 | 自定义命令 | `command` | `record<name, {template(必填,多行), description?, agent?, model?, subtask?}>`；无 master（恒为 record） |
| 2 | 格式化器 | `formatter` | master 三态（未设置/`true` 启用内置/`false` 全部关闭）+ `record<name, {disabled?, command?[], extensions?[]}>`（`environment` 高级字段不做，文件内手改保留） |
| 3 | 语言服务器 | `lsp` | 同 formatter：master 三态 + `record<id, {disabled?, command?[], extensions?[]}>`（`environment`/`initialization` 不做） |

## 契约设计

### 协议（src/shared/protocol.ts）

- `RecordFieldValue = string | boolean | string[] | null`；`RecordEntryValue = Record<string, RecordFieldValue>`；`RecordEditorValue = Record<string, RecordEntryValue | null>`（条目 null=删除标记；读侧永不产出 null）。
- 字段定义 `RecordFieldDef = { key; kind: "text" | "multiline" | "boolean" | "stringList" | "enum" | "model"; label; hint?; options?: string[]; required?: boolean; maxLen?: number }`（text 默认 ≤256，multiline 默认 ≤8000；model 字段按 MODEL_ID_PATTERN 校验并渲染为模型下拉）。
- 新 kind：`"recordEditor"`（描述符元数据 `record: { fields: RecordFieldDef[]; namePattern?: string; nameMaxLen?: number; maxEntries?: number }`，默认 `/^[A-Za-z0-9._-]+$/`、64、32）与 `"recordMaster"`（值 `true | false | null`）。
- 描述符：`command`（recordEditor，分组「命令」，fields：template multiline required、description text、agent enum options `["build","plan","general","explore"]`、model model、subtask boolean）、`formatterMaster`+`formatterEntries`（分组「格式化」）、`lspMaster`+`lspEntries`（分组「LSP」，nameLabel 服务器 id）。
- **载荷专用槽位**（recordEditor/recordMaster 不进 values 标量map，镜像 permission/mcp 先例）：`OpencodeSettingsPayload` 增 `records: { command: RecordAggregate; formatter: RecordAggregate; lsp: RecordAggregate }`，其中 `RecordAggregate = { mode: "unset" | "boolean" | "entries"; booleanValue: boolean | null; entries: Record<string, RecordEntryValue> }`（command 恒 entries/unset）。
- 写通道复用 `opencodeSetSetting`：command/formatterEntries/lspEntries 值 = RecordEditorValue；formatterMaster/lspMaster 值 = `true|false|null`。

### core（src/core/opencodeSettings.ts）

- `readRecordState(text, path): RecordAggregate`——布尔 → mode boolean；对象 → entries（**非对象条目跳过**；字段值按 kind 收敛：类型不符的叶省略——命令缺 template 仍显示为空供修复，不整条丢弃）；缺省 → unset。
- `recordEditorEdits(path, value)`——逐名 diff（镜像 modelCatalog）：条目 null → remove `[...path,name]`；对象 → set（**null 叶剪除**；剪后为空对象 → remove 该名，避免落 `{}`）；映射中缺席的名字**不触碰**（保护读侧跳过的破损条目与用户高级字段）。重命名 = 旧名 null + 新名 set。
- `recordMasterEdits(path, value)`——true/false → set（**UI 互锁防覆写条目**：对象形态存在时 master 禁用）；null → remove。
- 校验：recordEditor——名 pattern/长度/≤maxEntries；逐字段 kind 校验（required 非空、maxLen、enum ∈ options、model 过 MODEL_ID_PATTERN、stringList 复用 16/256 规则但作为字段 ≤8 条；boolean 布尔）；recordMaster——`true|false|null`。
- `readOpencodeSettingValues` 排除 recordEditor/recordMaster kind（走专用槽位）。

### 宿主

零逻辑改动（kind 驱动校验已泛化）；`buildOpencodeInitPayload` 聚合 `records` 槽位（readRecordState ×3）。

### webview（webview-ui/src/controls/）

- 新 `RecordEditor.tsx`：条目行（名称 + 展开/选中 + 删除标记）+ 新增名输入（pattern/长度/重名内联校验）+ 选中条目表单按字段 kind 渲染（text 输入、multiline textarea、boolean 开关、stringList 复用 StringListEditor（≤8 条）、enum/model 下拉——模型选项经 props 下传，镜像 ModelCatalogEditor）；本地草稿（草稿为组件本地态，init 推送不清空——批量二已验证的模式）；任一变更提交**全量快照**（含删除标记 null，空 → null 整键）；必填/超长内联错误阻止提交。
- 新 `RecordMasterSelect.tsx`（或并入 RecordEditor 组合组件）：三向下拉（未设置/启用内置/全部关闭）+ 互锁——文件为对象形态时 master 禁用（hint 已有条目），布尔形态时条目区禁用（hint 已设全局开关）——镜像 permission 双形态互锁。
- OpenCode 选项卡新分组渲染：命令 / 格式化 / LSP。

## 测试计划

- 单测：readRecordState（布尔/对象/缺省/破损条目跳过/字段类型不符省略/缺 template 保留空）；recordEditorEdits（逐名 set/remove、null 叶剪除、空对象→remove 名、缺席名不触碰、重命名、兄弟注释保留）；校验矩阵（名称/必填/maxLen/enum/model/stringList 条数/boolean/master 三值）；configStore 往返（command 含 model+template、formatter master false、lsp 条目）。
- webview：RecordEditor helpers（快照组装/删除标记/新增名校验/必填阻止）、互锁推导、分组渲染钉测。
- e2e：command 新增+改名+删除写回（磁盘 JSONC 断言 + 兄弟注释保留）；formatter master=false 写回与条目新增（互锁路径）；lsp 条目写回；boot 载荷 records 槽位断言。

## 红线（沿用）

mcp 整键永不删；`provider.options.apiKey` 永不回显；master 布尔写仅在无条目形态时允许（互锁），防覆写用户条目。
