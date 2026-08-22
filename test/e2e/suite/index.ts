/**
 * OpenCode Config Manager — e2e smoke suite.
 *
 * Loaded by VSCode (via @vscode/test-electron `--extensionTestsPath`); must
 * export `run()`. Runs in the SAME extension host as the extension under test.
 *
 * Isolation: XDG_CONFIG_HOME points at a seeded temp dir (set by
 * test/e2e/run.mjs); ConfigStore.resolveConfigDir resolves
 * $XDG_CONFIG_HOME/opencode. Test 0 asserts this before anything else runs.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { CMD } from "../../../src/constants";
import { validate } from "../../../src/core/jsoncEditor";

const sleep = promisify(setTimeout);

const EXTENSION_ID = "local.opencode-config-manager"; // publisher.name from package.json
const PRESET_NAME = "e2e-preset";

/** Every command contributed in package.json (source of truth: src/constants.ts). */
const COMMAND_IDS: readonly string[] = Object.values(CMD);

interface TestCase {
  name: string;
  fn: () => Promise<void>;
}

let configDir = "";
let presetFile = "";
let manualBackupDirName = "";

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

/**
 * `restoreBackup` guards with a modal confirmation
 * (vscode.window.showWarningMessage(..., { modal: true }, "恢复")) which no one
 * can click in a headless run. The test suite and the extension share the same
 * extension-host `vscode` API object, so we temporarily patch
 * showWarningMessage to auto-accept the FIRST offered action. As a fallback we
 * also drive the workbench's own dialog-accept command in case the object is
 * not shared. Success is proven by the caller via byte-level restore checks.
 */
async function executeRestoreBackup(dirName: string): Promise<void> {
  const windowApi = vscode.window as unknown as {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    showWarningMessage: (...args: any[]) => Thenable<string | undefined>;
  };
  const original = windowApi.showWarningMessage;
  let patchEngaged = false;
  windowApi.showWarningMessage = (...args: unknown[]) => {
    patchEngaged = true;
    const actions = args.filter((arg): arg is string => typeof arg === "string");
    // args are (message, [options], ...actionItems) — accept the last action.
    return Promise.resolve(actions.length > 1 ? actions[actions.length - 1] : undefined);
  };
  try {
    const restoring = Promise.resolve(vscode.commands.executeCommand(CMD.restoreBackup, dirName));
    // Give a potential (unpatched) modal a moment to open, then accept it.
    await sleep(1_000);
    await vscode.commands.executeCommand("workbench.action.acceptDialog").then(
      () => undefined,
      () => undefined,
    );
    await withTimeout(restoring, 20_000, "restoreBackup should resolve");
  } finally {
    windowApi.showWarningMessage = original;
  }
  console.log(`    (modal patch engaged: ${patchEngaged})`);
}

async function executeDeleteModel(id: string): Promise<void> {
  const windowApi = vscode.window as unknown as {
    showWarningMessage: (...args: unknown[]) => Thenable<string | undefined>;
  };
  const original = windowApi.showWarningMessage;
  windowApi.showWarningMessage = (...args: unknown[]) => {
    const actions = args.filter((arg): arg is string => typeof arg === "string");
    return Promise.resolve(actions.length > 1 ? actions[actions.length - 1] : undefined);
  };
  try {
    const deleting = Promise.resolve(vscode.commands.executeCommand(CMD.deleteModel, id));
    await sleep(1_000);
    await vscode.commands.executeCommand("workbench.action.acceptDialog").then(
      () => undefined,
      () => undefined,
    );
    await withTimeout(deleting, 10_000, "deleteModel should resolve");
  } finally {
    windowApi.showWarningMessage = original;
  }
}

function tests(): TestCase[] {
  return [
    {
      name: "isolation: XDG_CONFIG_HOME points at seeded temp dir",
      fn: async () => {
        const xdg = process.env.XDG_CONFIG_HOME;
        assert.ok(xdg, "XDG_CONFIG_HOME must be set by test/e2e/run.mjs");
        const resolvedSeed = path.resolve(xdg);
        const tmp = path.resolve(os.tmpdir());
        assert.ok(
          resolvedSeed === tmp || resolvedSeed.startsWith(`${tmp}${path.sep}`),
          `XDG_CONFIG_HOME (${resolvedSeed}) must live under os.tmpdir() (${tmp})`,
        );
        configDir = path.join(resolvedSeed, "opencode");
        assert.ok(fs.existsSync(configDir), `seeded config dir missing: ${configDir}`);
        assert.ok(fs.existsSync(path.join(configDir, "opencode.json")), "seeded opencode.json missing");
        assert.ok(
          fs.existsSync(path.join(configDir, "oh-my-opencode.json")),
          "seeded oh-my-opencode.json missing",
        );
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
    {
      name: "addModel writes models.json; deleteModel removes the entry",
      fn: async () => {
        const id = "e2e-test-provider/e2e-model-x";
        await vscode.commands.executeCommand(CMD.addModel, id);
        const modelsFile = path.join(configDir, "models.json");
        assert.ok(fs.existsSync(modelsFile), "models.json must exist after addModel");
        const afterAdd = JSON.parse(fs.readFileSync(modelsFile, "utf8")) as { models: { provider: string; model: string }[] };
        assert.ok(
          afterAdd.models.some((m) => `${m.provider}/${m.model}` === id),
          `added model ${id} not found in models.json`,
        );
        await executeDeleteModel(id);
        const afterDelete = JSON.parse(fs.readFileSync(modelsFile, "utf8")) as { models: { provider: string; model: string }[] };
        assert.ok(
          !afterDelete.models.some((m) => `${m.provider}/${m.model}` === id),
          `deleted model ${id} still present in models.json`,
        );
      },
    },
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
      name: "applyPreset('e2e-preset') resolves and keeps configs parseable",
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

        fs.writeFileSync(
          path.join(configDir, "opencode.json"),
          '{ "marker": "mutated-before-restore" }\n',
        );
        const backupCopy = fs.readFileSync(
          path.join(configDir, "backups", manualBackupDirName, "opencode.json"),
        );
        await executeRestoreBackup(manualBackupDirName);

        assert.ok(
          fs.readFileSync(path.join(configDir, "opencode.json")).equals(backupCopy),
          "live opencode.json must equal the restored backup copy",
        );

        const backupsDir = path.join(configDir, "backups");
        const autoDirs = fs
          .readdirSync(backupsDir, { withFileTypes: true })
          .filter(
            (entry) =>
              entry.isDirectory() &&
              /-(pre-apply|pre-save|pre-restore)$/.test(entry.name),
          );
        assert.ok(autoDirs.length === 0, "no automatic backups may be created");

        assertNoJsoncErrors(path.join(configDir, "opencode.json"));
        assertNoJsoncErrors(path.join(configDir, "oh-my-opencode.json"));
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
