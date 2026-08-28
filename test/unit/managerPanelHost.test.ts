import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { QuotaService } from "../../src/core/quotaService";
import { defaultQuotaVisibility, normalizeAutoRefreshSettings } from "../../src/shared/protocol";
import type { AutoRefreshSettings, QuotaSnapshot, QuotaVisibility } from "../../src/shared/protocol";
import type { QuotaStatusBar } from "../../src/ui/quotaStatusBar";
import { openManagerPanel } from "../../src/webview/managerPanelHost";
import type { ManagerPanelDeps } from "../../src/webview/managerPanelHost";
import type { PresetEditorSession } from "../../src/webview/presetEditorHost";

// VSCode is not available under vitest — mock exactly the surface the panel host uses
// (same pattern as tree.test.ts). createWebviewPanel hands out scriptable fake panels.
vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  Uri: { joinPath: vi.fn(() => ({})) },
  ViewColumn: { Active: 1 },
  commands: { registerCommand: vi.fn(() => ({ dispose: () => undefined })) },
}));

// The panel host only needs readWebviewHtml to succeed; serving a static document keeps
// the test free of dist-webview build state and of real webview URI plumbing.
vi.mock("../../src/webview/panelHtml", () => ({
  readWebviewHtml: () => "<html>manager</html>",
  buildWebviewHtml: (_webview: unknown, html: string) => html,
}));

/** Minimal disposable matching how the host uses vscode subscription handles. */
interface FakeDisposable {
  dispose(): void;
}

interface FakePanel {
  disposed: boolean;
  revealed: number;
  visible: boolean;
  webview: {
    html: string;
    postMessage: (message: unknown) => Promise<boolean>;
    onDidReceiveMessage: (callback: (raw: unknown) => void) => FakeDisposable;
  };
  /** Deliver a raw message as if the webview page sent it. */
  receive: (raw: unknown) => void;
  onDidDispose: (callback: () => void) => FakeDisposable;
  onDidChangeViewState: (callback: (event: { webviewPanel: FakePanel }) => void) => FakeDisposable;
  reveal: () => void;
  dispose: () => void;
}

/** Scriptable WebviewPanel double; dispose fires its listeners once, synchronously (as VSCode does). */
function makePanel(): FakePanel {
  let receiveCallback: ((raw: unknown) => void) | undefined;
  const disposeListeners: Array<() => void> = [];
  const panel: FakePanel = {
    disposed: false,
    revealed: 0,
    visible: true,
    webview: {
      html: "",
      postMessage: () => Promise.resolve(true),
      onDidReceiveMessage: (callback) => {
        receiveCallback = callback;
        return { dispose: () => undefined };
      },
    },
    receive: (raw: unknown) => {
      receiveCallback?.(raw);
    },
    onDidDispose: (callback) => {
      disposeListeners.push(callback);
      return { dispose: () => undefined };
    },
    onDidChangeViewState: () => ({ dispose: () => undefined }),
    reveal: () => {
      panel.revealed += 1;
    },
    dispose: () => {
      if (panel.disposed) {
        return;
      }
      panel.disposed = true;
      for (const listener of disposeListeners.splice(0)) {
        listener();
      }
    },
  };
  return panel;
}

function makeDeps(): { deps: ManagerPanelDeps; logs: string[] } {
  const logs: string[] = [];
  const statusBar: QuotaStatusBar = {
    refresh: () => Promise.resolve(),
    getSnapshot: (): QuotaSnapshot | null => null,
    getVisibility: (): QuotaVisibility => defaultQuotaVisibility(),
    setVisibility: () => undefined,
    setPanelVisible: () => undefined,
    refreshProvider: () => Promise.resolve(null),
    onSnapshot: () => ({ dispose: () => undefined }),
    dispose: () => undefined,
  };
  // Throwing session stubs: none of these paths run in the zombie-recreate tests, and
  // a throw fails loudly if a regression ever drags them in.
  const preset: PresetEditorSession = {
    begin: () => {
      throw new Error("unexpected preset.begin in managerPanelHost tests");
    },
    save: () => {
      throw new Error("unexpected preset.save in managerPanelHost tests");
    },
    noteDirty: () => undefined,
    cancel: () => undefined,
  };
  const deps: ManagerPanelDeps = {
    quotaService: new QuotaService(),
    statusBar,
    readSettings: (): AutoRefreshSettings => normalizeAutoRefreshSettings({}),
    saveSettings: () => Promise.resolve(),
    preset,
    listPresets: () => [],
    log: (message) => {
      logs.push(message);
    },
  };
  return { deps, logs };
}

// Minimal structural fake: the panel host only touches subscriptions and extensionUri.
const ctx = { subscriptions: [] as FakeDisposable[] } as unknown as vscode.ExtensionContext;

const createdPanels: FakePanel[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  createdPanels.length = 0;
  vi.mocked(vscode.window.createWebviewPanel).mockImplementation(() => {
    const panel = makePanel();
    createdPanels.push(panel);
    // Narrow double→WebviewPanel bridge: the fake implements the members the host uses;
    // the real type's extra readonly fields are irrelevant under the mock.
    return panel as unknown as vscode.WebviewPanel;
  });
});

afterEach(() => {
  // Disposing every created panel resets the module-level singleton (onDidDispose
  // identity guard) so tests stay order-independent; clear fake timers after.
  for (const panel of createdPanels) {
    panel.dispose();
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.mocked(vscode.window.createWebviewPanel).mockReset();
});

describe("openManagerPanel zombie-boot recreate", () => {
  it("buffers the navigation while the panel is still booting (within 20s)", async () => {
    const { deps } = makeDeps();
    await openManagerPanel(ctx, deps, { tab: "settings" });
    vi.setSystemTime(Date.now() + 19_999);
    await openManagerPanel(ctx, deps, { tab: "quota" });
    expect(createdPanels.length).toBe(1);
    expect(createdPanels[0].disposed).toBe(false);
    expect(createdPanels[0].revealed).toBe(1); // second click revealed the booting panel, no recreate
  });

  it("recreates a panel that never finished booting after 20s", async () => {
    const { deps, logs } = makeDeps();
    await openManagerPanel(ctx, deps, { tab: "quota" });
    expect(createdPanels.length).toBe(1);
    vi.setSystemTime(Date.now() + 20_001);
    await openManagerPanel(ctx, deps, { tab: "quota" });
    expect(createdPanels.length).toBe(2);
    expect(createdPanels[0].disposed).toBe(true);
    expect(logs.some((line) => line.includes("面板长时间未完成初始化，已重建管理面板"))).toBe(true);
  });

  it("does not recreate a panel that already booted once", async () => {
    const { deps } = makeDeps();
    await openManagerPanel(ctx, deps, { tab: "quota" });
    createdPanels[0].receive({ type: "ready" });
    vi.setSystemTime(Date.now() + 60_000);
    await openManagerPanel(ctx, deps, { tab: "quota" });
    expect(createdPanels.length).toBe(1);
    expect(createdPanels[0].disposed).toBe(false);
  });
});
