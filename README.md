# OpenCode Config Manager

VSCode 扩展：管理 [opencode](https://opencode.ai) 与 [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) 的配置文件 — 结构化修改、备份、恢复、命名预设一键切换。

## 功能

- **配置面板**（活动栏侧边栏）：配置文件 / 预设 / 备份三区树形视图
  - `opencode.json`（JSONC，保留注释与尾逗号）、`oh-my-opencode.json`、`AGENTS.md`（全局+项目级）、`command/`、`skills/`
  - agent/category 节点点击 → QuickPick 选模型与 variant，程序化写回
- **预设**：从当前配置捕获；Webview 矩阵编辑器（批量设模型、逐行 variant）；应用采用合并语义（预设未列出的键不动）
- **备份**：手动「立即备份」；manifest 记录原因；与当前配置 diff 对比；恢复时明确警告覆盖（应用/恢复不再自动产生备份）
- **状态栏**：显示当前预设，点击快速切换（`Ctrl+Alt+P`）

## 安装

```bash
npm install
npm --prefix webview-ui install
npm run package           # 编译 + webview 构建 + vsce 打包 → build/packages/
code --install-extension build/packages/opencode-config-manager-0.3.0.vsix
```

## 使用

1. 点击活动栏 OpenCode 图标打开面板
2. 首次：点「从当前配置捕获…」存一个基线预设
3. 改模型：展开 `oh-my-opencode.json` → 点任意 agent → 选模型
4. 切换：状态栏或预设区右键「应用」
5. 后悔药：变更前先「立即备份」，需要时备份区右键「恢复」/「对比」

### 模型清单

内置清单定义在 `src/core/builtinModels.ts`，首次调用模型列表时写入 `~/.config/opencode/models.json`（自愈：损坏或为空时自动重建）。展示顺序：`opencode.json` 条目优先，按 id 排序去重。

### 设置

| 键 | 默认 | 说明 |
|---|---|---|
| `opencodeConfigManager.configDirOverride` | — | 配置目录覆盖（默认 `~/.config/opencode`，尊重 `XDG_CONFIG_HOME`） |

## 架构

```
src/core/      纯逻辑（无 vscode 依赖，vitest 单测）
  jsoncEditor    jsonc-parser modify() 封装 — 注释/格式保留 + 原子写
  configStore    路径发现 / 模型目录 / 读写
  backupService  快照 / 恢复 / 保留策略
  presetService  预设 CRUD + 合并应用
src/tree/      树节点纯构建器 + 3 个 TreeDataProvider
src/ui/        命令 / QuickPick / 状态栏 / 保存守护
src/webview/   预设编辑器宿主（CSP + nonce + postMessage 协议）
webview-ui/    React 矩阵表单（Vite 单 bundle，VSCode CSS 变量主题）
```

数据位置：预设 `~/.config/opencode/presets/*.json`；备份 `~/.config/opencode/backups/<ISO时间戳>-<原因>/`（含 `manifest.json`）。

## 测试

```bash
npm test                 # vitest：单元 + 集成（85 tests）
./scripts/e2e.sh         # @vscode/test-electron 冒烟（xvfb 隔离环境）
```

设计文档：`docs/plans/2026-08-21-vscode-opencode-config-manager-design.md`
