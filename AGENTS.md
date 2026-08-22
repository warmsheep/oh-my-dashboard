# AGENTS.md

VSCode 扩展「OpenCode Config Manager」：管理 opencode / oh-my-openagent 配置（修改、备份、恢复、预设切换）。设计文档：`docs/plans/2026-08-21-vscode-opencode-config-manager-design.md`。

## 构建与测试（命令顺序敏感）

```bash
npm install && npm --prefix webview-ui install   # 两个独立 npm 项目，都要装
npx vitest run                                    # 单元+集成（纯 Node，无 VSCode）
npx tsc --noEmit                                  # 类型检查（vitest 不做类型检查，必跑）
npm run package                                   # 编译+webview构建+同步dist-webview+vsce → build/packages/
./scripts/e2e.sh                                  # e2e（需要 xvfb-run，Linux headless 下必须走这个脚本）
./scripts/install-code-server.sh                  # 安装最新 vsix 到本机 code-server（会重置 models.json）
```

- **不要直接跑 `npm run test:e2e`**（Linux 无显示服务器会挂）；必须走 `./scripts/e2e.sh`。
- `webview-ui/build` 是 Vite 产物，`dist-webview/` 是它的拷贝 — `npm run package` 和 e2e runner 会自动同步；手动构建 webview 后若直接跑 e2e，需先 `npm run build:webview`。
- e2e 首次运行会向 `.vscode-test/` 下载 ~150MB 的 VSCode 二进制。
- **每次 `npm run package` 打包前必须递增版本号**（用 `npm version <major|minor|patch> --no-git-tag-version`，会同步 package.json 与 lockfile）：bug 修复、模型清单等数据更新升 patch；新功能或行为变化升 minor；不兼容变更升 major。禁止不升版本重复打包。

## 硬性架构约束

- **`src/core/` 禁止 import 'vscode'`**（纯逻辑层，vitest 直接测）；VSCode 依赖只允许在 `src/extension.ts`、`src/tree/provider.ts`、`src/ui/`、`src/webview/`。
- **`src/shared/protocol.ts` 同时被扩展宿主和 webview-ui 打包**（webview 经 `@shared` alias 引用）— 禁止 import 'vscode'，改动会同时影响两侧。
- **JSONC 编辑只走 `src/core/jsoncEditor.ts`**（jsonc-parser `modify()` 链式 + `applyEdits`），禁止 `JSON.parse → 修改 → stringify`（会毁掉注释/尾逗号/tab 缩进；用户真实配置是 JSONC）。jsonc-parser 语义：`undefined`=删除键，`null` 会写入 JSON null。
- **`package.json` 的 contributes 与 `src/constants.ts`（CMD/VIEW）必须手工保持同步**，新增命令/视图两处都要改。
- UI 文案全部中文。

## 测试约定

- 所有测试用 `fs.mkdtempSync(os.tmpdir(), ...)` 沙盒，**绝不触碰真实 `~/.config/opencode`**（e2e runner 有 XDG_CONFIG_HOME 隔离 + 指纹守卫，发现真实配置被改动会直接失败）。
- `test/fixtures/opencode.jsonc` 的尾逗号和 tab 缩进是**故意保留的**真实 JSONC 怪癖，不要"修复"它（jsoncEditor 测试依赖）。
- 新增 core 行为先写 `test/unit/<module>.test.ts`（TDD：红→绿）；跨模块流程放 `test/integration/pipeline.test.ts`。
- e2e 里会弹模态框的命令（restore/delete 等）必须接受程序化参数绕过 UI，否则 headless 下挂死 — 参考 `test/e2e/suite/index.ts` 的 `executeRestoreBackup` patch 模式。

## 数据与运行时位置

- 管理对象：`~/.config/opencode/` 下 `opencode.json`（或 `opencode.jsonc`）、`AGENTS.md`、`command/`、`skills/`；预设存 `presets/*.json`；备份存 `backups/<ISO时间戳>-manual/`（只有手动备份，无自动备份）。
- agent/category 配置目标**不固定**：`ConfigStore.resolveAgentConfig()` 按 `~/.omo/omo.jsonc` → `~/.omo/omo.json` → `oh-my-opencode.jsonc` → `oh-my-opencode.json` → `oh-my-openagent.jsonc` → `oh-my-openagent.json` 顺序检测（与 oh-my-openagent 运行时同序）；都不存在时按 `~/.omo` 目录或 opencode.json 的 plugin 条目决定创建目标。omo 目标写 `[opencode]` 块内的 `reasoning` 键，legacy 目标写顶层 `variant` 键；应用时会清掉被改条目的冲突键（`variant`/`reasoning`/`models` 链）。
- 模型清单：内置清单在 `src/core/builtinModels.ts`，首次使用 seed 到 `~/.config/opencode/models.json`（可手编、损坏自愈重建）。清单来源是 models.dev（opencode 官方目录）— 更新模型时以其 provider/model id 为准。
- 插件发现：`ConfigStore.listPlugins()` 读 opencode.json[c] 的 `plugin` 数组（V2 `plugins` 键及 `{package}` 对象条目兼容）。npm 条目（可带 `@版本` 后缀，scoped 名切到第二个 `@`）优先解析运行时缓存 `~/.cache/opencode/node_modules/<name>/`（尊重 `XDG_CACHE_HOME`），回退 `<configDir>/node_modules/<name>/`；路径条目（`~/`、`./`、`/`、`file://` 前缀）按 home/configDir 解析。插件文件树排除嵌套 `node_modules` 与 `.git`；configDir 与缓存目录的 lockfile（package.json/package-lock.json/bun.lock）写入会触发树刷新。
- skills 发现：`SkillLocation.scope` 只有 `global|project`（家目录约定一律 global）。全局候选序：`~/.agents/skills` → `~/.claude/skills` → `<configDir>/skills` → `$XDG_CONFIG_HOME/agents|amp/skills` → `~/.copilot|​.gemini|.cursor|.codeium/windsurf|.codex/skills`；项目候选序：`.agents/` → `.claude/` → `.opencode/` → `.github/` → `.gemini/` → `.cursor/` → `.windsurf/` 下 `skills/`。仅报存在的目录（configDir 与家目录重合时去重）；技能=含 `SKILL.md` 的子目录，符号链接跟随判定（`~/.claude/skills` 常为指向 `~/.agents/skills` 的链接）。树行 label=显示路径（`~/…` 或工作区相对），description=`全局|项目 N`。备份 extraDirs 只带 `~/.agents/skills`（其余目录归各自工具管理）。
- Coding Plan 额度：`src/core/quotaService.ts` 从 `~/.local/share/opencode/auth.json` 读 Kimi/GLM/DeepSeek 凭据查官方接口（Kimi `api.kimi.com/coding/v1/usages`，GLM `open.bigmodel.cn/api/monitor/usage/quota/limit`，GLM unit 枚举 1=天/3=时/6=周，DeepSeek `api.deepseek.com/user/balance` 按量计费只有余额无窗口、多币种取 CNY 优先）；MiMo 走 `platform.xiaomimimo.com` Dashboard Cookie（存 `<configDir>/quota.json`，只有月度窗口，无 5h/周）。e2e 通过 `XDG_DATA_HOME` 隔离避免真实网络请求。
- 备份保留：手动备份永不清理；`DEFAULT_RETENTION` 里的 pre-* 规则仅为兼容旧版本残留备份。

## Git 约定

- 提交信息用 Conventional Commits（`feat:`/`fix:`/`chore:`/`test:`），正文可中文。
- `build/`、`dist/`、`dist-webview/`、`.vscode-test/`、`webview-ui/build`、*.vsix 均已 gitignore — 提交前 `git status` 确认无产物混入。
