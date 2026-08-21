import type { BackupEntry, DiscoveredConfig, JsoncError, Preset } from "../core/types";

export type NodeKind =
  | "configRoot"
  | "configFile"
  | "agent"
  | "category"
  | "agentsMd"
  | "dirSummary"
  | "presetRoot"
  | "preset"
  | "captureAction"
  | "backupRoot"
  | "backup"
  | "guide"
  | "parseError";

export interface BaseNode {
  kind: NodeKind;
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  contextValue: string;
  collapsibleState: "none" | "collapsed" | "expanded";
  children?: BaseNode[];
  filePath?: string;
  errorOffsets?: JsoncError[];
}

export function buildConfigTree(
  _d: DiscoveredConfig,
  _presets: Preset[],
  _currentPreset: string | null,
  _backups: BackupEntry[],
  _parseErrors: Map<string, JsoncError[]>,
): BaseNode[] {
  throw new Error("NOT_IMPLEMENTED");
}
