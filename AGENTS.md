# AGENTS.md

VSCode 扩展「OpenCode Config Manager」：管理 opencode / oh-my-openagent 配置（修改、备份、恢复、模板切换）。设计文档：`docs/plans/2026-08-21-vscode-opencode-config-manager-design.md`。

## 开发流程约束

接收到指令时先判断任务类型，按类型选择工作方式：

1. **简单任务**：自行开发、验证。
2. **复杂但单一的任务**：自行分析任务、修改，并委派子代理进行审查、验证；最终经多轮「审查 + 修复」完成任务。
3. **复杂长任务**：以项目经理角色推进项目，自己不参与开发，委派子代理进行分析、开发、审查、测试。像 pipeline 一样工作：分析 → 出具分析报告 → 开发 → 审查 + 测试 → 出具测试报告 → 再修复 + 审查 + 测试，循环直至任务完成。

### 开发、测试约束

1. 代码风格统一。
2. 代码简洁、高度抽象不冗余。
3. 可以用配置、枚举、常量的地方，不要硬编码。
4. 设计以及需求不过于发散，尽量简单地解决本次需求。
5. 有现成的类似代码，优先引用和改造，不要重复实现类似的代码块。
6. 社区有成熟且简单的方案或开源项目时，优先使用成熟方案，不要从零开始写。
7. 代码需有良好的注释，代码变更后需同步修改注释。
8. 代码需有单元测试，单元测试覆盖率达到 100%。
9. 代码编写需注意异常处理、边界处理、安全隐患、漏洞。
10. 代码需有集成测试、E2E 测试。

### 审查约束

1. 审查代码的编写风格、健壮性、安全性、性能、Bug、漏洞、兼容性。
2. 审查代码与实际需求理解是否有偏差。
3. 审查代码对各类异常情况的处理。

## 构建与测试（命令顺序敏感）

```bash
npm install && npm --prefix webview-ui install   # 两个独立 npm 项目，都要装
npm test                                          # 全部测试 = 根 vitest（单元+集成，纯 Node）+ webview-ui vitest 两个套件链式运行
npx vitest run                                    # 仅根套件：单元+集成（纯 Node，无 VSCode）
npx tsc --noEmit                                  # 类型检查（vitest 不做类型检查，必跑）
npm run package                                   # 编译+webview构建+同步dist-webview+vsce → build/packages/
./scripts/e2e.sh                                  # e2e 入口（内部转调 scripts/e2e.mjs）
./scripts/install-code-server.sh                  # 安装最新 vsix 到本机 code-server（绝不触碰 models.json）
```

- **e2e 统一走 `./scripts/e2e.sh`（或 `node scripts/e2e.mjs`），不要直接跑 `npm run test:e2e`**：runner 按平台决定是否套 xvfb-run（Linux 无 DISPLAY 时自动套）；首次运行会向 `.vscode-test/` 下载 ~150MB 的 VSCode 二进制。
- `webview-ui/build` 是 Vite 产物，`dist-webview/` 是它的拷贝 — `npm run package` 与 e2e runner 都会自动处理（runner 发现 build 缺失会自动跑 `npm run build:webview` 再同步 `dist-webview/`），无需手动预处理。
- **每次 `npm run package` 打包前必须递增版本号**（用 `npm version <major|minor|patch> --no-git-tag-version`，会同步 package.json 与 lockfile）：bug 修复、模型清单等数据更新升 patch；新功能或行为变化升 minor；不兼容变更升 major。禁止不升版本重复打包。

## 硬性架构约束

- **`src/core/` 禁止 import 'vscode'**（纯逻辑层，vitest 直接测）；VSCode 依赖只允许在 `src/extension.ts`、`src/tree/provider.ts`、`src/ui/`、`src/webview/`。
- **`src/shared/protocol.ts` 同时被扩展宿主和 webview-ui 打包**（webview 经 `@shared` alias 引用）— 禁止 import 'vscode'，改动会同时影响两侧。
- **JSONC 编辑只走 `src/core/jsoncEditor.ts`**（jsonc-parser `modify()` 链式 + `applyEdits`），禁止 `JSON.parse → 修改 → stringify`（会毁掉注释/尾逗号/tab 缩进；用户真实配置是 JSONC）。jsonc-parser 语义：`undefined`=删除键，`null` 会写入 JSON null。
- **文件写入只走 `src/core/atomicFile.ts` 的 `writeFileAtomic`**（tmp+fsync+rename，Windows EPERM/EACCES/EBUSY 退避重试；configStore.writeAtomic 是其薄封装）。备份目录拷贝走 backupService 自研递归拷贝（逐条目 `lstat`，符号链接一律跳过不跟随——防第三方 skills 目录植入链接越界读取/秘密外泄/全盘拷贝；受 256MB/2 万条目/16 层深度上限约束，超限抛 `BACKUP_CREATE_TOO_LARGE`/`BACKUP_EXPORT_TOO_LARGE` 纯错误码）。恢复目录前先递归清理目标路径上"挡道"的符号链接（防恢复经 `skills/x → ~/.bashrc` 类植入链接写穿目标），实际拷贝用 `cpSync(..., { dereference: true })`（备份树内无链接，Windows 重建符号链接需特权的问题不复存在）。
- **读配置分两级**：展示路径用 `readTextOrEmpty`（不可读降级为空）；写回路径（apply/setAgentModel 等）必须用 `readTextForEdit`（文件存在但不可读时抛 `CONFIG_UNREADABLE` 中止，绝不当空文件覆盖）。
- **名称安全收口在 `src/core/pathSafety.ts`**：`assertContainedFileName` 防目录遍历（所有以名称取文件的入口；`\` 仅在 win32 视为分隔符），`presetNameError` 是创建时严格校验（Windows 非法字符/保留名/末尾点空格）。存量非法名文件可读可删可应用，仅新建/重命名受限。
- **`package.json` 的 contributes 与 `src/constants.ts`（CMD/VIEW）必须手工保持同步**，新增命令/视图两处都要改。
- UI 文案全部中文；核心层错误码（`INVALID_PRESET_NAME`/`PRESET_NOT_FOUND` 等）在 `src/core/errors.ts` 的 `FRIENDLY_ERRORS`/`errorMessage()` 映射为中文提示（`JsoncSyntaxError` 与文件系统 errno 同在此映射）；额度模块直接产出中文友好消息。

## 代码风格

- **Prettier 统一格式**：根 `.prettierrc`（printWidth 120、双引号、trailingComma all），`@ianvs/prettier-plugin-sort-imports` 排 import（组序：`node:` 内置 → 外部包 → 相对路径，组间空行；specifier 排序、`import type` 保持独立语句紧邻同模块值导入）。提交前对 src/test/webview-ui 等源码跑 `npx prettier --check`；`test/fixtures/**` 与 *.md 不格式化。
- **fs 依赖注入命名**（core 可注入 fs 的模块）：真实模块导入别名一律 `import * as defaultFs from "node:fs"`，注入参数/类属性一律 `fsMod`；对外 OPTIONS 键名保持 `fs`（测试注入 `{fs: fake}`）。
- **注释一律英文**（引用 UI 文案原文可内嵌中文）；**用户可见字符串一律中文**。
- **core 层导出符号至少一行 JSDoc**；UI 工厂函数说明返回对象的 dispose 生命周期。
- **日志只走注入的 log 回调**（前缀 `模块名: `），禁止 `console.*`。
- **if/for 单语句体也必须花括号**；递增用 `+= 1`（不用 `++`）。
- **常量禁止跨文件复制**：能 import 就 import（如 `BACKUP_REASON_LABELS` 收口在 core/types.ts、`KNOWN_AGENTS` 收口在 shared/protocol.ts）；确需复制必须附"为何不能 import"注释。

## 测试约定

- 所有测试用 `fs.mkdtempSync(os.tmpdir(), ...)` 沙盒，**绝不触碰真实 `~/.config/opencode`**（e2e runner 有 XDG_CONFIG_HOME + `OPENCODE_CONFIG_DIR: ""` 隔离 + 指纹守卫，发现真实配置被改动会直接失败）。
- `test/fixtures/opencode.jsonc` 的尾逗号和 tab 缩进是**故意保留的**真实 JSONC 怪癖，不要"修复"它（jsoncEditor 测试依赖）。
- 新增 core 行为先写 `test/unit/<module>.test.ts`（TDD：红→绿）；跨模块流程放 `test/integration/pipeline.test.ts`。
- 权限类测试（chmod 000）在 Windows 无意义、以 root 运行时读限制无效 — 用 `it.skipIf(process.platform === "win32" || process.getuid?.() === 0)` 跳过；目录符号链接测试在 Windows 用 `junction` 类型（无需特权）。
- e2e 里会弹模态框的命令（restore/delete 等）必须接受程序化参数绕过 UI，否则 headless 下挂死 — 参考 `test/e2e/suite/index.ts` 的 `executeRestoreBackup` patch 模式。

## 数据与运行时位置

- 管理对象：`~/.config/opencode/` 下 `opencode.json`（或 `opencode.jsonc`）、`AGENTS.md`、`command/`、`skills/`；模板（原「预设」，代码与文件名仍用 preset）存 `presets/*.json`；备份存 `backups/<ISO时间戳>-manual/`（只有手动备份，无自动备份）。
- **扩展宿主纪律（不许以任何方式拖累其他插件）**：`readDirTree` 统一排除 `.git`/`node_modules`（共享 `TREE_EXCLUDES`）且单次遍历 ≤`TREE_MAX_ENTRIES`(=4000) 条；watchManager 刷新节流 ≥1s + 连续事件 maxWait 2s（防 debounce 活锁）+ 失败重 arm 指数退避（1s→30s）；`backups/` 只做**扁平**监视（递归会随历史备份线性吃光 Linux inotify 配额 8192，殃及 workbench 与所有插件），全局 skills 监视目标先 realpath 去重；`provider.refresh()` 重载期间的触发用脏标记合并为一次尾随重载；warmup 延迟 2s 避开启动 IO 风暴；`restore()` 与 create 同受 256MB/2 万条目预算约束（`BACKUP_RESTORE_TOO_LARGE`）。
- agent/category 配置目标**不固定**：`ConfigStore.resolveAgentConfig()` 按 `~/.omo/omo.jsonc` → `~/.omo/omo.json` → `oh-my-opencode.jsonc` → `oh-my-opencode.json` → `oh-my-openagent.jsonc` → `oh-my-openagent.json` 顺序检测（与 oh-my-openagent 运行时同序）；都不存在时按 `~/.omo` 目录或 opencode.json 的 plugin 条目决定创建目标。omo 目标写 `[opencode]` 块内的 `reasoning` 键，legacy 目标写顶层 `variant` 键；应用时会清掉被改条目的冲突键（`variant`/`reasoning`/`models` 链）。
- 模型清单：**插件不内置模型**，仅内置供应商白名单 `BUILTIN_PROVIDERS`（`src/core/builtinModels.ts`）。本地清单 `~/.config/opencode/models.json`：`ensureLocalModelsFile` 是**纯读**（缺失/为空/损坏一律返回 `[]`，绝不写盘——安装/升级绝不覆盖用户已有文件），损坏（shape 破损）时一次性备份 `models.json.bak` 后降级为空。清单为空时激活 warmup 会调 `modelCatalog.seedLocalModelsFromCatalog` 从 `models.dev/api.json` 按白名单拉取落盘（单请求、30s 超时、错误映射复用 quotaService 的 `readJsonBody`/`friendlyRequestError`；ExtensionMode.Test 跳过保 e2e hermetic；断网失败只记日志，下次激活重试）。「更新模型清单」按钮拉取同接口，按当前清单所涉供应商过滤后合并进 models.json（同 id 以最新覆盖、新 id 追加、用户自定义模型不删除；清单为空时回退白名单全量拉取）；合并语义收口在 `builtinModels.mergeCatalogIntoLocal`。**可用性过滤收口在 `modelCatalog.fetchModelCatalogs`**：只保留 `tool_call === true` 且 `status !== "deprecated"` 的模型（TTS/图像/视频/embedding 与已退役旧世代一律不下载），弃用 id 单独返回（`FetchedCatalog.deprecatedIds`），更新时据此清理本地存量（唯一的删除路径；不在目录中的 id 视为用户自定义，永不删除）。清单来源是 models.dev（opencode 官方目录）— 更新模型时以其 provider/model id 为准。
- 配置目录解析与 opencode 运行时严格一致（opencode 用 xdg-basedir，无平台分支）：三平台同为 `OPENCODE_CONFIG_DIR` > `$XDG_CONFIG_HOME/opencode` > `~/.config/opencode`（macOS/Windows 不用各自平台默认目录）；缓存/数据同理为 `~/.cache/opencode`、`~/.local/share/opencode`。
- 插件发现（`src/core/pluginResolver.ts`，入口 `ConfigStore.listPlugins()`）：读 opencode.json[c] 的 `plugin` 数组（V2 `plugins` 键及 `{package}` 对象条目兼容）。npm 条目可带 `@版本` 后缀，按 opencode 现行 arborist 布局 `<cache>/packages/<spec>/node_modules/<name>/` 解析，回退 bun 时代平铺布局 `<cache>/node_modules/<name>/` 与 `<configDir>/node_modules/<name>/`；路径条目（`~/`、`./`、`/`、`file://` 前缀）按 home/configDir 解析。插件文件树排除嵌套 `node_modules` 与 `.git`；configDir lockfile、缓存根 lockfile 与 `packages/` 平铺监视触发树刷新。目录键 sanitize、漂移兜底扫描等细节见 pluginResolver.ts 注释。
- skills 发现（`src/core/skillScanner.ts`）：`SkillLocation.scope` 只有 `global|project`（家目录约定一律 global）。全局候选序：`~/.agents/skills` → `~/.claude/skills` → `<configDir>/skills` → `$XDG_CONFIG_HOME/agents|amp/skills` → `~/.copilot|​.gemini|.cursor|.codeium/windsurf|.codex/skills`；项目候选序：`.agents/` → `.claude/` → `.opencode/` → `.github/` → `.gemini/` → `.cursor/` → `.windsurf/` 下 `skills/`。仅报存在的目录（configDir 与家目录重合时去重）；技能=含 `SKILL.md` 的子目录，符号链接跟随判定（`~/.claude/skills` 常为指向 `~/.agents/skills` 的链接）。备份 extraDirs 只带 `~/.agents/skills`（其余目录归各自工具管理）。
- Coding Plan 额度（`src/core/quotaService.ts`）：从 `~/.local/share/opencode/auth.json` 读 Kimi/GLM/DeepSeek 凭据查官方接口（DeepSeek 按量计费只有余额无窗口、多币种取 CNY 优先）；MiMo 走 `platform.xiaomimimo.com` Dashboard Cookie（存 `<configDir>/quota.json`，只有月度窗口，无 5h/周）。接口地址与 GLM unit 枚举等细节见 quotaService.ts 注释。**线程池纪律（防拖垮宿主）**：一切请求（fetchAll/fetchProvider）经 `RequestGate` 并发闸门（默认同时在途 ≤2）——DNS 黑洞时 undici 的 getaddrinfo 占 libuv 线程池（exthost 默认 4 线程、全扩展共享 async fs），AbortSignal 取消不了已排队的查询；自动刷新在连续 `QUOTA_PAUSE_AFTER_STREAK`(=3) 轮传输级失败后熔断停摆（手动刷新成功/配置变更复位），激活首刷延迟 5s 避开启动 IO 高峰。**恢复路径**：窗口聚焦（onDidChangeWindowState）时若额度降级（任一已配置供应商出错或无快照）立即刷一轮（10s 节流、仅降级时触发）；刷新失败经 `spliceStaleProviders` 做 stale-while-error 兜底——30 分钟内（`STALE_PROVIDER_MAX_AGE_MS`）沿用该供应商最近成功数据（`staleFetchedAt` 标记，状态栏/面板渲染 `~` 前缀），错误字段保留故熔断判定不受影响。展示入口是 Webview 额度面板（`src/webview/quotaPanelHost.ts` 单例 + `webview-ui/quota.html` 多入口构建）：按供应商分组、组内单独刷新（core `fetchProvider` + `mergeProviderSnapshot`）、MiMo Cookie 在分组内编辑；额度数据形状与展示辅助函数收口在 `src/shared/protocol.ts`（core re-export）。e2e 通过 `XDG_DATA_HOME` 隔离凭据（保存 Cookie 后的 MiMo 单组刷新会发真实请求，沙箱内失败按 friendly error 断言 `configured` 翻转即可）。
- 备份保留：手动备份永不清理；`DEFAULT_RETENTION` 里的 pre-* 规则仅为兼容旧版本残留备份。备份创建走暂存目录（`backups/.tmp-*` → rename 发布，失败自动清理，下次创建时 sweep）；恢复时受管文件经 `writeFileAtomic` 写回（ENOSPC/占用不会截断活配置）。Windows 下深层 skills 备份可能触 MAX_PATH（需用户开 LongPathsEnabled）。
- 备份导入/导出用 zip（`fflate`，纯 JS 无原生依赖）：**压缩/解压必须走 fflate 异步 API（`zip`/`unzip`，Node 下自动用 worker_threads）——禁止改回 `zipSync`/`unzipSync`**（同步版冻结扩展宿主事件循环，所有插件无响应；单测有「导出期间事件循环保持心跳」防回归守卫）。导出含空目录显式 `name/` 条目；导入先 stat 限制压缩包大小，再按头部声明的 originalSize 限流解压防 zip 炸弹，条目名经 `assertZipEntryName` 防遍历；`manifest.json` 必须 v1，未知 reason 用 `Object.hasOwn` 判定降级 manual（勿用 `in` —— 会命中原型链），目录名冲突加 `-import-N`；写入期非法路径类 errno 映射为 `BACKUP_IMPORT_INVALID`。

## Git 约定

- 提交信息用 Conventional Commits（`feat:`/`fix:`/`chore:`/`test:`），正文可中文。
- `build/`、`dist/`、`dist-webview/`、`.vscode-test/`、`webview-ui/build`、*.vsix 均已 gitignore — 提交前 `git status` 确认无产物混入。
