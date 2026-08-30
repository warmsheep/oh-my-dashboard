import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import { ConfigStore } from "../../src/core/configStore";
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
  /** Every host→webview message posted while the panel existed. */
  posted: unknown[];
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
    posted: [],
    webview: {
      html: "",
      postMessage: (message: unknown) => {
        panel.posted.push(message);
        return Promise.resolve(true);
      },
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

const configSandboxes: string[] = [];

/**
 * Real ConfigStore on a throwaway sandbox (hermetic homeDir: no ~/.omo, so the
 * write target is the seeded legacy file). Returns the sandbox root — tests read
 * <root>/oh-my-opencode.json to assert what the pump actually wrote.
 */
function sandboxConfigStore(seedLegacy: boolean): { store: ConfigStore; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mgrpanel-"));
  configSandboxes.push(root);
  if (seedLegacy) {
    fs.writeFileSync(path.join(root, "oh-my-opencode.json"), '{\n  "agents": {},\n  "categories": {}\n}\n');
  }
  return { store: new ConfigStore({ configDirOverride: root, homeDir: path.join(root, "home"), env: {} }), root };
}

function makeDeps(seedLegacy = true): { deps: ManagerPanelDeps; logs: string[]; refreshes: number[]; root: string } {
  const logs: string[] = [];
  const refreshes: number[] = [];
  const { store, root } = sandboxConfigStore(seedLegacy);
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
  // Throwing session stubs: none of these paths run in the panel-host tests, and
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
    configStore: store,
    listSkills: () => [],
    refreshAll: () => {
      refreshes.push(1);
    },
    log: (message) => {
      logs.push(message);
    },
  };
  return { deps, logs, refreshes, root };
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
  for (const dir of configSandboxes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
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

describe("manager panel 配置 tab protocol", () => {
  /** Open a booted panel on the settings tab; returns it for message delivery. */
  async function bootedPanel(deps: ManagerPanelDeps): Promise<FakePanel> {
    await openManagerPanel(ctx, deps, { tab: "settings" });
    const panel = createdPanels[0];
    panel.receive({ type: "ready" });
    return panel;
  }

  function configInits(panel: FakePanel): unknown[] {
    return panel.posted.filter((message) => (message as { type?: string }).type === "configInit");
  }

  it("ready pushes a configInit carrying live rows, models, skills and the write target", async () => {
    const { deps } = makeDeps();
    deps.listSkills = () => [
      { name: "demo", description: "演示技能", scope: "global", locationLabel: "~/.agents/skills" },
    ];
    const panel = await bootedPanel(deps);
    const inits = configInits(panel);
    expect(inits.length).toBe(1);
    const payload = (
      inits[0] as { payload: { rows: unknown[]; models: unknown[]; skills: unknown[]; target: unknown } }
    ).payload;
    // Live rows: every known agent/category is present (union with the empty live config).
    expect(payload.rows.length).toBeGreaterThanOrEqual(11 + 13);
    expect(payload.rows).toContainEqual({ section: "agents", name: "hephaestus", model: null, variant: null });
    expect(payload.skills).toEqual([
      { name: "demo", description: "演示技能", scope: "global", locationLabel: "~/.agents/skills" },
    ]);
    expect(payload.target).toEqual({
      kind: "legacy",
      path: path.join(deps.configStore.configDir, "oh-my-opencode.json"),
    });
  });

  it("navigating an open booted panel to the config tab pushes managerNavigate + configInit", async () => {
    const { deps } = makeDeps();
    const panel = await bootedPanel(deps);
    const before = panel.posted.length;
    await openManagerPanel(ctx, deps, { tab: "config" });
    const slice = panel.posted.slice(before);
    expect(slice).toContainEqual({ type: "managerNavigate", payload: { tab: "config" } });
    expect(slice.filter((message) => (message as { type?: string }).type === "configInit").length).toBe(1);
  });

  it("configSetModel writes through, replies ok, re-pushes configInit and refreshes", async () => {
    const { deps, refreshes, root } = makeDeps();
    const panel = await bootedPanel(deps);
    panel.receive({
      type: "configSetModel",
      payload: { section: "agents", name: "hephaestus", model: "zhipuai/glm-4.7", variant: "high" },
    });
    expect(panel.posted).toContainEqual({
      type: "configModelSaved",
      payload: { ok: true, section: "agents", name: "hephaestus" },
    });
    // The refreshed configInit carries the just-written assignment.
    const inits = configInits(panel);
    expect(inits.length).toBe(2);
    const refreshed = (
      inits[1] as {
        payload: { rows: { section: string; name: string; model: string | null; variant: string | null }[] };
      }
    ).payload;
    expect(refreshed.rows).toContainEqual({
      section: "agents",
      name: "hephaestus",
      model: "zhipuai/glm-4.7",
      variant: "high",
    });
    expect(refreshes.length).toBe(1);
    const written = JSON.parse(fs.readFileSync(path.join(root, "oh-my-opencode.json"), "utf8")) as {
      agents: Record<string, { model: string; variant?: string }>;
    };
    expect(written.agents.hephaestus).toEqual({ model: "zhipuai/glm-4.7", variant: "high" });
  });

  it("malformed configSetModel payloads get a !ok reply and write nothing", async () => {
    const { deps, root } = makeDeps();
    const panel = await bootedPanel(deps);
    const bytesBefore = fs.readFileSync(path.join(root, "oh-my-opencode.json"));
    for (const payload of [
      { section: "bogus", name: "hephaestus", model: "zhipuai/glm-4.7", variant: "high" },
      { section: "agents", name: "", model: "zhipuai/glm-4.7", variant: null },
      { section: "agents", name: "hephaestus", model: "not-a-model-id", variant: null },
      { section: "agents", name: "hephaestus", model: "zhipuai/glm-4.7", variant: "x".repeat(33) },
    ]) {
      panel.receive({ type: "configSetModel", payload });
    }
    const replies = panel.posted.filter((message) => (message as { type?: string }).type === "configModelSaved");
    expect(replies.length).toBe(4);
    for (const reply of replies) {
      const payload = (reply as { payload: { ok: boolean; error?: string } }).payload;
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe("配置请求格式无法识别");
    }
    // The bogus-section rejection echoes the parseable name with the fallback section.
    expect(replies[0]).toEqual({
      type: "configModelSaved",
      payload: { ok: false, section: "agents", name: "hephaestus", error: "配置请求格式无法识别" },
    });
    // Unparseable name echoes "".
    expect(replies[1]).toEqual({
      type: "configModelSaved",
      payload: { ok: false, section: "agents", name: "", error: "配置请求格式无法识别" },
    });
    expect(fs.readFileSync(path.join(root, "oh-my-opencode.json")).equals(bytesBefore)).toBe(true);
  });

  it("a write failure (broken JSONC target) replies !ok with the friendly error, no re-push", async () => {
    const { deps, root } = makeDeps();
    fs.writeFileSync(path.join(root, "oh-my-opencode.json"), "{,}\n");
    const panel = await bootedPanel(deps);
    const initsBefore = configInits(panel).length;
    panel.receive({
      type: "configSetModel",
      payload: { section: "categories", name: "quick", model: "zhipuai/glm-4.7", variant: null },
    });
    const replies = panel.posted.filter((message) => (message as { type?: string }).type === "configModelSaved");
    expect(replies.length).toBe(1);
    const payload = (replies[0] as { payload: { ok: boolean; error?: string } }).payload;
    expect(payload.ok).toBe(false);
    expect(typeof payload.error === "string" && payload.error.length > 0).toBe(true);
    expect(configInits(panel).length).toBe(initsBefore);
    expect(fs.readFileSync(path.join(root, "oh-my-opencode.json"), "utf8")).toBe("{,}\n");
  });
});

describe("manager panel OpenCode/OMO 设置 protocol", () => {
  /** Open a booted panel on the settings tab; returns it for message delivery. */
  async function bootedPanel(deps: ManagerPanelDeps): Promise<FakePanel> {
    await openManagerPanel(ctx, deps, { tab: "settings" });
    const panel = createdPanels[0];
    panel.receive({ type: "ready" });
    return panel;
  }

  function messagesOfType(panel: FakePanel, type: string): unknown[] {
    return panel.posted.filter((message) => (message as { type?: string }).type === type);
  }

  it("ready pushes an opencodeInit with values, configPath and models", async () => {
    const { deps, root } = makeDeps();
    fs.writeFileSync(path.join(root, "opencode.json"), JSON.stringify({ share: "auto", model: "zhipuai/glm-5" }));
    const panel = await bootedPanel(deps);
    const inits = messagesOfType(panel, "opencodeInit");
    expect(inits.length).toBe(1);
    const payload = (
      inits[0] as { payload: { values: Record<string, unknown>; configPath: string; models: unknown[] } }
    ).payload;
    expect(payload.values.share).toBe("auto");
    expect(payload.values.model).toBe("zhipuai/glm-5");
    expect(payload.values.snapshot).toBeNull();
    expect(payload.configPath).toBe(path.join(root, "opencode.json"));
    expect(Array.isArray(payload.models)).toBe(true);
  });

  it("navigating an open booted panel to the opencode tab pushes managerNavigate + opencodeInit; skills tab pushes configInit", async () => {
    const { deps } = makeDeps();
    const panel = await bootedPanel(deps);
    let before = panel.posted.length;
    await openManagerPanel(ctx, deps, { tab: "opencode" });
    expect(panel.posted.slice(before)).toContainEqual({ type: "managerNavigate", payload: { tab: "opencode" } });
    expect(panel.posted.slice(before).filter((m) => (m as { type?: string }).type === "opencodeInit").length).toBe(1);

    before = panel.posted.length;
    await openManagerPanel(ctx, deps, { tab: "skills" });
    expect(panel.posted.slice(before)).toContainEqual({ type: "managerNavigate", payload: { tab: "skills" } });
    expect(panel.posted.slice(before).filter((m) => (m as { type?: string }).type === "configInit").length).toBe(1);
  });

  it("opencodeSetSetting writes through, replies ok, re-pushes opencodeInit and refreshes", async () => {
    const { deps, refreshes, root } = makeDeps();
    const panel = await bootedPanel(deps);
    const before = panel.posted.length;
    panel.receive({ type: "opencodeSetSetting", payload: { key: "share", value: "auto" } });
    expect(panel.posted).toContainEqual({ type: "opencodeSettingSaved", payload: { ok: true, key: "share" } });
    expect(panel.posted.slice(before).filter((m) => (m as { type?: string }).type === "opencodeInit").length).toBe(1);
    expect(refreshes.length).toBe(1);
    const written = JSON.parse(fs.readFileSync(path.join(root, "opencode.json"), "utf8")) as { share: string };
    expect(written.share).toBe("auto");
  });

  it("omoSetSetting writes through, replies ok, re-pushes configInit with fresh omo values and refreshes", async () => {
    const { deps, refreshes, root } = makeDeps();
    const panel = await bootedPanel(deps);
    const initsBefore = messagesOfType(panel, "configInit").length;
    panel.receive({ type: "omoSetSetting", payload: { key: "teamMode", value: true } });
    expect(panel.posted).toContainEqual({ type: "omoSettingSaved", payload: { ok: true, key: "teamMode" } });
    const inits = messagesOfType(panel, "configInit");
    expect(inits.length).toBe(initsBefore + 1);
    const omo = (inits[inits.length - 1] as { payload: { omo: Record<string, unknown> } }).payload.omo;
    expect(omo.teamMode).toBe(true);
    expect(refreshes.length).toBe(1);
    const written = JSON.parse(fs.readFileSync(path.join(root, "oh-my-opencode.json"), "utf8")) as {
      team_mode?: { enabled?: boolean };
    };
    expect(written.team_mode?.enabled).toBe(true);
  });

  it("typed-but-invalid payloads get !ok replies with the key echo and write nothing", async () => {
    const { deps, root } = makeDeps();
    const panel = await bootedPanel(deps);
    const opencodeExisted = fs.existsSync(path.join(root, "opencode.json"));
    const bytesBefore = fs.readFileSync(path.join(root, "oh-my-opencode.json"));
    panel.receive({ type: "opencodeSetSetting", payload: { key: "bogus", value: "x" } });
    panel.receive({ type: "opencodeSetSetting", payload: { key: "share", value: "garbage" } });
    panel.receive({ type: "opencodeSetSetting", payload: { key: "share" } });
    panel.receive({ type: "opencodeSetSetting", payload: { key: 42, value: "auto" } });
    panel.receive({ type: "omoSetSetting", payload: { key: "nope", value: true } });
    panel.receive({ type: "omoSetSetting", payload: { key: "teamMode", value: "yes" } });
    const replies = panel.posted.filter((message) => {
      const type = (message as { type?: string }).type;
      return type === "opencodeSettingSaved" || type === "omoSettingSaved";
    });
    expect(replies.length).toBe(6);
    for (const reply of replies) {
      const payload = (reply as { payload: { ok: boolean; key: string; error?: string } }).payload;
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe("设置请求格式无法识别");
    }
    // Echo: parseable string keys echo verbatim; anything else falls back to "".
    expect(replies[0]).toEqual({
      type: "opencodeSettingSaved",
      payload: { ok: false, key: "bogus", error: "设置请求格式无法识别" },
    });
    expect(replies[2]).toEqual({
      type: "opencodeSettingSaved",
      payload: { ok: false, key: "share", error: "设置请求格式无法识别" },
    });
    expect(replies[3]).toEqual({
      type: "opencodeSettingSaved",
      payload: { ok: false, key: "", error: "设置请求格式无法识别" },
    });
    expect(fs.existsSync(path.join(root, "opencode.json"))).toBe(opencodeExisted);
    expect(fs.readFileSync(path.join(root, "oh-my-opencode.json")).equals(bytesBefore)).toBe(true);
  });

  it("a write failure (broken opencode.json) replies !ok with the friendly error, no re-push", async () => {
    const { deps, root } = makeDeps();
    fs.writeFileSync(path.join(root, "opencode.json"), "{,}\n");
    const panel = await bootedPanel(deps);
    const initsBefore = messagesOfType(panel, "opencodeInit").length;
    panel.receive({ type: "opencodeSetSetting", payload: { key: "share", value: "auto" } });
    const replies = messagesOfType(panel, "opencodeSettingSaved");
    expect(replies.length).toBe(1);
    const payload = (replies[0] as { payload: { ok: boolean; key: string; error?: string } }).payload;
    expect(payload.ok).toBe(false);
    expect(payload.key).toBe("share");
    expect(typeof payload.error === "string" && payload.error.length > 0).toBe(true);
    expect(messagesOfType(panel, "opencodeInit").length).toBe(initsBefore);
    expect(fs.readFileSync(path.join(root, "opencode.json"), "utf8")).toBe("{,}\n");
  });

  it("ready pushes an opencodeInit carrying the permission/mcp/tui aggregate fields", async () => {
    const { deps, root } = makeDeps();
    fs.writeFileSync(
      path.join(root, "opencode.json"),
      JSON.stringify({
        permission: { bash: "deny", webfetch: { "https://*": "allow" } },
        mcp: { github: { enabled: false }, filesystem: { command: "npx" } },
      }),
    );
    fs.writeFileSync(path.join(root, "tui.json"), JSON.stringify({ theme: "catppuccin" }));
    const panel = await bootedPanel(deps);
    const inits = messagesOfType(panel, "opencodeInit");
    const payload = (
      inits[0] as {
        payload: {
          permission: { shorthand: unknown; tools: unknown; advancedTools: unknown };
          mcp: unknown;
          tui: { theme: unknown; path: string };
        };
      }
    ).payload;
    expect(payload.permission).toEqual({ shorthand: null, tools: { bash: "deny" }, advancedTools: ["webfetch"] });
    expect(payload.mcp).toEqual([
      { name: "github", disabled: true },
      { name: "filesystem", disabled: false },
    ]);
    expect(payload.tui).toEqual({ theme: "catppuccin", path: path.join(root, "tui.json") });
  });

  it("opencodeSetSetting writes the new kinds through and re-pushes a fresh opencodeInit", async () => {
    const { deps, root } = makeDeps();
    fs.writeFileSync(path.join(root, "opencode.json"), "{}\n");
    const panel = await bootedPanel(deps);
    panel.receive({ type: "opencodeSetSetting", payload: { key: "instructions", value: [".cursor/rules"] } });
    panel.receive({
      type: "opencodeSetSetting",
      payload: { key: "compaction", value: { auto: false, tail_turns: 5 } },
    });
    panel.receive({ type: "opencodeSetSetting", payload: { key: "permissionTools", value: { bash: "ask" } } });
    panel.receive({ type: "opencodeSetSetting", payload: { key: "mcpServers", value: { github: true } } });
    panel.receive({ type: "opencodeSetSetting", payload: { key: "agentBuildTemperature", value: 0.7 } });

    const replies = messagesOfType(panel, "opencodeSettingSaved");
    expect(replies.map((reply) => (reply as { payload: { key: string } }).payload.key)).toEqual([
      "instructions",
      "compaction",
      "permissionTools",
      "mcpServers",
      "agentBuildTemperature",
    ]);
    for (const reply of replies) {
      expect((reply as { payload: { ok: boolean } }).payload.ok).toBe(true);
    }
    const written = JSON.parse(fs.readFileSync(path.join(root, "opencode.json"), "utf8"));
    expect(written.instructions).toEqual([".cursor/rules"]);
    expect(written.compaction).toEqual({ auto: false, tail_turns: 5 });
    expect(written.permission).toEqual({ bash: "ask" });
    expect(written.mcp.github).toEqual({ enabled: false });
    expect(written.agent).toEqual({ build: { temperature: 0.7 } });
    // The last re-pushed payload reflects the fresh aggregate state.
    const inits = messagesOfType(panel, "opencodeInit");
    const last = (inits[inits.length - 1] as { payload: { permission: unknown; mcp: unknown } }).payload;
    expect(last.permission).toEqual({ shorthand: null, tools: { bash: "ask" }, advancedTools: [] });
    expect(last.mcp).toEqual([{ name: "github", disabled: true }]);
  });

  it("invalid new-kind values get the !ok backstop with the key echo and write nothing", async () => {
    const { deps, root } = makeDeps();
    fs.writeFileSync(path.join(root, "opencode.json"), "{}\n");
    const panel = await bootedPanel(deps);
    const bytesBefore = fs.readFileSync(path.join(root, "opencode.json"));
    panel.receive({
      type: "opencodeSetSetting",
      payload: { key: "instructions", value: Array.from({ length: 17 }, (_, i) => `rule-${i}`) },
    });
    panel.receive({ type: "opencodeSetSetting", payload: { key: "compaction", value: { tail_turns: 101 } } });
    panel.receive({ type: "opencodeSetSetting", payload: { key: "permissionTools", value: { made_up: "ask" } } });
    panel.receive({ type: "opencodeSetSetting", payload: { key: "mcpServers", value: { "bad name!": true } } });
    panel.receive({ type: "opencodeSetSetting", payload: { key: "agentBuildTemperature", value: 2.5 } });

    const replies = messagesOfType(panel, "opencodeSettingSaved");
    expect(replies.length).toBe(5);
    for (const reply of replies) {
      expect(reply).toEqual({
        type: "opencodeSettingSaved",
        payload: { ok: false, key: expect.any(String), error: "设置请求格式无法识别" },
      });
    }
    expect((replies[0] as { payload: { key: string } }).payload.key).toBe("instructions");
    expect(fs.readFileSync(path.join(root, "opencode.json")).equals(bytesBefore)).toBe(true);
  });

  it("compaction null-leaf commit passes the kind validator and writes per-leaf edits", async () => {
    const { deps, root } = makeDeps();
    fs.writeFileSync(path.join(root, "opencode.json"), '{ "compaction": { "auto": true, "custom": "keep" } }\n');
    const panel = await bootedPanel(deps);

    panel.receive({
      type: "opencodeSetSetting",
      payload: { key: "compaction", value: { auto: false, tail_turns: null } },
    });

    expect(panel.posted).toContainEqual({ type: "opencodeSettingSaved", payload: { ok: true, key: "compaction" } });
    const written = JSON.parse(fs.readFileSync(path.join(root, "opencode.json"), "utf8"));
    expect(written.compaction).toEqual({ auto: false, custom: "keep" });
  });

  it("boot configInit carries omo values for the Wave-2 keys (fresh sandbox → nulls)", async () => {
    const { deps } = makeDeps();
    const panel = await bootedPanel(deps);
    const inits = messagesOfType(panel, "configInit");
    const omo = (inits[0] as { payload: { omo: Record<string, unknown> } }).payload.omo;
    expect(omo.disabledAgents).toBeNull();
    expect(omo.omoModels).toBeNull();
    expect(omo.runtimeFallbackParams).toBeNull();
    expect(omo.defaultMode).toBeNull();
    expect(omo.disableOmoEnv).toBeNull();
    expect(omo.aggressiveTruncation).toBeNull();
    expect(omo.truncateAllToolOutputs).toBeNull();
  });

  it("omoSetSetting writes the new kinds through and re-pushes configInit with fresh omo values", async () => {
    const { deps, root } = makeDeps();
    const panel = await bootedPanel(deps);
    panel.receive({ type: "omoSetSetting", payload: { key: "disabledAgents", value: ["oracle", "momus"] } });
    panel.receive({
      type: "omoSetSetting",
      payload: { key: "omoModels", value: { "kimi-max": { model: "moonshotai/kimi-k2", reasoning: "high" } } },
    });
    panel.receive({
      type: "omoSetSetting",
      payload: { key: "runtimeFallbackParams", value: { max_fallback_attempts: 5, cooldown_seconds: null } },
    });

    const replies = messagesOfType(panel, "omoSettingSaved");
    expect(replies.map((reply) => (reply as { payload: { key: string } }).payload.key)).toEqual([
      "disabledAgents",
      "omoModels",
      "runtimeFallbackParams",
    ]);
    for (const reply of replies) {
      expect((reply as { payload: { ok: boolean } }).payload.ok).toBe(true);
    }
    const written = JSON.parse(fs.readFileSync(path.join(root, "oh-my-opencode.json"), "utf8"));
    expect(written.disabled_agents).toEqual(["oracle", "momus"]);
    expect(written.models).toEqual({ "kimi-max": { model: "moonshotai/kimi-k2", reasoning: "high" } });
    expect(written.runtime_fallback).toEqual({ max_fallback_attempts: 5 });
    const inits = messagesOfType(panel, "configInit");
    const omo = (inits[inits.length - 1] as { payload: { omo: Record<string, unknown> } }).payload.omo;
    expect(omo.disabledAgents).toEqual(["oracle", "momus"]);
    expect(omo.omoModels).toEqual({ "kimi-max": { model: "moonshotai/kimi-k2", reasoning: "high" } });
    expect(omo.runtimeFallbackParams).toEqual({
      max_fallback_attempts: 5,
      cooldown_seconds: null,
      timeout_seconds: null,
      notify_on_fallback: null,
      restore_primary_after_cooldown: null,
    });
  });

  it("invalid new-kind omoSetSetting values get the !ok backstop with the key echo and write nothing", async () => {
    const { deps, root } = makeDeps();
    const panel = await bootedPanel(deps);
    const bytesBefore = fs.readFileSync(path.join(root, "oh-my-opencode.json"));
    panel.receive({ type: "omoSetSetting", payload: { key: "disabledAgents", value: ["not-an-agent"] } });
    panel.receive({ type: "omoSetSetting", payload: { key: "disabledAgents", value: ["oracle", "oracle"] } });
    panel.receive({
      type: "omoSetSetting",
      payload: { key: "omoModels", value: { a: { model: "no-slash-id", reasoning: null } } },
    });
    panel.receive({
      type: "omoSetSetting",
      payload: { key: "runtimeFallbackParams", value: { max_fallback_attempts: 21 } },
    });

    const replies = messagesOfType(panel, "omoSettingSaved");
    expect(replies.length).toBe(4);
    for (const reply of replies) {
      expect(reply).toEqual({
        type: "omoSettingSaved",
        payload: { ok: false, key: expect.any(String), error: "设置请求格式无法识别" },
      });
    }
    expect((replies[0] as { payload: { key: string } }).payload.key).toBe("disabledAgents");
    expect((replies[2] as { payload: { key: string } }).payload.key).toBe("omoModels");
    expect(fs.readFileSync(path.join(root, "oh-my-opencode.json")).equals(bytesBefore)).toBe(true);
  });

  it("tuiTheme writes round-trip into tui.json, re-push opencodeInit, and never create opencode.json", async () => {
    const { deps, refreshes, root } = makeDeps();
    const panel = await bootedPanel(deps);
    const before = panel.posted.length;
    panel.receive({ type: "opencodeSetSetting", payload: { key: "tuiTheme", value: "dracula" } });

    expect(panel.posted).toContainEqual({ type: "opencodeSettingSaved", payload: { ok: true, key: "tuiTheme" } });
    expect(panel.posted.slice(before).filter((m) => (m as { type?: string }).type === "opencodeInit").length).toBe(1);
    expect(refreshes.length).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(root, "tui.json"), "utf8"))).toEqual({ theme: "dracula" });
    expect(fs.existsSync(path.join(root, "opencode.json"))).toBe(false); // the tui face never touches opencode.json

    const inits = messagesOfType(panel, "opencodeInit");
    const tui = (inits[inits.length - 1] as { payload: { tui: { theme: string | null } } }).payload.tui;
    expect(tui.theme).toBe("dracula");
  });
});
