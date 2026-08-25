/**
 * OpenCode Config Manager — e2e suite.
 *
 * Loaded by VSCode (via @vscode/test-electron `--extensionTestsPath`); must
 * export `run()`. Runs in the SAME extension host as the extension under test.
 *
 * Isolation: XDG_CONFIG_HOME points at a seeded temp dir (set by
 * test/e2e/run.mjs); ConfigStore.resolveConfigDir resolves
 * $XDG_CONFIG_HOME/opencode. Test 0 asserts the full env mask (HOME /
 * XDG_DATA_HOME included) before anything else runs.
 *
 * Structure: a sequential smoke chain — later steps reuse artifacts created by
 * earlier ones (preset file, manual backup dir, imported backup dir, open
 * webview panel), so the shared state stays deterministic.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import * as vscode from "vscode";

import { CMD, TEST_BRIDGE } from "../../../src/constants";
import { BackupService } from "../../../src/core/backupService";
import { ConfigStore } from "../../../src/core/configStore";
import { validate } from "../../../src/core/jsoncEditor";
import { PresetService } from "../../../src/core/presetService";
import type { JsoncError, Preset } from "../../../src/core/types";
import { buildConfigTree, CURRENT_PRESET_BADGE } from "../../../src/tree/nodes";
import type { BaseNode } from "../../../src/tree/nodes";

const sleep = promisify(setTimeout);

const EXTENSION_ID = "local.opencode-config-manager"; // publisher.name from package.json
const PRESET_NAME = "e2e-preset";
/** Preset exercised through the webview save/apply protocol. */
const WV_PRESET = "e2e-webview";
const WV_PRESET_RENAMED = "e2e-webview-r";

/** Every command contributed in package.json (source of truth: src/constants.ts). */
const COMMAND_IDS: readonly string[] = Object.values(CMD);

interface TestCase {
  name: string;
  fn: () => Promise<void>;
}

let configDir = "";
let presetFile = "";
let manualBackupDirName = "";
let importedBackupDirName = "";

/**
 * Captured bridges for preset-editor panels opened earlier in the chain, keyed by
 * the panel's CURRENT name (kept in sync on rename-on-save / cancel).
 */
const heldBridges = new Map<string, PanelBridge>();

function assertNoJsoncErrors(file: string): void {
  assert.ok(fs.existsSync(file), `expected file to exist: ${file}`);
  const errors = validate(fs.readFileSync(file, "utf8"));
  assert.deepEqual(
    errors.map((error) => `${error.offset} ${error.message}`),
    [],
    `${path.basename(file)} must stay parseable JSONC`,
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Retry `check` every 100ms until true; the deterministic replacement for fixed sleeps. */
async function pollUntil(check: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`condition not met within ${ms}ms: ${label}`);
    }
    await sleep(100);
  }
}

/** pollUntil for value probes: retries until the probe returns a non-null value. */
async function pollFor<T>(probe: () => T | undefined | null, ms: number, label: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`value not available within ${ms}ms: ${label}`);
    }
    await sleep(100);
  }
}

/** Directory names under backups/ (staging dirs `.tmp-*` excluded). */
function backupDirNames(): string[] {
  const backupsDir = path.join(configDir, "backups");
  if (!fs.existsSync(backupsDir)) {
    return [];
  }
  return fs
    .readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".tmp-"))
    .map((entry) => entry.name);
}

function assertNoAutoBackups(): void {
  const auto = backupDirNames().filter((name) => /-(pre-apply|pre-save|pre-restore)$/.test(name));
  assert.deepEqual(auto, [], "no automatic pre-* backups may be created");
}

/** Read the current preset status-bar text via the ExtensionMode.Test bridge. */
function statusBarText(): Promise<string> {
  return Promise.resolve(vscode.commands.executeCommand(TEST_BRIDGE.statusBarText) as Thenable<string>);
}

// ---------------------------------------------------------------------------
// Window-API patches — the extension host shares ONE `vscode` API object with
// the test bundle, so temporarily replacing a window method intercepts the
// extension's own calls (proven by the showWarningMessage modal patches below).
// Every patch is scoped and restored by its caller.
// ---------------------------------------------------------------------------

interface WindowPatch {
  engaged(): boolean;
  restore(): void;
}

/**
 * Answer showWarningMessage calls — modal confirmations are unanswerable in a
 * headless run. `respond` receives (message, actionItems) and returns the chosen
 * action, or undefined to dismiss/cancel.
 */
function patchShowWarningMessage(respond: (message: string, actions: string[]) => string | undefined): WindowPatch {
  const windowApi = vscode.window as unknown as {
    showWarningMessage: (...args: unknown[]) => Thenable<string | undefined>;
  };
  const original = windowApi.showWarningMessage;
  let engaged = false;
  windowApi.showWarningMessage = (...args: unknown[]) => {
    engaged = true;
    const strings = args.filter((arg): arg is string => typeof arg === "string");
    const message = strings[0] ?? "";
    const actions = strings.length > 1 ? strings.slice(1) : [];
    return Promise.resolve(respond(message, actions));
  };
  return {
    engaged: () => engaged,
    restore(): void {
      windowApi.showWarningMessage = original;
    },
  };
}

/** Capture QuickPick items and answer with a fixed pick (undefined = cancel). */
function patchShowQuickPick(respond: (items: readonly unknown[]) => unknown): WindowPatch {
  const windowApi = vscode.window as unknown as {
    showQuickPick: (...args: unknown[]) => Thenable<unknown>;
  };
  const original = windowApi.showQuickPick;
  let engaged = false;
  windowApi.showQuickPick = (...args: unknown[]) => {
    engaged = true;
    return Promise.resolve(respond(Array.isArray(args[0]) ? args[0] : []));
  };
  return {
    engaged: () => engaged,
    restore(): void {
      windowApi.showQuickPick = original;
    },
  };
}

/**
 * Capture (not answer) showErrorMessage calls — non-modal, so a plain side-channel
 * recorder suffices; there is no headless hang to guard against. Restored by caller.
 */
function patchShowErrorMessage(): { messages: string[]; restore(): void } {
  const windowApi = vscode.window as unknown as {
    showErrorMessage: (...args: unknown[]) => Thenable<unknown>;
  };
  const original = windowApi.showErrorMessage;
  const messages: string[] = [];
  windowApi.showErrorMessage = (...args: unknown[]) => {
    const first = args.find((arg): arg is string => typeof arg === "string");
    if (first !== undefined) {
      messages.push(first);
    }
    return Promise.resolve(undefined);
  };
  return {
    messages,
    restore(): void {
      windowApi.showErrorMessage = original;
    },
  };
}

/**
 * Run a modal-guarded command with its showWarningMessage confirmation answered
 * (`confirm` false exercises the cancel path). The patch only answers messages
 * matching `match` — anything else dismisses, so unrelated warnings cannot be
 * mis-accepted. acceptDialog stays as the fallback when the API object is not
 * shared: wait briefly for the patch to engage, then fire it once.
 */
async function executeWithModal(
  commandId: string,
  arg: unknown,
  match: string,
  confirm: boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const patch = patchShowWarningMessage((message, actions) => {
    if (!message.includes(match)) {
      return undefined;
    }
    return confirm && actions.length > 0 ? actions[actions.length - 1] : undefined;
  });
  let engaged = false;
  try {
    const running = Promise.resolve(vscode.commands.executeCommand(commandId, arg));
    for (let i = 0; i < 10 && !patch.engaged(); i += 1) {
      await sleep(100);
    }
    engaged = patch.engaged();
    await vscode.commands.executeCommand("workbench.action.acceptDialog").then(
      () => undefined,
      () => undefined,
    );
    await withTimeout(running, timeoutMs, `${commandId} should resolve`);
  } finally {
    patch.restore();
  }
  assert.equal(engaged, true, `confirmation for ${commandId} must be answered by the patch`);
}

/**
 * `restoreBackup` guards with a modal confirmation which nobody can click in a
 * headless run — answer it through the shared-window patch above.
 */
async function executeRestoreBackup(dirName: string): Promise<void> {
  await executeWithModal(CMD.restoreBackup, dirName, dirName, true, 20_000);
}

async function executeDeleteModel(id: string): Promise<void> {
  await executeWithModal(CMD.deleteModel, id, id, true);
}

// ---------------------------------------------------------------------------
// Preset-editor webview bridge (webview↔host protocol roundtrip).
//
// The panel map in presetEditorHost is module-private and the B2 bridge only
// covers the host→webview direction. To drive SAVE messages (webview→host) we
// wrap vscode.window.createWebviewPanel while editPreset runs and capture:
//   - the real onDidReceiveMessage listener  → deliver save/dirty/cancel with
//   - panel.webview.postMessage              → observe {type:'result'} replies
// The real webview (React bundle) keeps running untouched — the wrappers only
// tee into the same calls the extension already makes.
//
// CONTRACT: reading lastReply() right after deliverSave() relies on the host's
// handleSave() completing SYNCHRONOUSLY (core save/rename/apply are sync fs, so
// the reply is already in `outbound` when deliver returns). If handleSave ever
// becomes async, the webview steps below fail DETERMINISTICALLY (red), not
// flakily — revisit this capture then.
// ---------------------------------------------------------------------------

interface PanelMessage {
  type: string;
  payload?: unknown;
}

interface PanelBridge {
  /** Deliver a webview→host protocol message to the extension's real listener. */
  deliver(raw: unknown): void;
  /** Host→webview messages posted while captured (init / result / modelsUpdated). */
  outbound: PanelMessage[];
}

async function openPresetEditorCaptured(name: string): Promise<PanelBridge> {
  const windowApi = vscode.window as unknown as {
    createWebviewPanel: (...args: unknown[]) => vscode.WebviewPanel;
  };
  const original = windowApi.createWebviewPanel;
  let bridge: PanelBridge | undefined;
  windowApi.createWebviewPanel = (...args: unknown[]) => {
    const panel = original.apply(windowApi, args);
    const webview = panel.webview as unknown as {
      onDidReceiveMessage: (listener: (raw: unknown) => void, ...rest: unknown[]) => vscode.Disposable;
      postMessage: (message: unknown) => Thenable<boolean>;
    };
    const capture: PanelBridge = {
      deliver: (): void => {
        throw new Error("onDidReceiveMessage listener was never registered for the captured panel");
      },
      outbound: [],
    };
    const originalOnDid = webview.onDidReceiveMessage;
    webview.onDidReceiveMessage = (listener: (raw: unknown) => void, ...rest: unknown[]) => {
      capture.deliver = (raw: unknown): void => {
        listener(raw);
      };
      return originalOnDid.call(webview, listener, ...rest);
    };
    try {
      const originalPost = webview.postMessage.bind(webview);
      webview.postMessage = (message: unknown) => {
        capture.outbound.push(message as PanelMessage);
        return originalPost(message);
      };
    } catch {
      throw new Error("panel.webview.postMessage could not be wrapped (frozen webview object?)");
    }
    bridge = capture;
    return panel;
  };
  try {
    await withTimeout(
      Promise.resolve(vscode.commands.executeCommand(CMD.editPreset, name)),
      20_000,
      `editPreset(${name}) must resolve once the webview is ready`,
    );
  } finally {
    windowApi.createWebviewPanel = original;
  }
  assert.ok(bridge, "createWebviewPanel was not called while opening the preset editor");
  // The host posts {type:'init'} right after the ready handshake — its presence in
  // the capture proves BOTH directions are wired to the real panel.
  assert.ok(
    bridge.outbound.some((message) => message.type === "init"),
    "captured panel must have received the init message",
  );
  heldBridges.set(name, bridge);
  return bridge;
}

interface SaveReply {
  action: string;
  ok: boolean;
  error?: string;
}

function lastReply(bridge: PanelBridge, action: string): SaveReply | undefined {
  const replies = bridge.outbound.filter(
    (message): message is PanelMessage & { payload: SaveReply } =>
      message.type === "result" &&
      typeof message.payload === "object" &&
      message.payload !== null &&
      (message.payload as SaveReply).action === action,
  );
  return replies.length > 0 ? replies[replies.length - 1].payload : undefined;
}

interface SaveRow {
  section: "agents" | "categories";
  name: string;
  model: string | null;
  variant: string | null;
}

/**
 * The full matrix payload the real webview sends on save: every stored row with
 * one entry overridden ("one cell edited").
 */
function rowsForSave(
  file: string,
  override: { section: "agents" | "categories"; name: string; model: string; variant: string | null },
): SaveRow[] {
  const preset = JSON.parse(fs.readFileSync(file, "utf8")) as Preset;
  const rows: SaveRow[] = [];
  const sections: readonly { key: "agents" | "categories"; settings: Preset["agents"] | Preset["categories"] }[] = [
    { key: "agents", settings: preset.agents ?? {} },
    { key: "categories", settings: preset.categories ?? {} },
  ];
  for (const { key, settings } of sections) {
    for (const [name, setting] of Object.entries(settings)) {
      if (override.section === key && override.name === name) {
        rows.push({ section: key, name, model: override.model, variant: override.variant });
      } else {
        rows.push({ section: key, name, model: setting.model, variant: setting.variant ?? null });
      }
    }
  }
  if (!rows.some((row) => row.section === override.section && row.name === override.name)) {
    rows.push({ section: override.section, name: override.name, model: override.model, variant: override.variant });
  }
  return rows;
}

function deliverSave(
  bridge: PanelBridge,
  payload: { name: string; apply: boolean; rows: SaveRow[]; description?: string },
): void {
  bridge.deliver({ type: "save", payload });
}

// ---------------------------------------------------------------------------
// Quota panel webview bridge — same capture technique as the preset editor,
// driven by the singleton quota panel (quotaRefresh / quotaConfigureMimo).
// ---------------------------------------------------------------------------

let quotaBridge: PanelBridge | undefined;

interface QuotaSnapshotMessage {
  snapshot: {
    providers: { providerId: string; configured: boolean; error: string | null; windows: unknown[] }[];
    fetchedAt: string;
  };
}

function quotaSnapshots(bridge: PanelBridge): QuotaSnapshotMessage[] {
  return bridge.outbound
    .filter(
      (message): message is PanelMessage & { payload: QuotaSnapshotMessage } =>
        (message.type === "quotaSnapshot" || message.type === "quotaInit") &&
        typeof message.payload === "object" &&
        message.payload !== null &&
        Array.isArray((message.payload as QuotaSnapshotMessage).snapshot?.providers),
    )
    .map((message) => message.payload);
}

/** Open (or reveal) the quota panel while capturing its bridge; asserts the boot handshake. */
async function openQuotaPanelCaptured(commandId: string, arg?: unknown): Promise<PanelBridge> {
  const windowApi = vscode.window as unknown as {
    createWebviewPanel: (...args: unknown[]) => vscode.WebviewPanel;
  };
  const original = windowApi.createWebviewPanel;
  let bridge: PanelBridge | undefined;
  windowApi.createWebviewPanel = (...args: unknown[]) => {
    const panel = original.apply(windowApi, args);
    const webview = panel.webview as unknown as {
      onDidReceiveMessage: (listener: (raw: unknown) => void, ...rest: unknown[]) => vscode.Disposable;
      postMessage: (message: unknown) => Thenable<boolean>;
    };
    const capture: PanelBridge = {
      deliver: (): void => {
        throw new Error("onDidReceiveMessage listener was never registered for the captured quota panel");
      },
      outbound: [],
    };
    const originalOnDid = webview.onDidReceiveMessage;
    webview.onDidReceiveMessage = (listener: (raw: unknown) => void, ...rest: unknown[]) => {
      capture.deliver = (raw: unknown): void => {
        listener(raw);
      };
      return originalOnDid.call(webview, listener, ...rest);
    };
    const originalPost = webview.postMessage.bind(webview);
    webview.postMessage = (message: unknown) => {
      capture.outbound.push(message as PanelMessage);
      return originalPost(message);
    };
    bridge = capture;
    return panel;
  };
  try {
    await withTimeout(
      Promise.resolve(vscode.commands.executeCommand(commandId, arg)),
      20_000,
      `${commandId} must resolve once the quota panel webview is ready`,
    );
  } finally {
    windowApi.createWebviewPanel = original;
  }
  // Reveal of an ALREADY-open singleton panel never calls createWebviewPanel — reuse
  // the held bridge instead (quotaInit lands there).
  if (bridge === undefined) {
    assert.ok(quotaBridge, "quota panel reveal must reuse the previously captured bridge");
    return quotaBridge;
  }
  assert.ok(
    bridge.outbound.some((message) => message.type === "quotaInit"),
    "captured quota panel must have received the quotaInit message",
  );
  quotaBridge = bridge;
  return bridge;
}

// ---------------------------------------------------------------------------
// Test chain
// ---------------------------------------------------------------------------

function tests(): TestCase[] {
  return [
    // ---- Section 1: environment & activation --------------------------------
    {
      name: "isolation: XDG_CONFIG_HOME/HOME/XDG_DATA_HOME point at temp sandboxes",
      fn: async () => {
        const underTmp = (value: string | undefined, label: string): string => {
          assert.ok(value, `${label} must be set by test/e2e/run.mjs`);
          const resolved = path.resolve(value);
          const tmp = path.resolve(os.tmpdir());
          assert.ok(
            resolved === tmp || resolved.startsWith(`${tmp}${path.sep}`),
            `${label} (${resolved}) must live under os.tmpdir() (${tmp})`,
          );
          return resolved;
        };
        const xdg = underTmp(process.env.XDG_CONFIG_HOME, "XDG_CONFIG_HOME");
        // HOME carries the omo target (~/.omo), XDG_DATA_HOME the quota credentials
        // (auth.json) — both must stay inside throwaway sandboxes too.
        underTmp(process.env.HOME, "HOME");
        underTmp(process.env.XDG_DATA_HOME, "XDG_DATA_HOME");
        configDir = path.join(xdg, "opencode");
        assert.ok(fs.existsSync(configDir), `seeded config dir missing: ${configDir}`);
        assert.ok(fs.existsSync(path.join(configDir, "opencode.json")), "seeded opencode.json missing");
        assert.ok(fs.existsSync(path.join(configDir, "oh-my-opencode.json")), "seeded oh-my-opencode.json missing");
      },
    },
    {
      name: `extension ${EXTENSION_ID} activates`,
      fn: async () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension, `extension ${EXTENSION_ID} not found in host`);
        await extension.activate();
        assert.equal(extension.isActive, true, "extension must be active after activate()");
      },
    },
    {
      name: `all ${COMMAND_IDS.length} contributed commands are registered`,
      fn: async () => {
        const registered = new Set(await vscode.commands.getCommands(false));
        const missing = COMMAND_IDS.filter((id) => !registered.has(id));
        assert.deepEqual(missing, [], "commands declared in package.json must be registered");
      },
    },
    {
      name: "openConfigFile(node.filePath) opens opencode.json as text document",
      fn: async () => {
        // commands.ts accepts a NodeLike arg with filePath (tree-item shape).
        await vscode.commands.executeCommand(CMD.openConfigFile, {
          filePath: path.join(configDir, "opencode.json"),
        });
        const document = vscode.window.activeTextEditor?.document;
        assert.ok(document, "expected an active text editor after openConfigFile");
        assert.ok(
          document.fileName.endsWith("opencode.json"),
          `active document should be opencode.json, got: ${document.fileName}`,
        );
      },
    },

    // ---- Section 2: discovery & models --------------------------------------
    {
      name: "plugins: listPlugins resolves the seeded npm install; plugin file opens",
      fn: async () => {
        // Same env as the extension host: XDG_CONFIG_HOME/HOME are set by run.mjs.
        const store = new ConfigStore();
        const plugins = store.listPlugins();
        const installed = plugins.find((p) => p.name === "@happycastle/opencode-openmemory");
        assert.ok(installed, `npm plugin not listed: ${plugins.map((p) => p.name).join(", ")}`);
        assert.equal(installed.kind, "npm");
        assert.equal(installed.installed, true);
        assert.equal(installed.version, "0.0.3");
        assert.ok(
          installed.resolvedPath.endsWith(path.join("node_modules", "@happycastle", "opencode-openmemory")),
          `unexpected resolvedPath: ${installed.resolvedPath}`,
        );
        const pathEntry = plugins.find((p) => p.kind === "path");
        assert.ok(pathEntry, "fixture path plugin (~/.config/.../dist/index.js) must be listed");
        assert.equal(pathEntry.installed, false, "path entry points outside the seeded HOME — must be uninstalled");

        await vscode.commands.executeCommand(CMD.openConfigFile, {
          filePath: path.join(installed.resolvedPath, "index.js"),
        });
        const document = vscode.window.activeTextEditor?.document;
        assert.ok(document, "expected an active text editor after opening the plugin file");
        assert.ok(
          document.fileName.endsWith(path.join("opencode-openmemory", "index.js")),
          `active document should be the plugin entry file, got: ${document.fileName}`,
        );
      },
    },
    {
      name: "addModel writes models.json; deleteModel removes the entry",
      fn: async () => {
        const id = "e2e-test-provider/e2e-model-x";
        await vscode.commands.executeCommand(CMD.addModel, id);
        const modelsFile = path.join(configDir, "models.json");
        assert.ok(fs.existsSync(modelsFile), "models.json must exist after addModel");
        const afterAdd = JSON.parse(fs.readFileSync(modelsFile, "utf8")) as {
          models: { provider: string; model: string }[];
        };
        assert.ok(
          afterAdd.models.some((m) => `${m.provider}/${m.model}` === id),
          `added model ${id} not found in models.json`,
        );
        await executeDeleteModel(id);
        const afterDelete = JSON.parse(fs.readFileSync(modelsFile, "utf8")) as {
          models: { provider: string; model: string }[];
        };
        assert.ok(
          !afterDelete.models.some((m) => `${m.provider}/${m.model}` === id),
          `deleted model ${id} still present in models.json`,
        );
      },
    },
    {
      name: "openModelsFile opens the local models catalog",
      fn: async () => {
        await withTimeout(
          Promise.resolve(vscode.commands.executeCommand(CMD.openModelsFile)),
          10_000,
          "openModelsFile should resolve",
        );
        const document = vscode.window.activeTextEditor?.document;
        assert.ok(document, "expected an active text editor after openModelsFile");
        assert.ok(
          document.fileName.endsWith("models.json"),
          `active document should be models.json, got: ${document.fileName}`,
        );
      },
    },

    // ---- Section 3: presets & backups (existing smoke chain) -----------------
    {
      name: "capturePreset('e2e-preset') writes presets/e2e-preset.json",
      fn: async () => {
        await vscode.commands.executeCommand(CMD.capturePreset, PRESET_NAME);
        presetFile = path.join(configDir, "presets", `${PRESET_NAME}.json`);
        assert.ok(fs.existsSync(presetFile), `preset file not written: ${presetFile}`);
        const preset = JSON.parse(fs.readFileSync(presetFile, "utf8")) as { name: string };
        assert.equal(preset.name, PRESET_NAME, "captured preset must carry its name");
      },
    },
    {
      name: "applyPreset('e2e-preset') resolves, keeps configs parseable, no auto backup",
      fn: async () => {
        await withTimeout(
          Promise.resolve(vscode.commands.executeCommand(CMD.applyPreset, PRESET_NAME)),
          15_000,
          "applyPreset should resolve",
        );
        const preset = JSON.parse(fs.readFileSync(presetFile, "utf8")) as { appliedAt: string | null };
        assert.ok(typeof preset.appliedAt === "string", "preset.appliedAt must be set after apply");
        assertNoJsoncErrors(path.join(configDir, "oh-my-opencode.json"));
        assertNoJsoncErrors(path.join(configDir, "opencode.json"));
        // Applying must not silently create pre-apply/pre-save backups (AGENTS.md
        // contract: 应用/恢复不再自动产生备份) — same guard the restore test applies.
        assertNoAutoBackups();
      },
    },
    {
      name: "backupNow creates a named *-manual backup with manifest.json",
      fn: async () => {
        await vscode.commands.executeCommand(CMD.backupNow, "e2e 备份");
        const backupsDir = path.join(configDir, "backups");
        assert.ok(fs.existsSync(backupsDir), "backups dir must exist after backupNow");
        const dirNames = fs
          .readdirSync(backupsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
        const manuals = dirNames.filter((name) => /-manual$/.test(name)).sort();
        assert.ok(manuals.length >= 1, `expected ≥1 *-manual backup, found: ${dirNames.join(", ")}`);
        const newest = manuals[manuals.length - 1];
        const manifestPath = path.join(backupsDir, newest, "manifest.json");
        assert.ok(fs.existsSync(manifestPath), `manifest.json missing in ${newest}`);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          reason: string;
          name?: string;
          fileCount: number;
        };
        assert.equal(manifest.reason, "manual");
        assert.equal(manifest.name, "e2e 备份");
        assert.ok(manifest.fileCount >= 2, "manual backup should contain both managed config files");
        manualBackupDirName = newest;
      },
    },
    {
      name: "editPreset('e2e-preset') resolves after webview posts ready (≤15s)",
      fn: async () => {
        // presetEditorHost loads <extensionRoot>/dist-webview/index.html and only
        // resolves openPresetEditor once the webview posts {type:'ready'}.
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension);
        const distWebview = path.join(extension.extensionUri.fsPath, "dist-webview");
        assert.ok(
          fs.existsSync(path.join(distWebview, "index.html")),
          "dist-webview/index.html missing — run.mjs must copy webview-ui/build first",
        );
        await withTimeout(
          Promise.resolve(vscode.commands.executeCommand(CMD.editPreset, PRESET_NAME)),
          15_000,
          "editPreset must resolve once the preset editor webview is ready",
        );
      },
    },
    {
      name: "restoreBackup(<manual dir>) restores; configs still parseable",
      fn: async () => {
        assert.ok(manualBackupDirName, "requires a manual backup from the previous step");

        fs.writeFileSync(path.join(configDir, "opencode.json"), '{ "marker": "mutated-before-restore" }\n');
        const backupCopy = fs.readFileSync(path.join(configDir, "backups", manualBackupDirName, "opencode.json"));
        await executeRestoreBackup(manualBackupDirName);

        assert.ok(
          fs.readFileSync(path.join(configDir, "opencode.json")).equals(backupCopy),
          "live opencode.json must equal the restored backup copy",
        );

        assertNoAutoBackups();

        assertNoJsoncErrors(path.join(configDir, "opencode.json"));
        assertNoJsoncErrors(path.join(configDir, "oh-my-opencode.json"));
      },
    },
    {
      name: "exportBackup → importBackup zip round-trip (programmatic args)",
      fn: async () => {
        assert.ok(manualBackupDirName, "requires a manual backup from the previous step");
        const zipPath = path.join(os.tmpdir(), `ocm-e2e-${Date.now()}.zip`);
        await vscode.commands.executeCommand(CMD.exportBackup, {
          dirName: manualBackupDirName,
          target: zipPath,
        });
        assert.ok(fs.existsSync(zipPath), "exported zip must exist");

        await vscode.commands.executeCommand(CMD.importBackup, zipPath);
        const backupsDir = path.join(configDir, "backups");
        const imported = fs
          .readdirSync(backupsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.includes("-import-"))
          .map((entry) => entry.name);
        assert.equal(imported.length, 1, `expected one -import- copy, found: ${imported.join(", ")}`);
        importedBackupDirName = imported[0];

        const original = fs.readFileSync(path.join(backupsDir, manualBackupDirName, "opencode.json"));
        const copy = fs.readFileSync(path.join(backupsDir, importedBackupDirName, "opencode.json"));
        assert.ok(original.equals(copy), "imported backup content must match the original");
        assert.ok(
          fs.existsSync(path.join(backupsDir, importedBackupDirName, "manifest.json")),
          "imported backup must carry manifest.json",
        );
        fs.rmSync(zipPath, { force: true });
      },
    },

    // ---- Section 4: webview save/apply protocol roundtrips -------------------
    {
      name: "webview save (apply:false) updates the preset file only",
      fn: async () => {
        await vscode.commands.executeCommand(CMD.capturePreset, WV_PRESET);
        const wvFile = path.join(configDir, "presets", `${WV_PRESET}.json`);
        assert.ok(fs.existsSync(wvFile), `preset ${WV_PRESET} must exist before editing`);
        const before = JSON.parse(fs.readFileSync(wvFile, "utf8")) as { appliedAt: string | null };
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        const agentBytesBefore = fs.readFileSync(agentConfig);

        const bridge = await openPresetEditorCaptured(WV_PRESET);
        deliverSave(bridge, {
          name: WV_PRESET,
          apply: false,
          rows: rowsForSave(wvFile, {
            section: "agents",
            name: "build",
            model: "e2e-p/test-model",
            variant: "think",
          }),
        });

        const reply = lastReply(bridge, "save");
        assert.ok(reply, "save must produce a {type:'result'} reply");
        assert.equal(reply.ok, true, `save reply must be ok:true, got: ${reply.error ?? "?"}`);

        const saved = JSON.parse(fs.readFileSync(wvFile, "utf8")) as {
          appliedAt: string | null;
          agents: { build?: { model: string; variant?: string } };
        };
        assert.equal(saved.agents.build?.model, "e2e-p/test-model");
        assert.equal(saved.agents.build?.variant, "think");
        assert.equal(saved.appliedAt, before.appliedAt, "save without apply must not touch appliedAt");
        assert.ok(
          fs.readFileSync(agentConfig).equals(agentBytesBefore),
          "save without apply must not write the live agent config",
        );
      },
    },
    {
      name: "webview save (apply:true) writes the live config and stamps appliedAt",
      fn: async () => {
        const wvFile = path.join(configDir, "presets", `${WV_PRESET}.json`);
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        const before = JSON.parse(fs.readFileSync(wvFile, "utf8")) as { appliedAt: string | null };

        // Same panel as the previous step (keyed by its current name).
        const bridge = await openPresetEditorReused(WV_PRESET);
        deliverSave(bridge, {
          name: WV_PRESET,
          apply: true,
          rows: rowsForSave(wvFile, {
            section: "agents",
            name: "build",
            model: "e2e-p/apply-model",
            variant: "medium",
          }),
        });

        const reply = lastReply(bridge, "apply");
        assert.ok(reply, "apply must produce a {type:'result'} reply");
        assert.equal(reply.ok, true, `apply reply must be ok:true, got: ${reply.error ?? "?"}`);

        assertNoJsoncErrors(agentConfig);
        const agent = JSON.parse(fs.readFileSync(agentConfig, "utf8")) as {
          agents: { build?: Record<string, unknown> };
        };
        assert.equal(agent.agents.build?.model, "e2e-p/apply-model");
        assert.equal(agent.agents.build?.variant, "medium");
        assert.equal("reasoning" in (agent.agents.build ?? {}), false, "legacy target must not gain a reasoning key");
        assert.equal("models" in (agent.agents.build ?? {}), false, "apply must clear models chains");

        const saved = JSON.parse(fs.readFileSync(wvFile, "utf8")) as { appliedAt: string | null };
        assert.ok(typeof saved.appliedAt === "string", "apply:true must stamp appliedAt");
        if (typeof before.appliedAt === "string") {
          assert.ok(saved.appliedAt >= before.appliedAt, "appliedAt must move forward");
        }

        // The status bar follows the tree snapshot refresh triggered by refreshAll.
        await pollUntil(
          async () => (await statusBarText()).includes(`模板: ${WV_PRESET}`),
          3_000,
          `status bar shows 模板: ${WV_PRESET}`,
        );
      },
    },
    {
      name: "webview save with a new name renames the preset (createdAt preserved)",
      fn: async () => {
        const wvFile = path.join(configDir, "presets", `${WV_PRESET}.json`);
        const renamedFile = path.join(configDir, "presets", `${WV_PRESET_RENAMED}.json`);
        const before = JSON.parse(fs.readFileSync(wvFile, "utf8")) as { createdAt: string };

        const bridge = await openPresetEditorReused(WV_PRESET);
        deliverSave(bridge, {
          name: WV_PRESET_RENAMED,
          apply: false,
          rows: rowsForSave(wvFile, {
            section: "agents",
            name: "build",
            model: "e2e-p/apply-model",
            variant: "medium",
          }),
        });
        const reply = lastReply(bridge, "save");
        assert.equal(reply?.ok, true, `rename-on-save reply must be ok:true, got: ${reply?.error ?? "?"}`);

        assert.equal(fs.existsSync(wvFile), false, "old preset file must be gone after rename-on-save");
        assert.ok(fs.existsSync(renamedFile), "renamed preset file must exist");
        const renamed = JSON.parse(fs.readFileSync(renamedFile, "utf8")) as { name: string; createdAt: string };
        assert.equal(renamed.name, WV_PRESET_RENAMED);
        assert.equal(renamed.createdAt, before.createdAt, "rename-on-save must preserve createdAt");

        // The host re-keys its open-panel map to the new name; the B2 bridge is
        // keyed by the CURRENT name, so it proves the re-key from the outside.
        const posted = await vscode.commands.executeCommand(TEST_BRIDGE.presetEditorPostMessage, WV_PRESET_RENAMED, {
          type: "modelsUpdated",
          payload: { models: [] },
        });
        assert.equal(posted, true, "bridge must find the panel under its NEW name");
        const postedOld = await vscode.commands.executeCommand(TEST_BRIDGE.presetEditorPostMessage, WV_PRESET, {
          type: "modelsUpdated",
          payload: { models: [] },
        });
        assert.equal(postedOld, false, "bridge must no longer find the panel under its OLD name");
        heldBridges.set(WV_PRESET_RENAMED, bridge);
        heldBridges.delete(WV_PRESET);
      },
    },
    {
      name: "webview save with an invalid name is rejected, nothing written",
      fn: async () => {
        const presetsDir = path.join(configDir, "presets");
        const before = fs.readdirSync(presetsDir).sort();

        const bridge = await openPresetEditorReused(WV_PRESET_RENAMED);
        deliverSave(bridge, {
          name: "../evil",
          apply: false,
          rows: rowsForSave(path.join(presetsDir, `${WV_PRESET_RENAMED}.json`), {
            section: "agents",
            name: "build",
            model: "e2e-p/evil-model",
            variant: null,
          }),
        });
        const reply = lastReply(bridge, "save");
        assert.ok(reply, "invalid save must still produce a reply");
        assert.equal(reply.ok, false, "invalid name must be rejected with ok:false");
        assert.ok(typeof reply.error === "string" && reply.error.length > 0, "rejection carries the Chinese reason");

        assert.deepEqual(
          fs.readdirSync(presetsDir).sort(),
          before,
          "presets dir must be byte-identical after the rejected save",
        );
        assert.equal(fs.existsSync(path.join(configDir, "evil.json")), false, "no escape outside presets/");
      },
    },
    {
      name: "webview cancel disposes the panel",
      fn: async () => {
        const bridge = await openPresetEditorReused(WV_PRESET_RENAMED);
        bridge.deliver({ type: "cancel" });
        heldBridges.delete(WV_PRESET_RENAMED);
        await pollUntil(
          async () =>
            (await vscode.commands.executeCommand(TEST_BRIDGE.presetEditorPostMessage, WV_PRESET_RENAMED, {
              type: "modelsUpdated",
              payload: { models: [] },
            })) === false,
          3_000,
          "panel keyed under the cancelled name must be removed from the host map",
        );
      },
    },

    // ---- Section 5: preset/backup management commands ------------------------
    {
      name: "renamePreset {from,to} renames and preserves metadata",
      fn: async () => {
        const fromFile = path.join(configDir, "presets", `${WV_PRESET_RENAMED}.json`);
        const toFile = path.join(configDir, "presets", `${WV_PRESET}.json`);
        const before = JSON.parse(fs.readFileSync(fromFile, "utf8")) as { createdAt: string; appliedAt?: string };

        await withTimeout(
          Promise.resolve(vscode.commands.executeCommand(CMD.renamePreset, { from: WV_PRESET_RENAMED, to: WV_PRESET })),
          10_000,
          "renamePreset should resolve",
        );

        assert.equal(fs.existsSync(fromFile), false, "old preset file must be gone");
        assert.ok(fs.existsSync(toFile), "renamed preset file must exist");
        const renamed = JSON.parse(fs.readFileSync(toFile, "utf8")) as {
          name: string;
          createdAt: string;
          appliedAt?: string;
        };
        assert.equal(renamed.name, WV_PRESET, "content name field must follow the new file name");
        assert.equal(renamed.createdAt, before.createdAt, "createdAt must survive the rename");
        assert.equal(renamed.appliedAt, before.appliedAt, "appliedAt must survive the rename");
      },
    },
    {
      name: "deletePreset: cancel keeps the file, confirm deletes it",
      fn: async () => {
        await vscode.commands.executeCommand(CMD.capturePreset, "e2e-del");
        const file = path.join(configDir, "presets", "e2e-del.json");
        assert.ok(fs.existsSync(file), "preset to delete must exist");

        await executeWithModal(CMD.deletePreset, "e2e-del", "e2e-del", false);
        assert.ok(fs.existsSync(file), "cancelled deletion must keep the preset file");

        await executeWithModal(CMD.deletePreset, "e2e-del", "e2e-del", true);
        assert.equal(fs.existsSync(file), false, "confirmed deletion must remove the preset file");
        const remaining = fs.readdirSync(path.join(configDir, "presets")).sort();
        assert.deepEqual(remaining, [`${PRESET_NAME}.json`, `${WV_PRESET}.json`], "only the flow presets remain");
      },
    },
    {
      name: "exportPreset {name,target} writes a valid preset JSON file",
      fn: async () => {
        const target = path.join(os.tmpdir(), `ocm-e2e-preset-${Date.now()}.json`);
        await withTimeout(
          Promise.resolve(vscode.commands.executeCommand(CMD.exportPreset, { name: PRESET_NAME, target })),
          10_000,
          "exportPreset should resolve",
        );
        assert.ok(fs.existsSync(target), "exported preset file must exist");
        const exported = JSON.parse(fs.readFileSync(target, "utf8")) as { name: string; createdAt: string };
        assert.equal(exported.name, PRESET_NAME);
        assert.ok(typeof exported.createdAt === "string");
        fs.rmSync(target, { force: true });
      },
    },
    {
      name: "setAgentModel (programmatic, legacy target) writes model+variant, cleans conflict keys",
      fn: async () => {
        const agentConfig = path.join(configDir, "oh-my-opencode.json");

        await withTimeout(
          Promise.resolve(
            vscode.commands.executeCommand(CMD.setAgentModel, {
              section: "agents",
              name: "build",
              model: "e2e-p/plan-model",
              variant: "high",
            }),
          ),
          10_000,
          "setAgentModel should resolve",
        );
        assertNoJsoncErrors(agentConfig);
        const afterSet = JSON.parse(fs.readFileSync(agentConfig, "utf8")) as {
          agents: { build?: Record<string, unknown> };
        };
        assert.equal(afterSet.agents.build?.model, "e2e-p/plan-model");
        assert.equal(afterSet.agents.build?.variant, "high");

        // Conflict-key cleanup: pre-write a `reasoning` key and a `models` chain into
        // the same entry, then set again — both must be removed by the assignment.
        const poisoned = JSON.parse(fs.readFileSync(agentConfig, "utf8")) as {
          agents: Record<string, Record<string, unknown>>;
        };
        poisoned.agents.build = {
          model: "e2e-p/plan-model",
          variant: "high",
          reasoning: "low",
          models: [{ model: "zhipuai-coding-plan/glm-5.2" }],
        };
        fs.writeFileSync(agentConfig, `${JSON.stringify(poisoned, null, 2)}\n`);

        await withTimeout(
          Promise.resolve(
            vscode.commands.executeCommand(CMD.setAgentModel, {
              section: "agents",
              name: "build",
              model: "e2e-p/plan-model-2",
              variant: "medium",
            }),
          ),
          10_000,
          "setAgentModel (cleanup pass) should resolve",
        );
        assertNoJsoncErrors(agentConfig);
        const afterCleanup = JSON.parse(fs.readFileSync(agentConfig, "utf8")) as {
          agents: { build?: Record<string, unknown> };
        };
        assert.equal(afterCleanup.agents.build?.model, "e2e-p/plan-model-2");
        assert.equal(afterCleanup.agents.build?.variant, "medium");
        assert.equal("reasoning" in (afterCleanup.agents.build ?? {}), false, "reasoning must be cleaned");
        assert.equal("models" in (afterCleanup.agents.build ?? {}), false, "models chain must be cleaned");
      },
    },
    {
      name: "setAgentModel (omo target) writes reasoning inside [opencode]",
      fn: async () => {
        const omoDir = path.join(os.homedir(), ".omo");
        const omoFile = path.join(omoDir, "omo.jsonc");
        assert.equal(fs.existsSync(omoDir), false, "fake HOME must not have ~/.omo before this step");
        // Seed the omo config AFTER activation — resolveAgentConfig() probes live, so
        // the write target switches from legacy to omo from this point on.
        fs.mkdirSync(omoDir, { recursive: true });
        fs.writeFileSync(omoFile, '{\n  "[opencode]": {\n    "agents": {},\n    "categories": {}\n  }\n}\n');
        const legacyConfig = path.join(configDir, "oh-my-opencode.json");
        const legacyBytes = fs.readFileSync(legacyConfig);

        await withTimeout(
          Promise.resolve(
            vscode.commands.executeCommand(CMD.setAgentModel, {
              section: "categories",
              name: "writing",
              model: "e2e-p/write-model",
              variant: "low",
            }),
          ),
          10_000,
          "setAgentModel (omo) should resolve",
        );

        assertNoJsoncErrors(omoFile);
        const omo = JSON.parse(fs.readFileSync(omoFile, "utf8")) as {
          "[opencode]"?: { categories?: { writing?: Record<string, unknown> } };
          categories?: Record<string, unknown>;
        };
        const blockEntry = omo["[opencode]"]?.categories?.writing;
        assert.equal(blockEntry?.model, "e2e-p/write-model", "assignment must land inside [opencode]");
        assert.equal(blockEntry?.reasoning, "low", "omo target uses the reasoning key");
        assert.equal("variant" in (blockEntry ?? {}), false, "omo target must not use the legacy variant key");
        assert.equal(omo.categories, undefined, "nothing may leak to the omo base level");
        assert.ok(
          fs.readFileSync(legacyConfig).equals(legacyBytes),
          "once the omo target exists, the legacy file must stay untouched",
        );
      },
    },
    {
      name: "renameBackup {dirName,name} updates manifest.name, keeps the dir name",
      fn: async () => {
        assert.ok(manualBackupDirName, "requires a manual backup from an earlier step");
        await withTimeout(
          Promise.resolve(
            vscode.commands.executeCommand(CMD.renameBackup, { dirName: manualBackupDirName, name: "e2e 备份改名" }),
          ),
          10_000,
          "renameBackup should resolve",
        );
        const manifestPath = path.join(configDir, "backups", manualBackupDirName, "manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: string };
        assert.equal(manifest.name, "e2e 备份改名", "manifest.name must carry the new display name");
        assert.ok(fs.existsSync(path.join(configDir, "backups", manualBackupDirName)), "dir name must stay the same");
      },
    },
    {
      name: "diffBackup(dirName) opens a diff tab: backup ↔ live opencode.json",
      fn: async () => {
        assert.ok(manualBackupDirName, "requires a manual backup from an earlier step");
        const live = path.join(configDir, "opencode.json");
        const original = fs.readFileSync(live);
        fs.writeFileSync(live, '{ "marker": "mutated-before-diff" }\n');
        try {
          await withTimeout(
            Promise.resolve(vscode.commands.executeCommand(CMD.diffBackup, manualBackupDirName)),
            10_000,
            "diffBackup should resolve",
          );
          const diffTab = await pollFor(
            () =>
              vscode.window.tabGroups.activeTabGroup.tabs
                .map((tab) => tab.input)
                .find((input): input is vscode.TabInputTextDiff => input instanceof vscode.TabInputTextDiff),
            3_000,
            "a TabInputTextDiff tab must open",
          );
          assert.equal(
            diffTab.original.fsPath,
            path.join(configDir, "backups", manualBackupDirName, "opencode.json"),
            "diff original side must be the backup copy",
          );
          assert.equal(diffTab.modified.fsPath, live, "diff modified side must be the live config");
        } finally {
          fs.writeFileSync(live, original);
        }
      },
    },
    {
      name: "deleteBackup (confirmed) removes the imported dir, others intact",
      fn: async () => {
        assert.ok(importedBackupDirName, "requires the imported backup from an earlier step");
        assert.ok(fs.existsSync(path.join(configDir, "backups", importedBackupDirName)));
        await executeWithModal(CMD.deleteBackup, importedBackupDirName, importedBackupDirName, true);
        assert.equal(
          fs.existsSync(path.join(configDir, "backups", importedBackupDirName)),
          false,
          "confirmed deletion must remove the imported backup dir",
        );
        assert.ok(
          fs.existsSync(path.join(configDir, "backups", manualBackupDirName)),
          "the manual backup must survive",
        );
      },
    },
    {
      name: "createConfig 'AGENTS.md' writes the template and opens it",
      fn: async () => {
        const agentsMd = path.join(configDir, "AGENTS.md");
        assert.equal(fs.existsSync(agentsMd), false, "seed must not contain AGENTS.md");
        await withTimeout(
          Promise.resolve(vscode.commands.executeCommand(CMD.createConfig, "AGENTS.md")),
          10_000,
          "createConfig should resolve",
        );
        assert.ok(fs.existsSync(agentsMd), "AGENTS.md must be created");
        assert.ok(
          fs.readFileSync(agentsMd, "utf8").startsWith("# AGENTS.md"),
          "created AGENTS.md must start with the template header",
        );
        const document = vscode.window.activeTextEditor?.document;
        assert.ok(document, "expected an active text editor after createConfig");
        assert.ok(
          document.fileName.endsWith("AGENTS.md"),
          `active document should be AGENTS.md, got: ${document.fileName}`,
        );
      },
    },

    // ---- Section 6: tree, status bar, error paths, quota ---------------------
    {
      name: "buildConfigTree: 5 roots in order, current preset badge, backup rows, parseError node",
      fn: async () => {
        const buildSnapshot = (): BaseNode[] => {
          // Same services and env the extension wires up — the suite shares the
          // extension host process and its XDG/HOME mask.
          const store = new ConfigStore();
          const discovered = store.discover();
          const presetService = new PresetService({ presetsDir: discovered.presetsDir, configStore: store });
          const presets = presetService.list();
          const backups = new BackupService({
            configDir: discovered.configDir,
            managedFiles: [
              discovered.opencodeJson,
              discovered.agentConfig.path,
              path.join(discovered.configDir, "AGENTS.md"),
            ],
            extraDirs: [],
          }).list();
          const parseErrors = new Map<string, JsoncError[]>();
          for (const file of [discovered.opencodeJson, discovered.agentConfig.path]) {
            const text = store.readTextOrEmpty(file);
            if (text.length > 0) {
              const errors = validate(text);
              if (errors.length > 0) {
                parseErrors.set(file, errors);
              }
            }
          }
          return buildConfigTree(
            discovered,
            presets,
            presetService.currentPresetName(presets),
            backups,
            parseErrors,
            store.ohMyAssignments(),
            store.listModelEntries(),
            store.listPlugins(),
          );
        };

        const roots = buildSnapshot();
        assert.deepEqual(
          roots.map((root) => root.kind),
          ["configRoot", "presetRoot", "backupRoot", "modelRoot", "pluginRoot"],
          "exactly the 5 section roots, in order",
        );
        assert.deepEqual(
          roots.map((root) => root.label),
          ["配置", "模板", "备份", "模型", "插件"],
        );

        const presetRoot = roots[1];
        const badgeNode = presetRoot.children?.find((child) => child.kind === "preset" && child.label === WV_PRESET);
        assert.ok(badgeNode, `preset node for ${WV_PRESET} missing`);
        assert.equal(badgeNode.description, CURRENT_PRESET_BADGE, "the applied preset carries the current badge");

        const backupRoot = roots[2];
        const backupNodes = backupRoot.children?.filter((child) => child.kind === "backup") ?? [];
        assert.ok(backupNodes.length >= 1, "backup section must list the manual backup");
        assert.ok(
          backupNodes.some((node) => node.label.includes("e2e 备份改名")),
          `renamed backup must be listed, got: ${backupNodes.map((node) => node.label).join(", ")}`,
        );

        // Broken JSONC surfaces as a parseError child under the config file node.
        const live = path.join(configDir, "opencode.json");
        const original = fs.readFileSync(live);
        fs.writeFileSync(live, "{,}\n");
        try {
          const broken = buildSnapshot();
          const openCodeNode = broken[0].children?.find((child) => child.id === "config:opencode.json");
          assert.ok(openCodeNode, "opencode.json config node missing");
          assert.ok(
            openCodeNode.label.includes("⚠️"),
            `broken file label must carry the warning mark: ${openCodeNode.label}`,
          );
          assert.equal(openCodeNode.children?.[0]?.kind, "parseError", "parseError node must appear");
        } finally {
          fs.writeFileSync(live, original);
        }
      },
    },
    {
      name: "fs.watch: external preset-file change auto-refreshes the status bar",
      fn: async () => {
        // Preconditions from earlier steps: e2e-webview is the CURRENT preset (newest
        // appliedAt), e2e-preset the older one — deleting the current preset's file
        // makes currentPresetName (max appliedAt) fall back to e2e-preset; restoring
        // the file flips the badge back.
        //
        // BOOTSTRAP first: presets/ is created AFTER activation, so its recursive
        // watcher only gets armed when some fire() (event burst on an ALREADY armed
        // watcher) runs arm() while presets/ exists — writes inside presets/ itself
        // are invisible until then. Creating configDir/package.json (a tracked
        // lockfile-churn basename, never read by the extension) guarantees such a
        // burst; the status-bar flip to the probe preset then proves fire() ran,
        // which armed presets/ before the rename phase relies on it.
        const presetsDir = path.join(configDir, "presets");
        const probePreset = path.join(presetsDir, "e2e-watch-probe.json");
        const bootstrapFlag = path.join(configDir, "package.json");
        const wvFile = path.join(presetsDir, `${WV_PRESET}.json`);
        const parked = `${wvFile}.parked`; // .parked ≠ *.json → not picked up as a preset

        fs.writeFileSync(bootstrapFlag, "{}\n");
        fs.writeFileSync(
          probePreset,
          JSON.stringify({ name: "e2e-watch-probe", appliedAt: "2999-01-01T00:00:00.000Z" }),
        );
        try {
          await pollUntil(
            async () => (await statusBarText()).includes("模板: e2e-watch-probe"),
            5_000,
            "watcher must pick up the externally created probe preset",
          );
        } finally {
          fs.rmSync(probePreset, { force: true });
          fs.rmSync(bootstrapFlag, { force: true });
        }
        await pollUntil(
          async () => (await statusBarText()).includes(`模板: ${WV_PRESET}`),
          5_000,
          "removing the probe must restore the previous current preset",
        );

        fs.renameSync(wvFile, parked);
        try {
          await pollUntil(
            async () => !(await statusBarText()).includes(`模板: ${WV_PRESET}`),
            5_000,
            "watcher debounce must drop the deleted preset from the status bar",
          );
        } finally {
          fs.renameSync(parked, wvFile);
        }
        await pollUntil(
          async () => (await statusBarText()).includes(`模板: ${WV_PRESET}`),
          5_000,
          "watcher must restore the current-preset badge after the file returns",
        );
      },
    },
    {
      name: "error paths: unknown preset / corrupt zip / cancelled quick pick all resolve",
      fn: async () => {
        const backupsBefore = backupDirNames().sort();

        // Capture the SHOWN error text so the FRIENDLY_ERRORS Chinese mapping is
        // asserted end-to-end (core error code → errorMessage → UI), not just resolve.
        const errors = patchShowErrorMessage();
        try {
          // PRESET_NOT_FOUND → showErrorMessage (non-modal) → command resolves.
          await withTimeout(
            Promise.resolve(vscode.commands.executeCommand(CMD.applyPreset, "no-such-preset")),
            10_000,
            "applyPreset(no-such) should resolve",
          );

          // Garbage bytes are not a zip → BACKUP_IMPORT_INVALID → resolves, no side effects.
          const corruptZip = path.join(os.tmpdir(), `ocm-e2e-corrupt-${Date.now()}.zip`);
          fs.writeFileSync(corruptZip, Buffer.from("this is definitely not a zip file", "utf8"));
          try {
            await withTimeout(
              Promise.resolve(vscode.commands.executeCommand(CMD.importBackup, corruptZip)),
              10_000,
              "importBackup(corrupt zip) should resolve",
            );
          } finally {
            fs.rmSync(corruptZip, { force: true });
          }
        } finally {
          errors.restore();
        }
        assert.ok(
          errors.messages.some((message) => message.includes("模板不存在")),
          `PRESET_NOT_FOUND must surface the Chinese friendly text, got: ${errors.messages.join(" | ")}`,
        );
        assert.ok(
          errors.messages.some((message) => message.includes("备份压缩包无效或已损坏")),
          `BACKUP_IMPORT_INVALID must surface the Chinese friendly text, got: ${errors.messages.join(" | ")}`,
        );
        assert.deepEqual(backupDirNames().sort(), backupsBefore, "corrupt import must not create backups");

        // Cancelled QuickPick (showPresetQuickPick without a programmatic arg) must
        // resolve instead of hanging headless — modal-regression sentinel.
        const patch = patchShowQuickPick(() => undefined);
        try {
          await withTimeout(
            Promise.resolve(vscode.commands.executeCommand(CMD.showPresetQuickPick)),
            10_000,
            "showPresetQuickPick (cancelled) should resolve",
          );
        } finally {
          patch.restore();
        }
        assert.equal(patch.engaged(), true, "showPresetQuickPick must have opened the QuickPick");
      },
    },
    {
      name: "quotaRefresh opens the quota panel: 4 unconfigured groups, no auth.json created",
      fn: async () => {
        const dataHome = process.env.XDG_DATA_HOME ?? "";
        const authFile = path.join(dataHome, "opencode", "auth.json");
        assert.equal(fs.existsSync(authFile), false, "fake HOME must not carry opencode credentials");

        const bridge = await openQuotaPanelCaptured(CMD.quotaRefresh);

        // Boot pushes a full-refresh snapshot even without credentials (all unconfigured,
        // zero network requests).
        await pollUntil(
          () => quotaSnapshots(bridge).some((message) => message.snapshot.providers.length === 4),
          15_000,
          "quota panel boot must push a 4-provider snapshot",
        );
        const boot = quotaSnapshots(bridge)[0];
        for (const provider of boot.snapshot.providers) {
          assert.equal(provider.configured, false, `${provider.providerId} must report unconfigured`);
          assert.equal(provider.error, null, `${provider.providerId} must carry no error`);
        }
        assert.equal(fs.existsSync(authFile), false, "no credentials may be created by a credential-free refresh");

        // Solo refresh of one provider through the panel protocol.
        bridge.deliver({ type: "quotaRefresh", payload: { providerId: "kimi" } });
        await pollUntil(
          () => quotaSnapshots(bridge).length >= 2,
          15_000,
          "solo kimi refresh must push an updated snapshot",
        );
        const solo = quotaSnapshots(bridge)[quotaSnapshots(bridge).length - 1];
        assert.ok(
          solo.snapshot.providers.some((provider) => provider.providerId === "kimi" && !provider.configured),
          "solo refresh must keep unconfigured kimi without credentials",
        );
        assert.equal(fs.existsSync(authFile), false, "solo refresh must not create credentials either");
      },
    },
    {
      name: "quotaSaveMimoCookie roundtrip: invalid rejected, valid persisted + mimo refresh",
      fn: async () => {
        assert.ok(quotaBridge, "quota panel must still be open from the previous step");
        const bridge = quotaBridge;
        const quotaJson = path.join(configDir, "quota.json");

        // "garbage" fails normalizeMimoCookie → MIMO_COOKIE_INVALID → friendly Chinese error.
        bridge.deliver({ type: "quotaSaveMimoCookie", payload: { cookie: "garbage" } });
        await pollUntil(
          () =>
            bridge.outbound.some(
              (message) =>
                message.type === "quotaConfigSaved" &&
                typeof message.payload === "object" &&
                message.payload !== null &&
                (message.payload as { ok?: unknown }).ok === false,
            ),
          10_000,
          "invalid cookie must produce a quotaConfigSaved(ok:false) reply",
        );
        const rejected = bridge.outbound
          .filter((message) => message.type === "quotaConfigSaved")
          .map((message) => message.payload as { ok: boolean; error?: string })
          .pop();
        assert.match(rejected?.error ?? "", /格式无法识别/, "the rejection must carry the friendly Chinese message");
        assert.equal(fs.existsSync(quotaJson), false, "an invalid cookie must not be persisted");

        // A well-formed cookie persists normalized and triggers a mimo-only refresh.
        bridge.deliver({
          type: "quotaSaveMimoCookie",
          payload: { cookie: "Cookie: junk=1; api-platform_serviceToken=abc; userId=42" },
        });
        await pollUntil(
          () =>
            bridge.outbound.some(
              (message) =>
                message.type === "quotaConfigSaved" &&
                typeof message.payload === "object" &&
                message.payload !== null &&
                (message.payload as { ok?: unknown }).ok === true,
            ),
          10_000,
          "valid cookie must produce a quotaConfigSaved(ok:true) reply",
        );
        assert.ok(fs.existsSync(quotaJson), "valid cookie must persist quota.json");
        const saved = JSON.parse(fs.readFileSync(quotaJson, "utf8")) as { mimo?: { cookie?: string } };
        assert.equal(saved.mimo?.cookie, "api-platform_serviceToken=abc; userId=42");

        // The post-save mimo refresh marks the provider configured (network result may be
        // an error in the sandbox, but configured must flip to true).
        const snapshotsBefore = quotaSnapshots(bridge).length;
        await pollUntil(
          () =>
            quotaSnapshots(bridge)
              .slice(snapshotsBefore)
              .some((message) =>
                message.snapshot.providers.some((provider) => provider.providerId === "mimo" && provider.configured),
              ),
          25_000,
          "post-save mimo refresh must report MiMo as configured",
        );
      },
    },
    {
      name: "quotaConfigureMimo reveals the panel focused on the MiMo group",
      fn: async () => {
        assert.ok(quotaBridge, "quota panel must still be open from the previous step");
        const bridge = await openQuotaPanelCaptured(CMD.quotaConfigureMimo);
        await pollUntil(
          () =>
            bridge.outbound.some(
              (message) =>
                message.type === "quotaInit" &&
                typeof message.payload === "object" &&
                message.payload !== null &&
                (message.payload as { focusProvider?: unknown }).focusProvider === "mimo",
            ),
          10_000,
          "quotaConfigureMimo must re-init the panel focused on MiMo",
        );
      },
    },
    {
      name: "opencodeExplorer.focus and refreshTree both resolve",
      fn: async () => {
        await withTimeout(
          Promise.resolve(vscode.commands.executeCommand("opencodeExplorer.focus")),
          10_000,
          "opencodeExplorer.focus should resolve",
        );
        await withTimeout(
          Promise.resolve(vscode.commands.executeCommand(CMD.refreshTree)),
          10_000,
          "refreshTree should resolve",
        );
      },
    },
  ];
}

/**
 * Fetch the bridge for a panel that is ALREADY open (the save/apply/rename steps
 * reuse one editor session). Fails loudly when the panel was closed or keyed
 * under a different name.
 */
async function openPresetEditorReused(name: string): Promise<PanelBridge> {
  // The panel for `name` is open from an earlier step, so editPreset short-circuits
  // with reveal() and createWebviewPanel never fires — verify reachability through
  // the B2 host→webview bridge instead; its openPanels keying is the same map the
  // inbound listener lives behind.
  const reachable = await vscode.commands.executeCommand(TEST_BRIDGE.presetEditorPostMessage, name, {
    type: "modelsUpdated",
    payload: { models: [] },
  });
  assert.equal(reachable, true, `expected an open preset editor panel for ${name}`);
  return heldBridges.get(name) ?? assert.fail(`no captured bridge held for open panel ${name}`);
}

export async function run(): Promise<void> {
  const cases = tests();
  console.log(`[e2e:suite] OpenCode Config Manager smoke — ${cases.length} checks`);
  for (const testCase of cases) {
    try {
      await testCase.fn();
      console.log(`  PASS ${testCase.name}`);
    } catch (error) {
      console.error(`  FAIL ${testCase.name}`);
      console.error(error);
      throw new Error(`e2e smoke failed at "${testCase.name}" — see errors above`);
    }
  }
  console.log(`[e2e:suite] all ${cases.length} checks passed`);
}
