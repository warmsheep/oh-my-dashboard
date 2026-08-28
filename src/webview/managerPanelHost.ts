import * as vscode from "vscode";

import { CMD, MANAGER_PANEL_VIEW_TYPE } from "../constants";
import { errorMessage } from "../core/errors";
import type { QuotaService } from "../core/quotaService";
import type {
  AutoRefreshSettings,
  AutoRefreshSettingsSource,
  ManagerTab,
  ModelOption,
  QuotaInitPayload,
  QuotaProviderId,
} from "../shared/protocol";
import { normalizeAutoRefreshSettings, QUOTA_PROVIDER_IDS } from "../shared/protocol";
import type { QuotaStatusBar } from "../ui/quotaStatusBar";
import { buildWebviewHtml, readWebviewHtml } from "./panelHtml";
import type { PresetEditorSession } from "./presetEditorHost";
import { isSaveTyped, parsePresetEditorMessage, saveActionOf } from "./presetEditorHost";

export interface ManagerPanelDeps {
  quotaService: QuotaService;
  statusBar: QuotaStatusBar;
  readSettings(): AutoRefreshSettings;
  saveSettings(settings: AutoRefreshSettings): Promise<void>;
  /** Preset-tab session controller (one editing session at a time in the 模板 tab). */
  preset: PresetEditorSession;
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
// Liveness probe for the open panel (see armLivenessProbe); module-level because
// the panel itself is a singleton.
let probeTimer: ReturnType<typeof setTimeout> | undefined;
/** A booted-once page must answer quotaPing within this window or it is treated as dead. */
const PROBE_TIMEOUT_MS = 1_500;
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
    vscode.commands.registerCommand(CMD.openSettings, () => openSafely({ tab: "settings" })),
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
      // before ready would silently drop the message.
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
    postPresetInit(panel, deps, options.presetName ?? null);
    return;
  }
  post({ type: "managerNavigate", payload: { tab: "settings" } });
  post({ type: "settingsInit", payload: { settings: deps.readSettings() } });
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
        // Fresh data right after boot: the snapshot event subscription below forwards
        // the cycle result to the page without the user clicking anything.
        void runFullRefresh();
        break;
      }
      case "pong":
        clearLivenessProbe();
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
  | { kind: "save"; source: AutoRefreshSettingsSource };

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
    default:
      return undefined;
  }
}
