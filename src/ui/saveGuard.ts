import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { validate } from "../core/jsoncEditor";
import type { BackupService } from "../core/backupService";
import type { ConfigStore } from "../core/configStore";
import { CONFIG_KEY } from "../constants";

export interface SaveGuardDeps {
  configStore: ConfigStore;
  backupService: BackupService;
  refreshAll(): void;
  workspaceFolders(): string[];
  log(message: string): void;
}

export function initSaveGuard(ctx: vscode.ExtensionContext, deps: SaveGuardDeps): void {
  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      void handleSave(doc).catch((error: unknown) => {
        deps.log(`saveGuard: ${errorMessage(error)}`);
        void vscode.window.showErrorMessage(`自动备份失败: ${errorMessage(error)}`);
      });
    }),
  );

  async function handleSave(doc: vscode.TextDocument): Promise<void> {
    const cfg = vscode.workspace.getConfiguration();
    if (!cfg.get<boolean>(CONFIG_KEY.autoBackupOnSave, true)) {
      return;
    }

    const discovered = deps.configStore.discover(deps.workspaceFolders());
    const saved = doc.uri.fsPath;
    const managedPaths = [
      discovered.opencodeJson,
      discovered.ohMyOpencodeJson,
      ...discovered.agentsMd.map((entry) => entry.path),
    ];
    if (!managedPaths.includes(saved)) {
      return;
    }

    if (saved.endsWith(".json")) {
      const errors = validate(doc.getText());
      if (errors.length > 0) {
        void vscode.window.showWarningMessage("保存的配置有语法错误，已跳过自动备份");
        deps.refreshAll();
        return;
      }
    }

    const text = doc.getText();
    const newest = newestPreSaveBackup(deps);
    if (newest) {
      const backupCopy = path.join(newest.dir, path.basename(saved));
      if (fs.existsSync(backupCopy) && deps.configStore.readTextOrEmpty(backupCopy) === text) {
        deps.log(`saveGuard: ${path.basename(saved)} 与最近一次 pre-save 备份内容一致，跳过备份`);
        deps.refreshAll();
        return;
      }
    }

    const entry = deps.backupService.create("pre-save");
    deps.backupService.prune("pre-save");
    void vscode.window.showInformationMessage(`已自动备份配置（${entry.dirName}）`);
    deps.refreshAll();
  }
}

function newestPreSaveBackup(deps: SaveGuardDeps) {
  const entries = deps.backupService
    .list()
    .filter((entry) => entry.manifest.reason === "pre-save");
  if (entries.length === 0) {
    return undefined;
  }
  return entries.reduce((a, b) => (a.dirName > b.dirName ? a : b));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
