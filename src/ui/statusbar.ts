import * as vscode from "vscode";

import { CMD } from "../constants";
import { errorMessage } from "../core/errors";
import type { PresetService } from "../core/presetService";
import type { Preset } from "../core/types";

/** Preset identity data the bar renders; refreshAll passes it straight from the tree snapshot. */
export interface PresetBarState {
  presets: Preset[];
  currentPreset: string | null;
}

export interface StatusBarDeps {
  presetService: PresetService;
  log(message: string): void;
}

export interface StatusBar extends vscode.Disposable {
  /** Refresh from the given snapshot; without one, derives once from presetService (activation). */
  update(state?: PresetBarState): void;
  /** Current bar text — read surface for the e2e test-bridge command. */
  text(): string;
}

/** Create the preset status-bar item (left-aligned); first render derives from presetService, later updates come from tree snapshots. */
export function createStatusBar(deps: StatusBarDeps): StatusBar {
  // Explicit id: id-less items are probabilistically dropped by the renderer across
  // window startup/restore (microsoft/vscode#185089) — same root cause as the quota bar.
  const item = vscode.window.createStatusBarItem("opencode-preset", vscode.StatusBarAlignment.Left, 100);
  item.name = "OpenCode 模板";
  item.command = CMD.showPresetQuickPick;

  const update = (state?: PresetBarState): void => {
    let resolved: PresetBarState;
    if (state !== undefined) {
      resolved = state;
    } else {
      try {
        const presets = deps.presetService.list();
        resolved = { presets, currentPreset: deps.presetService.currentPresetName(presets) };
      } catch (error) {
        deps.log(`statusbar: 读取模板状态失败: ${errorMessage(error)}`);
        resolved = { presets: [], currentPreset: null };
      }
    }
    const name = resolved.currentPreset;
    const appliedAt = resolved.presets.find((preset) => preset.name === name)?.appliedAt ?? null;
    item.text = `$(bookmark) 模板: ${name ?? "无"}`;
    item.tooltip = name
      ? `当前模板: ${name}${appliedAt ? `\n应用时间: ${appliedAt}` : "\n尚未在本机应用"}`
      : "未应用任何模板（点击切换）";
    item.show();
  };

  update();
  return {
    update,
    text: (): string => item.text,
    dispose(): void {
      item.dispose();
    },
  };
}
