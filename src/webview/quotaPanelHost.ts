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

/** Register the quota panel entry commands (status-bar click + MiMo config shortcut). */
export function registerQuotaPanel(ctx: vscode.ExtensionContext, deps: QuotaPanelDeps): void {
  ctx.subscriptions.push(
    // Handlers return the open promise (like editPreset): a command invocation resolves
    // only once the webview finished its ready handshake.
    vscode.commands.registerCommand(CMD.quotaRefresh, () => openQuotaPanel(ctx, deps)),
    vscode.commands.registerCommand(CMD.quotaConfigureMimo, () => openQuotaPanel(ctx, deps, { focusProvider: "mimo" })),
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

export async function openQuotaPanel(
  ctx: vscode.ExtensionContext,
  deps: QuotaPanelDeps,
  options: OpenQuotaPanelOptions = {},
): Promise<void> {
  // A reveal while the webview is still booting must buffer the focus into the
  // pending ready handler — posting before ready would silently drop the message.
  if (openPanel) {
    openPanel.reveal();
    if (options.focusProvider !== undefined) {
      openPanelFocus = options.focusProvider;
      // Re-init is idempotent on the page side; carrying focusProvider re-targets the group.
      if (openPanelReady) {
        void openPanel.webview.postMessage(quotaInitMessage(deps, options.focusProvider));
      }
    }
    return;
  }

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

  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  let readySettled = false;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    const settle = (fn: () => void): void => {
      if (readySettled) {
        return;
      }
      readySettled = true;
      if (readyTimer !== undefined) {
        clearTimeout(readyTimer);
      }
      fn();
    };
    resolveReady = () => settle(resolve);
    rejectReady = (error: Error) => settle(() => reject(error));
  });
  // Timeout disposes the blank panel and clears the singleton (via onDidDispose):
  // a webview that never booted must not squat on openPanel — later clicks would
  // only reveal a dead tab forever. The user can simply click again to retry.
  readyTimer = setTimeout(() => {
    // settle() clears this timer, so firing here means the promise was unsettled —
    // rejectReady settles it and the dispose below reaches the cleanup path.
    rejectReady(new Error("额度面板初始化超时"));
    panel.dispose();
  }, 20_000);

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
        post(quotaInitMessage(deps, openPanelFocus));
        resolveReady();
        // Fresh data right after boot: the snapshot event subscription below forwards
        // the cycle result to the page without the user clicking anything.
        void runFullRefresh();
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
    listener.dispose();
    snapshotSubscription.dispose();
    if (openPanel === panel) {
      openPanel = undefined;
      openPanelReady = false;
      openPanelFocus = undefined;
    }
    resolveReady();
  });

  panel.webview.html = buildWebviewHtml(panel.webview, html, distWebviewUri);
  await ready;
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
  { kind: "ready" } | { kind: "refresh"; providerId?: QuotaProviderId } | { kind: "saveCookie"; cookie: string };

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
