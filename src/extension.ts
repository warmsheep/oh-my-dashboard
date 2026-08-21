import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { BackupService } from "./core/backupService";
import { ConfigStore } from "./core/configStore";
import { validate } from "./core/jsoncEditor";
import { PresetService } from "./core/presetService";
import type { BackupEntry, DiscoveredConfig, JsoncError, ModelEntry, ModelSetting, Preset } from "./core/types";
import { CONFIG_KEY, CONFIG_SECTION, OUTPUT_CHANNEL_NAME, VIEW } from "./constants";
import { ConfigTreeDataProvider } from "./tree/provider";
import { registerCommands } from "./ui/commands";
import { createStatusBar } from "./ui/statusbar";
import { notifyPresetEditorsModelsChanged } from "./webview/presetEditorHost";

interface TreeDataSnapshot {
  discovered: DiscoveredConfig;
  presets: Preset[];
  currentPreset: string | null;
  backups: BackupEntry[];
  parseErrors: Map<string, JsoncError[]>;
  assignments: { agents: Record<string, ModelSetting>; categories: Record<string, ModelSetting> };
  models: ModelEntry[];
}

export function activate(ctx: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const override = cfg.get<string>(CONFIG_KEY.configDirOverride)?.trim();
  const configStore = new ConfigStore(override ? { configDirOverride: override } : {});

  const channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  ctx.subscriptions.push(channel);
  const log = (message: string): void => {
    channel.appendLine(`[${new Date().toISOString()}] ${message}`);
  };

  const workspaceFolders = (): string[] =>
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];

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

  const discovered = configStore.discover(workspaceFolders());
  const backupService = new BackupService({
    configDir: discovered.configDir,
    managedFiles: [
      discovered.opencodeJson,
      discovered.agentConfig.path,
      path.join(discovered.configDir, "AGENTS.md"),
    ],
  });
  const presetService = new PresetService({
    presetsDir: discovered.presetsDir,
    configStore,
  });

  const dataLoader = (): TreeDataSnapshot => {
    const { discovered, parseErrors } = collectStatic();
    return {
      discovered,
      parseErrors,
      presets: presetService.list(),
      currentPreset: presetService.currentPresetName(),
      backups: backupService.list(),
      assignments: configStore.ohMyAssignments(),
      models: configStore.listModelEntries(),
    };
  };

  const providers = {
    configFiles: new ConfigTreeDataProvider("config", dataLoader),
    presets: new ConfigTreeDataProvider("presets", dataLoader),
    backups: new ConfigTreeDataProvider("backups", dataLoader),
    models: new ConfigTreeDataProvider("models", dataLoader),
  };
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider(VIEW.configFiles, providers.configFiles),
    vscode.window.registerTreeDataProvider(VIEW.presets, providers.presets),
    vscode.window.registerTreeDataProvider(VIEW.backups, providers.backups),
    vscode.window.registerTreeDataProvider(VIEW.models, providers.models),
  );

  const statusbar = createStatusBar({ presetService, log });
  ctx.subscriptions.push(statusbar);

  const refreshAll = (): void => {
    providers.configFiles.refresh();
    providers.presets.refresh();
    providers.backups.refresh();
    providers.models.refresh();
    statusbar.update();
    notifyPresetEditorsModelsChanged(configStore.listModels());
  };

  registerCommands(ctx, { configStore, backupService, presetService, refreshAll, log });

  let watchTimer: NodeJS.Timeout | undefined;
  const onWatchEvent = (): void => {
    if (watchTimer !== undefined) {
      clearTimeout(watchTimer);
    }
    watchTimer = setTimeout(() => {
      watchTimer = undefined;
      refreshAll();
    }, 300);
  };
  const watchers: fs.FSWatcher[] = [];
  try {
    watchers.push(fs.watch(configStore.configDir, { recursive: true }, onWatchEvent));
    // The omo config lives outside the opencode config dir — watch it too (flat: only omo.jsonc matters).
    const agentConfigDir = path.dirname(discovered.agentConfig.path);
    if (agentConfigDir !== configStore.configDir && fs.existsSync(agentConfigDir)) {
      watchers.push(fs.watch(agentConfigDir, onWatchEvent));
    }
    ctx.subscriptions.push({
      dispose: () => {
        if (watchTimer !== undefined) {
          clearTimeout(watchTimer);
        }
        for (const watcher of watchers) {
          watcher.close();
        }
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`fs.watch(${configStore.configDir}) 失败，将依赖手动刷新: ${message}`);
    void vscode.window.showWarningMessage(
      `无法监视配置目录变更（${message}），请使用「OpenCode: 刷新」手动刷新`,
    );
  }
}

export function deactivate(): void {}
