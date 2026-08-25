import * as vscode from "vscode";

import { CMD, SETTINGS_PANEL_VIEW_TYPE } from "../constants";
import { errorMessage } from "../core/errors";
import type { AutoRefreshSettings, AutoRefreshSettingsSource } from "../shared/protocol";
import { normalizeAutoRefreshSettings } from "../shared/protocol";
import { buildWebviewHtml, readWebviewHtml } from "./panelHtml";

export interface SettingsPanelDeps {
  readSettings(): AutoRefreshSettings;
  saveSettings(settings: AutoRefreshSettings): Promise<void>;
  log(message: string): void;
}

// Singleton panel: the settings page is unique (same lifecycle as the quota panel).
let openPanel: vscode.WebviewPanel | undefined;
let openPanelReady = false;

/**
 * Saves received from the page currently in flight. While >0, the extension's
 * config-change listener must NOT push settingsInit back: those events are the
 * echo of our own writes, and mid-flight they carry PARTIAL state — adopting
 * them would visibly revert edits the user just made (rapid toggles included).
 * External changes (Settings UI, hand edits) only get pushed once saves settle;
 * the page normalizes before sending, so the post-settle echo is a no-op.
 */
let pendingSaves = 0;

/** Register the settings page entry command (tree-view gear button + command palette). */
export function registerSettingsPanel(ctx: vscode.ExtensionContext, deps: SettingsPanelDeps): void {
  // Same contract as commands.ts run(): a ready-timeout rejection must surface as a
  // Chinese message instead of escaping to the command system's English error log.
  const openSafely = (): Promise<void> =>
    openSettingsPanel(ctx, deps).catch((error: unknown) => {
      const message = errorMessage(error);
      deps.log(`settingsPanel: 打开设置失败: ${message}`);
      void vscode.window.showErrorMessage(`打开设置失败: ${message}`);
    });
  ctx.subscriptions.push(vscode.commands.registerCommand(CMD.openSettings, openSafely));
}

/**
 * Test-only bridge for e2e: post a raw protocol message into the open settings panel.
 * Returns false when no panel is open (mirror of postMessageToQuotaPanel).
 */
export function postMessageToSettingsPanel(message: unknown): boolean {
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
export function pushSettingsToOpenPanel(readSettings: () => AutoRefreshSettings): void {
  if (openPanel === undefined || !openPanelReady || pendingSaves > 0) {
    return;
  }
  void openPanel.webview.postMessage({ type: "settingsInit", payload: { settings: readSettings() } });
}

export async function openSettingsPanel(ctx: vscode.ExtensionContext, deps: SettingsPanelDeps): Promise<void> {
  if (openPanel) {
    openPanel.reveal();
    return;
  }

  const html = readWebviewHtml(ctx, "settings.html", deps.log);
  if (html === undefined) {
    void vscode.window.showErrorMessage(
      "设置前端资源缺失（dist-webview/settings.html），请先运行 npm run build:webview",
    );
    return;
  }

  const distWebviewUri = vscode.Uri.joinPath(ctx.extensionUri, "dist-webview");
  const panel = vscode.window.createWebviewPanel(SETTINGS_PANEL_VIEW_TYPE, "设置", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [distWebviewUri],
  });
  openPanel = panel;
  openPanelReady = false;
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
  // Timeout disposes the blank panel and clears the singleton (same recovery as the
  // quota panel): a webview that never booted must not squat on openPanel forever.
  readyTimer = setTimeout(() => {
    rejectReady(new Error("设置面板初始化超时"));
    panel.dispose();
  }, 20_000);

  const post = (message: unknown): void => {
    void panel.webview.postMessage(message);
  };

  // Serialized save pipeline: overlapping settingsSave messages (rapid toggles) must
  // not interleave their config.update batches — each link runs after the previous
  // write settled (each save carries the FULL form, so ordering is last-write-wins).
  let saveChain: Promise<void> = Promise.resolve();

  const listener = panel.webview.onDidReceiveMessage((raw: unknown) => {
    const message = parseMessage(raw);
    if (message === undefined) {
      deps.log(`settingsPanel: 忽略无法识别的 webview 消息: ${JSON.stringify(raw) ?? String(raw)}`);
      return;
    }
    switch (message.kind) {
      case "ready":
        openPanelReady = true;
        post({ type: "settingsInit", payload: { settings: deps.readSettings() } });
        resolveReady();
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
              // Failed saves leave page state diverged from persisted state (echo
              // suppression blocks the listener's settingsInit) — push the truth back.
              if (!saved.payload.ok) {
                post({ type: "settingsInit", payload: { settings: deps.readSettings() } });
              }
            }
          })
          .catch(() => undefined)
          .finally(() => {
            pendingSaves -= 1;
          });
        break;
    }
  });

  panel.onDidDispose(() => {
    listener.dispose();
    if (openPanel === panel) {
      openPanel = undefined;
      openPanelReady = false;
    }
    resolveReady();
  });

  panel.webview.html = buildWebviewHtml(panel.webview, html, distWebviewUri);
  await ready;
}

/**
 * Persist a normalized save and produce the settingsSaved reply message; failures
 * degrade to the !ok shape with the friendly Chinese error instead of throwing
 * into the message-pump callback.
 */
async function normalizeAndSave(
  deps: SettingsPanelDeps,
  source: AutoRefreshSettingsSource,
): Promise<{ type: "settingsSaved"; payload: { ok: boolean; error?: string } }> {
  const settings = normalizeAutoRefreshSettings(source);
  try {
    await deps.saveSettings(settings);
    deps.log("settings: 已保存自动刷新设置");
    return { type: "settingsSaved", payload: { ok: true } };
  } catch (error) {
    const message = errorMessage(error);
    deps.log(`settingsPanel: 保存设置失败: ${message}`);
    return { type: "settingsSaved", payload: { ok: false, error: message } };
  }
}

type ParsedMessage = { kind: "ready" } | { kind: "save"; source: AutoRefreshSettingsSource };

/**
 * Validate an incoming webview message against the protocol shape. Returns
 * undefined for anything unrecognized (module-private, same contract as the
 * quota panel host); the payload VALUES are validated by normalizeAutoRefreshSettings.
 */
function parseMessage(raw: unknown): ParsedMessage | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const msg = raw as Record<string, unknown>;
  switch (msg.type) {
    case "ready":
      return { kind: "ready" };
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
