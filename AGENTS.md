# AGENTS.md

VSCode 扩展「OpenCode Config Manager」：管理 opencode / oh-my-openagent 配置（修改、备份、恢复、预设切换）。设计文档：`docs/plans/2026-08-21-vscode-opencode-config-manager-design.md`。

## 构建与测试（命令顺序敏感）

```bash
npm install && npm --prefix webview-ui install   # 两个独立 npm 项目，都要装
npx vitest run                                    # 单元+集成（纯 Node，无 VSCode）
npx tsc --noEmit                                  # 类型检查（vitest 不做类型检查，必跑）
npm run package                                   # 编译+webview构建+同步dist-webview+vsce → build/packages/
./scripts/e2e.sh                                  # e2e 入口（跨平台：内部转调 scripts/e2e.mjs；Win/macOS 直接跑，Linux 无 DISPLAY 时自动套 xvfb-run）
./scripts/install-code-server.sh                  # 安装最新 vsix 到本机 code-server（会重置 models.json）
```

- **不要直接跑 `npm run test:e2e`**（Linux 无显示服务器会挂）；统一走 `node scripts/e2e.mjs`（或 `./scripts/e2e.sh`），由它按平台决定是否套 xvfb-run。
- `webview-ui/build` 是 Vite 产物，`dist-webview/` 是它的拷贝 — `npm run package` 和 e2e runner 会自动同步；手动构建 webview 后若直接跑 e2e，需先 `npm run build:webview`。
- e2e 首次运行会向 `.vscode-test/` 下载 ~150MB 的 VSCode 二进制。
- **每次 `npm run package` 打包前必须递增版本号**（用 `npm version <major|minor|patch> --no-git-tag-version`，会同步 package.json 与 lockfile）：bug 修复、模型清单等数据更新升 patch；新功能或行为变化升 minor；不兼容变更升 major。禁止不升版本重复打包。

## 硬性架构约束

- **`src/core/` 禁止 import 'vscode'**（纯逻辑层，vitest 直接测）；VSCode 依赖只允许在 `src/extension.ts`、`src/tree/provider.ts`、`src/ui/`、`src/webview/`。
- **`src/shared/protocol.ts` 同时被扩展宿主和 webview-ui 打包**（webview 经 `@shared` alias 引用）— 禁止 import 'vscode'，改动会同时影响两侧。
- **JSONC 编辑只走 `src/core/jsoncEditor.ts`**（jsonc-parser `modify()` 链式 + `applyEdits`），禁止 `JSON.parse → 修改 → stringify`（会毁掉注释/尾逗号/tab 缩进；用户真实配置是 JSONC）。jsonc-parser 语义：`undefined`=删除键，`null` 会写入 JSON null。
- **文件写入只走 `src/core/atomicFile.ts` 的 `writeFileAtomic`**（tmp+fsync+rename，Windows EPERM/EACCES/EBUSY 退避重试；configStore.writeAtomic 是其薄封装）。备份拷贝/恢复目录用 `cpSync(..., { dereference: true })`（Windows 重建符号链接需特权）。
- **读配置分两级**：展示路径用 `readTextOrEmpty`（不可读降级为空）；写回路径（apply/setAgentModel 等）必须用 `readTextForEdit`（文件存在但不可读时抛 `CONFIG_UNREADABLE` 中止，绝不当空文件覆盖）。
- **名称安全收口在 `src/core/pathSafety.ts`**：`assertContainedFileName` 防目录遍历（所有以名称取文件的入口；`\` 仅在 win32 视为分隔符），`presetNameError` 是创建时严格校验（Windows 非法字符/保留名/末尾点空格）。存量非法名文件可读可删可应用，仅新建/重命名受限。
- **`package.json` 的 contributes 与 `src/constants.ts`（CMD/VIEW）必须手工保持同步**，新增命令/视图两处都要改。
- UI 文案全部中文；核心层错误码（`INVALID_PRESET_NAME`/`PRESET_NOT_FOUND` 等）在 `commands.ts` 的 `FRIENDLY_ERRORS` 映射为中文提示。

## 测试约定

- 所有测试用 `fs.mkdtempSync(os.tmpdir(), ...)` 沙盒，**绝不触碰真实 `~/.config/opencode`**（e2e runner 有 XDG_CONFIG_HOME + `OPENCODE_CONFIG_DIR: ""` 隔离 + 指纹守卫，发现真实配置被改动会直接失败）。
- `test/fixtures/opencode.jsonc` 的尾逗号和 tab 缩进是**故意保留的**真实 JSONC 怪癖，不要"修复"它（jsoncEditor 测试依赖）。
- 新增 core 行为先写 `test/unit/<module>.test.ts`（TDD：红→绿）；跨模块流程放 `test/integration/pipeline.test.ts`。
- 权限类测试（chmod 000）在 Windows 无意义、以 root 运行时读限制无效 — 用 `it.skipIf(process.platform === "win32" || process.getuid?.() === 0)` 跳过；目录符号链接测试在 Windows 用 `junction` 类型（无需特权）。
- e2e 里会弹模态框的命令（restore/delete 等）必须接受程序化参数绕过 UI，否则 headless 下挂死 — 参考 `test/e2e/suite/index.ts` 的 `executeRestoreBackup` patch 模式。

## 数据与运行时位置

- 管理对象：`~/.config/opencode/` 下 `opencode.json`（或 `opencode.jsonc`）、`AGENTS.md`、`command/`、`skills/`；预设存 `presets/*.json`；备份存 `backups/<ISO时间戳>-manual/`（只有手动备份，无自动备份）。
- agent/category 配置目标**不固定**：`ConfigStore.resolveAgentConfig()` 按 `~/.omo/omo.jsonc` → `~/.omo/omo.json` → `oh-my-opencode.jsonc` → `oh-my-opencode.json` → `oh-my-openagent.jsonc` → `oh-my-openagent.json` 顺序检测（与 oh-my-openagent 运行时同序）；都不存在时按 `~/.omo` 目录或 opencode.json 的 plugin 条目决定创建目标。omo 目标写 `[opencode]` 块内的 `reasoning` 键，legacy 目标写顶层 `variant` 键；应用时会清掉被改条目的冲突键（`variant`/`reasoning`/`models` 链）。
- 模型清单：内置清单在 `src/core/builtinModels.ts`，首次使用 seed 到 `~/.config/opencode/models.json`（可手编、损坏自愈重建，自愈前原文件备份为 `models.json.bak`）。清单来源是 models.dev（opencode 官方目录）— 更新模型时以其 provider/model id 为准。
- 配置目录解析与 opencode 运行时严格一致：opencode 用 `xdg-basedir`（无平台分支），三平台同为 `OPENCODE_CONFIG_DIR` > `$XDG_CONFIG_HOME/opencode` > `~/.config/opencode`（macOS 不用 `~/Library/Application Support`，Windows 不用 `%APPDATA%`）；缓存/数据同理为 `~/.cache/opencode`、`~/.local/share/opencode`。
- 插件发现：`ConfigStore.listPlugins()` 读 opencode.json[c] 的 `plugin` 数组（V2 `plugins` 键及 `{package}` 对象条目兼容）。npm 条目（可带 `@版本` 后缀，scoped 名切到第二个 `@`）按 opencode 现行 arborist 布局解析：`<cache>/packages/<spec>/node_modules/<name>/`（裸名 spec 的目录键为 `<name>@latest`，win32 下非法字符按上游 sanitize 置 `_`；目录键漂移时扫描 `packages/*/node_modules/<name>` 兜底），再回退 bun 时代平铺布局 `<cache>/node_modules/<name>/` 与 `<configDir>/node_modules/<name>/`；路径条目（`~/`、`./`、`/`、`file://` 前缀，`file://` 走 `fileURLToPath`）按 home/configDir 解析。插件文件树排除嵌套 `node_modules` 与 `.git`；configDir lockfile、缓存根 lockfile 与 `packages/` 平铺监视触发树刷新。
- skills 发现：`SkillLocation.scope` 只有 `global|project`（家目录约定一律 global）。全局候选序：`~/.agents/skills` → `~/.claude/skills` → `<configDir>/skills` → `$XDG_CONFIG_HOME/agents|amp/skills` → `~/.copilot|​.gemini|.cursor|.codeium/windsurf|.codex/skills`；项目候选序：`.agents/` → `.claude/` → `.opencode/` → `.github/` → `.gemini/` → `.cursor/` → `.windsurf/` 下 `skills/`。仅报存在的目录（configDir 与家目录重合时去重）；技能=含 `SKILL.md` 的子目录，符号链接跟随判定（`~/.claude/skills` 常为指向 `~/.agents/skills` 的链接）。树行 label=显示路径（`~/…` 或工作区相对），description=`全局|项目 N`。备份 extraDirs 只带 `~/.agents/skills`（其余目录归各自工具管理）。
- Coding Plan 额度：`src/core/quotaService.ts` 从 `~/.local/share/opencode/auth.json` 读 Kimi/GLM/DeepSeek 凭据查官方接口（Kimi `api.kimi.com/coding/v1/usages`，GLM `open.bigmodel.cn/api/monitor/usage/quota/limit`，GLM unit 枚举 1=天/3=时/6=周，DeepSeek `api.deepseek.com/user/balance` 按量计费只有余额无窗口、多币种取 CNY 优先）；MiMo 走 `platform.xiaomimimo.com` Dashboard Cookie（存 `<configDir>/quota.json`，只有月度窗口，无 5h/周）。e2e 通过 `XDG_DATA_HOME` 隔离避免真实网络请求。
- 备份保留：手动备份永不清理；`DEFAULT_RETENTION` 里的 pre-* 规则仅为兼容旧版本残留备份。备份创建走暂存目录（`backups/.tmp-*` → rename 发布，失败自动清理，下次创建时 sweep）；恢复时受管文件经 `writeFileAtomic` 写回（ENOSPC/占用不会截断活配置）。Windows 下深层 skills 备份可能触 MAX_PATH（需用户开 LongPathsEnabled）。
- 备份导入/导出用 zip（`fflate`，纯 JS 无原生依赖）：导出含空目录显式 `name/` 条目；导入先 stat 限制压缩包大小，再用 `unzipSync` 的 `filter`（解压前拿到头部声明的 originalSize）限流防 zip 炸弹，条目名经 `assertZipEntryName` 防遍历，`manifest.json` 必须 v1，未知 reason 降级 manual（用 `Object.hasOwn` 判定，勿用 `in` —— 会命中原型链），目录名冲突加 `-import-N`。写入期 EEXIST/ENOTDIR/EISDIR 映射为 `BACKUP_IMPORT_INVALID`。

## Git 约定

- 提交信息用 Conventional Commits（`feat:`/`fix:`/`chore:`/`test:`），正文可中文。
- `build/`、`dist/`、`dist-webview/`、`.vscode-test/`、`webview-ui/build`、*.vsix 均已 gitignore — 提交前 `git status` 确认无产物混入。
