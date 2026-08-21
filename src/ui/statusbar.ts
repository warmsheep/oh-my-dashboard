import * as vscode from "vscode";
import type { PresetService } from "../core/presetService";
import { CMD } from "../constants";

export interface StatusBarDeps {
  presetService: PresetService;
  log(message: string): void;
}

export interface StatusBar extends vscode.Disposable {
  update(): void;
}

export function createStatusBar(deps: StatusBarDeps): StatusBar {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.name = "OpenCode 预设";
  item.command = CMD.showPresetQuickPick;

  const update = (): void => {
    let name: string | null = null;
    let appliedAt: string | null = null;
    try {
      name = deps.presetService.currentPresetName();
    } catch (error) {
      deps.log(`statusbar: currentPresetName 失败: ${errorMessage(error)}`);
    }
    if (name) {
      try {
        appliedAt = deps.presetService.load(name).appliedAt ?? null;
      } catch (error) {
        deps.log(`statusbar: 读取预设 ${name} 失败: ${errorMessage(error)}`);
      }
    }
    item.text = `$(bookmark) 预设: ${name ?? "无"}`;
    item.tooltip = name
      ? `当前预设: ${name}${appliedAt ? `\n应用时间: ${appliedAt}` : "\n尚未在本机应用"}`
      : "未应用任何预设（点击切换）";
    item.show();
  };

  update();
  return {
    update,
    dispose(): void {
      item.dispose();
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
