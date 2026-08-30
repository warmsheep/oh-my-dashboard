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
import { parseSafe, setValues, validate } from "../../../src/core/jsoncEditor";
import { PresetService } from "../../../src/core/presetService";
import type { JsoncError, Preset } from "../../../src/core/types";
import { OPENCODE_SETTINGS } from "../../../src/shared/protocol";
import type { ManagerTab, RecordAggregate } from "../../../src/shared/protocol";
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

/**
 * The manager page's six tab ids — a value mirror of webview-ui's MANAGER_TABS
 * (webview sources are not importable from this extension-host bundle), typed
 * against the shared ManagerTab union so id drift fails compilation here too.
 */
const MANAGER_TAB_IDS: readonly ManagerTab[] = ["config", "opencode", "quota", "settings", "preset", "skills"];

interface TestCase {
  name: string;
  fn: () => Promise<void>;
}

let configDir = "";
let presetFile = "";
let manualBackupDirName = "";
let importedBackupDirName = "";

/**
 * The ONE captured bridge of the singleton manager panel (模板/额度/设置 tabs).
 * Whichever section opens/captures the panel first sets it; later reveals reuse
 * it (reveal never calls createWebviewPanel).
 */
let managerBridge: PanelBridge | undefined;

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
// Preset tab webview bridge (webview↔host protocol roundtrip).
//
// The preset editor rides the merged manager panel (模板 tab); the panel is a
// singleton, so ALL sections share ONE captured bridge (`managerBridge`). To
// drive SAVE messages (webview→host) we wrap vscode.window.createWebviewPanel
// while the panel is CREATED (first open) and capture:
//   - the real onDidReceiveMessage listener  → deliver save/dirty/cancel with
//   - panel.webview.postMessage              → observe {type:'result'} replies
// The real webview (React bundle) keeps running untouched — the wrappers only
// tee into the same calls the extension already makes.
//
// CONTRACT: reading lastReply() right after deliverSave() relies on the host's
// save handling completing SYNCHRONOUSLY (core save/rename/apply are sync fs,
// so the reply is already in `outbound` when deliver returns). If that ever
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

/**
 * Open the manager panel's 模板 tab on `name` while capturing its bridge.
 * First call creates the panel (createWebviewPanel fires → capture); later
 * calls only reveal it and reuse the held manager bridge. Opening is decoupled
 * from the webview handshake (merged-panel policy), so the boot/reveal init is
 * awaited by POLLING for an init message carrying the requested preset name.
 */
async function openPresetTabCaptured(name: string): Promise<PanelBridge> {
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
  const streamLengthBefore = managerBridge?.outbound.length ?? 0;
  try {
    await withTimeout(
      Promise.resolve(vscode.commands.executeCommand(CMD.editPreset, name)),
      20_000,
      `editPreset(${name}) must resolve once the manager panel tab is open`,
    );
  } finally {
    windowApi.createWebviewPanel = original;
  }
  let held: PanelBridge;
  if (bridge !== undefined) {
    assert.ok(managerBridge === undefined, "the manager panel must be captured exactly once");
    managerBridge = bridge;
    held = bridge;
  } else {
    assert.ok(managerBridge, "editPreset reveal must reuse the previously captured manager bridge");
    held = managerBridge;
  }
  await pollUntil(
    () =>
      held.outbound
        .slice(streamLengthBefore)
        .some(
          (message) =>
            message.type === "init" && (message.payload as { preset?: { name?: unknown } })?.preset?.name === name,
        ),
    20_000,
    `the 模板 tab must receive an init carrying preset ${name}`,
  );
  return held;
}

/**
 * Reveal the already-open manager panel on `name`'s 模板 tab (session switch) and
 * wait for the fresh init — the preset-editor analog of a reveal-reuse step.
 */
async function openPresetTabReused(name: string): Promise<PanelBridge> {
  assert.ok(managerBridge, "manager panel must still be open from the previous step");
  const held = managerBridge;
  const before = held.outbound.length;
  await withTimeout(
    Promise.resolve(vscode.commands.executeCommand(CMD.editPreset, name)),
    20_000,
    `editPreset(${name}) reveal must resolve`,
  );
  await pollUntil(
    () =>
      held.outbound
        .slice(before)
        .some(
          (message) =>
            message.type === "init" && (message.payload as { preset?: { name?: unknown } })?.preset?.name === name,
        ),
    20_000,
    `the reused 模板 tab must receive a fresh init for ${name}`,
  );
  return held;
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
// Quota-view assertions — messages from the SAME manager panel bridge declared
// above (the quota tab rides the merged panel).
// ---------------------------------------------------------------------------

interface QuotaSnapshotMessage {
  snapshot: {
    providers: { providerId: string; configured: boolean; error: string | null; windows: unknown[] }[];
    fetchedAt: string;
  };
  visibility?: Record<string, boolean>;
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

// ---------------------------------------------------------------------------
// Settings view assertions — the manager panel carries the settings tab, so
// settingsInit rides the SAME bridge as the quota messages.
// ---------------------------------------------------------------------------

interface SettingsInitMessage {
  settings: {
    categories: Record<string, { enabled: boolean; intervalSeconds: number }>;
    quotaRefreshSeconds: number;
  };
}

function settingsInits(bridge: PanelBridge): SettingsInitMessage[] {
  return bridge.outbound
    .filter(
      (message): message is PanelMessage & { payload: SettingsInitMessage } =>
        message.type === "settingsInit" &&
        typeof message.payload === "object" &&
        message.payload !== null &&
        typeof (message.payload as SettingsInitMessage).settings?.categories === "object",
    )
    .map((message) => message.payload);
}

function settingsSavedReplies(bridge: PanelBridge): { ok: boolean }[] {
  return bridge.outbound
    .filter(
      (message): message is PanelMessage & { payload: { ok: boolean } } =>
        message.type === "settingsSaved" &&
        typeof message.payload === "object" &&
        message.payload !== null &&
        typeof (message.payload as { ok?: unknown }).ok === "boolean",
    )
    .map((message) => message.payload);
}

// ---------------------------------------------------------------------------
// OpenCode/OMO tab assertions — the two write-through setting channels ride the
// SAME manager panel bridge (opencodeInit boot pushes + per-key saved replies).
// ---------------------------------------------------------------------------

/** Boot/refresh payload of the OpenCode tab (values keyed by OPENCODE_SETTINGS keys). */
interface OpencodeInitMessage {
  values: Record<string, unknown>;
  configPath: string;
  models: unknown[];
  /** 权限 group read aggregate (batch 2): string shorthand + per-tool actions + pattern-object tools. */
  permission?: { shorthand?: unknown; tools?: Record<string, unknown>; advancedTools?: unknown[] };
  /** 终端界面 group face (batch 2): current tui.json theme + the tui.json path. */
  tui?: { theme?: unknown; path?: unknown };
  /** 命令/格式化/LSP/MCP/供应商/参考仓库 group read aggregates (batch 4 + batch-5 per-leaf migration): one per recordEditor path root; provider and references ride through unasserted. */
  records?: {
    command?: RecordAggregate;
    formatter?: RecordAggregate;
    lsp?: RecordAggregate;
    mcp?: RecordAggregate;
    provider?: RecordAggregate;
  };
}

function opencodeInits(bridge: PanelBridge): OpencodeInitMessage[] {
  return bridge.outbound
    .filter(
      (message): message is PanelMessage & { payload: OpencodeInitMessage } =>
        message.type === "opencodeInit" &&
        typeof message.payload === "object" &&
        message.payload !== null &&
        typeof (message.payload as OpencodeInitMessage).configPath === "string" &&
        typeof (message.payload as OpencodeInitMessage).values === "object",
    )
    .map((message) => message.payload);
}

/** Saved-reply shape shared by opencodeSettingSaved / omoSettingSaved (key echo on !ok). */
interface SettingSavedReply {
  ok: boolean;
  key?: string;
  error?: string;
}

function settingSavedReplies(
  bridge: PanelBridge,
  type: "opencodeSettingSaved" | "omoSettingSaved",
): SettingSavedReply[] {
  return bridge.outbound
    .filter(
      (message): message is PanelMessage & { payload: SettingSavedReply } =>
        message.type === type &&
        typeof message.payload === "object" &&
        message.payload !== null &&
        typeof (message.payload as SettingSavedReply).ok === "boolean",
    )
    .map((message) => message.payload);
}

/** Entries map of one record slot (command/formatter/lsp/mcp) from an init message. */
function recordEntriesOf(
  init: OpencodeInitMessage,
  slot: "command" | "formatter" | "lsp" | "mcp",
): Record<string, unknown> {
  return init.records?.[slot]?.entries ?? {};
}

/**
 * Poll a config value until it equals the expected value — config.update()
 * resolving does NOT guarantee the extension host's in-memory snapshot has
 * reloaded yet (the change broadcasts back asynchronously), so post-save
 * assertions must poll instead of reading once.
 */
async function pollConfigValue(key: string, expected: unknown, message: string): Promise<void> {
  await pollUntil(
    () => vscode.workspace.getConfiguration("opencodeConfigManager").get(key) === expected,
    10_000,
    message,
  );
}

/** Open (or reveal) the manager panel on the FIRST (配置) tab while capturing its bridge; polls for the boot settingsInit. */
async function openSettingsPanelCaptured(commandId: string): Promise<PanelBridge> {
  const windowApi = vscode.window as unknown as {
    createWebviewPanel: (...args: unknown[]) => vscode.WebviewPanel;
  };
  const original = windowApi.createWebviewPanel;
  let bridge: PanelBridge | undefined;
  // Snapshot the ALREADY-open panel's stream BEFORE the command: the reveal posts
  // (managerNavigate/settingsInit) land during executeCommand, so counting after
  // it resolves would slice them out of the "new messages" window forever.
  const heldBefore = managerBridge;
  const heldCount = heldBefore?.outbound.length ?? 0;
  windowApi.createWebviewPanel = (...args: unknown[]) => {
    const panel = original.apply(windowApi, args);
    const webview = panel.webview as unknown as {
      onDidReceiveMessage: (listener: (raw: unknown) => void, ...rest: unknown[]) => vscode.Disposable;
      postMessage: (message: unknown) => Thenable<boolean>;
    };
    const capture: PanelBridge = {
      deliver: (): void => {
        throw new Error("onDidReceiveMessage listener was never registered for the captured manager panel");
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
      Promise.resolve(vscode.commands.executeCommand(commandId)),
      20_000,
      `${commandId} must resolve once the manager panel tab is open`,
    );
  } finally {
    windowApi.createWebviewPanel = original;
  }
  // Reveal of an ALREADY-open singleton panel never calls createWebviewPanel — reuse
  // the held bridge instead (the settingsInit re-push lands there).
  if (bridge === undefined) {
    assert.ok(heldBefore, "manager panel reveal must reuse the previously captured bridge");
    await pollUntil(
      () =>
        heldBefore.outbound
          .slice(heldCount)
          .some(
            (message) =>
              message.type === "managerNavigate" &&
              (message.payload as { tab?: unknown } | undefined)?.tab === "config",
          ),
      10_000,
      "openSettings reveal must navigate the manager panel to the first (配置) tab",
    );
    return heldBefore;
  }
  // Opening is decoupled from the webview handshake (merged-panel policy): the
  // settingsInit push lands asynchronously after the page boots.
  const captured = bridge;
  await pollUntil(
    () => captured.outbound.some((message) => message.type === "settingsInit"),
    20_000,
    "captured manager panel must have received the settingsInit message",
  );
  managerBridge = bridge;
  return bridge;
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
      `${commandId} must resolve once the quota panel tab is open`,
    );
  } finally {
    windowApi.createWebviewPanel = original;
  }
  // Reveal of an ALREADY-open singleton panel never calls createWebviewPanel — reuse
  // the held bridge instead (quotaInit lands there).
  if (bridge === undefined) {
    assert.ok(managerBridge, "manager panel reveal must reuse the previously captured bridge");
    return managerBridge;
  }
  // Opening is decoupled from the webview handshake (bad-network regression): the
  // command resolves at panel creation, so the boot handshake lands asynchronously.
  const captured = bridge;
  await pollUntil(
    () => captured.outbound.some((message) => message.type === "quotaInit"),
    20_000,
    "captured manager panel must have received the quotaInit message",
  );
  managerBridge = bridge;
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
      name: "openTmuxOpencode resolves as a hermetic no-op under ExtensionMode.Test",
      fn: async () => {
        // Test mode skips tmux probes and terminal creation on purpose (the sandbox
        // must never spawn real tmux/opencode processes); the command still resolves
        // without side effects on the terminal set.
        const before = vscode.window.terminals.length;
        await vscode.commands.executeCommand(CMD.openTmuxOpencode);
        assert.equal(vscode.window.terminals.length, before, "openTmuxOpencode must not create terminals in Test mode");
      },
    },
    {
      name: "openBaseOpencode resolves as a hermetic no-op under ExtensionMode.Test",
      fn: async () => {
        const before = vscode.window.terminals.length;
        await vscode.commands.executeCommand(CMD.openBaseOpencode);
        assert.equal(vscode.window.terminals.length, before, "openBaseOpencode must not create terminals in Test mode");
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
        // No bundled catalog anymore: removing the LAST entry deletes models.json
        // (an empty local catalog is represented as file absence, never re-seeded).
        assert.equal(fs.existsSync(modelsFile), false, "deleting the last model must remove models.json");
      },
    },
    {
      name: "updateModelCatalog merges fetched provider models, custom models survive",
      fn: async () => {
        const modelsFile = path.join(configDir, "models.json");
        // A user-added custom model on a provider the fake catalog also returns: it must
        // survive the merge (the catalog cannot know about hand-added models). Also
        // seed a stale deprecated id to verify the update prunes it.
        const customId = "deepseek/e2e-custom-model";
        const staleId = "openai/gpt-4";
        await withTimeout(
          Promise.resolve(vscode.commands.executeCommand(CMD.addModel, customId)),
          10_000,
          "addModel must resolve",
        );
        await withTimeout(
          Promise.resolve(vscode.commands.executeCommand(CMD.addModel, staleId)),
          10_000,
          "addModel (stale) must resolve",
        );

        // Intercept global fetch (the command resolves it at call time) with a minimal
        // models.dev-shaped payload: deepseek + openai, including deprecated and
        // non-tool entries that must never reach models.json.
        const originalFetch = globalThis.fetch;
        const fetchUrls: string[] = [];
        globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
          fetchUrls.push(String(url));
          return new Response(
            JSON.stringify({
              deepseek: {
                id: "deepseek",
                models: {
                  "deepseek-v5-e2e": { name: "DeepSeek V5（e2e）", tool_call: true },
                  "deepseek-chat": { name: "DeepSeek Chat", tool_call: true },
                  "deepseek-tts": { name: "DeepSeek TTS", tool_call: false },
                },
              },
              openai: {
                id: "openai",
                models: {
                  "gpt-4": { name: "GPT-4", tool_call: true, status: "deprecated" },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as typeof fetch;
        try {
          await withTimeout(
            Promise.resolve(vscode.commands.executeCommand(CMD.updateModelCatalog)),
            20_000,
            "updateModelCatalog must resolve against the patched fetch",
          );
        } finally {
          globalThis.fetch = originalFetch;
        }
        assert.ok(
          fetchUrls.some((url) => url.includes("models.dev")),
          "the update must have fetched the models.dev catalog",
        );
        assert.ok(
          fetchUrls.every((url) => url.includes("models.dev")),
          "the patched window must not have answered any unrelated fetch (isolation)",
        );

        const after = JSON.parse(fs.readFileSync(modelsFile, "utf8")) as {
          models: { provider: string; model: string }[];
        };
        const ids = after.models.map((m) => `${m.provider}/${m.model}`);
        assert.ok(ids.includes("deepseek/deepseek-v5-e2e"), "fresh upstream model must be merged in");
        assert.ok(ids.includes(customId), "custom model must survive the update");
        assert.ok(ids.includes("deepseek/deepseek-chat"), "replaced upstream entry must be present");
        assert.ok(!ids.includes("deepseek/deepseek-tts"), "non-tool (TTS) model must be filtered out");
        assert.ok(!ids.includes(staleId), "deprecated model must be pruned from the local list");

        await executeDeleteModel(customId);
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
      name: "editPreset('e2e-preset') opens the manager panel's 模板 tab and resolves (≤15s)",
      fn: async () => {
        // The preset editor rides the merged manager page (manager.html); opening
        // is decoupled from the webview handshake — the command resolves at panel
        // creation and the boot init lands asynchronously.
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension);
        const distWebview = path.join(extension.extensionUri.fsPath, "dist-webview");
        assert.ok(
          fs.existsSync(path.join(distWebview, "manager.html")),
          "dist-webview/manager.html missing — run.mjs must copy webview-ui/build first",
        );
        await openPresetTabCaptured(PRESET_NAME);
      },
    },
    {
      name: "模板 tab list view: boot + navigate push presetList; presetEdit starts the session in-panel",
      fn: async () => {
        try {
          await vscode.commands.executeCommand(CMD.capturePreset, "e2e-list");
          const bridge = await openPresetTabReused(PRESET_NAME);

          // Boot push (fired at ready during the previous test) and the navigate
          // push (this reveal) both deliver the preset list powering the default view.
          const listNames = (message: PanelMessage | undefined): string[] => {
            const presets = (message?.payload as { presets?: Array<{ name?: unknown }> } | undefined)?.presets ?? [];
            return presets.map((preset) => String(preset.name));
          };
          const lists = bridge.outbound.filter((message) => message.type === "presetList");
          assert.ok(lists.length >= 2, "boot AND navigate must each push a presetList message");
          // Temporal contract of this assertion: the boot push predates the
          // capturePreset("e2e-list") call above, so only the reveal-time push is
          // guaranteed to list it.
          const latestNames = listNames(lists[lists.length - 1]);
          assert.ok(
            latestNames.includes(PRESET_NAME),
            `latest presetList must contain ${PRESET_NAME}, got: ${latestNames.join(",")}`,
          );
          assert.ok(
            latestNames.includes("e2e-list"),
            `latest presetList must contain e2e-list, got: ${latestNames.join(",")}`,
          );

          // In-panel click (no tree/context menu): presetEdit begins the named
          // session through the same begin/init path the editPreset command drives.
          const before = bridge.outbound.length;
          bridge.deliver({ type: "presetEdit", payload: { name: "e2e-list" } });
          await pollUntil(
            () =>
              bridge.outbound
                .slice(before)
                .some(
                  (message) =>
                    message.type === "init" &&
                    (message.payload as { preset?: { name?: unknown } })?.preset?.name === "e2e-list",
                ),
            5_000,
            "presetEdit(e2e-list) must produce an init for e2e-list",
          );

          // A malformed presetEdit (bad payload shape) is dropped without a reply.
          const beforeGarbage = bridge.outbound.length;
          bridge.deliver({ type: "presetEdit", payload: { name: "" } });
          await new Promise((resolve) => setTimeout(resolve, 200));
          assert.equal(
            bridge.outbound.slice(beforeGarbage).some((message) => message.type === "init"),
            false,
            "malformed presetEdit must not produce an init",
          );

          // EXTERNAL mutation sync: a tree-side capture (refreshAll → refreshViews)
          // must re-push the preset list to the open panel, same contract as the
          // models/settings external-change pushes.
          const beforeCapture = bridge.outbound.length;
          await vscode.commands.executeCommand(CMD.capturePreset, "e2e-ext");
          await pollUntil(
            () =>
              bridge.outbound
                .slice(beforeCapture)
                .some((message) => message.type === "presetList" && listNames(message).includes("e2e-ext")),
            10_000,
            "tree-side capturePreset must re-push presetList containing e2e-ext to the open panel",
          );
        } finally {
          // Leave no fixture behind: later tests snapshot the presets dir.
          fs.rmSync(path.join(configDir, "presets", "e2e-list.json"), { force: true });
          fs.rmSync(path.join(configDir, "presets", "e2e-ext.json"), { force: true });
        }
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

        const bridge = await openPresetTabCaptured(WV_PRESET);
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

        // Same manager panel as the previous step (singleton, session switch).
        const bridge = await openPresetTabReused(WV_PRESET);
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

        const bridge = await openPresetTabReused(WV_PRESET);
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

        // Single-panel era: re-keying is gone, but the session must FOLLOW the
        // rename — reopening the new name reveals the same panel and its init
        // carries the renamed preset.
        const renamedBridge = await openPresetTabReused(WV_PRESET_RENAMED);
        assert.equal(renamedBridge, bridge, "editPreset(newName) must reuse the open manager panel");
      },
    },
    {
      name: "webview save with an invalid name is rejected, nothing written",
      fn: async () => {
        const presetsDir = path.join(configDir, "presets");
        const before = fs.readdirSync(presetsDir).sort();

        const bridge = await openPresetTabReused(WV_PRESET_RENAMED);
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

    // ---- Section 4b: 配置 tab protocol (same manager panel bridge) ------------
    {
      name: "config tab: boot configInit carries live assignment rows, skills and the write target",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        // Boot push (ready handler): rows carry the seeded fixture assignment, skills the
        // seeded fake skill (frontmatter description), target the legacy file (~/.omo is
        // only created by a later Section 5 step).
        await pollUntil(
          () =>
            bridge.outbound.some((message) => {
              if (message.type !== "configInit" || typeof message.payload !== "object" || message.payload === null) {
                return false;
              }
              const payload = message.payload as {
                rows?: { section?: string; name?: string; model?: string | null; variant?: string | null }[];
                skills?: { name?: string; description?: string; scope?: string }[];
                target?: { kind?: string; path?: string };
              };
              const row = payload.rows?.find((r) => r.section === "agents" && r.name === "hephaestus");
              const skill = payload.skills?.find((s) => s.name === "e2e-skill");
              return (
                row?.model === "zhipuai-coding-plan/glm-5.2" &&
                row?.variant === "medium" &&
                skill?.description === "e2e 技能（配置页展示用）" &&
                skill?.scope === "global" &&
                payload.target?.kind === "legacy" &&
                payload.target?.path === path.join(configDir, "oh-my-opencode.json")
              );
            }),
          20_000,
          "boot configInit must carry the seeded agent row, fake skill and legacy target",
        );
        // Batch-3 boot contract: the OMO misc values ride the SAME boot configInit.
        // The fixture sets none of the new descriptors EXCEPT tmux — its pre-seeded
        // tmux block reads back through tmuxParams (enum leaf present, isolation
        // leaf unset → null); the tmuxParams write test below re-seeds that block.
        const bootMessage = bridge.outbound.find((message) => message.type === "configInit");
        assert.ok(bootMessage, "the boot configInit must be captured in the outbound stream");
        const omo = (bootMessage.payload as { omo?: Record<string, unknown> }).omo;
        for (const key of [
          "disabledMcps",
          "disabledCommands",
          "browserAutomation",
          "websearchProvider",
          "gitMaster",
          "teamModeLimits",
          "agentOrder",
        ]) {
          assert.equal(omo?.[key], null, `boot omo.${key} must read null on the fresh sandbox`);
        }
        assert.deepEqual(
          omo?.tmuxParams,
          { layout: "main-vertical", main_pane_size: 60, isolation: null },
          "boot omo.tmuxParams must mirror the fixture's tmux block with the isolation leaf null",
        );
        // Batch-5 boot contract: the fixture seeds an `agents` block but none of the
        // per-agent leaf keys, so the four agent-map kinds read as EMPTY maps (a null
        // would mean the whole `agents` block were missing); the seven scalar/shallow
        // kinds read null — the fixture carries no claude_code / keyword_detector /
        // goal / codegraph / monitor / i18n / notification keys.
        for (const key of [
          "claudeCode",
          "keywordExpansions",
          "goalParams",
          "codegraph",
          "monitorParams",
          "i18nLocale",
          "notificationForce",
        ]) {
          assert.equal(omo?.[key], null, `boot omo.${key} must read null on the fresh sandbox`);
        }
        for (const key of ["agentUltrawork", "agentCompaction", "agentPrompt", "agentPromptAppend"]) {
          assert.deepEqual(
            omo?.[key],
            {},
            `boot omo.${key} must read an empty map — agents exists but no agent sets the leaf`,
          );
        }
      },
    },
    {
      name: "configSetModel writes the live agent config, replies ok, re-pushes configInit",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        const initsBefore = bridge.outbound.filter((message) => message.type === "configInit").length;

        bridge.deliver({
          type: "configSetModel",
          payload: { section: "agents", name: "hephaestus", model: "zhipuai/glm-4.7", variant: "high" },
        });
        await pollUntil(
          () =>
            bridge.outbound.some(
              (message) =>
                message.type === "configModelSaved" &&
                typeof message.payload === "object" &&
                message.payload !== null &&
                (message.payload as { ok?: unknown }).ok === true,
            ),
          10_000,
          "configSetModel must produce a configModelSaved(ok:true) reply",
        );
        // The refreshed configInit (handler push; the watcher echo may add one more)
        // must carry the just-written assignment.
        await pollUntil(
          () =>
            bridge.outbound.slice(initsBefore).some(
              (message) =>
                message.type === "configInit" &&
                (
                  message.payload as {
                    rows?: { section?: string; name?: string; model?: string | null; variant?: string | null }[];
                  }
                ).rows?.some(
                  (row) =>
                    row.section === "agents" &&
                    row.name === "hephaestus" &&
                    row.model === "zhipuai/glm-4.7" &&
                    row.variant === "high",
                ),
            ),
          10_000,
          "a refreshed configInit carrying the new model must follow the write",
        );

        assertNoJsoncErrors(agentConfig);
        const agent = JSON.parse(fs.readFileSync(agentConfig, "utf8")) as {
          agents: { hephaestus?: Record<string, unknown> };
        };
        assert.equal(agent.agents.hephaestus?.model, "zhipuai/glm-4.7");
        assert.equal(agent.agents.hephaestus?.variant, "high");
      },
    },
    {
      name: "malformed configSetModel (bad section) is rejected without a file write",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        const bytesBefore = fs.readFileSync(agentConfig);

        bridge.deliver({
          type: "configSetModel",
          payload: { section: "bogus", name: "hephaestus", model: "zhipuai/glm-4.7", variant: "high" },
        });
        await pollUntil(
          () =>
            bridge.outbound.some(
              (message) =>
                message.type === "configModelSaved" &&
                typeof message.payload === "object" &&
                message.payload !== null &&
                (message.payload as { ok?: unknown }).ok === false &&
                typeof (message.payload as { error?: unknown }).error === "string" &&
                ((message.payload as { error?: unknown }).error as string).includes("格式无法识别"),
            ),
          10_000,
          "malformed configSetModel must produce a !ok configModelSaved reply",
        );
        assert.ok(
          fs.readFileSync(agentConfig).equals(bytesBefore),
          "a rejected configSetModel must not write the agent config",
        );
      },
    },

    // ---- Section 4c: OpenCode/OMO tab protocol (same manager panel bridge) ----
    {
      name: "OpenCode tab: boot opencodeInit carries all-null fresh values, the sandbox configPath and models",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        // Boot push (ready handler): the always-mounted OpenCode tab body receives
        // its channel regardless of the entry tab (this panel booted via editPreset).
        await pollUntil(() => opencodeInits(bridge).length > 0, 20_000, "boot must push opencodeInit");
        const boot = opencodeInits(bridge)[0];
        // Fresh sandbox: the seeded fixture opencode.json sets none of the descriptors.
        // Product rule (core readOpencodeSettingValues): file-targeted descriptors
        // (tui.json) and the recordEditor/recordMaster kinds (incl. the batch-5
        // mcpEntries migration of the old mcpServers kind) are EXCLUDED from the
        // scalar values map — their data rides the payload's dedicated
        // tui/records fields (next test + the batch-4 section at the chain end).
        const expected: Record<string, unknown> = {};
        for (const setting of OPENCODE_SETTINGS) {
          if (setting.file !== undefined || setting.kind === "recordEditor" || setting.kind === "recordMaster") {
            continue;
          }
          expected[setting.key] = null;
        }
        // Batch-6 exception: the fixture pre-seeds a `plugin` array for the tree-view
        // plugin tests (test/fixtures/opencode.jsonc), so pluginEntries — a scalar-map
        // kind since batch 6 — reads it through on boot. The exact array below mirrors
        // the fixture; asserting it here also proves the pluginList read surfaces
        // string entries (incl. the ~ path form) in the real boot path.
        expected.pluginEntries = [
          "~/.config/opencode/node_modules/oh-my-opencode/dist/index.js",
          "@happycastle/opencode-openmemory@latest",
        ];
        assert.deepEqual(boot.values, expected, "every OPENCODE_SETTINGS key must be present and null");
        // Batch 3: the six new descriptors are all scalar-map kinds (no file target,
        // no dedicated payload face), so the deepEqual above already pins them null —
        // named here so a future descriptor edit (e.g. an accidental `file` route)
        // trips a loudly-labeled assertion instead of silently leaving the map.
        for (const key of ["logLevel", "shell", "subagentDepth", "toolOutput", "attachmentImage", "watcherIgnore"]) {
          assert.equal(boot.values[key], null, `boot values.${key} must read null on the fresh sandbox`);
        }
        // Batch 4 tripwire (mirrors the batch-3 loop above, inverted): the five record
        // descriptors NEVER enter the scalar values map — the recordEditor/recordMaster
        // kinds are read-side excluded, their data rides payload.records instead
        // (asserted in the batch-4 section at the chain end). A descriptor edit that
        // accidentally lets one into values fails here loudly.
        for (const key of ["command", "formatterMaster", "formatterEntries", "lspMaster", "lspEntries"]) {
          assert.equal(
            boot.values[key],
            undefined,
            `boot values.${key} must stay out of the scalar map (record kinds ride payload.records)`,
          );
        }
        assert.equal(
          boot.configPath,
          path.join(configDir, "opencode.json"),
          "configPath must point into the sandbox config dir",
        );
        assert.ok(Array.isArray(boot.models) && boot.models.length > 0, "models must be a non-empty options array");
      },
    },
    {
      name: "OpenCode tab: boot opencodeInit 携带权限聚合、records.mcp 聚合与 tui.json 路径（批量五迁移）",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const boot = opencodeInits(managerBridge)[0];
        assert.ok(boot, "the boot opencodeInit must still be captured");
        // The fixture seeds no `permission` key → all-empty aggregate.
        assert.deepEqual(
          boot.permission,
          { shorthand: null, tools: {}, advancedTools: [] },
          "boot permission aggregate must be empty on a permission-less fixture",
        );
        // Batch-5 migration: the batch-2 mcpServers toggle list is GONE — the mcp face
        // now rides the payload's records.mcp aggregate (mode/entries from the fixture
        // seed). The read surfaces only the descriptor fields — since batch 4 that
        // includes the fixture's `headers` string map (a flat KEY→string leaf passes
        // the stringMap kind), while other advanced keys would stay disk-only
        // (write-side preservation pinned by the mcpEntries write-through test below).
        assert.deepEqual(
          boot.records?.mcp,
          {
            mode: "entries",
            booleanValue: null,
            entries: {
              openmemory: {
                type: "remote",
                url: "https://mcp.example.internal:8787/mcp",
                enabled: true,
                headers: { "x-api-key": "REDACTED-LOCAL-DEV" },
              },
            },
          },
          "boot records.mcp must mirror the fixture's openmemory entry with descriptor fields",
        );
        assert.equal(
          "mcp" in boot,
          false,
          "the legacy payload-level mcp list slot must be gone (batch-5 records.mcp migration)",
        );
        assert.deepEqual(
          boot.tui,
          { theme: null, path: path.join(configDir, "tui.json") },
          "boot tui face must read theme:null and point at the sandbox tui.json",
        );
      },
    },
    {
      name: "opencodeSetSetting writes share:disabled, replies ok, re-pushes opencodeInit, disk follows",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        const initsBefore = opencodeInits(bridge).length;

        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "share", value: "disabled" } });
        await pollUntil(
          () => settingSavedReplies(bridge, "opencodeSettingSaved").some((reply) => reply.ok && reply.key === "share"),
          10_000,
          "opencodeSetSetting(share) must produce an opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBefore)
              .some((init) => init.values.share === "disabled"),
          10_000,
          "a refreshed opencodeInit carrying share:disabled must follow the write",
        );

        // The seeded fixture is REAL JSONC (trailing commas + tabs) — parse with the
        // product's tolerance and prove the edit kept it parseable + preserved $schema.
        assertNoJsoncErrors(opencodeJson);
        const parsed = parseSafe<Record<string, unknown>>(fs.readFileSync(opencodeJson, "utf8")).value;
        assert.ok(parsed !== null && !Array.isArray(parsed), "opencode.json must parse to an object");
        assert.equal(parsed.share, "disabled", 'on-disk opencode.json must contain "share": "disabled"');
        assert.equal(parsed.$schema, "https://opencode.ai/config.json", "the JSONC edit must preserve $schema");
      },
    },
    {
      name: "opencodeSetSetting null write removes the share key (恢复默认)",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        const repliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBefore = opencodeInits(bridge).length;

        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "share", value: null } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "share"),
          10_000,
          "the null write must produce its own opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBefore)
              .some((init) => init.values.share === null),
          10_000,
          "a refreshed opencodeInit carrying share:null must follow the removal",
        );

        assertNoJsoncErrors(opencodeJson);
        const parsed = parseSafe<Record<string, unknown>>(fs.readFileSync(opencodeJson, "utf8")).value;
        assert.ok(parsed !== null && !Array.isArray(parsed), "opencode.json must parse to an object");
        assert.equal("share" in parsed, false, "the null write must remove the share key from disk");
      },
    },
    {
      name: "opencodeSetSetting permissionTools 写 bash:ask，模式对象兄弟键字节级保留",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        // Seed a hand-written pattern-object sibling under permission.edit through the
        // product's own JSONC editor — the per-tool write must never touch it
        // (advanced-rule protection, design red line).
        const seeded = setValues(fs.readFileSync(opencodeJson, "utf8"), [
          { path: ["permission", "edit"], value: { "*.secret": "deny" } },
        ]);
        fs.writeFileSync(opencodeJson, seeded);
        const snippetOf = (text: string): string => /"edit"\s*:\s*\{[^{}]*\}/.exec(text)?.[0] ?? "";
        const snippetBefore = snippetOf(seeded);
        assert.ok(snippetBefore.length > 0, "the seeded pattern sibling must be present before the write");

        const repliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBefore = opencodeInits(bridge).length;
        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "permissionTools", value: { bash: "ask" } } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "permissionTools"),
          10_000,
          "opencodeSetSetting(permissionTools) must produce an opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBefore)
              .some((init) => init.permission?.tools?.bash === "ask"),
          10_000,
          "a refreshed opencodeInit carrying permission.tools.bash:ask must follow the write",
        );

        assertNoJsoncErrors(opencodeJson);
        const after = fs.readFileSync(opencodeJson, "utf8");
        const parsed = parseSafe<Record<string, unknown>>(after).value;
        assert.ok(parsed !== null && !Array.isArray(parsed), "opencode.json must parse to an object");
        const permission = parsed.permission as { bash?: unknown; edit?: unknown } | undefined;
        assert.equal(permission?.bash, "ask", "on-disk permission.bash must be ask");
        assert.deepEqual(permission?.edit, { "*.secret": "deny" }, "the pattern-object sibling must survive the write");
        assert.equal(snippetOf(after), snippetBefore, "the pattern-object sibling must survive byte-identically");
      },
    },
    {
      name: "opencodeSetSetting mcpEntries 写入：remote/local 条目落盘、缺 url 拒绝、null 标记改名/删除、openmemory 兄弟字节级保留",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        // The fixture's openmemory entry carries a `headers` string map (a descriptor
        // field since batch 4, but absent from every value posted below). Writes only
        // touch names present in the posted value, so the whole openmemory block
        // (headers included) must survive byte-identically (same protection contract
        // as the lsp priority leaf).
        const snippetOf = (text: string): string => /"x-api-key"\s*:\s*"REDACTED-LOCAL-DEV"/.exec(text)?.[0] ?? "";
        const snippetBefore = snippetOf(fs.readFileSync(opencodeJson, "utf8"));
        assert.ok(snippetBefore.length > 0, "the fixture's openmemory headers leaf must be present before the writes");

        // Add a remote entry — the pruned entry (type+url only) lands on disk.
        const repliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBefore = opencodeInits(bridge).length;
        const context7Url = "https://mcp.context7.com/mcp";
        bridge.deliver({
          type: "opencodeSetSetting",
          payload: { key: "mcpEntries", value: { context7: { type: "remote", url: context7Url } } },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "mcpEntries"),
          10_000,
          "opencodeSetSetting(mcpEntries context7) must produce an opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBefore)
              .some(
                (init) =>
                  init.records?.mcp?.mode === "entries" &&
                  JSON.stringify(recordEntriesOf(init, "mcp")["context7"]) ===
                    JSON.stringify({ type: "remote", url: context7Url }),
              ),
          10_000,
          "a refreshed opencodeInit carrying records.mcp.entries[context7] must follow the write",
        );
        assertNoJsoncErrors(opencodeJson);
        let parsed = parseSafe<{ mcp?: Record<string, Record<string, unknown>> }>(
          fs.readFileSync(opencodeJson, "utf8"),
        ).value;
        assert.ok(parsed !== null, "opencode.json must parse to an object");
        assert.deepEqual(
          parsed.mcp?.context7,
          { type: "remote", url: context7Url },
          "on-disk mcp.context7 must carry exactly type+url",
        );
        assert.ok(parsed.mcp?.openmemory, "the fixture's openmemory entry must survive the sibling write");

        // Cross-field rule (remote ⇒ url required): the entry fails the kind validator,
        // so the write lands on the generic malformed-message backstop — !ok key echo,
        // no file write.
        const bytesBefore = fs.readFileSync(opencodeJson);
        const repliesBeforeReject = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        bridge.deliver({
          type: "opencodeSetSetting",
          payload: { key: "mcpEntries", value: { broke: { type: "remote" } } },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeReject)
              .some(
                (reply) =>
                  reply.ok === false && reply.key === "mcpEntries" && (reply.error ?? "").includes("格式无法识别"),
              ),
          10_000,
          "the remote-without-url entry must produce a !ok reply echoing the key",
        );
        assert.ok(
          fs.readFileSync(opencodeJson).equals(bytesBefore),
          "the rejected remote-without-url write must leave opencode.json byte-identical",
        );

        // Add a local entry with an explicit enabled:true leaf — boolean true is
        // non-null, so the prune keeps it and disk carries the full triple.
        const docsEntry = { type: "local", command: ["npx", "docs-server"], enabled: true };
        const repliesBeforeDocs = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBeforeDocs = opencodeInits(bridge).length;
        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "mcpEntries", value: { docs: docsEntry } } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeDocs)
              .some((reply) => reply.ok && reply.key === "mcpEntries"),
          10_000,
          "the docs entry write must produce its own opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBeforeDocs)
              .some((init) => JSON.stringify(recordEntriesOf(init, "mcp")["docs"]) === JSON.stringify(docsEntry)),
          10_000,
          "a refreshed opencodeInit carrying records.mcp.entries[docs] (enabled:true included) must follow the write",
        );
        assertNoJsoncErrors(opencodeJson);
        parsed = parseSafe<{ mcp?: Record<string, Record<string, unknown>> }>(
          fs.readFileSync(opencodeJson, "utf8"),
        ).value;
        assert.ok(parsed !== null, "opencode.json must parse to an object");
        assert.deepEqual(
          parsed.mcp?.docs,
          docsEntry,
          "on-disk mcp.docs must carry type+command+enabled (the boolean true leaf is kept)",
        );

        // Rename = old name null + new name set in ONE value (per-name diff semantics).
        const repliesBeforeRename = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        bridge.deliver({
          type: "opencodeSetSetting",
          payload: {
            key: "mcpEntries",
            value: { context7: null, context8: { type: "remote", url: context7Url } },
          },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeRename)
              .some((reply) => reply.ok && reply.key === "mcpEntries"),
          10_000,
          "the rename write must produce its own opencodeSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(opencodeJson);
        parsed = parseSafe<{ mcp?: Record<string, Record<string, unknown>> }>(
          fs.readFileSync(opencodeJson, "utf8"),
        ).value;
        assert.ok(parsed !== null, "opencode.json must parse to an object");
        assert.equal("context7" in (parsed.mcp ?? {}), false, "the old name must be gone after the rename");
        assert.deepEqual(
          parsed.mcp?.context8,
          { type: "remote", url: context7Url },
          "the new name must carry the remote entry",
        );

        // Delete the extra names; only the fixture's openmemory remains, its advanced
        // headers leaf byte-identical throughout.
        const repliesBeforeDelete = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBeforeDelete = opencodeInits(bridge).length;
        bridge.deliver({
          type: "opencodeSetSetting",
          payload: { key: "mcpEntries", value: { context8: null, docs: null } },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeDelete)
              .some((reply) => reply.ok && reply.key === "mcpEntries"),
          10_000,
          "the delete write must produce its own opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBeforeDelete)
              .some(
                (init) =>
                  recordEntriesOf(init, "mcp")["context8"] === undefined &&
                  recordEntriesOf(init, "mcp")["docs"] === undefined,
              ),
          10_000,
          "a refreshed opencodeInit without the deleted mcp names must follow the delete",
        );
        assertNoJsoncErrors(opencodeJson);
        const after = fs.readFileSync(opencodeJson, "utf8");
        parsed = parseSafe<{ mcp?: Record<string, Record<string, unknown>> }>(after).value;
        assert.ok(parsed !== null, "opencode.json must parse to an object");
        assert.deepEqual(
          Object.keys(parsed.mcp ?? {}),
          ["openmemory"],
          "only the fixture's openmemory entry may remain after the deletes",
        );
        assert.equal(snippetOf(after), snippetBefore, "the openmemory headers leaf must survive byte-identically");
      },
    },
    {
      name: "废弃 mcpServers 消息：通用 !ok 兜底回执且不写盘（批量五迁移守卫）",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        const bytesBefore = fs.readFileSync(opencodeJson);
        const repliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;

        // mcpServers was REMOVED in batch 5 (replaced by mcpEntries): the key no longer
        // resolves to a descriptor, so the write lands on the generic malformed-message
        // backstop — a !ok key echo, never a file write.
        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "mcpServers", value: { x: true } } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBefore)
              .some(
                (reply) =>
                  reply.ok === false && reply.key === "mcpServers" && (reply.error ?? "").includes("格式无法识别"),
              ),
          10_000,
          "the stale mcpServers write must produce a !ok reply echoing the key",
        );
        assert.ok(
          fs.readFileSync(opencodeJson).equals(bytesBefore),
          "the stale mcpServers write must leave opencode.json byte-identical",
        );
      },
    },
    {
      name: "opencodeSetSetting instructions 写入数组与 null 删除键",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        const repliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBefore = opencodeInits(bridge).length;

        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "instructions", value: ["./AGENTS.md"] } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "instructions"),
          10_000,
          "opencodeSetSetting(instructions) must produce an opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBefore)
              .some((init) => Array.isArray(init.values.instructions)),
          10_000,
          "a refreshed opencodeInit carrying the instructions array must follow the write",
        );
        assertNoJsoncErrors(opencodeJson);
        let parsed = parseSafe<Record<string, unknown>>(fs.readFileSync(opencodeJson, "utf8")).value;
        assert.ok(parsed !== null && !Array.isArray(parsed), "opencode.json must parse to an object");
        assert.deepEqual(parsed.instructions, ["./AGENTS.md"], "on-disk instructions must be the written array");

        const repliesBeforeRemoval = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "instructions", value: null } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeRemoval)
              .some((reply) => reply.ok && reply.key === "instructions"),
          10_000,
          "the null write must produce its own opencodeSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(opencodeJson);
        parsed = parseSafe<Record<string, unknown>>(fs.readFileSync(opencodeJson, "utf8")).value;
        assert.ok(parsed !== null && !Array.isArray(parsed), "opencode.json must parse to an object");
        assert.equal("instructions" in parsed, false, "the null write must remove the instructions key from disk");
      },
    },
    {
      name: "opencodeSetSetting tuiTheme 写入 tui.json（opencode.json 不受影响），null 删除主题",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        const tuiJson = path.join(configDir, "tui.json");
        assert.equal(fs.existsSync(tuiJson), false, "the sandbox must not carry a tui.json before the first write");
        const opencodeBytesBefore = fs.readFileSync(opencodeJson);
        const repliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBefore = opencodeInits(bridge).length;

        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "tuiTheme", value: "catppuccin" } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "tuiTheme"),
          10_000,
          "opencodeSetSetting(tuiTheme) must produce an opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBefore)
              .some((init) => init.tui?.theme === "catppuccin"),
          10_000,
          "a refreshed opencodeInit carrying tui.theme:catppuccin must follow the write",
        );

        assert.ok(fs.existsSync(tuiJson), "the write must create configDir/tui.json");
        assertNoJsoncErrors(tuiJson);
        let tui = JSON.parse(fs.readFileSync(tuiJson, "utf8")) as { theme?: unknown };
        assert.equal(tui.theme, "catppuccin", "tui.json must carry theme:catppuccin");
        assert.ok(
          fs.readFileSync(opencodeJson).equals(opencodeBytesBefore),
          "the tuiTheme write must not modify opencode.json",
        );

        const repliesBeforeRemoval = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "tuiTheme", value: null } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeRemoval)
              .some((reply) => reply.ok && reply.key === "tuiTheme"),
          10_000,
          "the null write must produce its own opencodeSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(tuiJson);
        tui = JSON.parse(fs.readFileSync(tuiJson, "utf8")) as { theme?: unknown };
        assert.equal("theme" in tui, false, "the null write must remove the theme key from tui.json");
      },
    },
    {
      name: "omoSetSetting writes teamMode:true to the legacy target, configInit re-push carries omo values",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        const configInitsBefore = bridge.outbound.filter((message) => message.type === "configInit").length;

        bridge.deliver({ type: "omoSetSetting", payload: { key: "teamMode", value: true } });
        await pollUntil(
          () => settingSavedReplies(bridge, "omoSettingSaved").some((reply) => reply.ok && reply.key === "teamMode"),
          10_000,
          "omoSetSetting(teamMode) must produce an omoSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            bridge.outbound
              .slice(configInitsBefore)
              .some(
                (message) =>
                  message.type === "configInit" &&
                  (message.payload as { omo?: { teamMode?: unknown } } | undefined)?.omo?.teamMode === true,
              ),
          10_000,
          "a refreshed configInit carrying omo.teamMode:true must follow the write",
        );

        // Legacy target (the sandbox state the config-tab tests above also pin): the
        // value lands at TOP-LEVEL team_mode.enabled — the omo [opencode]-block scope
        // is covered by the omoSettings unit tests.
        assertNoJsoncErrors(agentConfig);
        const agent = JSON.parse(fs.readFileSync(agentConfig, "utf8")) as { team_mode?: { enabled?: unknown } };
        assert.equal(
          agent.team_mode?.enabled,
          true,
          "legacy oh-my-opencode.json must carry top-level team_mode.enabled",
        );
      },
    },
    {
      name: "omoSetSetting omoModels 写 legacy 顶层 models 目录并回推 configInit，null 条目删别名",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        const configInitsBefore = bridge.outbound.filter((message) => message.type === "configInit").length;

        bridge.deliver({
          type: "omoSetSetting",
          payload: { key: "omoModels", value: { "kimi-max": { model: "kimi/kimi-k2", reasoning: "high" } } },
        });
        await pollUntil(
          () => settingSavedReplies(bridge, "omoSettingSaved").some((reply) => reply.ok && reply.key === "omoModels"),
          10_000,
          "omoSetSetting(omoModels) must produce an omoSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            bridge.outbound
              .slice(configInitsBefore)
              .some(
                (message) =>
                  message.type === "configInit" &&
                  (
                    (message.payload as { omo?: { omoModels?: Record<string, unknown> } } | undefined)?.omo
                      ?.omoModels?.["kimi-max"] as { model?: unknown; reasoning?: unknown } | undefined
                  )?.model === "kimi/kimi-k2",
              ),
          10_000,
          'a refreshed configInit carrying omo.omoModels["kimi-max"] must follow the write',
        );

        // Legacy target: `models` is a SHARED-scope key — top level of the target file
        // for both generations (the omo [opencode]-block scope is covered by unit tests).
        assertNoJsoncErrors(agentConfig);
        let agent = JSON.parse(fs.readFileSync(agentConfig, "utf8")) as { models?: Record<string, unknown> };
        assert.deepEqual(
          agent.models?.["kimi-max"],
          { model: "kimi/kimi-k2", reasoning: "high" },
          'legacy target must carry top-level models["kimi-max"] with model+reasoning',
        );

        const repliesBeforeRemoval = settingSavedReplies(bridge, "omoSettingSaved").length;
        bridge.deliver({ type: "omoSetSetting", payload: { key: "omoModels", value: { "kimi-max": null } } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(repliesBeforeRemoval)
              .some((reply) => reply.ok && reply.key === "omoModels"),
          10_000,
          "the null-entry write must produce its own omoSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(agentConfig);
        agent = JSON.parse(fs.readFileSync(agentConfig, "utf8")) as { models?: Record<string, unknown> };
        assert.equal("kimi-max" in (agent.models ?? {}), false, "the null entry must remove the alias from disk");
      },
    },
    {
      name: "omoSetSetting disabledAgents 写 legacy 顶层数组，null 删除键",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        const repliesBefore = settingSavedReplies(bridge, "omoSettingSaved").length;

        bridge.deliver({ type: "omoSetSetting", payload: { key: "disabledAgents", value: ["oracle", "metis"] } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "disabledAgents"),
          10_000,
          "omoSetSetting(disabledAgents) must produce an omoSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(agentConfig);
        let agent = JSON.parse(fs.readFileSync(agentConfig, "utf8")) as { disabled_agents?: unknown };
        assert.deepEqual(
          agent.disabled_agents,
          ["oracle", "metis"],
          "legacy target must carry the top-level disabled_agents array",
        );

        const repliesBeforeRemoval = settingSavedReplies(bridge, "omoSettingSaved").length;
        bridge.deliver({ type: "omoSetSetting", payload: { key: "disabledAgents", value: null } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(repliesBeforeRemoval)
              .some((reply) => reply.ok && reply.key === "disabledAgents"),
          10_000,
          "the null write must produce its own omoSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(agentConfig);
        agent = JSON.parse(fs.readFileSync(agentConfig, "utf8")) as { disabled_agents?: unknown };
        assert.equal("disabled_agents" in agent, false, "the null write must remove the disabled_agents key from disk");
      },
    },
    {
      name: "typed-but-invalid opencodeSetSetting/omoSetSetting get !ok key echoes, nothing written",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        const opencodeBytesBefore = fs.readFileSync(opencodeJson);
        const agentBytesBefore = fs.readFileSync(agentConfig);
        const opencodeRepliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const omoRepliesBefore = settingSavedReplies(bridge, "omoSettingSaved").length;

        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "notAKey", value: "x" } });
        bridge.deliver({ type: "omoSetSetting", payload: { key: "teamMode", value: "bogus" } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(opencodeRepliesBefore)
              .some(
                (reply) =>
                  reply.ok === false && reply.key === "notAKey" && (reply.error ?? "").includes("格式无法识别"),
              ),
          10_000,
          "unknown opencodeSetSetting key must produce a !ok reply echoing the key",
        );
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(omoRepliesBefore)
              .some(
                (reply) =>
                  reply.ok === false && reply.key === "teamMode" && (reply.error ?? "").includes("格式无法识别"),
              ),
          10_000,
          "wrong-typed omoSetSetting value must produce a !ok reply echoing the key",
        );
        assert.ok(
          fs.readFileSync(opencodeJson).equals(opencodeBytesBefore),
          "a rejected opencodeSetSetting must not write opencode.json",
        );
        assert.ok(
          fs.readFileSync(agentConfig).equals(agentBytesBefore),
          "a rejected omoSetSetting must not write the agent config",
        );
      },
    },
    {
      name: "非法值兜底：未知权限工具与非法模型别名的写入收 !ok 回执且不写盘",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        const opencodeBytesBefore = fs.readFileSync(opencodeJson);
        const agentBytesBefore = fs.readFileSync(agentConfig);
        const opencodeRepliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const omoRepliesBefore = settingSavedReplies(bridge, "omoSettingSaved").length;

        // Known descriptors with OUT-OF-KIND values: "hack" is not one of the 15
        // permission tools; "bad alias!" fails the model-alias charset.
        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "permissionTools", value: { hack: "allow" } } });
        bridge.deliver({
          type: "omoSetSetting",
          payload: { key: "omoModels", value: { "bad alias!": { model: "x/y" } } },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(opencodeRepliesBefore)
              .some(
                (reply) =>
                  reply.ok === false && reply.key === "permissionTools" && (reply.error ?? "").includes("格式无法识别"),
              ),
          10_000,
          "an unknown permission tool must produce a !ok reply echoing the key",
        );
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(omoRepliesBefore)
              .some(
                (reply) =>
                  reply.ok === false && reply.key === "omoModels" && (reply.error ?? "").includes("格式无法识别"),
              ),
          10_000,
          "an invalid model alias must produce a !ok reply echoing the key",
        );
        assert.ok(
          fs.readFileSync(opencodeJson).equals(opencodeBytesBefore),
          "the rejected permissionTools write must not write opencode.json",
        );
        assert.ok(
          fs.readFileSync(agentConfig).equals(agentBytesBefore),
          "the rejected omoModels write must not write the agent config",
        );
      },
    },
    {
      name: "tab navigation contract: navigate pushes stay within the six ids; boot feeds both new tab bodies",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        // The opencode/skills tabs have NO command entry point (in-page tab bar only),
        // so their managerNavigate path cannot be captured from the host side — the
        // page-side acceptance of the two new ids is pinned by the webview-ui
        // normalizeManagerTab unit tests. Host-side, this suite pins: every navigate
        // push stays within the six-id union, and both new always-mounted tab bodies
        // received their data channels at boot (opencodeInit / configInit.skills).
        const navigateTabs = bridge.outbound
          .filter((message) => message.type === "managerNavigate")
          .map((message) => (message.payload as { tab?: unknown } | undefined)?.tab);
        assert.ok(navigateTabs.length > 0, "the captured stream must contain managerNavigate pushes");
        for (const tab of navigateTabs) {
          assert.ok(
            typeof tab === "string" && (MANAGER_TAB_IDS as readonly string[]).includes(tab),
            `managerNavigate tab must stay within the six known ids, got: ${String(tab)}`,
          );
        }
        assert.ok(opencodeInits(bridge).length > 0, "boot must have pushed opencodeInit for the OpenCode tab body");
        const skillsFed = bridge.outbound.some((message) => {
          if (message.type !== "configInit" || typeof message.payload !== "object" || message.payload === null) {
            return false;
          }
          const skills = (message.payload as { skills?: { name?: unknown }[] }).skills;
          return Array.isArray(skills) && skills.some((skill) => skill?.name === "e2e-skill");
        });
        assert.ok(skillsFed, "boot must have pushed configInit carrying the skills list for the 技能 tab body");
      },
    },

    // ---- Section 4d: batch-3 descriptors (same manager panel bridge) ---------
    // Placed BEFORE the Section-5 step that seeds ~/.omo/omo.jsonc: the OMO writes
    // here must land in the LEGACY target (top-level keys), matching the batch-2
    // omoSetSetting tests above.
    {
      name: "opencodeSetSetting logLevel 写入 DEBUG 并回推，null 删除键",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        const repliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBefore = opencodeInits(bridge).length;

        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "logLevel", value: "DEBUG" } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "logLevel"),
          10_000,
          "opencodeSetSetting(logLevel) must produce an opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBefore)
              .some((init) => init.values.logLevel === "DEBUG"),
          10_000,
          "a refreshed opencodeInit carrying logLevel:DEBUG must follow the write",
        );
        assertNoJsoncErrors(opencodeJson);
        let parsed = parseSafe<Record<string, unknown>>(fs.readFileSync(opencodeJson, "utf8")).value;
        assert.ok(parsed !== null && !Array.isArray(parsed), "opencode.json must parse to an object");
        assert.equal(parsed.logLevel, "DEBUG", 'on-disk opencode.json must contain "logLevel": "DEBUG"');

        const repliesBeforeRemoval = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "logLevel", value: null } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeRemoval)
              .some((reply) => reply.ok && reply.key === "logLevel"),
          10_000,
          "the null write must produce its own opencodeSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(opencodeJson);
        parsed = parseSafe<Record<string, unknown>>(fs.readFileSync(opencodeJson, "utf8")).value;
        assert.ok(parsed !== null && !Array.isArray(parsed), "opencode.json must parse to an object");
        assert.equal("logLevel" in parsed, false, "the null write must remove the logLevel key from disk");
      },
    },
    {
      name: "omoSetSetting tmuxParams 枚举叶写入：未知兄弟键与注释字节级保留",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        // Re-seed the whole tmux block through the product's JSONC editor (replacing
        // the fixture's default layout), then park an inline comment in front of the
        // key — the per-leaf write below must keep BOTH the unknown sibling leaf and
        // the comment byte-identically (same contract as the permissionTools sibling).
        const seeded = setValues(fs.readFileSync(agentConfig, "utf8"), [
          { path: ["tmux"], value: { layout: "tiled", custom_note: "keep" } },
        ]);
        const comment = "/* e2e: tmux 注释（兄弟保留断言用） */ ";
        const commented = seeded.replace(/"tmux"\s*:/, `${comment}"tmux":`);
        fs.writeFileSync(agentConfig, commented);
        const commentOf = (text: string): string => /\/\* e2e:[^*]*\*\//.exec(text)?.[0] ?? "";
        const noteOf = (text: string): string => /"custom_note"\s*:\s*"keep"/.exec(text)?.[0] ?? "";
        const commentBefore = commentOf(commented);
        const noteBefore = noteOf(commented);
        assert.ok(commentBefore.length > 0, "the seeded comment must be present before the write");
        assert.ok(noteBefore.length > 0, "the seeded custom_note sibling must be present before the write");

        const repliesBefore = settingSavedReplies(bridge, "omoSettingSaved").length;
        const configInitsBefore = bridge.outbound.filter((message) => message.type === "configInit").length;
        bridge.deliver({
          type: "omoSetSetting",
          payload: { key: "tmuxParams", value: { layout: "tiled", main_pane_size: 70, isolation: null } },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "tmuxParams"),
          10_000,
          "omoSetSetting(tmuxParams) must produce an omoSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            bridge.outbound
              .slice(configInitsBefore)
              .some(
                (message) =>
                  message.type === "configInit" &&
                  (message.payload as { omo?: { tmuxParams?: { layout?: unknown; main_pane_size?: unknown } } })?.omo
                    ?.tmuxParams?.layout === "tiled" &&
                  (message.payload as { omo?: { tmuxParams?: { layout?: unknown; main_pane_size?: unknown } } })?.omo
                    ?.tmuxParams?.main_pane_size === 70,
              ),
          10_000,
          "a refreshed configInit carrying omo.tmuxParams layout:tiled + main_pane_size:70 must follow the write",
        );

        assertNoJsoncErrors(agentConfig);
        const after = fs.readFileSync(agentConfig, "utf8");
        // parseSafe, not JSON.parse: the file legitimately carries the seeded JSONC
        // comment at this point.
        const agent = parseSafe<{ tmux?: Record<string, unknown> }>(after).value;
        assert.ok(agent !== null, "agent config must parse to an object");
        assert.equal(agent.tmux?.layout, "tiled", "disk tmux.layout must stay tiled");
        assert.equal(agent.tmux?.main_pane_size, 70, "disk tmux.main_pane_size must be 70");
        assert.equal("isolation" in (agent.tmux ?? {}), false, "the null isolation leaf must not land on disk");
        assert.equal(agent.tmux?.custom_note, "keep", "the unknown sibling leaf must survive the per-leaf write");
        assert.equal(commentOf(after), commentBefore, "the inline comment must survive byte-identically");
        assert.equal(noteOf(after), noteBefore, "the custom_note sibling must survive byte-identically");

        // Strip the seeded comment so later chain steps can keep plain JSON.parse on
        // this file (the Section-5 setAgentModel tests read it with JSON.parse).
        const cleaned = after.replace(comment, "");
        fs.writeFileSync(agentConfig, cleaned);
        assert.doesNotThrow(() => JSON.parse(cleaned), "the legacy file must be strict-JSON clean again");
      },
    },
    {
      name: "omoSetSetting disabledMcps 写 legacy 顶层数组，null 删除键",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        const repliesBefore = settingSavedReplies(bridge, "omoSettingSaved").length;

        bridge.deliver({ type: "omoSetSetting", payload: { key: "disabledMcps", value: ["websearch", "lsp"] } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "disabledMcps"),
          10_000,
          "omoSetSetting(disabledMcps) must produce an omoSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(agentConfig);
        let agent = JSON.parse(fs.readFileSync(agentConfig, "utf8")) as { disabled_mcps?: unknown };
        assert.deepEqual(
          agent.disabled_mcps,
          ["websearch", "lsp"],
          "legacy target must carry the top-level disabled_mcps array",
        );

        const repliesBeforeRemoval = settingSavedReplies(bridge, "omoSettingSaved").length;
        bridge.deliver({ type: "omoSetSetting", payload: { key: "disabledMcps", value: null } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(repliesBeforeRemoval)
              .some((reply) => reply.ok && reply.key === "disabledMcps"),
          10_000,
          "the null write must produce its own omoSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(agentConfig);
        agent = JSON.parse(fs.readFileSync(agentConfig, "utf8")) as { disabled_mcps?: unknown };
        assert.equal("disabled_mcps" in agent, false, "the null write must remove the disabled_mcps key from disk");
      },
    },
    {
      name: "omoSetSetting agentOrder 写入与删除；重复项写入收 !ok 回执且不写盘",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        const repliesBefore = settingSavedReplies(bridge, "omoSettingSaved").length;

        bridge.deliver({
          type: "omoSetSetting",
          payload: { key: "agentOrder", value: ["sisyphus", "oracle", "metis"] },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "agentOrder"),
          10_000,
          "omoSetSetting(agentOrder) must produce an omoSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(agentConfig);
        let agent = JSON.parse(fs.readFileSync(agentConfig, "utf8")) as { agent_order?: unknown };
        assert.deepEqual(
          agent.agent_order,
          ["sisyphus", "oracle", "metis"],
          "legacy target must carry the top-level agent_order array in order",
        );

        // orderedList dedup gate: the duplicate entry fails the kind validator at the
        // protocol layer, so the write gets the malformed-message backstop reply and
        // the file stays byte-identical.
        const bytesBefore = fs.readFileSync(agentConfig);
        const repliesBeforeDupes = settingSavedReplies(bridge, "omoSettingSaved").length;
        bridge.deliver({ type: "omoSetSetting", payload: { key: "agentOrder", value: ["sisyphus", "sisyphus"] } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(repliesBeforeDupes)
              .some(
                (reply) =>
                  reply.ok === false && reply.key === "agentOrder" && (reply.error ?? "").includes("格式无法识别"),
              ),
          10_000,
          "the duplicate-entries write must produce a !ok reply echoing the key",
        );
        assert.ok(
          fs.readFileSync(agentConfig).equals(bytesBefore),
          "the rejected agentOrder write must not touch the agent config",
        );

        const repliesBeforeRemoval = settingSavedReplies(bridge, "omoSettingSaved").length;
        bridge.deliver({ type: "omoSetSetting", payload: { key: "agentOrder", value: null } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(repliesBeforeRemoval)
              .some((reply) => reply.ok && reply.key === "agentOrder"),
          10_000,
          "the null write must produce its own omoSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(agentConfig);
        agent = JSON.parse(fs.readFileSync(agentConfig, "utf8")) as { agent_order?: unknown };
        assert.equal("agent_order" in agent, false, "the null write must remove the agent_order key from disk");
      },
    },
    {
      name: "opencodeSetSetting subagentDepth 整数校验：3.5 拒绝不写盘，3 写入",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        const bytesBefore = fs.readFileSync(opencodeJson);
        const repliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;

        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "subagentDepth", value: 3.5 } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBefore)
              .some(
                (reply) =>
                  reply.ok === false && reply.key === "subagentDepth" && (reply.error ?? "").includes("格式无法识别"),
              ),
          10_000,
          "the fractional write must produce a !ok reply echoing the key",
        );
        assert.ok(
          fs.readFileSync(opencodeJson).equals(bytesBefore),
          "the rejected subagentDepth write must not touch opencode.json",
        );

        const repliesBeforeValid = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBefore = opencodeInits(bridge).length;
        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "subagentDepth", value: 3 } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeValid)
              .some((reply) => reply.ok && reply.key === "subagentDepth"),
          10_000,
          "the integer write must produce an opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBefore)
              .some((init) => init.values.subagentDepth === 3),
          10_000,
          "a refreshed opencodeInit carrying subagentDepth:3 must follow the write",
        );
        assertNoJsoncErrors(opencodeJson);
        const parsed = parseSafe<Record<string, unknown>>(fs.readFileSync(opencodeJson, "utf8")).value;
        assert.ok(parsed !== null && !Array.isArray(parsed), "opencode.json must parse to an object");
        assert.equal(parsed.subagent_depth, 3, "on-disk opencode.json must contain subagent_depth: 3");
      },
    },

    // ---- Section 4f: batch-5 OMO descriptors (same manager panel bridge) --------
    // Same placement contract as Section 4d: BEFORE the Section-5 step that seeds
    // ~/.omo/omo.jsonc, the writes here land in the LEGACY target's top-level keys.
    {
      name: "omoSetSetting agentUltrawork 写 oracle 覆写：兄弟 model 字节级保留；null 条目删叶子不删智能体",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        // The fixture pre-seeds agents.oracle = {model, variant} — the sibling this
        // test must NOT disturb. The prefix regex matches the entry opening through
        // model+variant WITHOUT a closing brace, so the same snippet stays matchable
        // after the nested ultrawork object is appended inside the oracle entry.
        const oraclePrefixOf = (text: string): string =>
          /"oracle"\s*:\s*\{\s*"model"\s*:\s*"zhipuai-coding-plan\/glm-5\.2"\s*,\s*"variant"\s*:\s*"high"/.exec(
            text,
          )?.[0] ?? "";
        const prefixBefore = oraclePrefixOf(fs.readFileSync(agentConfig, "utf8"));
        assert.ok(
          prefixBefore.length > 0,
          "the fixture's oracle model/variant sibling must be present before the write",
        );

        const repliesBefore = settingSavedReplies(bridge, "omoSettingSaved").length;
        const configInitsBefore = bridge.outbound.filter((message) => message.type === "configInit").length;
        bridge.deliver({
          type: "omoSetSetting",
          payload: {
            key: "agentUltrawork",
            value: { oracle: { model: "openai/gpt-5.6-sol", reasoning: "high" } },
          },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "agentUltrawork"),
          10_000,
          "omoSetSetting(agentUltrawork) must produce an omoSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            bridge.outbound.slice(configInitsBefore).some((message) => {
              if (message.type !== "configInit") {
                return false;
              }
              const entry = (
                message.payload as { omo?: { agentUltrawork?: { oracle?: { model?: unknown; reasoning?: unknown } } } }
              )?.omo?.agentUltrawork?.oracle;
              return entry?.model === "openai/gpt-5.6-sol" && entry?.reasoning === "high";
            }),
          10_000,
          "a refreshed configInit carrying omo.agentUltrawork.oracle must follow the write",
        );

        assertNoJsoncErrors(agentConfig);
        const after = fs.readFileSync(agentConfig, "utf8");
        const agent = parseSafe<{ agents?: { oracle?: Record<string, unknown> } }>(after).value;
        assert.ok(agent !== null, "agent config must parse to an object");
        assert.deepEqual(
          agent.agents?.oracle?.ultrawork,
          { model: "openai/gpt-5.6-sol", reasoning: "high" },
          "legacy target must carry top-level agents.oracle.ultrawork with model+reasoning",
        );
        assert.equal(
          agent.agents?.oracle?.model,
          "zhipuai-coding-plan/glm-5.2",
          "the oracle model sibling must survive",
        );
        assert.equal(agent.agents?.oracle?.variant, "high", "the oracle variant sibling must survive");
        assert.equal(
          oraclePrefixOf(after),
          prefixBefore,
          "the oracle model/variant sibling must survive the per-leaf write byte-identically",
        );

        // Per-agent removal: the null entry deletes ONLY the ultrawork leaf — the
        // agents.oracle entry itself (model+variant) must stay intact.
        const repliesBeforeRemoval = settingSavedReplies(bridge, "omoSettingSaved").length;
        bridge.deliver({ type: "omoSetSetting", payload: { key: "agentUltrawork", value: { oracle: null } } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(repliesBeforeRemoval)
              .some((reply) => reply.ok && reply.key === "agentUltrawork"),
          10_000,
          "the null-entry write must produce its own omoSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(agentConfig);
        const afterRemoval = parseSafe<{ agents?: { oracle?: Record<string, unknown> } }>(
          fs.readFileSync(agentConfig, "utf8"),
        ).value;
        assert.ok(afterRemoval !== null, "agent config must parse to an object");
        assert.equal("ultrawork" in (afterRemoval.agents?.oracle ?? {}), false, "the ultrawork leaf must be gone");
        assert.equal(
          afterRemoval.agents?.oracle?.model,
          "zhipuai-coding-plan/glm-5.2",
          "agents.oracle must stay intact after the removal (model)",
        );
        assert.equal(
          afterRemoval.agents?.oracle?.variant,
          "high",
          "agents.oracle must stay intact after the removal (variant)",
        );
      },
    },
    {
      name: "omoSetSetting agentPromptAppend 写 metis 追加文本；null 删除叶子",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        const repliesBefore = settingSavedReplies(bridge, "omoSettingSaved").length;
        const configInitsBefore = bridge.outbound.filter((message) => message.type === "configInit").length;

        bridge.deliver({
          type: "omoSetSetting",
          payload: { key: "agentPromptAppend", value: { metis: "追加提示词内容" } },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "agentPromptAppend"),
          10_000,
          "omoSetSetting(agentPromptAppend) must produce an omoSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            bridge.outbound
              .slice(configInitsBefore)
              .some(
                (message) =>
                  message.type === "configInit" &&
                  (message.payload as { omo?: { agentPromptAppend?: { metis?: unknown } } })?.omo?.agentPromptAppend
                    ?.metis === "追加提示词内容",
              ),
          10_000,
          "a refreshed configInit carrying omo.agentPromptAppend.metis must follow the write",
        );

        assertNoJsoncErrors(agentConfig);
        let agent = parseSafe<{ agents?: { metis?: Record<string, unknown> } }>(
          fs.readFileSync(agentConfig, "utf8"),
        ).value;
        assert.ok(agent !== null, "agent config must parse to an object");
        assert.equal(
          agent.agents?.metis?.prompt_append,
          "追加提示词内容",
          "disk agents.metis.prompt_append must carry the written text",
        );
        assert.equal(agent.agents?.metis?.model, "zhipuai-coding-plan/glm-5.2", "the metis model sibling must survive");

        const repliesBeforeRemoval = settingSavedReplies(bridge, "omoSettingSaved").length;
        bridge.deliver({ type: "omoSetSetting", payload: { key: "agentPromptAppend", value: { metis: null } } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(repliesBeforeRemoval)
              .some((reply) => reply.ok && reply.key === "agentPromptAppend"),
          10_000,
          "the null write must produce its own omoSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(agentConfig);
        agent = parseSafe<{ agents?: { metis?: Record<string, unknown> } }>(fs.readFileSync(agentConfig, "utf8")).value;
        assert.ok(agent !== null, "agent config must parse to an object");
        assert.equal(
          "prompt_append" in (agent.agents?.metis ?? {}),
          false,
          "the null write must remove the prompt_append leaf from disk",
        );
        assert.ok(agent.agents?.metis?.model, "agents.metis must stay intact after the removal");
      },
    },
    {
      name: "omoSetSetting claudeCode 部分写入：null 叶子不落盘，自定义兄弟键字节级保留",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const agentConfig = path.join(configDir, "oh-my-opencode.json");
        // Seed a hand-written sibling under claude_code through the product's own JSONC
        // editor — the per-leaf write below must never touch it (same contract as the
        // permissionTools pattern sibling / lsp priority leaf).
        const seeded = setValues(fs.readFileSync(agentConfig, "utf8"), [
          { path: ["claude_code"], value: { custom_layer: "keep" } },
        ]);
        fs.writeFileSync(agentConfig, seeded);
        const snippetOf = (text: string): string => /"custom_layer"\s*:\s*"keep"/.exec(text)?.[0] ?? "";
        const snippetBefore = snippetOf(seeded);
        assert.ok(snippetBefore.length > 0, "the seeded claude_code sibling must be present before the write");

        const repliesBefore = settingSavedReplies(bridge, "omoSettingSaved").length;
        const configInitsBefore = bridge.outbound.filter((message) => message.type === "configInit").length;
        bridge.deliver({
          type: "omoSetSetting",
          payload: {
            key: "claudeCode",
            value: { mcp: false, commands: null, skills: null, agents: null, hooks: null, plugins: null },
          },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "omoSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "claudeCode"),
          10_000,
          "omoSetSetting(claudeCode) must produce an omoSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            bridge.outbound
              .slice(configInitsBefore)
              .some(
                (message) =>
                  message.type === "configInit" &&
                  (message.payload as { omo?: { claudeCode?: { mcp?: unknown } } })?.omo?.claudeCode?.mcp === false,
              ),
          10_000,
          "a refreshed configInit carrying omo.claudeCode.mcp:false must follow the write",
        );

        assertNoJsoncErrors(agentConfig);
        const after = fs.readFileSync(agentConfig, "utf8");
        const agent = parseSafe<{ claude_code?: Record<string, unknown> }>(after).value;
        assert.ok(agent !== null, "agent config must parse to an object");
        assert.deepEqual(
          agent.claude_code,
          { mcp: false, custom_layer: "keep" },
          "disk claude_code must carry ONLY the non-null descriptor leaf plus the custom sibling — no literal null leaves",
        );
        assert.equal(snippetOf(after), snippetBefore, "the custom sibling must survive the write byte-identically");
      },
    },

    {
      name: "webview cancel clears the preset session but keeps the manager panel open",
      fn: async () => {
        const bridge = await openPresetTabReused(WV_PRESET_RENAMED);
        bridge.deliver({ type: "cancel" });

        // Merged-panel semantics: cancel ends the EDITING SESSION (the page clears
        // itself + the host drops the crash-recovery draft), NOT the shared panel.
        const reachable = await vscode.commands.executeCommand(TEST_BRIDGE.presetEditorPostMessage, "any", {
          type: "modelsUpdated",
          payload: { models: [] },
        });
        assert.equal(reachable, true, "the manager panel must stay open after a preset cancel");

        // The session restarts cleanly on the next editPreset (fresh init).
        await openPresetTabReused(WV_PRESET_RENAMED);

        // Reset the singleton for the quota section below: its first tests patch
        // createWebviewPanel and require a COLD panel (no reveal path).
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await pollUntil(
          async () =>
            (await vscode.commands.executeCommand(TEST_BRIDGE.presetEditorPostMessage, "any", {
              type: "modelsUpdated",
              payload: { models: [] },
            })) === false,
          5_000,
          "manager panel singleton must reset after closeAllEditors",
        );
        managerBridge = undefined;
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

        // A noteExternalRefresh (e.g. the activation warmup at +2s) can land BETWEEN
        // the write and the debounced fire on fast machines, marking the bootstrap
        // content as seen and eating the event. Retry with FRESH content — a real
        // byte change always survives the content dedupe.
        let bootstrapAttempt = 0;
        const writeBootstrap = (): void => {
          bootstrapAttempt += 1;
          fs.writeFileSync(bootstrapFlag, `${JSON.stringify({ attempt: bootstrapAttempt })}\n`);
        };
        writeBootstrap();
        fs.writeFileSync(
          probePreset,
          JSON.stringify({ name: "e2e-watch-probe", appliedAt: "2999-01-01T00:00:00.000Z" }),
        );
        try {
          while (true) {
            try {
              await pollUntil(
                async () => (await statusBarText()).includes("模板: e2e-watch-probe"),
                4_000,
                "watcher must pick up the externally created probe preset",
              );
              break;
            } catch (error) {
              if (bootstrapAttempt >= 3) {
                throw error;
              }
              writeBootstrap();
            }
          }
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
      name: "quotaRefresh resolves even when the webview never boots (opening is never blocked)",
      fn: async () => {
        // Bad-network regression: on code-server a degraded browser link can keep the
        // webview from booting arbitrarily long. The command used to await the ready
        // handshake and dispose the panel after 20s — every status-bar click while the
        // bar showed "?" was silently undone. Opening must resolve unconditionally.
        const windowApi = vscode.window as unknown as {
          createWebviewPanel: (...args: unknown[]) => vscode.WebviewPanel;
        };
        const original = windowApi.createWebviewPanel;
        let deadPanel: vscode.WebviewPanel | undefined;
        windowApi.createWebviewPanel = (...args: unknown[]) => {
          const panel = original.apply(windowApi, args);
          // Swallow the html assignment: no document, no scripts, ready never fires.
          Object.defineProperty(panel.webview, "html", { get: () => "", set: () => undefined });
          deadPanel = panel;
          return panel;
        };
        try {
          await withTimeout(
            Promise.resolve(vscode.commands.executeCommand(CMD.quotaRefresh)),
            5_000,
            "quotaRefresh must resolve without waiting for the webview handshake",
          );
          assert.equal(deadPanel?.visible, true, "the never-booting panel must stay open, not be disposed");
        } finally {
          windowApi.createWebviewPanel = original;
          deadPanel?.dispose(); // reset the singleton so the next quota test opens fresh
        }
      },
    },
    {
      name: "quota panel zombie (booted once, page gone) is probed and recreated on click",
      fn: async () => {
        // Long-idle code-server regression: the webview iframe can die silently without
        // onDidDispose, leaving the singleton pointing at a dead page — every later click
        // only revealed a blank tab. Click must ping the page and recreate it on silence.
        const windowApi = vscode.window as unknown as {
          createWebviewPanel: (...args: unknown[]) => vscode.WebviewPanel;
        };
        const original = windowApi.createWebviewPanel;
        const created: vscode.WebviewPanel[] = [];
        const disposed = new Set<vscode.WebviewPanel>();
        let bridge: PanelBridge | undefined;
        windowApi.createWebviewPanel = (...args: unknown[]) => {
          const panel = original.apply(windowApi, args);
          // Kill the page: the html assignment is swallowed, so no real webview ever
          // boots and nothing will answer the liveness ping.
          Object.defineProperty(panel.webview, "html", { get: () => "", set: () => undefined });
          panel.onDidDispose(() => disposed.add(panel));
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
          const originalPost = webview.postMessage.bind(webview);
          webview.postMessage = (message: unknown) => {
            capture.outbound.push(message as PanelMessage);
            return originalPost(message);
          };
          bridge = capture;
          created.push(panel);
          return panel;
        };
        try {
          await withTimeout(
            Promise.resolve(vscode.commands.executeCommand(CMD.quotaRefresh)),
            5_000,
            "first click must open the panel without waiting for the webview",
          );
          assert.equal(created.length, 1, "first click creates exactly one panel");
          // Forge the one-time boot handshake: the singleton now believes the page is
          // alive (openPanelReady=true) even though no real page exists.
          bridge!.deliver({ type: "ready" });

          await withTimeout(
            Promise.resolve(vscode.commands.executeCommand(CMD.quotaRefresh)),
            5_000,
            "second click must reveal without blocking on the dead page",
          );
          assert.ok(
            bridge!.outbound.some((message) => message.type === "quotaPing"),
            "the reveal path must probe the booted-once page",
          );
          await pollUntil(
            () => created.length === 2,
            10_000,
            "silent page must trigger dispose + fresh panel creation",
          );
          assert.ok(disposed.has(created[0]), "the zombie panel must be disposed");
          assert.ok(!disposed.has(created[1]), "the replacement panel must stay open");
        } finally {
          windowApi.createWebviewPanel = original;
          for (const panel of created) {
            panel.dispose(); // reset the singleton so the next quota test opens fresh
          }
        }
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
        // Boot assertions read the quotaInit MESSAGE specifically: the panel-open
        // visibility kick fires a quotaSnapshot FIRST (before the webview handshake),
        // so a positional [0] over the mixed stream could hit the wrong message.
        const bootInit = bridge.outbound.find((message) => message.type === "quotaInit") as
          { payload: QuotaSnapshotMessage } | undefined;
        assert.ok(bootInit, "captured manager panel must have received quotaInit");
        const boot = bootInit.payload;
        for (const provider of boot.snapshot.providers) {
          assert.equal(provider.configured, false, `${provider.providerId} must report unconfigured`);
          assert.equal(provider.error, null, `${provider.providerId} must carry no error`);
        }
        assert.deepEqual(
          boot.visibility,
          { kimi: true, glm: true, mimo: true, deepseek: true },
          "boot quotaInit must carry the all-visible default",
        );
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
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
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
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
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
      name: "quotaSetStatusBar roundtrip: toggle persisted, cookie preserved, mode 0600",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const quotaJson = path.join(configDir, "quota.json");

        bridge.deliver({ type: "quotaSetStatusBar", payload: { providerId: "kimi", visible: false } });
        await pollUntil(
          () =>
            bridge.outbound.some(
              (message) =>
                message.type === "quotaStatusBarSaved" &&
                typeof message.payload === "object" &&
                message.payload !== null &&
                (message.payload as { ok?: unknown }).ok === true &&
                (message.payload as { visibility?: { kimi?: unknown } }).visibility?.kimi === false,
            ),
          10_000,
          "toggling kimi off must produce a quotaStatusBarSaved(ok) reply carrying the record",
        );

        const saved = JSON.parse(fs.readFileSync(quotaJson, "utf8")) as {
          statusBar?: Record<string, boolean>;
          mimo?: { cookie?: string };
        };
        assert.equal(saved.statusBar?.kimi, false, "quota.json must persist the hidden provider");
        assert.equal(
          saved.mimo?.cookie,
          "api-platform_serviceToken=abc; userId=42",
          "the visibility merge must preserve the MiMo cookie",
        );
        assert.deepEqual(
          saved.statusBar,
          { kimi: false, glm: true, mimo: true, deepseek: true },
          "the persisted record must be the full normalized visibility",
        );
        if (process.platform !== "win32") {
          // writeFileAtomic renames a fresh tmp file — the visibility save must re-apply
          // chmod 0600 or the credential-bearing quota.json drops to the umask default.
          assert.equal(fs.statSync(quotaJson).mode & 0o777, 0o600, "quota.json must stay owner-only (0600)");
        }

        // Toggle back on so later rounds/tests start from the default visible set.
        bridge.deliver({ type: "quotaSetStatusBar", payload: { providerId: "kimi", visible: true } });
        await pollUntil(
          () =>
            bridge.outbound.some(
              (message) =>
                message.type === "quotaStatusBarSaved" &&
                (message.payload as { visibility?: { kmi?: unknown; kimi?: unknown } }).visibility?.kimi === true,
            ),
          10_000,
          "toggling kimi back on must echo the restored record",
        );

        // Malformed toggles are dropped without a reply.
        const repliesBefore = bridge.outbound.filter((message) => message.type === "quotaStatusBarSaved").length;
        bridge.deliver({ type: "quotaSetStatusBar", payload: { providerId: "nonsense", visible: false } });
        bridge.deliver({ type: "quotaSetStatusBar", payload: { providerId: "kimi", visible: "yes" } });
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(
          bridge.outbound.filter((message) => message.type === "quotaStatusBarSaved").length,
          repliesBefore,
          "malformed quotaSetStatusBar payloads must be ignored",
        );
      },
    },
    {
      name: "all-hidden + closed panel survives the empty-target cycle (refresh chain stays alive)",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;

        // 1s auto-refresh so the empty-target timer path actually fires within the test.
        const userConfig = vscode.workspace.getConfiguration("opencodeConfigManager");
        await userConfig.update("quota.refreshSeconds", 1, vscode.ConfigurationTarget.Global);
        await pollConfigValue("quota.refreshSeconds", 1, "1s quota interval must be active");

        // Hide ALL four providers (panel open → rounds still fetch all).
        for (const providerId of ["kimi", "glm", "mimo", "deepseek"] as const) {
          bridge.deliver({ type: "quotaSetStatusBar", payload: { providerId, visible: false } });
        }
        await pollUntil(
          () => {
            const saved = JSON.parse(fs.readFileSync(path.join(configDir, "quota.json"), "utf8")) as {
              statusBar?: Record<string, boolean>;
            };
            return (
              Object.values(saved.statusBar ?? {}).length === 4 && Object.values(saved.statusBar!).every((v) => !v)
            );
          },
          10_000,
          "all four hidden toggles must persist to quota.json",
        );

        // Close the panel: with everything hidden AND no open panel, refresh rounds
        // have EMPTY targets. A leaked single-flight promise here (the regression)
        // permanently freezes every later full refresh.
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        // Give the 1s timer at least one empty-target tick.
        await new Promise((resolve) => setTimeout(resolve, 2_500));

        // Re-show one provider through a REOPENED panel and prove the chain works:
        // the fresh panel's boot refresh must push NEW quotaSnapshot messages.
        const reopened = await openQuotaPanelCaptured(CMD.quotaRefresh);
        const reopenedBase = reopened.outbound.length;
        await pollUntil(
          () => reopened.outbound.slice(reopenedBase).filter((message) => message.type === "quotaSnapshot").length > 0,
          15_000,
          "post-reopen boot refresh must produce fresh quotaSnapshot pushes (empty-target cycle must not freeze the chain)",
        );

        // Restore: all visible + default interval.
        reopened.deliver({ type: "quotaSetStatusBar", payload: { providerId: "kimi", visible: true } });
        reopened.deliver({ type: "quotaSetStatusBar", payload: { providerId: "glm", visible: true } });
        reopened.deliver({ type: "quotaSetStatusBar", payload: { providerId: "mimo", visible: true } });
        reopened.deliver({ type: "quotaSetStatusBar", payload: { providerId: "deepseek", visible: true } });
        await pollUntil(
          () =>
            reopened.outbound.some(
              (message) =>
                message.type === "quotaStatusBarSaved" &&
                (message.payload as { visibility?: Record<string, boolean> }).visibility?.deepseek === true,
            ),
          10_000,
          "visibility restore must be acknowledged",
        );
        await userConfig.update("quota.refreshSeconds", 30, vscode.ConfigurationTarget.Global);
        await pollConfigValue("quota.refreshSeconds", 30, "quota interval must be restored");
      },
    },
    {
      name: "openSettings boots with defaults; save persists clamped config and re-syncs the page",
      fn: async () => {
        const bridge = await openSettingsPanelCaptured(CMD.openSettings);

        // Boot payload reflects the package.json defaults: every category off at 30s, quota 30s.
        // Anchor on the LAST config-tab navigation from THIS entry point (earlier pushes —
        // panel boot during the all-hidden test, quota-era reveals — legitimately carried
        // other state); the settingsInit riding along with it (打开设置 keeps the settings
        // tab fresh on arrival) is the entry's boot payload.
        const navigateIdx = bridge.outbound.reduce(
          (last, message, index) =>
            message.type === "managerNavigate" && (message.payload as { tab?: unknown })?.tab === "config"
              ? index
              : last,
          -1,
        );
        assert.ok(navigateIdx >= 0, "openSettings must land on the first (配置) tab");
        const bootMessage = bridge.outbound
          .slice(navigateIdx + 1)
          .find((message) => message.type === "settingsInit") as { payload: SettingsInitMessage } | undefined;
        assert.ok(bootMessage, "the config navigation must be followed by a settingsInit push");
        const boot = bootMessage.payload;
        for (const category of ["config", "presets", "backups", "models", "plugins"]) {
          assert.deepEqual(
            boot.settings.categories[category],
            { enabled: false, intervalSeconds: 30 },
            `${category} must carry the default setting`,
          );
        }
        assert.equal(boot.settings.quotaRefreshSeconds, 30);

        // Save a partial payload — the host normalizes (missing categories → defaults,
        // out-of-range interval → clamp) and persists every key.
        // Echo baseline = stream length AT SAVE TIME: the merged panel pushed earlier
        // settingsInits (panel boot, quota-era reveals) carrying legit PRE-save state.
        const echoBaseline = settingsInits(bridge).length;
        bridge.deliver({
          type: "settingsSave",
          payload: {
            settings: {
              categories: {
                presets: { enabled: true, intervalSeconds: 45 },
                backups: { enabled: true, intervalSeconds: 99_999 },
              },
              quotaRefreshSeconds: 0,
            },
          },
        });
        await pollUntil(
          () => settingsSavedReplies(bridge).some((reply) => reply.ok),
          10_000,
          "save must produce a settingsSaved(ok:true) reply",
        );
        await pollConfigValue("autoRefresh.presets.enabled", true, "presets polling must be enabled");
        await pollConfigValue("autoRefresh.presets.intervalSeconds", 45, "presets interval must persist as 45");
        await pollConfigValue("autoRefresh.backups.intervalSeconds", 3600, "out-of-range interval must clamp to 3600");
        await pollConfigValue("autoRefresh.models.enabled", false, "missing category falls back to its default");
        await pollConfigValue("quota.refreshSeconds", 0, "quota refresh must be disabled (0)");

        // Own-save config events must NOT echo settingsInit carrying PARTIAL state
        // back to the page — mid-flight echoes were the visible "rapid edits revert"
        // regression. Any echo that arrives AFTER the save (incl. a harmless
        // post-settle no-op) must carry the FINAL persisted state, never a pre-save
        // value.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        for (const echo of settingsInits(bridge).slice(echoBaseline)) {
          assert.equal(
            echo.settings.categories.presets?.enabled,
            true,
            "a settingsInit echo must never carry stale pre-save state (rapid-edit revert regression)",
          );
          assert.equal(echo.settings.quotaRefreshSeconds, 0);
        }

        // EXTERNAL changes (Settings UI, hand-edited settings.json) still push a
        // settingsInit so an open page never shows stale values.
        const userConfig = vscode.workspace.getConfiguration("opencodeConfigManager");
        await userConfig.update("autoRefresh.plugins.enabled", true, vscode.ConfigurationTarget.Global);
        await pollUntil(
          () => settingsInits(bridge).some((message) => message.settings.categories.plugins?.enabled === true),
          10_000,
          "external config change must push settingsInit to the open page",
        );
        await userConfig.update("autoRefresh.plugins.enabled", undefined, vscode.ConfigurationTarget.Global);
        await pollConfigValue("autoRefresh.plugins.enabled", false, "external cleanup must remove the override");

        // Persisted settings must actually RE-ARM the polling scheduler (the feature's
        // whole purpose): enable the config section at a 1s interval and observe two
        // ticks through the test-bridge counter.
        const ticksBefore = (await vscode.commands.executeCommand(TEST_BRIDGE.autoRefreshTicks)) as number;
        bridge.deliver({
          type: "settingsSave",
          payload: { settings: { categories: { config: { enabled: true, intervalSeconds: 1 } } } },
        });
        await pollUntil(
          async () =>
            ((await vscode.commands.executeCommand(TEST_BRIDGE.autoRefreshTicks)) as number) >= ticksBefore + 2,
          20_000,
          "enabled 1s polling must produce at least two scheduler ticks",
        );

        // VSCode user settings persist across e2e runs — restore the defaults so
        // later runs (and later cases) start from a clean sheet. Defaults write as
        // key REMOVALS (undefined), keeping settings.json free of redundant keys.
        bridge.deliver({ type: "settingsSave", payload: { settings: { categories: {}, quotaRefreshSeconds: 30 } } });
        await pollUntil(
          () => settingsSavedReplies(bridge).length >= 3,
          10_000,
          "restore save must produce its settingsSaved reply",
        );
        await pollConfigValue("autoRefresh.presets.enabled", false, "restore must disable presets polling");
        await pollConfigValue("autoRefresh.config.enabled", false, "restore must stop the 1s polling");
        await pollConfigValue("quota.refreshSeconds", 30, "restore must reset the quota interval");
      },
    },
    {
      name: "settings panel reveal reuses the singleton and malformed messages are ignored",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = await openSettingsPanelCaptured(CMD.openSettings);
        assert.equal(bridge, managerBridge, "reveal must reuse the captured singleton bridge");

        // Malformed payloads are dropped without a reply or a crash…
        bridge.deliver({ type: "settingsSave", payload: {} });
        bridge.deliver({ type: "settingsSave" });
        bridge.deliver({ type: "totally-unknown" });
        // …and a well-formed save still works afterwards.
        const repliesBefore = settingsSavedReplies(bridge).length;
        bridge.deliver({
          type: "settingsSave",
          payload: { settings: { categories: { models: { enabled: true, intervalSeconds: 60 } } } },
        });
        await pollUntil(
          () => settingsSavedReplies(bridge).length >= repliesBefore + 1,
          10_000,
          "valid save after garbage must still produce a reply",
        );
        await pollConfigValue("autoRefresh.models.enabled", true, "models polling must be enabled after the save");
        bridge.deliver({ type: "settingsSave", payload: { settings: { categories: {}, quotaRefreshSeconds: 30 } } });
        await pollUntil(
          () => settingsSavedReplies(bridge).length >= repliesBefore + 2,
          10_000,
          "final restore must produce a reply",
        );
        await pollConfigValue("autoRefresh.models.enabled", false, "final restore must disable models polling");
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

    {
      name: "opencodeSetSetting compaction 写入：null 叶子字段不落盘（disk 只保留 {auto:false}）",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        const repliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBefore = opencodeInits(bridge).length;

        bridge.deliver({
          type: "opencodeSetSetting",
          payload: { key: "compaction", value: { auto: false, tail_turns: null } },
        });
        // shallowObject values carrying null leaves (field = 未设置, exactly what the
        // webview's ShallowObjectFields commits) are accepted by the validator and
        // written per-leaf: disk carries ONLY the non-null fields — compaction === { auto: false }.
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "compaction"),
          10_000,
          "opencodeSetSetting(compaction) must produce an opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBefore)
              .some((init) => (init.values.compaction as { auto?: unknown } | null)?.auto === false),
          10_000,
          "a refreshed opencodeInit carrying compaction.auto:false must follow the write",
        );

        assertNoJsoncErrors(opencodeJson);
        const parsed = parseSafe<{ compaction?: Record<string, unknown> }>(fs.readFileSync(opencodeJson, "utf8")).value;
        assert.ok(parsed !== null, "opencode.json must parse to an object");
        assert.deepEqual(
          parsed.compaction,
          { auto: false },
          "disk compaction must carry ONLY the non-null fields — no literal null leaf",
        );
      },
    },

    // ---- Section 4e: batch-4 record kinds (same manager panel bridge) ---------
    // command/formatter/lsp ride the payload's records slot (read) and the
    // command/formatterEntries/lspEntries/formatterMaster/lspMaster descriptor
    // keys (write). The current panel's boot push predates this section, so its
    // records slot still mirrors the pristine fixture.
    {
      name: "OpenCode tab: boot opencodeInit 携带 records 槽位（命令/格式化未设置，LSP 读出 fixture 条目）",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const boot = opencodeInits(managerBridge)[0];
        assert.ok(boot, "the current panel's boot opencodeInit must be captured");
        const unset = { mode: "unset", booleanValue: null, entries: {} };
        assert.deepEqual(
          boot.records?.command,
          unset,
          "boot records.command must read unset — the fixture seeds no command key",
        );
        assert.deepEqual(
          boot.records?.formatter,
          unset,
          "boot records.formatter must read unset — the fixture seeds no formatter key",
        );
        // The fixture DOES seed lsp.kotlin-ls (with an advanced `priority` field):
        // the read aggregate surfaces only the descriptor fields (command/extensions),
        // `priority` stays disk-only — the lspEntries test below pins its survival.
        assert.deepEqual(
          boot.records?.lsp,
          {
            mode: "entries",
            booleanValue: null,
            entries: {
              "kotlin-ls": {
                command: ["~/.local/share/opencode/bin/kotlin-ls/official/kotlin-lsp.sh", "--stdio"],
                extensions: [".kt", ".kts"],
              },
            },
          },
          "boot records.lsp must mirror the fixture's kotlin-ls entry with priority omitted",
        );
      },
    },
    {
      name: "opencodeSetSetting command 写入：新增/改名/删除写回磁盘并回推 records 聚合",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        const releaseEntry = {
          template: "Write release notes for $ARGUMENTS",
          description: "生成发布说明",
          agent: "build",
          model: "kimi/kimi-k2",
          subtask: true,
        };

        const repliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBefore = opencodeInits(bridge).length;
        bridge.deliver({
          type: "opencodeSetSetting",
          payload: { key: "command", value: { "release-notes": releaseEntry } },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "command"),
          10_000,
          "opencodeSetSetting(command) must produce an opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBefore)
              .some(
                (init) =>
                  init.records?.command?.mode === "entries" &&
                  JSON.stringify(recordEntriesOf(init, "command")["release-notes"]) === JSON.stringify(releaseEntry),
              ),
          10_000,
          "a refreshed opencodeInit carrying records.command.entries[release-notes] must follow the write",
        );
        assertNoJsoncErrors(opencodeJson);
        let parsed = parseSafe<{ command?: Record<string, Record<string, unknown>> }>(
          fs.readFileSync(opencodeJson, "utf8"),
        ).value;
        assert.ok(parsed !== null, "opencode.json must parse to an object");
        assert.deepEqual(
          parsed.command?.["release-notes"],
          releaseEntry,
          "on-disk command[release-notes] must carry template/description/agent/model/subtask",
        );

        // Rename = old name null + new name set in ONE value (per-name diff semantics).
        const repliesBeforeRename = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        bridge.deliver({
          type: "opencodeSetSetting",
          payload: {
            key: "command",
            value: { "release-notes": null, rn: { template: "Write release notes for $ARGUMENTS" } },
          },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeRename)
              .some((reply) => reply.ok && reply.key === "command"),
          10_000,
          "the rename write must produce its own opencodeSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(opencodeJson);
        parsed = parseSafe<{ command?: Record<string, Record<string, unknown>> }>(
          fs.readFileSync(opencodeJson, "utf8"),
        ).value;
        assert.ok(parsed !== null, "opencode.json must parse to an object");
        assert.equal("release-notes" in (parsed.command ?? {}), false, "the old name must be gone after the rename");
        assert.equal(
          parsed.command?.rn?.template,
          "Write release notes for $ARGUMENTS",
          "the new name must carry the template",
        );

        // Delete the remaining entry: the name disappears; the empty `command: {}`
        // container MAY stay behind (same tolerated residue as permissionTools —
        // the pure edit builder never rewrites the parent key).
        const repliesBeforeDelete = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBeforeDelete = opencodeInits(bridge).length;
        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "command", value: { rn: null } } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeDelete)
              .some((reply) => reply.ok && reply.key === "command"),
          10_000,
          "the delete write must produce its own opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBeforeDelete)
              .some((init) => recordEntriesOf(init, "command")["rn"] === undefined),
          10_000,
          "a refreshed opencodeInit without records.command.entries[rn] must follow the delete",
        );
        assertNoJsoncErrors(opencodeJson);
        const afterDelete = parseSafe<{ command?: Record<string, unknown> }>(
          fs.readFileSync(opencodeJson, "utf8"),
        ).value;
        assert.ok(afterDelete !== null, "opencode.json must parse to an object");
        assert.equal(
          Object.keys(afterDelete.command ?? {}).length,
          0,
          "the deleted name must be gone (command absent or an empty container residue)",
        );
      },
    },
    {
      name: "recordEditor 破损兄弟条目保护：合法条目写入后破损条目字节级保留",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        // Seed a hand-written BROKEN entry through the product's own JSONC editor —
        // a plain string where an entry object belongs. The read side skips it
        // (non-object entries never enter the aggregate); the write side only touches
        // names present in the posted value, so it must survive byte-identically
        // (same protection contract as the permissionTools pattern-object sibling).
        const seeded = setValues(fs.readFileSync(opencodeJson, "utf8"), [
          { path: ["command", "legacy"], value: "just-a-string" },
        ]);
        fs.writeFileSync(opencodeJson, seeded);
        const snippetOf = (text: string): string => /"legacy"\s*:\s*"just-a-string"/.exec(text)?.[0] ?? "";
        const snippetBefore = snippetOf(seeded);
        assert.ok(snippetBefore.length > 0, "the seeded broken entry must be present before the write");

        const repliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBefore = opencodeInits(bridge).length;
        bridge.deliver({
          type: "opencodeSetSetting",
          payload: { key: "command", value: { "ok-entry": { template: "ok" } } },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "command"),
          10_000,
          "the sibling write must produce an opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBefore)
              .some(
                (init) =>
                  recordEntriesOf(init, "command")["ok-entry"] !== undefined &&
                  recordEntriesOf(init, "command")["legacy"] === undefined,
              ),
          10_000,
          "a refreshed opencodeInit must carry ok-entry but NOT the broken legacy entry (read side skips it)",
        );

        assertNoJsoncErrors(opencodeJson);
        const after = fs.readFileSync(opencodeJson, "utf8");
        const parsed = parseSafe<{ command?: Record<string, unknown> }>(after).value;
        assert.ok(parsed !== null, "opencode.json must parse to an object");
        assert.deepEqual(
          parsed.command?.["ok-entry"],
          { template: "ok" },
          "the valid sibling entry must be written to disk",
        );
        assert.equal(
          parsed.command?.legacy,
          "just-a-string",
          "the broken entry must survive the sibling write with its value intact",
        );
        assert.equal(snippetOf(after), snippetBefore, "the broken entry must survive byte-identically");
      },
    },
    {
      name: "opencodeSetSetting formatterMaster/Entries：master false 写回布尔，布尔形态下条目写被拒不写盘，清 master 后条目落地",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        const prettierEntry = { command: ["npx", "prettier"], extensions: ["ts", "json"] };

        const repliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBefore = opencodeInits(bridge).length;
        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "formatterMaster", value: false } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "formatterMaster"),
          10_000,
          "opencodeSetSetting(formatterMaster) must produce an opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBefore)
              .some(
                (init) => init.records?.formatter?.mode === "boolean" && init.records.formatter.booleanValue === false,
              ),
          10_000,
          "a refreshed opencodeInit carrying records.formatter boolean mode must follow the write",
        );
        assertNoJsoncErrors(opencodeJson);
        let parsed = parseSafe<{ formatter?: unknown }>(fs.readFileSync(opencodeJson, "utf8")).value;
        assert.ok(parsed !== null, "opencode.json must parse to an object");
        assert.equal(parsed.formatter, false, "on-disk formatter must be the boolean false");

        // Boolean-form → entries write: the PROTOCOL accepts the value (recordEditor
        // validation is pure — it never re-checks the file shape; the UI interlock is
        // what prevents this flow in the panel), but the JSONC edit cannot nest a
        // property into the boolean leaf: jsonc-parser throws, the host answers !ok
        // and the file stays untouched. Pinned as a REFUSAL — safe, no corruption.
        const bytesBefore = fs.readFileSync(opencodeJson);
        const repliesBeforeRefusal = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        bridge.deliver({
          type: "opencodeSetSetting",
          payload: { key: "formatterEntries", value: { prettier: prettierEntry } },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeRefusal)
              .some((reply) => reply.ok === false && reply.key === "formatterEntries"),
          10_000,
          "the entries-over-boolean write must produce a !ok reply echoing the key",
        );
        assert.ok(
          fs.readFileSync(opencodeJson).equals(bytesBefore),
          "the refused formatterEntries write must leave opencode.json byte-identical",
        );

        // The panel's own way out of the boolean form: clear the master (null removes
        // the key), then the entry lands as the object form.
        const repliesBeforeClear = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "formatterMaster", value: null } });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeClear)
              .some((reply) => reply.ok && reply.key === "formatterMaster"),
          10_000,
          "the master-clear write must produce its own opencodeSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(opencodeJson);
        parsed = parseSafe<{ formatter?: unknown }>(fs.readFileSync(opencodeJson, "utf8")).value;
        assert.ok(parsed !== null, "opencode.json must parse to an object");
        assert.equal("formatter" in parsed, false, "the null master write must remove the formatter key from disk");

        const repliesBeforeEntries = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBeforeEntries = opencodeInits(bridge).length;
        bridge.deliver({
          type: "opencodeSetSetting",
          payload: { key: "formatterEntries", value: { prettier: prettierEntry } },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeEntries)
              .some((reply) => reply.ok && reply.key === "formatterEntries"),
          10_000,
          "the formatterEntries write must produce an opencodeSettingSaved(ok:true) reply",
        );
        // Interlock payload check: with entries on disk the aggregate flips to the
        // entries form — the face the master select locks against (已有条目).
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBeforeEntries)
              .some(
                (init) =>
                  init.records?.formatter?.mode === "entries" &&
                  JSON.stringify(recordEntriesOf(init, "formatter")["prettier"]) === JSON.stringify(prettierEntry),
              ),
          10_000,
          "a refreshed opencodeInit carrying records.formatter entries mode with prettier must follow the write",
        );
        assertNoJsoncErrors(opencodeJson);
        const entriesParsed = parseSafe<{ formatter?: Record<string, Record<string, unknown>> }>(
          fs.readFileSync(opencodeJson, "utf8"),
        ).value;
        assert.ok(entriesParsed !== null, "opencode.json must parse to an object");
        assert.deepEqual(
          entriesParsed.formatter?.prettier,
          prettierEntry,
          "on-disk formatter must be an object carrying the prettier entry",
        );
      },
    },
    {
      name: "opencodeSetSetting lspEntries 写入/停用/删除：fixture 条目 kotlin-ls（含 priority）字节级保留",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        // The fixture's lsp.kotlin-ls carries `priority` — an advanced field outside
        // the descriptor. Every write below touches only names present in the posted
        // value, so the whole kotlin-ls block (priority included) must survive.
        const snippetOf = (text: string): string => /"priority"\s*:\s*10/.exec(text)?.[0] ?? "";
        const snippetBefore = snippetOf(fs.readFileSync(opencodeJson, "utf8"));
        assert.ok(snippetBefore.length > 0, "the fixture's kotlin-ls priority leaf must be present before the writes");

        const repliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBefore = opencodeInits(bridge).length;
        bridge.deliver({
          type: "opencodeSetSetting",
          payload: {
            key: "lspEntries",
            value: { "rust-analyzer": { command: ["rust-analyzer"], extensions: ["rs"] } },
          },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBefore)
              .some((reply) => reply.ok && reply.key === "lspEntries"),
          10_000,
          "opencodeSetSetting(lspEntries) must produce an opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBefore)
              .some(
                (init) =>
                  recordEntriesOf(init, "lsp")["rust-analyzer"] !== undefined &&
                  recordEntriesOf(init, "lsp")["kotlin-ls"] !== undefined,
              ),
          10_000,
          "a refreshed opencodeInit carrying both lsp entries must follow the write",
        );
        assertNoJsoncErrors(opencodeJson);
        let parsed = parseSafe<{ lsp?: Record<string, Record<string, unknown>> }>(
          fs.readFileSync(opencodeJson, "utf8"),
        ).value;
        assert.ok(parsed !== null, "opencode.json must parse to an object");
        assert.deepEqual(
          parsed.lsp?.["rust-analyzer"],
          { command: ["rust-analyzer"], extensions: ["rs"] },
          "on-disk lsp[rust-analyzer] must carry command+extensions",
        );
        assert.deepEqual(
          parsed.lsp?.["kotlin-ls"],
          {
            command: ["~/.local/share/opencode/bin/kotlin-ls/official/kotlin-lsp.sh", "--stdio"],
            extensions: [".kt", ".kts"],
            priority: 10,
          },
          "the fixture's kotlin-ls entry (priority included) must survive the sibling write",
        );

        // Disable = full-entry set with disabled:true (the set replaces the entry).
        const repliesBeforeDisable = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        bridge.deliver({
          type: "opencodeSetSetting",
          payload: {
            key: "lspEntries",
            value: { "rust-analyzer": { command: ["rust-analyzer"], extensions: ["rs"], disabled: true } },
          },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeDisable)
              .some((reply) => reply.ok && reply.key === "lspEntries"),
          10_000,
          "the disable write must produce its own opencodeSettingSaved(ok:true) reply",
        );
        assertNoJsoncErrors(opencodeJson);
        parsed = parseSafe<{ lsp?: Record<string, Record<string, unknown>> }>(
          fs.readFileSync(opencodeJson, "utf8"),
        ).value;
        assert.ok(parsed !== null, "opencode.json must parse to an object");
        assert.equal(parsed.lsp?.["rust-analyzer"]?.disabled, true, "the disable write must set disabled:true");
        assert.deepEqual(
          parsed.lsp?.["rust-analyzer"]?.command,
          ["rust-analyzer"],
          "the wholesale entry set must still carry the command field",
        );

        // Delete rust-analyzer; kotlin-ls must remain (byte-identical priority leaf).
        const repliesBeforeDelete = settingSavedReplies(bridge, "opencodeSettingSaved").length;
        const initsBeforeDelete = opencodeInits(bridge).length;
        bridge.deliver({
          type: "opencodeSetSetting",
          payload: { key: "lspEntries", value: { "rust-analyzer": null } },
        });
        await pollUntil(
          () =>
            settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBeforeDelete)
              .some((reply) => reply.ok && reply.key === "lspEntries"),
          10_000,
          "the delete write must produce its own opencodeSettingSaved(ok:true) reply",
        );
        await pollUntil(
          () =>
            opencodeInits(bridge)
              .slice(initsBeforeDelete)
              .some((init) => recordEntriesOf(init, "lsp")["rust-analyzer"] === undefined),
          10_000,
          "a refreshed opencodeInit without records.lsp.entries[rust-analyzer] must follow the delete",
        );
        assertNoJsoncErrors(opencodeJson);
        const after = fs.readFileSync(opencodeJson, "utf8");
        parsed = parseSafe<{ lsp?: Record<string, Record<string, unknown>> }>(after).value;
        assert.ok(parsed !== null, "opencode.json must parse to an object");
        assert.equal("rust-analyzer" in (parsed.lsp ?? {}), false, "the deleted lsp entry must be gone from disk");
        assert.ok(parsed.lsp?.["kotlin-ls"], "the fixture's kotlin-ls entry must survive the delete");
        assert.equal(snippetOf(after), snippetBefore, "the kotlin-ls priority leaf must survive byte-identically");
      },
    },
    {
      name: "recordEditor 非法值兜底：非法名称/缺必填字段/master 非布尔收 !ok 回执且不写盘",
      fn: async () => {
        assert.ok(managerBridge, "manager panel must still be open from the previous step");
        const bridge = managerBridge;
        const opencodeJson = path.join(configDir, "opencode.json");
        const bytesBefore = fs.readFileSync(opencodeJson);
        const repliesBefore = settingSavedReplies(bridge, "opencodeSettingSaved").length;

        // Known descriptors with OUT-OF-KIND values: "bad entry!" fails the entry-name
        // charset; {x:{}} misses the required template; "yes" is not true|false|null.
        bridge.deliver({
          type: "opencodeSetSetting",
          payload: { key: "command", value: { "bad entry!": { template: "x" } } },
        });
        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "command", value: { x: {} } } });
        bridge.deliver({ type: "opencodeSetSetting", payload: { key: "formatterMaster", value: "yes" } });
        await pollUntil(
          () => {
            const rejections = settingSavedReplies(bridge, "opencodeSettingSaved")
              .slice(repliesBefore)
              .filter(
                (reply) =>
                  reply.ok === false && (reply.error ?? "").includes("格式无法识别") && typeof reply.key === "string",
              );
            const commandRejections = rejections.filter((reply) => reply.key === "command").length;
            const formatterRejections = rejections.filter((reply) => reply.key === "formatterMaster").length;
            return commandRejections >= 2 && formatterRejections >= 1;
          },
          10_000,
          "all three invalid record writes must produce !ok key-echo replies",
        );
        assert.ok(
          fs.readFileSync(opencodeJson).equals(bytesBefore),
          "the rejected record writes must not touch opencode.json",
        );
      },
    },
  ];
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
