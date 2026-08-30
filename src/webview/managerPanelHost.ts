import * as vscode from "vscode";

import { CMD, MANAGER_PANEL_VIEW_TYPE, MODEL_ID_PATTERN } from "../constants";
import type { ConfigStore } from "../core/configStore";
import { errorMessage } from "../core/errors";
import { isValidOmoMiscValue } from "../core/omoSettings";
import { isValidOpencodeSettingValue } from "../core/opencodeSettings";
import type { QuotaService } from "../core/quotaService";
import type {
  AutoRefreshSettings,
  AutoRefreshSettingsSource,
  ConfigInitPayload,
  ManagerTab,
  ModelOption,
  OmoMiscSetting,
  OmoSettingValue,
  OpencodeSetting,
  OpencodeSettingsPayload,
  OpencodeSettingValue,
  PresetListEntry,
  QuotaInitPayload,
  QuotaProviderId,
  SkillSummary,
} from "../shared/protocol";
import {
  normalizeAutoRefreshSettings,
  OMO_MISC_SETTINGS,
  OPENCODE_SETTINGS,
  QUOTA_PROVIDER_IDS,
} from "../shared/protocol";
import type { QuotaStatusBar } from "../ui/quotaStatusBar";
import { buildWebviewHtml, readWebviewHtml } from "./panelHtml";
import type { PresetEditorSession } from "./presetEditorHost";
import { assignmentRows, isSaveTyped, parsePresetEditorMessage, saveActionOf } from "./presetEditorHost";

export interface ManagerPanelDeps {
  quotaService: QuotaService;
  statusBar: QuotaStatusBar;
  readSettings(): AutoRefreshSettings;
  saveSettings(settings: AutoRefreshSettings): Promise<void>;
  /** Preset-tab session controller (one editing session at a time in the 模板 tab). */
  preset: PresetEditorSession;
  /** Preset list for the 模板 tab's default (no open session) view. */
  listPresets(): PresetListEntry[];
  /** Config-store backing the 配置 tab: live assignment reads + setAgentModel writes. */
  configStore: ConfigStore;
  /** Lazy skills provider for the 配置 tab (full discover scan); only invoked when a payload is built. */
  listSkills(): SkillSummary[];
  /** Full UI refresh after a successful in-panel config write (same contract as the preset-save path). */
  refreshAll(): void;
  log(message: string): void;
}

/**
 * Which tab an entry point lands on; focusProvider scrolls one quota group into
 * view, presetName starts (or switches) the preset editing session (null = new).
 */
export interface OpenManagerPanelOptions {
  tab: ManagerTab;
  focusProvider?: QuotaProviderId;
  presetName?: string | null;
}

// Singleton panel: the manager page (额度/设置 tabs) is unique, like the quota and
// settings pages it replaces. openPanelNavigate/openPanelReady live on the same
// lifecycle (reset in onDidDispose).
let openPanel: vscode.WebviewPanel | undefined;
let openPanelReady = false;
let openPanelNavigate: OpenManagerPanelOptions | undefined;
/** Creation time (Date.now()) of the current singleton panel; 0 = none. Feeds the zombie-boot recreate check. */
let openPanelCreatedAt = 0;
// Liveness probe for the open panel (see armLivenessProbe); module-level because
// the panel itself is a singleton.
let probeTimer: ReturnType<typeof setTimeout> | undefined;
/** A booted-once page must answer quotaPing within this window or it is treated as dead. */
const PROBE_TIMEOUT_MS = 1_500;
/**
 * Matches the boot watchdog in createManagerPanel: a page that never finished
 * booting after 20s is a zombie (its iframe was likely evicted during a long-idle
 * code-server session before the first ready). The user's explicit click is the
 * right moment to rebuild the iframe — unlike an automatic dispose, which would
 * yank a tab away from a page that is merely booting slowly on a degraded link.
 */
const PANEL_RECREATE_AFTER_MS = 20_000;
/**
 * Saves received from the page currently in flight. While >0, the extension's
 * config-change listener must NOT push settingsInit back: those events are the
 * echo of our own writes, and mid-flight they carry PARTIAL state — adopting
 * them would visibly revert edits the user just made (rapid toggles included).
 * External changes (Settings UI, hand edits) only get pushed once saves settle;
 * the page normalizes before sending, so the post-settle echo is a no-op.
 */
let pendingSaves = 0;

/**
 * Register the manager panel entry commands: the status-bar quota click, the MiMo
 * cookie shortcut (both → 额度 tab), and the tree gear / 打开设置 (→ 设置 tab).
 */
export function registerManagerPanel(ctx: vscode.ExtensionContext, deps: ManagerPanelDeps): void {
  // Same contract as commands.ts run(): an unexpected open failure must surface as a
  // Chinese message instead of escaping to the command system's English error log.
  const openSafely = (options: OpenManagerPanelOptions): Promise<void> =>
    openManagerPanel(ctx, deps, options).catch((error: unknown) => {
      const message = errorMessage(error);
      deps.log(`managerPanel: 打开管理面板失败: ${message}`);
      void vscode.window.showErrorMessage(`打开管理面板失败: ${message}`);
    });
  ctx.subscriptions.push(
    vscode.commands.registerCommand(CMD.quotaRefresh, () => openSafely({ tab: "quota" })),
    vscode.commands.registerCommand(CMD.quotaConfigureMimo, () => openSafely({ tab: "quota", focusProvider: "mimo" })),
    // 打开设置 lands on the FIRST tab (配置): the entry's historical guarantee of
    // fresh settings data is preserved by the settingsInit push riding along on
    // the config navigation (see postNavigateMessages).
    vscode.commands.registerCommand(CMD.openSettings, () => openSafely({ tab: "config" })),
  );
}

/**
 * Open the manager panel on the 模板 tab editing `name` (null = a new unsaved
 * preset). Called by the editPreset command; an already-open panel just
 * navigates + receives a fresh preset init (switching the editing session).
 */
export function openPresetEditorTab(
  ctx: vscode.ExtensionContext,
  deps: ManagerPanelDeps,
  name: string | null,
): Promise<void> {
  return openManagerPanel(ctx, deps, { tab: "preset", presetName: name });
}

/**
 * Push a refreshed model catalog to the open panel's preset tab. Accepts the
 * list itself or a lazy provider; the provider is only invoked when the panel
 * is open, so callers avoid computing `listModels()` when nobody listens.
 */
export function notifyManagerPanelModelsChanged(models: ModelOption[] | (() => ModelOption[])): void {
  if (openPanel === undefined) {
    return;
  }
  const resolved = typeof models === "function" ? models() : models;
  void openPanel.webview.postMessage({ type: "modelsUpdated", payload: { models: resolved } });
}

/**
 * Push a refreshed preset list to the open panel's 模板 tab (same lazy-provider
 * contract as the models push). Keeps the list view in sync with EXTERNAL
 * changes — tree-side 捕获/删除/重命名/应用 and watcher-driven refreshes —
 * mirroring how models and settings already re-sync the open page.
 */
export function notifyManagerPanelPresetsChanged(presets: PresetListEntry[] | (() => PresetListEntry[])): void {
  if (openPanel === undefined) {
    return;
  }
  const resolved = typeof presets === "function" ? presets() : presets;
  void openPanel.webview.postMessage({ type: "presetList", payload: { presets: resolved } });
}

/**
 * Push a refreshed configInit to the open panel's 配置 tab (same lazy-provider
 * contract as the models push): watcher-driven config changes re-sync the open
 * page. Models intentionally ride the existing modelsUpdated channel instead.
 */
export function notifyManagerPanelConfigChanged(payload: ConfigInitPayload | (() => ConfigInitPayload)): void {
  if (openPanel === undefined) {
    return;
  }
  const resolved = typeof payload === "function" ? payload() : payload;
  void openPanel.webview.postMessage({ type: "configInit", payload: resolved });
}

/**
 * Push a refreshed opencodeInit to the open panel's OpenCode tab (same lazy-provider
 * contract as the config push): watcher-driven opencode.json changes re-sync the open
 * page. Mirrors {@link notifyManagerPanelConfigChanged}.
 */
export function notifyManagerPanelOpencodeChanged(
  payload: OpencodeSettingsPayload | (() => OpencodeSettingsPayload),
): void {
  if (openPanel === undefined) {
    return;
  }
  const resolved = typeof payload === "function" ? payload() : payload;
  void openPanel.webview.postMessage({ type: "opencodeInit", payload: resolved });
}

/**
 * Build the 配置 tab boot payload: live assignment rows (no preset overlay),
 * merged model options, discovered skills, the current write target (kind +
 * path only), and the OMO misc feature values powering the 功能设置 section.
 * Exported so the extension can feed {@link notifyManagerPanelConfigChanged}
 * with a lazy provider over the same deps. `skills` lets the watcher-driven push
 * reuse the tree snapshot's locations instead of re-running a full discover scan.
 */
export function buildConfigInitPayload(deps: ManagerPanelDeps, skills?: SkillSummary[]): ConfigInitPayload {
  const target = deps.configStore.resolveAgentConfig();
  return {
    rows: assignmentRows(deps.configStore.ohMyAssignments()),
    models: deps.configStore.listModels(),
    skills: skills ?? deps.listSkills(),
    target: { kind: target.kind, path: target.path },
    omo: deps.configStore.omoMiscValues(),
  };
}

/**
 * Build the OpenCode tab boot payload: current settings values, the opencode.json[c]
 * path (displayed at the top of the tab), merged model options for the model
 * pickers, plus the read aggregates of the 权限 / 命令/格式化/LSP/MCP 服务器 groups
 * and the tui.json face (theme + path) powering the 终端界面 group. Exported so the
 * extension can feed {@link notifyManagerPanelOpencodeChanged} with a lazy provider.
 */
export function buildOpencodeInitPayload(deps: ManagerPanelDeps): OpencodeSettingsPayload {
  return {
    values: deps.configStore.opencodeSettingValues(),
    configPath: deps.configStore.resolveOpencodeConfigPath(),
    models: deps.configStore.listModels(),
    permission: deps.configStore.permissionState(),
    tui: { theme: deps.configStore.tuiTheme(), path: deps.configStore.tuiConfigPath() },
    records: deps.configStore.recordStates(),
  };
}

/**
 * Test-only bridge for e2e: post a raw protocol message into the open manager panel.
 * Returns false when no panel is open (mirror of postMessageToPresetEditor).
 */
export function postMessageToManagerPanel(message: unknown): boolean {
  if (openPanel === undefined) {
    return false;
  }
  void openPanel.webview.postMessage(message);
  return true;
}

/**
 * Push a fresh settingsInit into the open page — used by the extension's config
 * listener for EXTERNAL changes. Returns without posting while own saves are in
 * flight (echo suppression, see pendingSaves) or no panel is open.
 */
export function pushSettingsToManagerPanel(readSettings: () => AutoRefreshSettings): void {
  if (openPanel === undefined || !openPanelReady || pendingSaves > 0) {
    return;
  }
  void openPanel.webview.postMessage({ type: "settingsInit", payload: { settings: readSettings() } });
}

function clearLivenessProbe(): void {
  if (probeTimer !== undefined) {
    clearTimeout(probeTimer);
    probeTimer = undefined;
  }
}

/**
 * Probe the open panel's webview and replace it when the page died silently.
 * Long-idle code-server sessions can evict the webview's iframe (service-worker
 * restarts, browser tab freezing) WITHOUT firing onDidDispose — the singleton
 * then points at a tab whose JS context is gone: every later click only revealed
 * a dead page that can never render data again. A booted-once page answers
 * quotaPing with pong (the manager ROOT listener answers regardless of the
 * active tab); silence for PROBE_TIMEOUT_MS means the panel is a zombie and is
 * disposed + recreated fresh (the identity guard in onDidDispose keeps the
 * replacement safe against the async dispose event).
 */
function armLivenessProbe(
  ctx: vscode.ExtensionContext,
  deps: ManagerPanelDeps,
  options: OpenManagerPanelOptions,
): void {
  const panel = openPanel;
  if (panel === undefined) {
    return;
  }
  clearLivenessProbe();
  void panel.webview.postMessage({ type: "quotaPing" });
  probeTimer = setTimeout(() => {
    probeTimer = undefined;
    if (openPanel !== panel) {
      return; // already replaced or closed while the probe was pending
    }
    deps.log("managerPanel: 面板页面无响应，已重建管理面板");
    panel.dispose();
    createManagerPanel(ctx, deps, options);
  }, PROBE_TIMEOUT_MS);
}

export async function openManagerPanel(
  ctx: vscode.ExtensionContext,
  deps: ManagerPanelDeps,
  options: OpenManagerPanelOptions,
): Promise<void> {
  if (openPanel) {
    openPanel.reveal();
    if (openPanelReady) {
      // Re-init is idempotent on the page side; managerNavigate re-targets the tab.
      postNavigateMessages(openPanel, deps, options);
      if (options.tab === "quota") {
        // Clicking the quota surface always refreshes: it revives the auto-refresh
        // circuit breaker (paused after transport-failure streaks while idle) the
        // moment one manual cycle succeeds, healing a status bar stuck on "?".
        // Opening the 设置 tab deliberately does NOT refresh.
        void deps.statusBar.refresh();
      }
      armLivenessProbe(ctx, deps, options);
    } else {
      // Still booting: buffer the navigation into the pending ready handler — posting
      // before ready would silently drop the message. UNLESS the page went past the
      // boot watchdog without EVER becoming ready: the liveness probe cannot see it
      // (it only covers booted-once pages), so every later click would land on a
      // dead blank tab forever. Dispose + recreate fresh — the identity guard in
      // onDidDispose keeps this replacement safe (same pattern as armLivenessProbe).
      if (Date.now() - openPanelCreatedAt > PANEL_RECREATE_AFTER_MS) {
        deps.log("managerPanel: 面板长时间未完成初始化，已重建管理面板");
        openPanel.dispose();
        createManagerPanel(ctx, deps, options);
        return;
      }
      openPanelNavigate = options;
    }
    return;
  }
  createManagerPanel(ctx, deps, options);
}

/** Build the quota-view boot payload (cached snapshot + visibility + optional focus). */
function quotaInitPayload(deps: ManagerPanelDeps, focusProvider: QuotaProviderId | undefined): QuotaInitPayload {
  const payload: QuotaInitPayload = {
    snapshot: deps.statusBar.getSnapshot(),
    visibility: deps.statusBar.getVisibility(),
  };
  if (focusProvider !== undefined) {
    payload.focusProvider = focusProvider;
  }
  return payload;
}

function postNavigateMessages(
  panel: vscode.WebviewPanel,
  deps: ManagerPanelDeps,
  options: OpenManagerPanelOptions,
): void {
  const post = (message: unknown): void => {
    void panel.webview.postMessage(message);
  };
  if (options.tab === "quota") {
    post({ type: "managerNavigate", payload: { tab: "quota", focusProvider: options.focusProvider } });
    post({ type: "quotaInit", payload: quotaInitPayload(deps, options.focusProvider) });
    return;
  }
  if (options.tab === "preset") {
    post({ type: "managerNavigate", payload: { tab: "preset" } });
    postPresetList(panel, deps);
    postPresetInit(panel, deps, options.presetName ?? null);
    return;
  }
  if (options.tab === "config") {
    post({ type: "managerNavigate", payload: { tab: "config" } });
    post({ type: "configInit", payload: buildConfigInitPayload(deps) });
    // The 打开设置 entry now lands here (first tab): keep the settings tab's
    // data fresh on arrival, preserving the entry's pre-config-tab guarantee.
    post({ type: "settingsInit", payload: { settings: deps.readSettings() } });
    return;
  }
  if (options.tab === "opencode") {
    post({ type: "managerNavigate", payload: { tab: "opencode" } });
    post({ type: "opencodeInit", payload: buildOpencodeInitPayload(deps) });
    return;
  }
  if (options.tab === "skills") {
    post({ type: "managerNavigate", payload: { tab: "skills" } });
    // Skills data rides configInit (no own channel): re-push it so navigation
    // lands on a fresh skills list, exactly like a config-tab navigation would.
    post({ type: "configInit", payload: buildConfigInitPayload(deps) });
    return;
  }
  post({ type: "managerNavigate", payload: { tab: "settings" } });
  post({ type: "settingsInit", payload: { settings: deps.readSettings() } });
}

/**
 * Push the preset list powering the 模板 tab's default view (shown whenever no
 * edit session is open). Idempotent data refresh — safe to re-send anytime.
 */
function postPresetList(panel: vscode.WebviewPanel, deps: ManagerPanelDeps): void {
  void panel.webview.postMessage({ type: "presetList", payload: { presets: deps.listPresets() } });
}

/**
 * Begin (or switch) the preset editing session and post its init; a load
 * failure (unreadable preset, listModels throw) posts initFailed instead —
 * the page keeps the previous/empty session visible with the error banner.
 */
function postPresetInit(panel: vscode.WebviewPanel, deps: ManagerPanelDeps, name: string | null): void {
  try {
    const payload = deps.preset.begin(name);
    void panel.webview.postMessage({ type: "init", payload });
  } catch (error) {
    const msg = errorMessage(error);
    deps.log(`managerPanel: 模板编辑会话初始化失败: ${msg}`);
    void panel.webview.postMessage({ type: "initFailed", payload: { error: msg } });
  }
}

function createManagerPanel(
  ctx: vscode.ExtensionContext,
  deps: ManagerPanelDeps,
  options: OpenManagerPanelOptions,
): void {
  const html = readWebviewHtml(ctx, "manager.html", deps.log);
  if (html === undefined) {
    void vscode.window.showErrorMessage(
      "管理面板前端资源缺失（dist-webview/manager.html），请先运行 npm run build:webview",
    );
    return;
  }

  const distWebviewUri = vscode.Uri.joinPath(ctx.extensionUri, "dist-webview");
  const panel = vscode.window.createWebviewPanel(MANAGER_PANEL_VIEW_TYPE, "OpenCode 管理", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [distWebviewUri],
  });
  openPanel = panel;
  openPanelReady = false;
  openPanelNavigate = options;
  openPanelCreatedAt = Date.now();
  ctx.subscriptions.push(panel);

  // Boot watchdog, diagnostics ONLY. Opening is deliberately decoupled from the
  // webview handshake (policy inherited from the quota panel): on degraded networks
  // (code-server ships webview resources through the browser link / service worker)
  // the page boots arbitrarily slowly, and an await-ready + dispose-on-timeout
  // design silently undoes every click until the network heals. The tab now stays
  // open and initializes whenever ready eventually lands; closing the tab resets
  // the singleton via onDidDispose, so a later click opens fresh.
  let bootWatchdog: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    bootWatchdog = undefined;
    if (!openPanelReady && openPanel === panel) {
      deps.log("managerPanel: 管理面板 20 秒内未完成初始化（面板保持打开，就绪后自动加载）");
    }
  }, 20_000);
  const clearWatchdog = (): void => {
    if (bootWatchdog !== undefined) {
      clearTimeout(bootWatchdog);
      bootWatchdog = undefined;
    }
  };

  const post = (message: unknown): void => {
    void panel.webview.postMessage(message);
  };

  // Coalesce double-clicks per provider: the page disables its button, but a queued
  // second message (keyboard + click) must not start a duplicate solo fetch.
  const soloInFlight = new Map<QuotaProviderId, Promise<void>>();

  /**
   * Saves received from the page currently in flight (module-level pendingSaves:
   * pushSettingsToManagerPanel reads it for echo suppression).
   */
  // Serialized save pipeline: overlapping settingsSave messages (rapid toggles) must
  // not interleave their config.update batches — each link runs after the previous
  // write settled (each save carries the FULL form, so ordering is last-write-wins).
  let saveChain: Promise<void> = Promise.resolve();

  // Snapshot delivery uses ONE channel: statusBar.onSnapshot fires on every full
  // cycle and every solo merge (success AND failure), and the subscription below
  // forwards it to the page — no per-request reply posts.
  const runSoloRefresh = (providerId: QuotaProviderId): Promise<void> => {
    const existing = soloInFlight.get(providerId);
    if (existing) {
      return existing;
    }
    const running = deps.statusBar
      .refreshProvider(providerId)
      .then(() => undefined)
      .finally(() => {
        soloInFlight.delete(providerId);
      });
    soloInFlight.set(providerId, running);
    return running;
  };

  const runFullRefresh = (): Promise<void> => deps.statusBar.refresh().then(() => undefined);

  const listener = panel.webview.onDidReceiveMessage((raw: unknown) => {
    const presetMessage = parsePresetEditorMessage(raw);
    if (presetMessage !== undefined) {
      switch (presetMessage.kind) {
        case "dirty":
          if (presetMessage.dirty) {
            deps.preset.noteDirty();
          }
          break;
        case "cancel":
          // The page already cleared its local session; drop the crash-recovery
          // draft so a reopen starts clean instead of restoring discarded edits.
          deps.preset.cancel();
          break;
        case "save":
          // handleSave is synchronous (core save/rename/apply are sync fs) — the
          // reply lands before the page's awaitResult guard can time out.
          post({ type: "result", payload: deps.preset.save(presetMessage.payload) });
          // Saves and renames change the on-disk list (a rename-before-throw can
          // change it even on !ok): re-push so the list view shown after the
          // session closes never goes stale.
          postPresetList(panel, deps);
          break;
      }
      return;
    }
    const message = parseMessage(raw);
    if (message === undefined) {
      deps.log(`managerPanel: 忽略无法识别的 webview 消息: ${JSON.stringify(raw) ?? String(raw)}`);
      // Backstop (preset tab): a save-typed message that failed validation must
      // still get a reply, or the page stays busy forever (awaitingResult never
      // clears).
      if (isSaveTyped(raw)) {
        post({ type: "result", payload: { action: saveActionOf(raw), ok: false, error: "保存请求格式无法识别" } });
      }
      // Backstop (配置 tab): same busy-forever contract for configSetModel.
      if (isConfigSetModelTyped(raw)) {
        post({
          type: "configModelSaved",
          payload: { ok: false, ...configSetModelEcho(raw), error: "配置请求格式无法识别" },
        });
      }
      // Backstop (OpenCode/OMO tabs): same busy-forever contract for the two
      // settings-write messages; the key echo lets the page clear its pending row.
      if (isOpencodeSetSettingTyped(raw)) {
        post({
          type: "opencodeSettingSaved",
          payload: { ok: false, ...settingKeyEcho(raw), error: "设置请求格式无法识别" },
        });
      }
      if (isOmoSetSettingTyped(raw)) {
        post({
          type: "omoSettingSaved",
          payload: { ok: false, ...settingKeyEcho(raw), error: "设置请求格式无法识别" },
        });
      }
      return;
    }
    switch (message.kind) {
      case "ready": {
        openPanelReady = true;
        clearWatchdog();
        // Consume the buffered entry-point navigation ONCE: a later webview
        // context reload must not replay a stale creation-time tab — the page's
        // persisted tab wins, only the data is re-pushed.
        const navigate = openPanelNavigate;
        openPanelNavigate = undefined;
        if (navigate !== undefined) {
          postNavigateMessages(panel, deps, navigate);
        } else {
          post({ type: "quotaInit", payload: quotaInitPayload(deps, undefined) });
        }
        // Settings state rides along on boot so the 设置 tab is ready without an
        // extra round trip when the user switches to it.
        post({ type: "settingsInit", payload: { settings: deps.readSettings() } });
        // Same for the 配置 tab's payload: the tab body is always mounted, so the
        // live assignments + skills must boot regardless of the entry tab.
        post({ type: "configInit", payload: buildConfigInitPayload(deps) });
        // Same for the OpenCode tab: always-mounted body, settings boot with the panel.
        post({ type: "opencodeInit", payload: buildOpencodeInitPayload(deps) });
        // Same for the 模板 tab's preset list: tab bodies are always mounted, so the
        // list must boot regardless of the entry tab (a preset-targeted navigate
        // already pushed one — the duplicate carries the same data and is harmless).
        postPresetList(panel, deps);
        // Fresh data right after boot: the snapshot event subscription below forwards
        // the cycle result to the page without the user clicking anything.
        void runFullRefresh();
        break;
      }
      case "pong":
        clearLivenessProbe();
        break;
      case "editPreset":
        // List-view click: the same begin/init path the editPreset command drives.
        // The page is already on the 模板 tab, so only the session init is needed.
        postPresetInit(panel, deps, message.name);
        break;
      case "setModel":
        try {
          // Core owns the write path (readTextForEdit contract, JSONC syntax abort,
          // conflict-key cleanup, atomic write); errors map to Chinese via errorMessage().
          deps.configStore.setAgentModel(message.section, message.name, message.model, message.variant);
          deps.log(
            `managerPanel: 已更新 ${message.name} → ${message.model}${message.variant ? `（variant: ${message.variant}）` : ""}`,
          );
          post({ type: "configModelSaved", payload: { ok: true, section: message.section, name: message.name } });
          // Refreshed payload so the open tab re-syncs immediately; the explicit
          // refreshAll matches the preset-save path (the fs.watch echo also fires,
          // but later and deduped).
          post({ type: "configInit", payload: buildConfigInitPayload(deps) });
          deps.refreshAll();
        } catch (error) {
          const msg = errorMessage(error);
          deps.log(`managerPanel: 配置页更新模型失败: ${msg}`);
          post({
            type: "configModelSaved",
            payload: { ok: false, section: message.section, name: message.name, error: msg },
          });
        }
        break;
      case "setOpencodeSetting":
        try {
          // Same write contract as setModel, for one OPENCODE_SETTINGS entry in opencode.json[c].
          deps.configStore.setOpencodeSetting(message.setting.key, message.value);
          deps.log(`managerPanel: 已更新 OpenCode 设置 ${message.setting.key}`);
          post({ type: "opencodeSettingSaved", payload: { ok: true, key: message.setting.key } });
          post({ type: "opencodeInit", payload: buildOpencodeInitPayload(deps) });
          deps.refreshAll();
        } catch (error) {
          const msg = errorMessage(error);
          deps.log(`managerPanel: OpenCode 设置写入失败: ${msg}`);
          post({ type: "opencodeSettingSaved", payload: { ok: false, key: message.setting.key, error: msg } });
        }
        break;
      case "setOmoSetting":
        try {
          // Same write contract, for one OMO_MISC_SETTINGS entry in the agent config target.
          deps.configStore.setOmoMiscSetting(message.setting.key, message.value);
          deps.log(`managerPanel: 已更新 OMO 功能设置 ${message.setting.key}`);
          post({ type: "omoSettingSaved", payload: { ok: true, key: message.setting.key } });
          // The OMO misc values ride configInit — re-push that channel.
          post({ type: "configInit", payload: buildConfigInitPayload(deps) });
          deps.refreshAll();
        } catch (error) {
          const msg = errorMessage(error);
          deps.log(`managerPanel: OMO 功能设置写入失败: ${msg}`);
          post({ type: "omoSettingSaved", payload: { ok: false, key: message.setting.key, error: msg } });
        }
        break;
      case "refresh":
        void (message.providerId === undefined ? runFullRefresh() : runSoloRefresh(message.providerId));
        break;
      case "saveCookie":
        try {
          // Core owns persistence: normalize (invalid → MIMO_COOKIE_INVALID), merge into
          // quota.json, atomic write, chmod 0600. Errors map to Chinese via errorMessage().
          deps.quotaService.saveMimoCookie(message.cookie);
          deps.log("managerPanel: 已写入 MiMo Cookie（quota.json）");
          post({ type: "quotaConfigSaved", payload: { ok: true } });
          void runSoloRefresh("mimo");
        } catch (error) {
          const msg = errorMessage(error);
          deps.log(`managerPanel: 保存 MiMo Cookie 失败: ${msg}`);
          post({ type: "quotaConfigSaved", payload: { ok: false, error: msg } });
        }
        break;
      case "setStatusBar":
        try {
          // Persist into quota.json (merge preserves the cookie), swap the status
          // bar's in-memory record, echo the normalized truth back to the page.
          const visibility = deps.quotaService.saveQuotaStatusBarProvider(message.providerId, message.visible);
          deps.statusBar.setVisibility(visibility);
          deps.log(`managerPanel: ${message.providerId} 状态栏显示已${message.visible ? "开启" : "关闭"}`);
          post({ type: "quotaStatusBarSaved", payload: { ok: true, visibility } });
          if (message.visible) {
            // Newly shown provider: fill its segment immediately instead of waiting
            // for the next scheduled cycle.
            void runFullRefresh();
          }
        } catch (error) {
          const msg = errorMessage(error);
          deps.log(`managerPanel: 保存状态栏显示设置失败: ${msg}`);
          post({ type: "quotaStatusBarSaved", payload: { ok: false, error: msg } });
        }
        break;
      case "save":
        // Normalize BEFORE persisting: webview input is never trusted raw; clamped
        // values echo back to the page through the config-change settingsInit push.
        pendingSaves += 1;
        saveChain = saveChain
          .then(() => normalizeAndSave(deps, message.source))
          .then((saved) => {
            if (openPanel === panel && openPanelReady) {
              post(saved);
              // Post-save truth push (ok AND !ok): the page marks `saved` from the
              // payload it sent, and an external change that landed during the save
              // flight (echo-suppressed) would otherwise never re-sync.
              post({ type: "settingsInit", payload: { settings: deps.readSettings() } });
            }
          })
          .catch(() => undefined)
          .finally(() => {
            pendingSaves -= 1;
          });
        break;
    }
  });

  // Forward every snapshot event (auto-refresh cycles AND manual refresh results — the
  // single delivery channel) while the panel is alive; page + status bar stay in sync.
  const snapshotSubscription = deps.statusBar.onSnapshot((snapshot) => {
    if (snapshot !== null) {
      post({ type: "quotaSnapshot", payload: { snapshot } });
    }
  });

  // Panel visibility gates refresh targets: while the tab is the active editor the
  // quota view is "open", so hidden providers join every auto cycle; a return to
  // the tab kicks one immediate round (hidden data may be old).
  const viewStateSubscription = panel.onDidChangeViewState((event) => {
    deps.statusBar.setPanelVisible(event.webviewPanel.visible);
  });
  deps.statusBar.setPanelVisible(panel.visible);

  panel.onDidDispose(() => {
    // Cancel any pending probe FIRST: the user closing the tab must never be
    // "answered" 1.5s later by resurrecting a fresh panel they just closed.
    clearLivenessProbe();
    clearWatchdog();
    listener.dispose();
    snapshotSubscription.dispose();
    viewStateSubscription.dispose();
    if (openPanel === panel) {
      openPanel = undefined;
      openPanelReady = false;
      openPanelNavigate = undefined;
      openPanelCreatedAt = 0;
      // Release the visibility gate so closed-panel cycles stop including hidden
      // providers (the identity guard keeps a replacement panel from being muted
      // by this reset — it re-arms itself through its own onDidChangeViewState).
      deps.statusBar.setPanelVisible(false);
    }
  });

  panel.webview.html = buildWebviewHtml(panel.webview, html, distWebviewUri);
  // No await on the handshake: the tab is already open, and the ready handler above
  // drives init + first refresh whenever the webview finishes booting.
}

/**
 * Persist a normalized save and produce the settingsSaved reply message; failures
 * degrade to the !ok shape with the friendly Chinese error instead of throwing
 * into the message-pump callback.
 */
async function normalizeAndSave(
  deps: ManagerPanelDeps,
  source: AutoRefreshSettingsSource,
): Promise<{ type: "settingsSaved"; payload: { ok: boolean; error?: string } }> {
  const settings = normalizeAutoRefreshSettings(source);
  try {
    await deps.saveSettings(settings);
    deps.log("settings: 已保存自动刷新设置");
    return { type: "settingsSaved", payload: { ok: true } };
  } catch (error) {
    const message = errorMessage(error);
    deps.log(`managerPanel: 保存设置失败: ${message}`);
    return { type: "settingsSaved", payload: { ok: false, error: message } };
  }
}

type ParsedMessage =
  | { kind: "ready" }
  | { kind: "pong" }
  | { kind: "refresh"; providerId?: QuotaProviderId }
  | { kind: "saveCookie"; cookie: string }
  | { kind: "setStatusBar"; providerId: QuotaProviderId; visible: boolean }
  | { kind: "save"; source: AutoRefreshSettingsSource }
  | { kind: "editPreset"; name: string | null }
  | { kind: "setModel"; section: "agents" | "categories"; name: string; model: string; variant: string | null }
  | { kind: "setOpencodeSetting"; setting: OpencodeSetting; value: OpencodeSettingValue }
  | { kind: "setOmoSetting"; setting: OmoMiscSetting; value: OmoSettingValue };

/**
 * Validate an incoming webview message against the protocol shape. Returns
 * undefined for anything unrecognized (module-private, same contract as the
 * preset editor host); settings payload VALUES are validated by
 * normalizeAutoRefreshSettings.
 */
function parseMessage(raw: unknown): ParsedMessage | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const msg = raw as Record<string, unknown>;
  switch (msg.type) {
    case "ready":
      return { kind: "ready" };
    case "pong":
      return { kind: "pong" };
    case "quotaRefresh": {
      const providerId = (msg.payload as { providerId?: unknown } | undefined)?.providerId;
      if (providerId === undefined) {
        return { kind: "refresh" };
      }
      return typeof providerId === "string" && (QUOTA_PROVIDER_IDS as readonly string[]).includes(providerId)
        ? { kind: "refresh", providerId: providerId as QuotaProviderId }
        : undefined;
    }
    case "quotaSaveMimoCookie": {
      const cookie = (msg.payload as { cookie?: unknown } | undefined)?.cookie;
      // Cookies are long browser headers; 8 KiB comfortably covers them while still
      // bounding garbage input.
      return typeof cookie === "string" && cookie.length > 0 && cookie.length <= 8192
        ? { kind: "saveCookie", cookie }
        : undefined;
    }
    case "quotaSetStatusBar": {
      const payload = msg.payload as { providerId?: unknown; visible?: unknown } | undefined;
      const providerId = payload?.providerId;
      const visible = payload?.visible;
      return typeof providerId === "string" &&
        (QUOTA_PROVIDER_IDS as readonly string[]).includes(providerId) &&
        typeof visible === "boolean"
        ? { kind: "setStatusBar", providerId: providerId as QuotaProviderId, visible }
        : undefined;
    }
    case "settingsSave": {
      const settings = (msg.payload as { settings?: unknown } | undefined)?.settings;
      return typeof settings === "object" && settings !== null && !Array.isArray(settings)
        ? { kind: "save", source: settings as AutoRefreshSettingsSource }
        : undefined;
    }
    case "presetEdit": {
      const name = (msg.payload as { name?: unknown } | undefined)?.name;
      if (name === null) {
        return { kind: "editPreset", name: null };
      }
      // Name length cap mirrors parseRows in presetEditorHost (every protocol-
      // carried name is bounded); begin() itself tolerates unknown names.
      return typeof name === "string" && name.length > 0 && name.length <= 64
        ? { kind: "editPreset", name }
        : undefined;
    }
    case "configSetModel": {
      const payload = msg.payload as
        { section?: unknown; name?: unknown; model?: unknown; variant?: unknown } | undefined;
      const section = payload?.section;
      const name = payload?.name;
      const model = payload?.model;
      const variant = payload?.variant;
      // Bounds mirror the preset-editor payload caps; the model must be a
      // provider/model id (MODEL_ID_PATTERN, same as the command path).
      return (section === "agents" || section === "categories") &&
        typeof name === "string" &&
        name.length > 0 &&
        name.length <= 64 &&
        typeof model === "string" &&
        MODEL_ID_PATTERN.test(model) &&
        (variant === null || (typeof variant === "string" && variant.length > 0 && variant.length <= 32))
        ? { kind: "setModel", section, name, model, variant }
        : undefined;
    }
    case "opencodeSetSetting": {
      const payload = msg.payload as { key?: unknown; value?: unknown } | undefined;
      const found =
        typeof payload?.key === "string" ? OPENCODE_SETTINGS.find((entry) => entry.key === payload.key) : undefined;
      // Key must be a known descriptor and the value must pass its kind validator
      // (same anti-arbitrary-JSONC-write gate the core write path re-checks).
      return found !== undefined && isValidOpencodeSettingValue(found, payload?.value)
        ? { kind: "setOpencodeSetting", setting: found, value: payload?.value as OpencodeSettingValue }
        : undefined;
    }
    case "omoSetSetting": {
      const payload = msg.payload as { key?: unknown; value?: unknown } | undefined;
      const found =
        typeof payload?.key === "string" ? OMO_MISC_SETTINGS.find((entry) => entry.key === payload.key) : undefined;
      return found !== undefined && isValidOmoMiscValue(found, payload?.value)
        ? { kind: "setOmoSetting", setting: found, value: payload?.value as OmoSettingValue }
        : undefined;
    }
    default:
      return undefined;
  }
}

/** Typed-but-invalid configSetModel detector for the rejection backstop (isSaveTyped analog). */
function isConfigSetModelTyped(raw: unknown): raw is { payload?: unknown } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>).type === "configSetModel"
  );
}

/** Typed-but-invalid opencodeSetSetting / omoSetSetting detectors for the rejection backstop. */
function isOpencodeSetSettingTyped(raw: unknown): raw is { payload?: unknown } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>).type === "opencodeSetSetting"
  );
}

function isOmoSetSettingTyped(raw: unknown): raw is { payload?: unknown } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>).type === "omoSetSetting"
  );
}

/**
 * Best-effort key echo for the malformed-settings rejection replies: a parseable
 * string key echoes verbatim (so the page clears the right pending row), anything
 * else falls back to "" — the configSetModelEcho analog.
 */
function settingKeyEcho(raw: { payload?: unknown }): { key: string } {
  const payload =
    typeof raw.payload === "object" && raw.payload !== null && !Array.isArray(raw.payload)
      ? (raw.payload as { key?: unknown })
      : undefined;
  return { key: typeof payload?.key === "string" ? payload.key : "" };
}

/**
 * Best-effort section/name echo for the malformed-configSetModel rejection reply:
 * the protocol types section as agents|categories, so an unparsable section falls
 * back to "agents" and an unparsable name to "".
 */
function configSetModelEcho(raw: { payload?: unknown }): { section: "agents" | "categories"; name: string } {
  const payload =
    typeof raw.payload === "object" && raw.payload !== null && !Array.isArray(raw.payload)
      ? (raw.payload as { section?: unknown; name?: unknown })
      : undefined;
  return {
    section: payload?.section === "categories" ? "categories" : "agents",
    name: typeof payload?.name === "string" ? payload.name : "",
  };
}
