import { realpathSync } from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { CONFIG_KEY, CONFIG_LEAF, CONFIG_SECTION, OUTPUT_CHANNEL_NAME, TEST_BRIDGE, VIEW } from "./constants";
import { AutoRefreshScheduler } from "./core/autoRefreshScheduler";
import { BackupService } from "./core/backupService";
import { LOCAL_MODELS_FILE } from "./core/builtinModels";
import { ConfigStore } from "./core/configStore";
import { errorMessage } from "./core/errors";
import { validate } from "./core/jsoncEditor";
import { seedLocalModelsFromCatalog } from "./core/modelCatalog";
import { PresetService } from "./core/presetService";
import { QuotaService } from "./core/quotaService";
import { skillSummaries } from "./core/skillScanner";
import type { DiscoveredConfig, JsoncError } from "./core/types";
import { WatchManager } from "./core/watchManager";
import type { WatchTarget } from "./core/watchManager";
import { toPresetListEntries } from "./shared/protocol";
import { ConfigTreeDataProvider } from "./tree/provider";
import type { TreeDataSnapshot } from "./tree/provider";
import { registerCommands } from "./ui/commands";
import { createQuotaStatusBar } from "./ui/quotaStatusBar";
import { readAutoRefreshSettings, writeAutoRefreshSettings } from "./ui/settingsStore";
import { createStatusBar } from "./ui/statusbar";
import {
  buildConfigInitPayload,
  buildOpencodeInitPayload,
  notifyManagerPanelConfigChanged,
  notifyManagerPanelModelsChanged,
  notifyManagerPanelOpencodeChanged,
  notifyManagerPanelPresetsChanged,
  openPresetEditorTab,
  postMessageToManagerPanel,
  pushSettingsToManagerPanel,
  registerManagerPanel,
} from "./webview/managerPanelHost";
import { createPresetEditorSession } from "./webview/presetEditorHost";

export function activate(ctx: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  // Section-scoped get() requires the LEAF key; the fully-qualified form silently yields undefined.
  const override = cfg.get<string>(CONFIG_LEAF.configDirOverride)?.trim();
  const configStore = new ConfigStore(override ? { configDirOverride: override } : {});

  const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  ctx.subscriptions.push(channel);
  const log = (message: string): void => {
    channel.appendLine(`[${new Date().toISOString()}] ${message}`);
  };

  const workspaceFolders = (): string[] => vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];

  const collectStatic = (): {
    discovered: DiscoveredConfig;
    parseErrors: Map<string, JsoncError[]>;
  } => {
    const discovered = configStore.discover(workspaceFolders());
    const parseErrors = new Map<string, JsoncError[]>();
    for (const file of [discovered.opencodeJson, discovered.agentConfig.path]) {
      const text = configStore.readTextOrEmpty(file);
      if (text.length > 0) {
        const errors = validate(text);
        if (errors.length > 0) {
          parseErrors.set(file, errors);
        }
      }
    }
    return { discovered, parseErrors };
  };

  // Activation wiring needs path-level fields only (managedFiles, watcher targets, service
  // dirs); discoverPaths() answers those without building skills/command trees. The one
  // FULL discover per activation happens inside the provider's first loadData below.
  const paths = configStore.discoverPaths(workspaceFolders());
  const backupService = new BackupService({
    configDir: paths.configDir,
    managedFiles: [paths.opencodeJson, paths.agentConfig.path, path.join(paths.configDir, "AGENTS.md")],
    // User-level skills live outside configDir; project skills are excluded (they live in the user's repo).
    extraDirs: [{ label: "skills-user", src: configStore.userSkillsDir }],
    // The "models" backup scope snapshots the local model catalog.
    modelsFile: path.join(paths.configDir, LOCAL_MODELS_FILE),
  });
  const presetService = new PresetService({
    presetsDir: paths.presetsDir,
    configStore,
  });

  const dataLoader = (): TreeDataSnapshot => {
    const { discovered, parseErrors } = collectStatic();
    const presets = presetService.list();
    return {
      discovered,
      parseErrors,
      presets,
      currentPreset: presetService.currentPresetName(presets),
      backups: backupService.list(),
      assignments: configStore.ohMyAssignments(),
      models: configStore.listModelEntries(),
      plugins: configStore.listPlugins(),
    };
  };

  // One merged view instead of four: every collapsed→expand transition of a view pane costs
  // renderer-side layout + when-clause evaluation over all extensions' contributions (2-3s in a
  // long-lived code-server window, independent of extension-side speed). A single always-visible
  // view restores via the fast path; the four sections expand as plain tree nodes (milliseconds).
  const provider = new ConfigTreeDataProvider(dataLoader);
  ctx.subscriptions.push(vscode.window.registerTreeDataProvider(VIEW.explorer, provider));

  const statusbar = createStatusBar({ presetService, log });
  ctx.subscriptions.push(statusbar);

  const quotaService = new QuotaService({
    quotaConfigPath: path.join(paths.configDir, "quota.json"),
  });
  const quotaStatusBar = createQuotaStatusBar({ quotaService, log });
  ctx.subscriptions.push(quotaStatusBar);

  // Watcher-driven refresh (debounced + content-deduped inside WatchManager). Kept separate
  // from `refreshAll` below so the watcher path does not re-open the explicit-refresh
  // cooldown after every watcher-triggered reload.
  const refreshViews = (): void => {
    // Called from the fs.watch debounce timer too — a throwing loader must degrade
    // to a log line there, never an uncaught exception in a timer callback.
    // refresh() can throw synchronously (sync loadData) or reject asynchronously.
    try {
      void provider.refresh().then(
        (snapshot) => {
          statusbar.update({ presets: snapshot.presets, currentPreset: snapshot.currentPreset });
          // Lazy providers: listModels()/mapping only run when the manager panel
          // is open (snapshot presets are already computed for the tree anyway).
          notifyManagerPanelModelsChanged(() => configStore.listModels());
          notifyManagerPanelPresetsChanged(() => toPresetListEntries(snapshot.presets));
          // Lazy too, and reuses the snapshot's skill locations — no second
          // discover() walk per watcher-driven refresh while the panel is open.
          notifyManagerPanelConfigChanged(() =>
            buildConfigInitPayload(managerDeps, skillSummaries(snapshot.discovered.skillLocations)),
          );
          // OpenCode-tab settings ride their own channel (opencode.json changes
          // also flow through this watcher; the OMO misc values already ride
          // the configInit push above via the same agent-config watch).
          notifyManagerPanelOpencodeChanged(() => buildOpencodeInitPayload(managerDeps));
        },
        (error: unknown) => {
          log(`refresh 失败: ${errorMessage(error)}`);
        },
      );
    } catch (error) {
      log(`refreshAll 失败: ${errorMessage(error)}`);
    }
  };

  const MANAGED_SUBDIRS = ["presets", "backups", "command", "skills"] as const;
  const MANAGED_BASENAMES = new Set([
    "opencode.json",
    "opencode.jsonc",
    "oh-my-opencode.json",
    "oh-my-opencode.jsonc",
    "oh-my-openagent.json",
    "oh-my-openagent.jsonc",
    "AGENTS.md",
    "models.json",
    "quota.json",
    // lockfile churn in configDir = npm/bun install touched the plugin set
    "package.json",
    "package-lock.json",
    "bun.lock",
  ]);
  const OMO_BASENAMES = new Set(["omo.jsonc", "omo.json"]);
  const PLUGIN_LOCK_BASENAMES = new Set(["package.json", "bun.lock", "bun.lockb"]);
  const agentConfigDir = path.dirname(paths.agentConfig.path);
  const pluginCacheDir = configStore.pluginCacheDir;
  // configDir must stay flat (filtered): it hosts node_modules (~20k files) that are
  // irrelevant to the extension — a recursive watch there costs seconds of inotify
  // setup and blocks activation. Only the managed subdirs are watched recursively (a
  // few dozen files). Missing dirs are skipped by WatchManager and retried on every
  // event burst, so dirs created after activation (presets/, <cache>/packages/ once
  // opencode first installs a plugin) get armed too.
  //
  // The table is FROZEN at activation: global skills locations that only appear later
  // are not added (WatchManager re-arms the listed dirs, it never re-resolves them) —
  // an accepted trade-off, recorded so nobody reads the const below as "recomputed".
  const watchTargets: WatchTarget[] = [
    { dir: configStore.configDir, recursive: false, allowedBasenames: MANAGED_BASENAMES },
    // The omo config lives outside the opencode config dir — watch it too (flat, filtered).
    ...(agentConfigDir !== configStore.configDir
      ? [{ dir: agentConfigDir, recursive: false, allowedBasenames: OMO_BASENAMES }]
      : []),
    // The opencode runtime installs npm plugins into its cache; lockfile writes there signal
    // plugin installs/uninstalls (the node_modules tree itself must stay unwatched).
    ...(pluginCacheDir !== configStore.configDir
      ? [{ dir: pluginCacheDir, recursive: false, allowedBasenames: PLUGIN_LOCK_BASENAMES }]
      : []),
    // opencode installs npm plugins isolated under <cache>/packages/<spec>/ (arborist);
    // a flat watch there catches per-plugin dir creation/removal. Root lockfile writes
    // (bun-era layout) are covered by the pluginCacheDir watch above.
    ...(pluginCacheDir !== configStore.configDir
      ? [{ dir: path.join(pluginCacheDir, "packages"), recursive: false }]
      : []),
    ...MANAGED_SUBDIRS.map((name): WatchTarget => {
      // backups/ grows FOREVER (manual backups are never pruned) and each historical
      // backup is a full tree — a recursive watch costs one inotify watch per subdir
      // across ALL backups (Linux cap 8192, shared with every other extension and the
      // workbench's own watcher). A flat watch on top-level entry churn (dir add/remove/
      // rename = backup created/deleted/renamed) covers every UI-relevant change.
      if (name === "backups") {
        return { dir: path.join(configStore.configDir, name), recursive: false };
      }
      return { dir: path.join(configStore.configDir, name), recursive: true };
    }),
    // Home-level skills dirs (~/.agents, ~/.claude, …) live outside configDir; watch each
    // discovered one recursively (a few dozen files each) so skill edits refresh the tree.
    // realpath dedupes symlink aliases first: ~/.claude/skills is typically a link to
    // ~/.agents/skills, and watching both doubles the event stream AND the inotify
    // consumption of the same physical tree.
    ...[
      ...new Set(
        paths.skillLocations
          .filter(
            (location) => location.scope === "global" && location.dir !== path.join(configStore.configDir, "skills"),
          )
          .map((location) => {
            try {
              return realpathSync(location.dir);
            } catch {
              return location.dir;
            }
          }),
      ),
    ].map((dir): WatchTarget => ({ dir, recursive: true })),
  ];

  const watchManager = new WatchManager({ targets: watchTargets, onRefresh: refreshViews, log });
  watchManager.arm();
  if (watchManager.watcherCount() === 0) {
    const message = "所有文件监视器创建失败";
    log(`fs.watch 失败，将依赖手动刷新: ${message}`);
    void vscode.window.showWarningMessage(`无法监视配置目录变更（${message}），请使用「OpenCode: 刷新」手动刷新`);
  }
  ctx.subscriptions.push(watchManager);

  const refreshAll = (): void => {
    refreshViews();
    // Our own writes echo back through fs.watch ~300ms later; mark the post-command disk
    // state as seen so the echo dedupes instead of paying a second full refresh.
    watchManager.noteExternalRefresh();
  };

  // Opt-in per-category polling on top of the always-on fs.watch layer: every tick
  // walks the same manual-refresh path (reload + echo suppression), so the two
  // mechanisms coalesce inside the provider's dirty-flag refresh logic.
  let autoRefreshTicks = 0;
  const autoRefreshScheduler = new AutoRefreshScheduler({
    getSettings: readAutoRefreshSettings,
    onRefresh: () => {
      autoRefreshTicks += 1;
      refreshAll();
    },
  });
  autoRefreshScheduler.reconfigure();
  ctx.subscriptions.push(autoRefreshScheduler);

  // Manager panel (模板/额度/设置 tabs): registered here because the preset-tab
  // session depends on refreshAll (defined above).
  const presetSession = createPresetEditorSession(ctx, { configStore, presetService, refreshAll, log });
  const managerDeps = {
    quotaService,
    statusBar: quotaStatusBar,
    readSettings: readAutoRefreshSettings,
    saveSettings: writeAutoRefreshSettings,
    preset: presetSession,
    listPresets: () => toPresetListEntries(presetService.list()),
    configStore,
    // Full discover() scan (the same one the tree uses) — lazy: only invoked when
    // the manager panel actually builds a configInit payload.
    listSkills: () => skillSummaries(configStore.discover(workspaceFolders()).skillLocations),
    refreshAll,
    log,
  };
  registerManagerPanel(ctx, managerDeps);

  // autoRefresh.* keys re-arm the polling scheduler; EXTERNAL settings changes
  // (standard Settings UI, hand edits) re-sync the open manager page — own-save
  // echoes are suppressed inside pushSettingsToManagerPanel so they can't revert
  // in-flight edits. quota.refreshSeconds is covered by quotaStatusBar's own
  // listener for re-scheduling; here it only refreshes the page display.
  const settingsListener = vscode.workspace.onDidChangeConfiguration((event) => {
    const autoRefreshChanged = event.affectsConfiguration(CONFIG_KEY.autoRefresh);
    if (autoRefreshChanged) {
      autoRefreshScheduler.reconfigure();
    }
    if (autoRefreshChanged || event.affectsConfiguration(CONFIG_KEY.quotaRefreshSeconds)) {
      pushSettingsToManagerPanel(readAutoRefreshSettings);
    }
  });
  ctx.subscriptions.push(settingsListener);

  registerCommands(ctx, {
    configStore,
    backupService,
    presetService,
    refreshAll,
    openPresetEditor: (name: string | null) => openPresetEditorTab(ctx, managerDeps, name),
    log,
  });

  // Warmup's full discover (skills/plugin trees) runs synchronously on the shared
  // exthost event loop — defer it past the activation IO storm other extensions
  // produce (language servers, git), then mark the seed write as seen so its
  // fs.watch echo doesn't pay a second full scan.
  const warmupTimer = setTimeout(() => {
    void provider.warmup().then(
      async () => {
        // Models are no longer bundled: seed the empty local catalog from models.dev
        // (builtin provider allowlist) once per activation until it succeeds. Skipped
        // under Test mode so the e2e sandbox never depends on real network.
        if (ctx.extensionMode === vscode.ExtensionMode.Test) {
          watchManager.noteExternalRefresh();
          return;
        }
        try {
          const seeded = await seedLocalModelsFromCatalog(paths.configDir);
          if (seeded.length > 0) {
            log(`models: 已从 models.dev 初始化模型清单（${seeded.length} 个模型）`);
            watchManager.noteExternalRefresh();
            refreshViews();
          }
        } catch (error) {
          log(`models: 联网初始化模型清单失败: ${errorMessage(error)}`);
        }
      },
      () => undefined,
    );
  }, 2_000);
  ctx.subscriptions.push({ dispose: () => clearTimeout(warmupTimer) });

  // Hidden test-bridge commands for the e2e suite ONLY (IDs owned by TEST_BRIDGE in
  // constants.ts). Deliberately NOT in package.json contributes (never user-visible
  // in the command palette) and registered only under ExtensionMode.Test:
  // (a) round-trip postMessage into the open preset editor panel,
  // (b) round-trip postMessage into the open manager panel (quota/settings legacy
  //     aliases kept: both now forward into the same merged singleton),
  // (c) read the preset status-bar text. See test/e2e/suite.
  if (ctx.extensionMode === vscode.ExtensionMode.Test) {
    ctx.subscriptions.push(
      vscode.commands.registerCommand(
        TEST_BRIDGE.presetEditorPostMessage,
        // The name arg is legacy from the multi-panel era; the merged panel is a
        // singleton, so every preset-editor bridge post lands on it directly.
        (_name: string, message: unknown): boolean => postMessageToManagerPanel(message),
      ),
      vscode.commands.registerCommand(TEST_BRIDGE.quotaPanelPostMessage, (message: unknown): boolean =>
        postMessageToManagerPanel(message),
      ),
      vscode.commands.registerCommand(TEST_BRIDGE.settingsPanelPostMessage, (message: unknown): boolean =>
        postMessageToManagerPanel(message),
      ),
      vscode.commands.registerCommand(TEST_BRIDGE.statusBarText, (): string => statusbar.text()),
      vscode.commands.registerCommand(TEST_BRIDGE.autoRefreshTicks, (): number => autoRefreshTicks),
    );
  }
}

export function deactivate(): void {}
