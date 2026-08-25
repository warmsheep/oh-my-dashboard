# 设计：Coding Plan 额度面板（Webview 设置页）

- 日期：2026-08-25
- 状态：已确认（用户逐节审批通过）
- 范围：把状态栏额度点击后的 QuickPick 弹窗重构为类设置页的完整 Webview 编辑器窗口

## 1. 需求决定记录

| 维度 | 决定 |
|---|---|
| 页面形态 | WebviewPanel 编辑器标签页（单例，重复打开 reveal），不再是弹窗 |
| 分组展示 | 按 4 家供应商固定顺序分组：Kimi → GLM → MiMo → DeepSeek |
| 单组刷新 | 每组头部独立「刷新」按钮，仅重新请求该家 |
| 刷新全部 | 页面底部「刷新全部」按钮 |
| API-KEY | **只读**：仅显示「已检测到 / 未配置」+ 引导 `opencode auth login`，不显示任何 key 材料，不提供编辑 |
| MiMo Cookie | 页面内分组下方编辑：password 型输入框，留空 = 保持不变，填写 = 替换保存（凭据零回显），存 `quota.json`（沿用既有路径） |
| auth.json | 不写入、不修改（凭据来源仍为 opencode 自己管理） |
| 旧弹窗 | QuickPick 详情弹窗整体移除；`quotaConfigureMimo` 的 InputBox 流程移除，改为打开面板并定位 MiMo 分组 |

## 2. 交互与信息架构

- 状态栏额度段点击 → 打开「Coding Plan 额度」面板；立即显示缓存快照（若有）→ 后台自动触发一次「刷新全部」
- 既有自动刷新周期（`quota.refreshSeconds`）继续服务状态栏；页面打开期间每轮结果推送给页面（状态栏与页面同源）
- 命令 id 不变，title 调整：
  - `opencode.quotaRefresh` → 「Coding Plan 额度：查看额度面板」
  - `opencode.quotaConfigureMimo` → 打开面板并定位 MiMo 分组（title 保持「Coding Plan 额度：配置 MiMo Cookie」）

## 3. 页面结构

- 页头：标题 + 「更新于 HH:mm:ss」
- 供应商分组卡片 ×4：
  - 分组头：供应商名 + 状态徽标（已配置 / 未配置 / 刷新中）+ 右侧「刷新」按钮
  - 额度区：每窗口一行（5h/7d/30d）——进度条 + 剩余%着色（≥60 绿 / 20–60 黄 / <20 红，与状态栏同规则）+ 已用/上限 + 重置时间；DeepSeek/MiMo 余额行（币种符号 + 绝对值着色）
  - 错误行：该组 `error` 中文提示（红色横幅）；单组失败不影响其它组
  - 配置区：MiMo Cookie 编辑（见上表）；其余三家只读凭据状态 + 引导文案
- 页底：「刷新全部」

## 4. 协议（src/shared/protocol.ts）

额度数据形状（`QuotaProviderId`/`QuotaWindowKind`/`QuotaWindow`/`ProviderQuota`/`QuotaSnapshot`）从 core 迁到 shared（core re-export；webview 免拖入 node:fs）。新增消息族（沿用 frozen 契约 + parse 校验风格）：

| 方向 | 消息 | 载荷 |
|---|---|---|
| Ext→WV | `quotaInit` | `{snapshot}` |
| Ext→WV | `quotaSnapshot` | `{snapshot}`（手动刷新结果 + 自动刷新推送） |
| Ext→WV | `quotaConfigSaved` | `{providerId:"mimo", ok, error?}` |
| WV→Ext | `quotaRefresh` | `{providerId?}`（缺省 = 刷新全部） |
| WV→Ext | `quotaSaveMimoCookie` | `{cookie}` |

## 5. core 层（src/core/quotaService.ts）

- `fetchProvider(providerId): Promise<ProviderQuota>`：读取该家凭据并单独请求（从 `fetchAll` 抽取共享的凭据读取；复用既有 fetchKimi/fetchGlm/fetchMimo/fetchDeepSeek）
- 纯函数 `mergeProviderSnapshot(snapshot, provider)`：单组刷新后合并回快照
- `saveMimoCookie`/`readMimoCookie` 沿用；自动刷新/退避/单飞逻辑不动

## 6. 宿主与接线

- `src/webview/panelHtml.ts`：抽取共享 HTML 构建工具（CSP + nonce + 重写**所有** script/link 资产引用），presetEditorHost 与新宿主共用
- `src/webview/quotaPanelHost.ts`：复用 presetEditorHost 模式（单例 panel map、ready 握手 → `quotaInit`、dispose 清理、`retainContextWhenHidden`）
- `src/constants.ts`：新增 `QUOTA_PANEL_VIEW_TYPE = "opencode.quotaPanel"`；CMD id 不变
- `src/extension.ts`：协调宿主与状态栏，注入 `{getSnapshot, refresh(providerId?), onSnapshot}` 桥
- `src/ui/quotaStatusBar.ts`：移除 `showQuotaDetail` QuickPick 路径；点击 → 打开面板；暴露桥接回调

## 7. 构建管线（webview-ui/vite.config.ts）

- `rollupOptions.input = { index, quota }`；输出 `[name].js` / `[name].css`；移除 `inlineDynamicImports`（多入口不兼容，项目本无动态导入）
- quota 入口 import 同一份共享样式（主题变量 + `.ctl`/`.btn` 等控件样式），避免样式复制
- `cpSync → dist-webview` 同步与 vsce 打包流程不变

## 8. 错误处理与安全

- 凭据零回显：MiMo Cookie 输入框永远空起步（placeholder 提示已配置/未配置）；API-KEY 不进 webview
- 保存 Cookie 走既有 `normalizeMimoCookie` 校验 + `MIMO_COOKIE_INVALID` 中文错误；`CONFIG_UNREADABLE` 防覆盖语义保持
- CSP 与模板编辑器一致（`default-src 'none'; style-src cspSource 'unsafe-inline'; script-src cspSource` + nonce）

## 9. 测试策略

- 根单测：`fetchProvider`×4（复用现有 fetch mock 模式）、`mergeProviderSnapshot`、协议 quota 消息解析
- webview 单测：额度页纯 helpers（着色映射、窗口行数据、Cookie 表单状态机）
- e2e：capture-bridge 驱动面板（打开 → init → deliver `quotaRefresh` → 断言 `quotaSnapshot`；deliver `quotaSaveMimoCookie` → 断言 quota.json 写入 / 错误回包）；改造现有 quota 两条用例（不再 patch QuickPick/InputBox）
- 全量回归：`npx tsc --noEmit` + `npm test` + `npx prettier --check` + `./scripts/e2e.sh`
- 版本：**minor** bump（新功能，打包前执行）
