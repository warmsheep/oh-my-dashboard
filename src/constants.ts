/**
 * Extension glue-layer constants: command IDs, view IDs, settings keys,
 * validation patterns and file templates.
 *
 * Command / view IDs MUST stay in sync with package.json `contributes`.
 */

export const CMD = {
  openConfigFile: "opencode.openConfigFile",
  createConfig: "opencode.createConfig",
  setAgentModel: "opencode.setAgentModel",
  capturePreset: "opencode.capturePreset",
  applyPreset: "opencode.applyPreset",
  editPreset: "opencode.editPreset",
  renamePreset: "opencode.renamePreset",
  deletePreset: "opencode.deletePreset",
  exportPreset: "opencode.exportPreset",
  showPresetQuickPick: "opencode.showPresetQuickPick",
  backupNow: "opencode.backupNow",
  renameBackup: "opencode.renameBackup",
  restoreBackup: "opencode.restoreBackup",
  diffBackup: "opencode.diffBackup",
  deleteBackup: "opencode.deleteBackup",
  exportBackup: "opencode.exportBackup",
  importBackup: "opencode.importBackup",
  refreshTree: "opencode.refreshTree",
  addModel: "opencode.addModel",
  deleteModel: "opencode.deleteModel",
  openModelsFile: "opencode.openModelsFile",
  quotaRefresh: "opencode.quotaRefresh",
  quotaConfigureMimo: "opencode.quotaConfigureMimo",
} as const;

export const VIEW = {
  explorer: "opencodeExplorer",
} as const;

export const CONFIG_SECTION = "opencodeConfigManager";

export const CONFIG_KEY = {
  configDirOverride: "opencodeConfigManager.configDirOverride",
  quotaRefreshSeconds: "opencodeConfigManager.quota.refreshSeconds",
} as const;

export const PRESET_EDITOR_VIEW_TYPE = "opencode.presetEditor";

/**
 * Preset name validation is owned by src/core/pathSafety.ts (single source for the
 * tree/commands/webview layers). Re-exported here so existing imports keep working.
 */
export { PRESET_NAME_PATTERN, presetNameError } from "./core/pathSafety";

/** Free-text model ids entered by hand: `provider/model`. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export const OUTPUT_CHANNEL_NAME = "OpenCode Config Manager";

export const FILE_TEMPLATES: Record<"opencode.json" | "oh-my-opencode.json" | "omo.jsonc" | "AGENTS.md", string> = {
  "opencode.json":
    '{\n  "$schema": "https://opencode.ai/config.json",\n  "provider": {}\n}\n',
  "oh-my-opencode.json":
    '{\n  "$schema": "https://raw.githubusercontent.com/code-yeongyu/oh-my-opencode/dev/assets/oh-my-opencode.schema.json",\n  "agents": {},\n  "categories": {}\n}\n',
  "omo.jsonc":
    '{\n  "$schema": "https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/omo.schema.json",\n  "[opencode]": {\n    "agents": {},\n    "categories": {}\n  }\n}\n',
  "AGENTS.md": "# AGENTS.md\n",
};

/** workspaceState key under which an unsaved preset-editor draft is kept. */
export function presetDraftKey(name: string | null): string {
  return `presetDraft:${name ?? "__new__"}`;
}
