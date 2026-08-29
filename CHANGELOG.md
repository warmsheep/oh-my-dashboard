# Changelog

> 版本与日期以 git 历史为准；0.8.0–0.14.0、0.16.x、0.18.0 等中间版本为本地打包、版本号未入库，相关变更归并入下一个入库版本。

## 0.38.0 (2026-08-29)

- **Open Base Opencode 同样固定随机端口**：启动命令改为 `opencode --port <随机空闲端口>`（复用 core `pickFreePort`，探测失败经 `FREE_PORT_UNAVAILABLE` 中文降级），终端环境经 `TerminalOptions.env`（合并模式）附带 `OPENCODE_PORT` 兜底（与 tmux 启动一致，覆盖旧版 opencode 的 ctx.serverUrl 缺失场景）——其他终端可 `opencode attach http://127.0.0.1:<P>`、外部工具可直连；启动后弹出端口提示。纯数字 flag 保持 bash/zsh/fish/PowerShell/cmd 全方言兼容，三平台原生支持不变

## 0.37.0 (2026-08-29)

- **新命令「OpenCode: Open Base Opencode」**：编辑器区域普通终端直接运行 opencode TUI——无 tmux/端口固定/颜色主题修正（那些均为 tmux pane 环境的补丁；直连 VSCode 终端时 TUI 原生 truecolor + OSC 背景探测自动明暗）。跨平台设计：仅发送裸 `opencode`（bash/zsh/fish/PowerShell/cmd 通用），工作区定位用终端 `cwd` 选项而非 `cd` 命令，零引号零平台分支；**Linux/macOS/本地 Windows 三平台原生支持**（opencode 缺失时由终端自身报错，不探测 exthost PATH 以免 nvm/Homebrew 误判）；ExtensionMode.Test 无副作用保 e2e hermetic
- **Windows/macOS 兼容性补齐（Open Tmux Opencode 平台矩阵）**：macOS 原生支持（zsh/bash 终端、版本探测驱动的颜色/主题策略均平台无关，缺 tmux 时中文提示已含 brew 指引）；Windows 经 Remote-WSL 完整支持（exthost 运行于 WSL Linux，行为与 Linux 一致）；本地 Windows exthost 缺 tmux 时新增专用错误码 `TMUX_NOT_FOUND_WINDOWS`——给出 Remote-WSL + WSL 内安装 tmux 的指引（替代不适用的 apt/brew 提示），此前的优雅降级路径（探测失败→提示、不建终端、不崩溃）保持不变。README 补平台支持说明

## 0.36.3 (2026-08-29)

- **修复：team 成员窗格不跟随主题锁定（仍为暗色）**——0.36.2 的锁定仅导出在主 pane 命令内（`export XDG_STATE_HOME=…`），而 oh-my-openagent 经 `split-window` 拉起的成员窗格继承的是**会话环境**，读不到该导出。现改为：扩展侧创建逐次状态目录（`fs.mkdtemp`）并把 kv 种子写入 **`<目录>/opencode/kv.json`**（路径契约收口在 core `tuiThemeKvPath` 并单测锁定——此前一度误写到目录根导致静默失效），主 pane 仍显式导出，同时追加 `tmux set-environment -t <会话> XDG_STATE_HOME <目录>` 使成员窗格经会话环境继承同一锁定。真机（tmux 3.3a）验证：主窗格与仅靠继承的成员窗格**双双渲染亮色板**（48;5;15/255/254）。顺带收益：pane 命令不再含 `VAR=$(…)` 构造（fish 解析错误源），fish 探测跳过分支删除，fish 3.0+ 现在也能获得主题锁定
- 已知边界：0.36.2 前创建的存量会话 attach 时不带该会话环境，其成员窗格仍为自然回退——删除会话重建即获得锁定；主题仍为启动时快照（跟随当时 VSCode 配色）；状态目录仍不回收；用户若手动把 `XDG_STATE_HOME` 加入 tmux `update-environment`（非默认），attach 时会话环境可能被清

## 0.36.2 (2026-08-29)

- **Open Tmux Opencode 主题跟随 VSCode 明暗配色**：启动时读取当前 VSCode 配色（Light/HighContrastLight → 亮色，其余 → 暗色）并让 opencode TUI 以对应模式启动。机制（opencode TUI 源码 + 真机实证）：TUI 的明/暗是 **mode** 而非主题名，解析链为 `kv theme_mode_lock ?? 终端 OSC 背景探测 ?? 暗色`——tmux 下 OSC 探测永远无响应，故此前恒为暗色；且无任何环境变量/配置键可覆盖 mode。现通过逐次重定向 `XDG_STATE_HOME` 到临时状态目录并预置 `kv.json` 的 `theme_mode_lock` 锁定模式（仅影响本 pane）：实测 light 锁全界面翻转为亮色板（背景 48;5;15/254/251），dark 锁保持暗色板（232/238/235）
- 已知取舍：TUI 内部的明暗切换仅对该 pane 生效（每次启动以 VSCode 主题为准）；状态目录中 session/model 指针逐次重置（会话数据本体在共享 data 目录，不受影响）；临时状态目录不回收（exec 替换 shell 无法 trap，量级极小）；team 成员窗格不继承该锁（沿用自然回退）；`default-shell` 为 fish 时自动跳过主题锁（`VAR=$(…)` 是 fish 语法错误，会导致整个 pane 命令解析失败）；`${TMPDIR:-/tmp}` 引号化以防含空格路径分词，前缀任何失败都会在 export 前中止（降级为正常未锁定启动而非损坏）
- attach 路径不变（沿用会话既有主题）；e2e 沙箱（ExtensionMode.Test）仍为无副作用跳过

## 0.36.1 (2026-08-29)

- **修复：tmux 终端内文字全部黑色**——根因（tmux 1.8 实测）：新 pane 环境为 `TERM=screen`（tmux 默认 default-terminal，无色彩能力）+ 从 VSCode 终端泄漏进 tmux server 环境的 `COLORTERM=truecolor`，两个矛盾信号使 opencode TUI 放弃配色（实测 pane 输出仅剩 `[30m` 黑色码，甚至完全不渲染）。现按 tmux 能力自动修复：default-terminal 不含 256color/direct/truecolor 时导出 `TERM=screen-256color`（pane 内 export + 会话级 `set-option default-terminal`，oh-my-openagent team 成员窗格后续切分时同样继承）；tmux < 3.2 时将 pane 与会话级 `COLORTERM` 置空（`export COLORTERM=`——fish 无 unset 内建故用空串赋值，对各类 TUI 等效于无 truecolor；旧 tmux 无法转换 truecolor 转义只会渲染成黑，3.2+ 自行管理 COLORTERM 故不干预）；未知探测结果一律走保守修复分支。创建流程相应改为「分离创建 → 配置会话 → attach」（`;` 链保留 probe→create 竞态韧性，attach 路径不变）。经真实 tmux 1.8 + opencode 端到端验证：修复前 pane 无任何色码，修复后 256 色完整渲染（38;5;*/48;5;* 全套），会话内新建窗格（模拟 team 成员）环境正确继承
- 注意：attach 不会给旧逻辑创建的存量会话补配——升级后请对既有黑字会话执行一次 `tmux kill-session -t <会话名>` 再重新运行命令

## 0.36.0 (2026-08-29)

- **状态栏额度分段按供应商命名**：额度各分段的状态栏条目名从统一的「Coding Plan 额度」改为「Kimi 额度」「GLM 额度」等（右键状态栏菜单与无障碍面板可见；分段正文不变），可见而未配置时的中性回退入口保留原名；`QuotaBarSegment` 新增 `name` 字段（core 单测同步）
- **新命令「OpenCode: Open Tmux Opencode」**：在编辑器区域新开终端页，经 tmux 启动 opencode TUI 并绑定随机空闲端口（`export OPENCODE_PORT=<P>; exec opencode --port <P>`）。调研确认（opencode tui.ts/network.ts/server.ts + oh-my-openagent layout.ts/resolve-server-url.ts 源码，及真实 tmux 分离会话实测）：TUI 不带 `--port/--hostname/--mdns` 时完全不起 TCP 服务（进程内 RPC，插件 `ctx.serverUrl` 为死的 localhost:4096），oh-my-openagent team 模式的 `isServerRunning` 门会静默跳过成员窗格布局；带 `--port` 后 `ctx.serverUrl` 携带真实端口，team 模式经 `opencode attach <url>` 切窗格拉起成员。tmux 会话按工作区名 sanitize 命名（`opencode-<slug>`，无工作区为 `opencode`），重复执行 attach 已有会话（保留原端口）；会话存在性探测用 `list-sessions` + 代码内精确比对——旧版 tmux 对 `-t` 目标做唯一前缀匹配，`opencode` 会被误连到 `opencode-<其他工作区>`（tmux 1.8 实测；`=<name>` 精确前缀旧版不支持）；工作目录在 pane 内经 `cd` 设置（`new-session -c` 需 tmux 1.9+，CentOS 7 的 1.8 不支持，已实测）；缺 tmux 时报 `TMUX_NOT_FOUND` 中文安装指引；e2e（ExtensionMode.Test）下跳过探测与终端创建保持沙箱 hermetic（真实链路经「tmux 分离会话 + curl 端口 200」人工验证）

## 0.35.1 (2026-08-28)

- **修复：点击「打开设置」应激活第一个选项卡**——0.35.0 的「配置」选项卡上线后，齿轮/命令面板「打开设置」仍导航到第三个「设置」选项卡；现改为落在最前的**配置选项卡**，且该导航同时附带一次 settingsInit 推送，保留入口「设置数据始终新鲜」的历史语义（用户随后点「设置」选项卡看到的即为最新值）。e2e 断言同步更新（reveal 导航目标、boot 锚点）

## 0.35.0 (2026-08-28)

- **管理面板新增「配置」选项卡（排在最前），分两块展示**：① **当前 OMO 模型配置**——agent/分类 × 模型/variant 矩阵（与模板编辑器同视觉），页内下拉即时修改并写入检测到的目标文件（omo/legacy，显示写入目标路径），改动经 `configSetModel` 消息走核心 `setAgentModel`（JSONC 保注释写回 + 冲突键清理），失败红条提示并回滚乐观更新，成功后宿主回推刷新的 `configInit`；② **Skills 只读清单**——列出全部已发现技能的名称与描述（新增 `skillSummaries` 读取各 SKILL.md frontmatter 的 `description`，8KiB 限读 + 300 字截断），按目录分组并标注 全局/项目 徽标，无任何可编辑控件
- 协议新增 `SkillSummary`/`ConfigInitPayload` 与 `configInit`/`configModelSaved`/`configSetModel` 三条消息；`ManagerTab` 增加 `config` 取值（webview 选项卡顺序：配置/额度/设置/模板）；面板 boot、导航与外部配置变更（watcher 刷新复用树快照的 skill locations，不重复 discover）均推送 configInit
- e2e 新增三例：boot payload 携带行/技能/目标、configSetModel 写入+回执+刷新、畸形请求拒绝且不落盘；单测新增 skillSummaries 17 例、配置页消息泵 5 例、webview helpers 11 例

## 0.34.1 (2026-08-28)

- **修复：模板编辑器在部分 code-server 环境下整体呈深色、文字看不清（0.34.0 修复不彻底）**——实测定位：这类环境的 webview **不注入 `--vscode-*` 主题变量**，管理页所有 `var(--vscode-*, 兜底)` 全部落到原深色兜底值（页面 `#1e1e1e`、输入框/下拉 `#313131`），0.34.0 只改了下拉弹层底色未改文字兜底，浅灰底+浅灰字依旧不可读。修复：`webview-ui/src/main.css` 全部兜底值翻转为浅色（页面白底、输入框/下拉/分区头浅灰 `#f2f2f2`、文字深灰 `#333`、悬停浅灰、根 `color-scheme: light`）——无变量注入的环境整体呈浅灰且全部可读；正常桌面 VSCode 与新版 code-server 有变量注入，主题跟随行为完全不变（深色主题仍深色）。三场景（无变量/深色主题/浅色主题）经真实浏览器实测截图+计算样式验证

## 0.34.0 (2026-08-28)

- **修复：code-server 长时间切走后重连，额度栏显示 `~` 旧数据、点击无反应、其他插件一并卡死**——根因一：全局 fetch（undici）DNS 走 `getaddrinfo`，跑在与所有扩展共享的 libuv 线程池（默认 4 线程）上；网络黑洞时 `AbortSignal` 只能放弃 Promise、取消不了已排队的查询，聚焦恢复刷新与手动点击持续产生新查询，线程池逐渐被占满，所有扩展的 async fs 饿死。修复：新增 `src/core/resilientFetch.ts`，额度与模型清单请求默认改走 c-ares（`dns.promises.Resolver` 自定义 lookup + undici Agent `connect.lookup`，查询走事件循环不占线程池，正结果 30s TTL 缓存，仅 c-ares 失败才回退 getaddrinfo 罕见路径）；`RequestGate` 并发闸门与连续失败熔断保留作为二道防线。根因二：管理面板 iframe 在久置期间被回收但从未完成首次就绪时，点击只会缓冲导航、永远停在死白页（探活只覆盖已就绪页面）；现超过 20s 仍未就绪的面板在下一次入口点击时直接重建
- **备份支持按范围选择**：手动「立即备份」可在名称后勾选仅包含 配置/模板/模型（模型 = `models.json` 清单，此前不入备份）；恢复时按备份**实际内容**探测可选范围（旧版无范围字段的全量备份同样兼容），只恢复勾选项，确认弹窗列明将恢复的范围；程序化调用支持 `{ name?, scopes? }` / `{ dirName, scopes? }` 参数（headless 安全）
- **修复：模板编辑器下拉菜单深色背景看不清字**（code-server 浏览器端尤甚）——`<select>` 原生弹层不跟随 VSCode 主题变量；现按 webview body 主题类声明 `color-scheme` 并显式指定 `option/optgroup` 底色（浅色侧回落浅灰 `#f2f2f2`），深浅主题均清晰可读

## 0.33.1 (2026-08-28)

- **修复：插件状态栏有概率不显示**（需到额度页切换供应商「状态栏」开关才能恢复）——根因：两个状态栏（额度分段 + 模板）都用**无 id** 的 `createStatusBarItem(alignment, priority)` 重载在激活期创建条目，VSCode 渲染器在窗口启动/恢复阶段会概率性丢弃无 id 条目（microsoft/vscode#185089）；而我方条目池「段数不变则原位更新」的设计使条目被丢弃后永远没有重建机会——只有切换可见性开关改变段数触发重建才恢复，与用户 workaround 完全吻合。修复：改为显式稳定 id 创建——额度条每段 `opencode-quota.<供应商>:<窗口|余额|错误>`、中性回退 `opencode-quota.neutral`、模板条 `opencode-preset`；`formatQuotaBar` 分段现携带稳定 id（新增单测锁定「同一逻辑段跨渲染 id 不变 + 全栏唯一」契约，既有分段断言同步更新）
- 触发面：窗口重载/恢复、code-server 与远程容器场景尤甚；修复后无需任何手动恢复动作

## 0.33.0 (2026-08-28)

- **模板选项卡默认展示模板列表**：原先打开「模板」选项卡为空提示、必须从侧栏右键「编辑模板」才能载入内容；现在选项卡默认渲染模板列表（名称 / 描述 / 创建与应用时间），点击任一模板行即开始编辑（与「编辑模板」命令同一会话链路），页内新增「新建模板」入口，不再依赖侧栏菜单操作。有未保存草稿的模板行显示「有未保存草稿」标记（草稿按模板名分槽，语义不变）；会话取消/关闭后回到列表
- 协议新增 `presetList`（宿主 → 页面：面板 ready、导航到模板页、每次模板保存后、以及**外部变更**——树侧捕获/删除/重命名/应用与文件监视触发的刷新——都推送，保存重命名也即时刷新列表）与 `presetEdit`（页面 → 宿主：列表点击发起编辑，`name: null` 即新建）；宿主对 `presetEdit` 载荷做与协议一致的名称边界校验，畸形载荷静默丢弃并记日志
- 会话初始化失败（如模板文件不可读）不再把整页替换成错误横幅：列表保持可见，错误横幅显示在列表上方，可直接换一行重试
- 测试：`toPresetListEntries` 协议映射、webview `formatPresetDate`（YYYY-MM-DD，坏值降级「—」）；e2e 新增「boot + 导航双推 presetList / 页内 presetEdit 直接开会话 / 畸形载荷无回复」回路

## 0.32.0 (2026-08-28)

- **模板编辑器并入「OpenCode 管理」面板**：原先每模板一个独立编辑器窗口（多面板）收敛为管理面板第三个「模板」选项卡（模板/额度/设置）；「编辑模板（矩阵表单）」命令改为打开/切换到该选项卡并载入对应模板。多面板收缩为**单会话**——编辑 B 时 A 的未保存草稿按模板名分槽保留（webview state 命名空间化），切回即恢复；宿主侧 workspaceState 崩溃恢复快照语义不变
- 「取消」语义改为**清空模板会话**（页面回空态提示 + 宿主清除恢复草稿），不再关闭面板——管理面板承载额度/设置不再随模板编辑退出；未保存修改时仍先弹「确认放弃」
- 架构：`presetEditorHost` 重构为纯会话控制器（begin/save/noteDirty/cancel，去除面板管理与按名 re-key）；`managerPanelHost` 消息泵统一分发 save/dirty/cancel 并新增 `openPresetEditorTab` 入口与 `notifyManagerPanelModelsChanged` 模型推送（lazy provider 语义保留）；webview 构建收敛为 **manager 单入口**（删除 index.html 入口与 `PRESET_EDITOR_VIEW_TYPE`）
- e2e：模板段全部改走 manager 单桥（创建捕获一次、后续 reveal 复用 + init 轮询匹配模板名）；rename-on-save 断言从「面板 re-key」改为「会话跟随新名」；cancel 用例改为「面板保持 + 会话可重启」，段末重置单例保证额度段冷启动
- 浏览器实测：三选项卡切换、矩阵编辑、脏标记、切卡草稿保留、dirty 取消确认与放弃回空态

## 0.31.3 (2026-08-27)

- 管理面板选项卡悬停背景改为浅灰半透明（`rgba(128,128,128,0.18)`，替代原深色 `--vscode-list-hover-background`），深浅主题下均呈浅灰提示

## 0.31.2 (2026-08-27)

- 修复管理面板额度页「点击页面任意位置都在切换 DeepSeek 状态栏开关」：状态栏开关复用设置页的 `.s-switch-input` 隐形覆盖层样式（`position:absolute; inset:0`），其包含块由 `.s-switch` 的 `position:relative` 提供——额度页的 `.qstatus-toggle` 标签缺定位，四个隐形 checkbox 全部铺满整页叠放，最顶层（最后一组 DeepSeek）吞掉所有点击。已给 `.qstatus-toggle` 补上 `position:relative` 包含块；浏览器实测：点击标题/刷新按钮/空白处/选项卡四个开关均不变，点击各组开关仅翻转自身

## 0.31.1 (2026-08-27)

- **设置页与额度面板合并为「OpenCode 管理」面板**：原先两个独立编辑器窗口（齿轮「打开设置」+ 状态栏额度点击的额度面板）收敛为一个单例面板，页内「额度 / 设置」选项卡切换；命令入口不变——齿轮/命令面板「打开设置」直达设置选项卡，状态栏额度点击与「配置 MiMo Cookie」直达额度选项卡（新增 `managerNavigate` 协议消息驱动已打开面板的选项卡跳转）。两个选项卡内容常驻挂载（CSS 切换，不卸载）：Cookie 草稿、设置表单未保存状态、刷新进行中标记在切卡后全部保留；存活探测（ping/pong）与 ready 握手由页面根组件应答，任何选项卡下都有效（键盘左右方向键可切换选项卡）
- **供应商「状态栏」开关**：额度页每个供应商分组头部新增开关，关闭后状态栏不再显示该供应商分段，且**不参与定时刷新**——自动刷新轮次只抓取可见供应商（`fetchAll` 支持供应商子集），管理面板打开（编辑器标签页可见）期间恢复全量抓取、面板从隐藏切回可见时立即补一轮；熔断/降级判定只看本轮实际抓取的切片，隐藏供应商的历史数据不掩盖真实失败。开关持久化在 `quota.json` 的 `statusBar` 块（合并写保留 MiMo Cookie 与未知键，写入后重设 chmod 0600——原子写 tmp+rename 会把凭据文件权限降回 umask 默认值），缺省一律显示（非严格 `false` 容错为显示）；全部隐藏时状态栏整体收起，但可见而未配置时保留「Coding Plan」中性入口
- 设置页打开策略与额度面板统一为解耦式（命令立即返回、20 秒看门狗仅记日志不再关面板）——沿用弱网回归修复的语义，`openSettings` 不再因 webview 启动慢而报错；webview 上下文静默重载后不重放创建时的入口选项卡（页面持久化选项卡优先）
- 刷新调度加固：空目标轮次（全部隐藏且面板关闭）守卫移至单飞承诺创建之前——此前提前 return 跳过清空 `refreshPromise` 的 finally，已结算的承诺永久占位会让后续所有全量刷新（自动轮次/面板踢发/手动刷新）静默合并成空操作（e2e 新增「全部隐藏→关面板→空目标轮→重开面板刷新链仍活」回归用例）；目标扩大的踢发（面板重新可见/隐藏供应商重新开启）不再被在途窄目标轮次吞并——并发补一轮（token 所有权：仅最新轮次可清槽与重排，RequestGate 仍约束真实并发）；单供应商手动刷新仅在其真正成功时复位熔断器（提供方抓取在断网下也以 error 结果 resolve，不应重启已熔断的自动轮次）
- 设置保存落定后无论成败都回推一次 settingsInit 真值（保存飞行期间被回声抑制的外部变更不再丢失同步）；`quota.json` 写入路径收口为单一 `mutateQuotaConfig`（Cookie 与可见性共用读-合-写-chmod 链）
- e2e：额度/设置两桥统一为单一 manager 桥（面板合并后 reveal 不再触发 createWebviewPanel）、settingsInit 断言改轮询（解耦打开）、可见性开关回路用例（落盘/全量记录/Cookie 保留/0600 权限/畸形载荷忽略）、quotaInit 可见性缺省断言
- 测试：`normalizeQuotaVisibility`/`readQuotaStatusBarVisibility`/`saveQuotaStatusBarProvider`（合并保序、损坏自愈、CONFIG_UNREADABLE、0600）、`fetchAll` 子集与空集零请求、`filterQuotaSnapshotByVisibility`、webview `normalizeManagerTab`

## 0.30.1 (2026-08-27)

- **切回窗口自动刷新额度**：长时间挂机（休眠/断网/VPN 切换）会触发传输级熔断、自动刷新停摆，状态栏卡在 `?`；现在切回 code-server 窗口/标签页时，只要额度显示异常（任一已配置供应商出错或尚无数据）立即触发一轮刷新（单飞合并、10 秒节流；不受「0 = 关闭自动刷新」影响，属恢复动作）——网络恢复的瞬间即自愈并复位熔断器，无需手动点击
- **旧数据兜底，不再立刻变 `?`**：刷新失败时 30 分钟内沿用该供应商最近一次成功的数据，数字前加 `~` 标记（悬停提示数据截止时间与失败原因；额度面板同样显示旧数据 + 错误横幅 + 「数据较旧」徽标）——网络闪断/休眠唤醒期间额度数字保持可见
- 数据超过 30 分钟未成功刷新则回退为 `?`（旧数据对 5 小时窗口已无参考价值，避免误导）；拼接为归一化操作——超龄的旧覆盖也会被剥离，`~` 不会在持续刷新路径上滞留；无有效内容（无可推导百分比的窗口、无真实余额）的供应商不参与兜底，直接显示 `?`
- 测试：`spliceStaleProviders`（缓存拼接/超龄回退/归一化剥离/无内容缓存不拼接/干净直通）、`providerHasDisplayData`（窗口可推导/余额真实/空形状）、`quotaSnapshotDegraded`（无快照/已配置出错/未配置不计）与 `formatQuotaBar` 旧数据 `~` 渲染（窗口与余额两类）

## 0.29.1 (2026-08-27)

- **模型清单只收录可用作编码代理的模型**：联网获取（激活初始化与「更新模型清单」）现按 models.dev 的能力与状态字段过滤——仅保留 `tool_call: true`（剔除 TTS/语音、图像生成、视频、embedding 等无法运行代理会话的模型）且未被标记 `deprecated`（剔除上游已退役旧世代，如 glm-4.6、kimi-k2、gpt-4/o1 全家、qwen3-coder 等）的条目；实测白名单供应商范围由 235 个模型收敛至 157 个可用模型
- 「更新模型清单」会顺带**清理上游已标记弃用的本地存量条目**（此前无过滤时代种入的旧世代模型自动移除，清理至空则删除 models.json；不在 models.dev 目录中的 id 视为用户自定义，永不删除）；结果提示新增「清理 N 个已弃用」
- 真正无变化的更新不再重写 models.json（内容级比较：同 id 同 provider/model/label 视为未变化，手编 JSONC 注释与格式得以保留）；全部供应商均无可收录模型时提示「模型清单未变更」
- 测试：fetch 过滤（弃用/非工具/缺字段/beta 保留）、合并清理语义、同内容不落盘、清理至空删文件、e2e 断言 TTS 不入库 + 弃用条目被清理

## 0.28.1 (2026-08-27)

- **插件不再内置模型清单**（移除 138 条硬编码模型），只内置供应商白名单 `BUILTIN_PROVIDERS`（GLM / Kimi / MiniMax / MiMo / DeepSeek / GPT / Claude / Grok / Gemini 等 10 家）；模型数据一律以 models.dev 为准联网获取
- 本地 `models.json` 改为「安装/升级绝不覆盖」：`ensureLocalModelsFile` 变纯读（缺失/为空/损坏一律返回空清单、绝不写盘）；损坏文件一次性备份 `models.json.bak` 后降级为空，由下次成功的网络更新重建（升级前已存在的文件内容原样保留）
- 清单为空（新装/被清空）时扩展激活后自动从 models.dev 按白名单拉取初始化；断网首启清单保持为空（记日志，下次激活重试），联网后点「更新模型清单」即可补齐；e2e 测试模式跳过自动拉取保持沙盒隔离
- 「更新模型清单」按钮：本地清单为空时按「当前清单供应商 ∪ 内置供应商白名单」拉取；全部供应商均未被 models.dev 收录时跳过落盘（不重排手编 JSONC 的注释与格式），提示「模型清单未变更」
- 删除模型删至清单为空时删除 models.json（缺失即空清单，不再隐式复活内置目录）
- 修复「重装插件后模型清单被还原」：安装脚本 `install-code-server.sh` 每次安装前会删除本地 `models.json`（内置清单时代的遗留逻辑），导致用户联网更新与手动添加的模型在每次重装时丢失、并被重种回旧版内置清单；现已移除该重置，安装/升级绝不触碰 `models.json`
- 测试同步重写：builtinModels 纯读语义（空/损坏/JSONC/权限降级）、configStore 无隐式 seed、pipeline 场景 G（纯读 + .bak + 网络重建）、modelCatalog 新增 seed 三例（白名单过滤、非空 no-op、损坏重建）、e2e 删除末条模型语义翻转

## 0.27.1 (2026-08-26)

- 新增「更新模型清单」：模型分区标题右侧行内按钮（或命令面板 `OpenCode: 更新模型清单（从 models.dev）`），拉取 models.dev（opencode 官方模型目录）最新清单，取当前模型清单所涉供应商的最新模型合并进 `models.json`——新模型追加、同名模型以最新数据刷新、用户手动添加的自定义模型保留不删；合并结果以中文提示汇报新增/刷新数量，全部供应商均未收录时明确说明「模型清单未变更」
- 请求复用额度模块的防御性读取与错误映射（`readJsonBody`/`friendlyRequestError`，导出共享）：单请求 + 30 秒超时，HTTP/解析/传输类失败均映射为友好中文提示
- 测试：`test/unit/modelCatalog.test.ts` 覆盖拉取过滤/标签回退/畸形载荷/错误映射/合并语义（自定义模型不丢）/落盘持久化；e2e 拦截 `globalThis.fetch` 验证真实命令链路（自定义模型存活、新模型入库、补丁窗口隔离）

## 0.26.2 (2026-08-26)

- 修复长时间挂机后额度面板「僵尸化」：code-server 长时间放置（浏览器标签冻结/Service Worker 重启）可能静默回收额度面板 webview 的 iframe，但不触发关闭事件——插件单例仍指向一个 JS 已死的标签页，之后每次点击状态栏只是 reveal 一个永远空白的死页，表现为「点了弹不出页面」。现点击时对已打开的面板做存活探测（新增 quotaPing/pong 协议消息）：页面 1.5 秒内无应答即销毁死面板并重建全新面板；存活则复用并立即重发初始化数据
- 点击状态栏现在总是触发一次手动刷新：此前挂机期间弱网连续失败会熔断自动刷新，网络恢复后无人复活，状态栏永远停在「?」；现在点击即刷新，成功一轮即自动复活熔断器（单飞合并，连点不放大请求量）
- e2e 新增「僵尸面板探测重建」用例：伪造已就绪但无真实页面的面板，断言再次点击触发 ping 探测、无应答后旧面板被销毁、新面板被创建

## 0.26.1 (2026-08-26)

- 修复网络不佳时点击状态栏额度无反应：额度面板的打开与 webview 就绪握手彻底解耦——此前命令会等待 webview `ready`（上限 20 秒），超时后关闭面板并报「额度面板初始化超时」；在弱网（尤其 code-server，webview 资源经浏览器链路/Service Worker 加载）下面板加载缓慢或失败时，每次点击都被静默撤销，表现为「状态栏显示 ? 期间怎么点都没反应、网络恢复才打得开」。现改为：点击立即创建/显示面板标签页并返回，webview 何时就绪何时初始化（迟到的 ready 也能正常加载），20 秒看门狗仅记日志、绝不关闭用户的面板；关闭标签页即重置单例，后续点击重新打开
- e2e 新增防回归用例：伪造永不就绪的 webview（拦截 `html` 赋值），断言 `quotaRefresh` 快速 resolve 且面板保持打开；面板桥的 `quotaInit` 断言改为轮询（命令不再等待握手）

## 0.26.0 (2026-08-25)

- 设置页改为显式保存模型：修改开关/间隔只更新本地表单（页脚出现「有未保存的更改」提示，按钮点亮），点击「保存设置」才一次性写入全部设置；编辑期间外部配置变更按字段级脏标记合并——未触碰的字段跟随外部值，编辑中的字段不被覆盖；保存成功以本次发送的快照标记持久态（飞行期间的新编辑保持未保存状态）

## 0.25.1 (2026-08-25)

- 修复设置页「快速连续修改被还原 + 保存卡顿」：保存期间配置变更回推 settingsInit 会携带**部分写入的中间态**覆盖页面本地状态（开关回跳），且逐键顺序写 11 次配置导致每次保存延迟近 1 秒。现改为：自家保存的回声推送在写入期间被抑制（保存失败才回推持久化真实值）、保存按消息串行化、写入恢复为逐键并行（单轮往返）；状态栏额度刷新间隔的读取与设置页共用同一钳制边界（0–3600，默认 30）
- 设置写入按 `inspect()` 识别覆盖范围：工作区级覆盖的键写回工作区作用域，开关不再被工作区值「弹回」
- e2e：fs.watch 用例对激活 +2s warmup 标记撞上防抖窗的既有竞态加固（重写内容法重试）；设置用例新增「保存期间不产生过期回声」「外部修改推送」「1s 轮询真实产生 tick」断言

## 0.25.0 (2026-08-25)

- 新增「设置」页面（侧边栏面板标题栏齿轮按钮 / 命令面板「OpenCode: 打开设置」）：
  - 配置 / 模板 / 备份 / 模型 / 插件五个分区独立的定时自动刷新开关（默认关闭，不改变既有行为），开启后可配置轮询间隔（秒，默认 30，范围 1–3600）；轮询复用手动刷新路径（重载 + 回声去重），与始终开启的文件变更监听互不干扰；调度器按类别各自 setTimeout 链自调度，配置修改即时生效
  - Coding Plan 额度刷新频率可直接在页面修改（默认 30 秒，0 = 关闭），沿用 `quota.refreshSeconds` 配置键，保存后立即按新频率查询（网络退避/熔断语义不变）
  - 设置读写收口在 VSCode 配置（`autoRefresh.<分区>.enabled/.intervalSeconds`），标准设置 UI 的修改同样实时同步到打开的设置页；表单值经 shared 协议归一化（越界钳制、非法回退默认）后才落盘

## 0.24.0 (2026-08-25)

- 三路子代理深审后的扩展宿主加固（消除一切可能拖垮其他插件的路径）：
  - 目录遍历防护：readDirTree 统一排除 `.git`/`node_modules`（收口为共享 `TREE_EXCLUDES`）并加 4000 条目预算——git clone 的 skills 仓库不再把 `.git/objects` 数千文件带入每次同步刷新；visited 键从 realpathSync（O(路径组件数)）改为 statSync dev:ino（1 次系统调用）
  - 文件监视纪律：backups/ 由递归改扁平监视（备份永不清理，递归监视会随历史备份线性消耗 Linux inotify 配额 8192，耗尽殃及所有插件与 workbench 自身）；全局 skills 监视目标 realpath 去重（~/.claude/skills → ~/.agents/skills symlink 双监视）；刷新节流 ≥1s、连续事件 maxWait 2s 防活锁、失败重 arm 指数退避（1s→30s）
  - 刷新合并：provider 重载期间的触发改为脏标记 + 一次尾随重载（原先被丢弃导致树滞留）
  - 激活让路：warmup 全量发现延迟 2s（避开其他插件启动 IO 风暴）且种子写回声不再触发二次全扫；restore() 补 256MB/2 万条目预算上限（外来超大备份目录不再变成无界同步拷贝，超限报 `BACKUP_RESTORE_TOO_LARGE`）
  - 面板健壮性：模板编辑器 ready 超时后关闭死标签页（原先永久占用 openPanels）；额度面板命令超时改为中文错误提示（不再外溢英文 rejection）

## 0.23.2 (2026-08-25)

- 备份 zip 导入/导出改走 fflate 异步 worker（worker_threads）：此前 zipSync/unzipSync 在扩展宿主主线程同步压缩/解压（上限 256MB，最坏冻结事件循环数秒，所有插件一并无响应）；现压缩/解压移出事件循环，新增「导出期间事件循环保持心跳」防回归单测；审计确认其余同步 IO 均有界（条目/字节上限），命令层异常经统一 run() 包裹无未处理 rejection

## 0.23.1 (2026-08-25)

- 熔断恢复补丁：整轮刷新成功时同步复位暂停日志标记（`pausedLogged`），修复熔断恢复后再次停摆时暂停提示被吞一次的问题

## 0.23.0 (2026-08-25)

- 额度请求并发闸门与熔断，杜绝拖垮扩展宿主：此前 DNS 黑洞时 4 家供应商并行 fetch 的 getaddrinfo 会占满 exthost 共享的 libuv 线程池（4 线程，所有插件的 async fs 同池），导致其他插件一并无响应。现在 QuotaService 全部请求（自动刷新 + 面板单组刷新）经同一闸门，任意时刻在途请求 ≤2；连续 3 轮传输级失败后自动刷新完全停摆（手动刷新成功或修改设置即恢复）；激活首刷延迟 5 秒避开其他插件启动 IO 高峰；deactivate 竞态下刷新与事件派发增加 disposed 守卫

## 0.22.4 (2026-08-25)

- 修复 code-server（VSCode Web）下额度面板白屏/「额度面板初始化超时」：0.22.0 起 CSP script-src 附加的 nonce 会拦截 ES 模块运行时 import（桌面版不受影响），回退为与 0.21.x 相同的纯源白名单，并加防回归单测；ready 超时后现在会关闭白屏面板并释放单例，点击即可重试（0.22.3 为同修复的未发布打包）

## 0.22.2 (2026-08-25)

- Kimi 月额度语义核实（行为无变化）：`coding/v1/usages` 顶层 usage 确认为周额度（每 7 天刷新，与官网 75% 月用量不对应）；会员月余额走 `GetSubscriptionStats`，需网页登录 token，Coding API Key 无权访问（后续可按 MiMo Cookie 模式做成可配置凭据）

## 0.22.1 (2026-08-25)

- 额度面板：凭据检测提示移入供应商分组标题栏（单行省略、悬停显示全文），不再占用分组正文空间

## 0.22.0 (2026-08-25)

- 额度展示重构为 Webview 设置页：状态栏点击/命令打开「Coding Plan 额度」面板（单例编辑器标签页），按供应商分组展示窗口进度条、剩余百分比与重置时间，支持分组单独刷新与底部「刷新全部」，面板打开期间跟随自动刷新实时更新
- MiMo Cookie 配置收口到面板分组内（password 输入、留空保持不变、保存即刷新）；Kimi/GLM/DeepSeek 凭据只读显示检测状态并引导 `opencode auth login`；移除旧 QuickPick 详情弹窗与 InputBox 配置流
- webview 构建改多入口（模板编辑器 index + 额度面板 quota，共享 vendor/vscode chunk）；额度数据形状与展示辅助函数收口 shared/protocol（core re-export）；core 新增 `fetchProvider` 单供应商刷新与 `mergeProviderSnapshot`；e2e 改用面板 capture-bridge 驱动 quota 协议

## 0.21.1 (2026-08-24)

- 额度文案措辞统一（5小时窗口→5小时额度，月度额度→月额度）

## 0.21.0 (2026-08-24)

- 额度自动刷新指数退避（30s → 60s → 最长 2 分钟）与全中文错误提示
- 核心层正确性与安全加固，模块拆分（pluginResolver / skillScanner / agentAssignment / watchManager）
- 模板编辑器协议加固与渲染性能优化
- 命令程序化参数与路径守卫、错误映射迁移、configDirOverride 修复
- e2e 套件扩容至 33 步；prettier 风格门禁、webview-ui 测试接入 `npm test`

## 0.20.1 (2026-08-23)

- 「导入备份」命令补图标（inline 菜单与保存图标对齐）

## 0.20.0 (2026-08-23)

- 备份导入/导出（zip 格式，三平台通用；导入校验 manifest、防目录遍历/zip 炸弹）

## 0.19.0 (2026-08-22)

- 跨平台兼容与安全加固（Linux/Windows/macOS）；备份/恢复原子化

## 0.18.0 – 0.18.1 (2026-08-22)

- DeepSeek 按量余额：余额型 provider 加入额度 QuickPick 与 tooltip，按绝对值独立着色

## 0.17.2 (2026-08-22)

- 活动栏图标改为线性 open-book 风格（全尺寸 codicon 墨色）

## 0.16.0 – 0.17.0 (2026-08-22)

- 用户可见术语统一：预设 → 模板、config file → 配置
- 跨工具 skills 发现（全局/项目多目录约定）与插件列示（npm / 本地路径，运行时缓存布局解析）
- skills 备份 extraDirs；插件与 skills 目录变更自动刷新

## 0.15.0 (2026-08-22)

- 「重命名备份」命令与右键菜单

## 0.8.0 – 0.14.1 (2026-08-22)

- Coding Plan 额度：Kimi/GLM/MiMo 额度服务 + 状态栏分窗口独立着色与详情 QuickPick
- 四个树视图合并为单一分区 Explorer；启动性能优化（按需激活、warmup、内容检查的监视管线）
- 命名备份：备份时输入名称（仅展示），列表显示「名称 · 时间戳」

## 0.7.2 (2026-08-22)

- 仅监视受管路径，毫秒级激活

## 0.7.1 (2026-08-22)

- 打包产物卫生；确立「打包前必须递增版本号」规则

## 0.7.0 (2026-08-22)

- agent 配置目标自动检测：按 oh-my-openagent 运行时同序检测 `~/.omo/omo.jsonc` → 旧版 `oh-my-opencode.json[c]` / `oh-my-openagent.json[c]`，模板应用/命令/激活全部路由到检测目标，树中显示检测到的配置文件
- 备份服务支持显式受管文件清单
- Webview 模板行 variant 拓宽
- 修复：批量设模型覆盖模板从未配置过的行；MiMo provider id 修正并扩充内置清单

## 0.6.0 (2026-08-21)

- 侧边栏「模型」栏移至最上方
- 配置文件栏的 command/ skills/ 目录可展开预览子目录与文件树，单击文件直接打开编辑
- 预设节点单击即打开预设编辑器（应用仍走右键菜单，防误触）
- 备份范围纳入 presets/（预设模板随备份保存，恢复时一并还原）

## 0.5.0 (2026-08-21)

- 新增「模型」配置栏：展示合并后的模型清单（opencode.json + models.json，同名合一，标注来源），
  支持自定义添加/删除本地模型（写入 models.json，无需升级插件）
- 预设编辑器实时同步：模型清单变更时，已打开的预设编辑器自动刷新下拉选项（modelsUpdated 推送）
- 新命令：添加模型… / 删除模型 / 打开模型清单文件

## 0.4.2 (2026-08-21)

- GPT 系列补齐 GPT-5.6 全部变体：gpt-5.6 / Sol / Luna / Terra（models.dev 2026-07-09 发布）

## 0.4.1 (2026-08-21)

- Kimi 系列改走 kimi-for-coding 通道（k3 / k3-256k / kimi-for-coding-highspeed）
- 安装脚本在安装后自动重置本地 models.json，确保每次升级后内置模型清单刷新到最新版本

## 0.4.0 (2026-08-21)

- 内置模型清单按 models.dev（opencode 官方模型目录）2026-08-21 数据全量刷新，15 → 33 项，
  每系列收录最新主力：GLM-5.3、Kimi K3、MiniMax M3、MiMo v2.5 Pro、DeepSeek V4、
  GPT-5.6、Claude Opus 5 / Sonnet 5、Grok 4.6、Gemini 3.7 Flash 等

## 0.3.0 (2026-08-21)

- 内置常用模型清单（GLM/Kimi/MiniMax/MiMo/DeepSeek/GPT/Claude/Grok/Gemini 共 15 项），
  首次使用时生成 `~/.config/opencode/models.json`（可手动编辑，损坏自愈）
- 模型列表双源合并：opencode.json providers + 本地清单，同名 id 合并为一（opencode.json 优先）
- 构建产物统一输出到 `build/packages/`（`npm run package`）

## 0.2.0 (2026-08-21)

- 移除所有自动备份（应用预设前 / 保存前 / 恢复前）：仅保留手动「立即备份」
  - 应用预设直接写入；恢复前弹窗明确警告覆盖且不可撤销
  - 移除 `autoBackupOnSave` / `maxAutoBackups` 设置
- 界面全面中文化：命令面板标题、侧边栏视图名、活动栏容器、备份原因标签、Webview 分区标题等

## 0.1.0 (2026-08-21)

初始版本。

- 侧边栏三区面板：配置文件 / 预设 / 备份
- JSONC 结构化编辑（保留注释、尾逗号、缩进风格）
- agent/category 模型与 variant QuickPick 编辑
- 预设：捕获 / 矩阵编辑器 / 合并语义应用 / 重命名 / 删除 / 导出
- 备份：手动 / pre-apply / pre-save / pre-restore，保留策略，diff 对比，恢复
- 状态栏当前预设显示与快速切换（Ctrl+Alt+P）
- 85 项单元+集成测试，e2e 冒烟（test-electron）
