import * as vscode from "vscode";

import { CMD, QUOTA_PANEL_VIEW_TYPE } from "../constants";
import { errorMessage } from "../core/errors";
import type { QuotaService } from "../core/quotaService";
import type { QuotaInitPayload, QuotaProviderId } from "../shared/protocol";
import { QUOTA_PROVIDER_IDS } from "../shared/protocol";
import type { QuotaStatusBar } from "../ui/quotaStatusBar";
import { buildWebviewHtml, readWebviewHtml } from "./panelHtml";

export interface QuotaPanelDeps {
  quotaService: QuotaService;
  statusBar: QuotaStatusBar;
  log(message: string): void;
}

/** Options for opening the quota panel; focusProvider scrolls one group into view. */
export interface OpenQuotaPanelOptions {
  focusProvider?: QuotaProviderId;
}

// Singleton panel: unlike preset editors (one per preset name) the quota page is unique.
// openPanelFocus/openPanelReady live on the same lifecycle (reset in onDidDispose).
let openPanel: vscode.WebviewPanel | undefined;
let openPanelReady = false;
let openPanelFocus: QuotaProviderId | undefined;
// Liveness probe for the open panel (see armLivenessProbe); module-level because
// the panel itself is a singleton.
let probeTimer: ReturnType<typeof setTimeout> | undefined;
/** A booted-once page must answer quotaPing within this window or it is treated as dead. */
const PROBE_TIMEOUT_MS = 1_500;

/** Register the quota panel entry commands (status-bar click + MiMo config shortcut). */
export function registerQuotaPanel(ctx: vscode.ExtensionContext, deps: QuotaPanelDeps): void {
  // Same contract as commands.ts run(): an unexpected open failure must surface as a
  // Chinese message instead of escaping to the command system's English error log.
  const openSafely = (options: OpenQuotaPanelOptions = {}): Promise<void> =>
    openQuotaPanel(ctx, deps, options).catch((error: unknown) => {
      const message = errorMessage(error);
      deps.log(`quotaPanel: 打开额度面板失败: ${message}`);
      void vscode.window.showErrorMessage(`打开额度面板失败: ${message}`);
    });
  ctx.subscriptions.push(
    vscode.commands.registerCommand(CMD.quotaRefresh, () => openSafely()),
    vscode.commands.registerCommand(CMD.quotaConfigureMimo, () => openSafely({ focusProvider: "mimo" })),
  );
}

/**
 * Test-only bridge for e2e: post a raw protocol message into the open quota panel.
 * Returns false when no panel is open (mirror of postMessageToPresetEditor).
 */
export function postMessageToQuotaPanel(message: unknown): boolean {
  if (openPanel === undefined) {
    return false;
  }
  void openPanel.webview.postMessage(message);
  return true;
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
 * quotaPing with pong; silence for PROBE_TIMEOUT_MS means the panel is a zombie
 * and is disposed + recreated fresh (the identity guard in onDidDispose keeps
 * the replacement safe against the async dispose event).
 */
function armLivenessProbe(ctx: vscode.ExtensionContext, deps: QuotaPanelDeps, options: OpenQuotaPanelOptions): void {
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
    deps.log("quotaPanel: 面板页面无响应，已重建额度面板");
    panel.dispose();
    createQuotaPanel(ctx, deps, options);
  }, PROBE_TIMEOUT_MS);
}

export async function openQuotaPanel(
  ctx: vscode.ExtensionContext,
  deps: QuotaPanelDeps,
  options: OpenQuotaPanelOptions = {},
): Promise<void> {
  if (openPanel) {
    openPanel.reveal();
    if (openPanelReady) {
      // Re-init is idempotent on the page side; carrying focusProvider re-targets the group.
      if (options.focusProvider !== undefined) {
        openPanelFocus = options.focusProvider;
      }
      void openPanel.webview.postMessage(quotaInitMessage(deps, options.focusProvider));
      // Clicking the quota surface always refreshes: it revives the auto-refresh
      // circuit breaker (paused after transport-failure streaks while idle) the
      // moment one manual cycle succeeds, healing a status bar stuck on "?".
      void deps.statusBar.refresh();
      armLivenessProbe(ctx, deps, options);
    } else if (options.focusProvider !== undefined) {
      // Still booting: buffer the focus into the pending ready handler — posting
      // before ready would silently drop the message.
      openPanelFocus = options.focusProvider;
    }
    return;
  }
  createQuotaPanel(ctx, deps, options);
}

function createQuotaPanel(ctx: vscode.ExtensionContext, deps: QuotaPanelDeps, options: OpenQuotaPanelOptions): void {
  const html = readWebviewHtml(ctx, "quota.html", deps.log);
  if (html === undefined) {
    void vscode.window.showErrorMessage(
      "额度面板前端资源缺失（dist-webview/quota.html），请先运行 npm run build:webview",
    );
    return;
  }

  const distWebviewUri = vscode.Uri.joinPath(ctx.extensionUri, "dist-webview");
  const panel = vscode.window.createWebviewPanel(QUOTA_PANEL_VIEW_TYPE, "Coding Plan 额度", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [distWebviewUri],
  });
  openPanel = panel;
  openPanelReady = false;
  openPanelFocus = options.focusProvider;
  ctx.subscriptions.push(panel);

  // Boot watchdog, diagnostics ONLY. Opening is deliberately decoupled from the
  // webview handshake: on degraded networks (code-server ships webview resources
  // through the browser link / service worker) the page boots arbitrarily slowly,
  // and the old await-ready + dispose-on-timeout design silently undid every click
  // until the network healed — the status bar showed "?" and clicks did nothing.
  // The tab now stays open and initializes whenever ready eventually lands; closing
  // the tab resets the singleton via onDidDispose, so a later click opens fresh.
  let bootWatchdog: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    bootWatchdog = undefined;
    if (!openPanelReady && openPanel === panel) {
      deps.log("quotaPanel: 额度面板 20 秒内未完成初始化（面板保持打开，就绪后自动加载）");
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
    const message = parseMessage(raw);
    if (message === undefined) {
      deps.log(`quotaPanel: 忽略无法识别的 webview 消息: ${JSON.stringify(raw) ?? String(raw)}`);
      return;
    }
    switch (message.kind) {
      case "ready":
        openPanelReady = true;
        clearWatchdog();
        post(quotaInitMessage(deps, openPanelFocus));
        // Fresh data right after boot: the snapshot event subscription below forwards
        // the cycle result to the page without the user clicking anything.
        void runFullRefresh();
        break;
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
          deps.log("quota: 已写入 MiMo Cookie（quota.json，来自额度面板）");
          post({ type: "quotaConfigSaved", payload: { ok: true } });
          void runSoloRefresh("mimo");
        } catch (error) {
          const msg = errorMessage(error);
          deps.log(`quotaPanel: 保存 MiMo Cookie 失败: ${msg}`);
          post({ type: "quotaConfigSaved", payload: { ok: false, error: msg } });
        }
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

  panel.onDidDispose(() => {
    // Cancel any pending probe FIRST: the user closing the tab must never be
    // "answered" 1.5s later by resurrecting a fresh panel they just closed.
    clearLivenessProbe();
    clearWatchdog();
    listener.dispose();
    snapshotSubscription.dispose();
    if (openPanel === panel) {
      openPanel = undefined;
      openPanelReady = false;
      openPanelFocus = undefined;
    }
  });

  panel.webview.html = buildWebviewHtml(panel.webview, html, distWebviewUri);
  // No await on the handshake: the tab is already open, and the ready handler above
  // drives init + first refresh whenever the webview finishes booting.
}

function quotaInitMessage(
  deps: QuotaPanelDeps,
  focusProvider: QuotaProviderId | undefined,
): { type: "quotaInit"; payload: QuotaInitPayload } {
  const payload: QuotaInitPayload = { snapshot: deps.statusBar.getSnapshot() };
  if (focusProvider !== undefined) {
    payload.focusProvider = focusProvider;
  }
  return { type: "quotaInit", payload };
}

type ParsedMessage =
  | { kind: "ready" }
  | { kind: "pong" }
  | { kind: "refresh"; providerId?: QuotaProviderId }
  | { kind: "saveCookie"; cookie: string };

/**
 * Validate an incoming webview message against the protocol shape. Returns
 * undefined for anything unrecognized (module-private, same contract as the
 * preset editor host).
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
    default:
      return undefined;
  }
}
