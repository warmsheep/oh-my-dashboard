# VSCode 插件设计：OpenCode / oh-my-opencode 配置管理器

- 日期：2026-08-21
- 状态：已确认（用户逐节审批通过）
- 项目名（暂定）：oh-my-config-manager（workspace: oh-my-dashboard）

> **历史文档**：本文为 0.1.0 立项时的设计记录，部分决定已被后续版本取代 — 0.2.0 移除全部自动备份（pre-apply/pre-save/pre-restore）；路径解析改为与 opencode 一致的 xdg-basedir（三平台统一 `~/.config/opencode`，不再使用 macOS 平台默认目录）；四个树视图合并为单一分区 Explorer；「预设」已更名「模板」。现状以 `README.md`、`AGENTS.md` 与 `CHANGELOG.md` 为准，本文仅供追溯。

## 1. 背景与目标

用户同时使用 opencode 与 oh-my-opencode（CLI bin 名 `oh-my-openagent`），配置分散在
`~/.config/opencode/` 下多个文件。当前痛点：

- 手工备份：目录里已存在多个 `oh-my-opencode.json.bak.<timestamp>` 手工副本
- 模型升级时需要逐条修改 20+ 个 agent/category 的模型映射
- 无预设概念，无法在"重度创作"与"省钱"等模型组合间快速切换

插件提供：**修改配置、备份、恢复、切换（命名预设）** 四大能力。

## 2. 需求决定记录

| 维度 | 决定 |
|---|---|
| 管理范围 | `opencode.json`、`oh-my-opencode.json`、`command/`、`skills/`、`AGENTS.md`（全局+项目级）。不含 `openmemory.jsonc` |
| 切换语义 | 命名预设 = provider 默认模型 + agents/categories 模型分配的组合，一键应用 |
| UI 形态 | 侧边栏 TreeView（主）+ Webview 预设编辑器（矩阵表单）+ 状态栏当前预设（捷径） |
| 修改方式 | 结构化编辑（TreeView 点击 agent → QuickPick 换模型/variant → 程序化写回）+ 快速打开（编辑器直接编辑 + JSONC 校验） |
| 硬约束 | `opencode.json` 实测为 JSONC（含尾逗号）。程序化编辑必须保留注释与格式 |

## 3. 架构

```
oh-my-dashboard/
├── src/                          # 扩展主进程（Node.js）
│   ├── extension.ts              # 入口：注册 TreeView / 命令 / Webview / 状态栏
│   ├── tree/                     # TreeView 数据提供者与节点定义
│   ├── core/                     # 纯逻辑层（禁止 import vscode，全部可单测）
│   │   ├── configStore.ts        #   配置发现（ConfigLocator）/读写
│   │   ├── jsoncEditor.ts        #   JSONC 保留注释修改（jsonc-parser modify()）
│   │   ├── backupService.ts      #   备份/恢复/保留策略
│   │   └── presetService.ts      #   预设 CRUD + 应用（合并语义）
│   ├── webview/                  # 预设编辑器 Webview 宿主（postMessage 协议）
│   └── ui/                       # QuickPick / 消息 / diff 入口
├── webview-ui/                   # 预设编辑器前端（Vite + React，单 bundle）
└── test/                         # vitest 单测 + @vscode/test-electron 集成冒烟
```

分层原则：**core/ 不依赖 VSCode API**，保证业务逻辑可独立单元测试。

## 4. 数据模型

### 4.1 预设（部分快照，只含可切换维度）

`~/.config/opencode/presets/<name>.json`：

```json
{
  "name": "重度创作",
  "description": "主力模型全开 max/xhigh",
  "createdAt": "2026-08-21T14:00:00Z",
  "appliedAt": "2026-08-21T15:00:00Z",
  "defaults": { "model": "zhipuai-coding-plan/glm-5.3" },
  "agents":     { "oracle": { "model": "…", "variant": "high" } },
  "categories": { "ultrabrain": { "model": "…", "variant": "xhigh" } }
}
```

- 预设里未列出的 agents/categories 键在应用时不改动（合并语义）
- `defaults.model` 对应 `opencode.json` 的默认模型

### 4.2 备份（管理范围全量快照）

`~/.config/opencode/backups/<ISO时间戳>-<reason>/`：

```
opencode.json  oh-my-opencode.json  AGENTS.md  command/  skills/
manifest.json  # { reason, preset?, createdAt, fileCount, machine }
```

备份与预设分工：备份 = 全量 + 时间线（恢复用）；预设 = 模型维度 + 命名（切换用）。

## 5. TreeView 设计

```
📦 OpenCode 配置
├── ⚙️ 配置文件
│   ├── opencode.json / oh-my-opencode.json   → 点击打开（保存时校验+条件自动备份）
│   │   └── oh-my-opencode.json 可展开：
│   │       🤖 oracle: glm-5.2/high    → 点击 QuickPick 换模型/variant
│   │       📦 ultrabrain: glm-5.2/xhigh
│   ├── AGENTS.md（全局 / 各工作区根的项目级）
│   └── 📁 command/ (N)  📁 skills/ (N)
├── 🎛️ 预设
│   ├── 🟢 重度创作（当前）  → 右键: 应用/编辑/重命名/删除/导出
│   └── ➕ 从当前配置捕获…
└── 🗂️ 备份
    └── 🕐 <时间> <原因>    → 右键: 恢复/对比(diff)/删除
```

## 6. Webview 预设编辑器

- 矩阵表单：Agents（10）与 Categories（13）分组列表，每行模型下拉 + variant 下拉
- 模型下拉数据源：解析 `opencode.json` 全部 `provider.models`（自动跟随新增 provider）
- variant 枚举：`—/low/medium/high/xhigh/max`
- 批量操作：全部模型设为某模型
- 按钮：取消 / 保存 / 保存并应用
- 主题跟随 VSCode（CSS 变量）；未保存关闭提示
- 通信：`postMessage` ↔ 扩展侧 `presetService`

## 7. JSONC 编辑管线（核心）

```
读取 → jsonc-parser parseTree() → AST（含位置/注释）
修改 → modify(text, edits[], formattingOptions) → 新文本（保留注释与缩进）
写回 → 写 .tmp → fsync → 原子 rename
```

- 程序化编辑一律走 `modify()`，禁止 `parse → JSON.stringify`
- 保存校验：`parse()` errors 非空 → 提示错误位置，跳过自动备份（防垃圾快照）
- 格式：2 空格缩进，与现有文件风格一致

## 8. 应用预设流程

```
1. 自动备份（reason=pre-apply）
2. 读 oh-my-opencode.json AST
3. 预设中的 agents.X.model/variant、categories.X.*、defaults.model 逐路径 modify()
4. 原子写回 → 更新 appliedAt → 刷新 TreeView + 状态栏
```

## 9. 备份策略

| 触发点 | reason | 保留策略 |
|---|---|---|
| 手动立即备份 | `manual` | 永久 |
| 应用预设前 | `pre-apply` | 最近 20 份（设置可配） |
| 编辑器保存被管理文件（内容有变化时） | `pre-save` | 同上 |

恢复：先做 `pre-restore` 备份（双向安全）→ 复制 → 刷新。
对比：`vscode.diff(backupFile, currentFile)`。

## 10. 错误处理与边界

- 配置不存在：TreeView 引导项，一键从模板创建
- JSONC 语法错误：节点显示 ⚠️，禁用结构化编辑，只能手动修复
- 路径发现：Linux `~/.config/opencode` / macOS `~/Library/Application Support/opencode`，尊重 `XDG_CONFIG_HOME`
- 多根工作区：每个 root 各显示项目级 `AGENTS.md`
- 原子写：tmp+rename；opencode 会话启动时读配置，运行中修改无冲突

## 11. 测试策略

- core/ 单测（vitest，无 VSCode 依赖）：
  - jsoncEditor：注释/尾逗号保留 round-trip（真实配置脱敏 fixture）
  - presetService：应用前后 diff 断言（合并语义、未列出键不动）
  - backupService：保留策略、恢复往返
- 集成冒烟（@vscode/test-electron）：命令注册、TreeView 渲染

## 12. 工具链

TypeScript 5 + npm；Webview Vite + React；`vsce package` 出 `.vsix`，
`code --install-extension` 本地安装，不上 Marketplace。

## 13. 命令清单（contributes）

- `opencode.openConfig` / `opencode.setAgentModel`
- `opencode.capturePreset` / `opencode.applyPreset` / `opencode.editPreset`
- `opencode.backupNow` / `opencode.restoreBackup` / `opencode.diffBackup`
- 状态栏：当前预设名，点击弹出切换 QuickPick
