export type Variant = "low" | "medium" | "high" | "xhigh" | "max";
export const VARIANTS: readonly Variant[] = ["low", "medium", "high", "xhigh", "max"];

export type JsonPath = (string | number)[];

export interface ModelSetting {
  model: string;
  /**
   * Reasoning level. Presets capture/apply the canonical `reasoning` key on omo targets and the
   * deprecated `variant` key on legacy targets; upstream accepts harness-native tokens beyond
   * VARIANTS (e.g. "off", "minimal"), so this is intentionally wider than Variant.
   */
  variant?: string | null;
}

export interface Preset {
  name: string;
  description?: string;
  createdAt: string;
  appliedAt?: string | null;
  defaults: { model?: string | null };
  agents: Record<string, ModelSetting>;
  categories: Record<string, ModelSetting>;
}

export type BackupReason = "manual" | "pre-apply" | "pre-save" | "pre-restore";

export interface BackupManifest {
  version: 1;
  reason: BackupReason;
  /** User-facing display name; purely presentational — the dir keeps its timestamp id. */
  name?: string;
  preset?: string;
  createdAt: string;
  fileCount: number;
  machine: string;
}

export interface BackupEntry {
  dirName: string;
  dir: string;
  manifest: BackupManifest;
}

export interface JsoncError {
  offset: number;
  length: number;
  message: string;
}

export interface ParseResult<T> {
  value: T | null;
  errors: JsoncError[];
}

export interface ModelOption {
  id: string;
  provider: string;
  model: string;
  label: string;
}

export interface ModelEntry {
  option: ModelOption;
  source: "opencode" | "local" | "both";
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  children?: DirEntry[];
}

/** Where agent/category model assignments live on this machine. */
export interface AgentConfigTarget {
  /** "omo": unified ~/.omo/omo.jsonc (latest oh-my-openagent). "legacy": oh-my-opencode.json[c] / oh-my-openagent.json[c]. */
  kind: "omo" | "legacy";
  path: string;
  /** Path prefix for agents/categories sections: ["[opencode]"] on omo targets, [] on legacy. */
  sectionPath: JsonPath;
  /** Canonical per-entry reasoning field written on this target. */
  reasoningKey: "reasoning" | "variant";
  exists: boolean;
}

export interface DiscoveredConfig {
  configDir: string;
  opencodeJson: string;
  ohMyOpencodeJson: string;
  agentConfig: AgentConfigTarget;
  agentsMd: { scope: "global" | "project"; path: string; exists: boolean }[];
  commandDir: string;
  commandFiles: string[];
  skillsDir: string;
  skillNames: string[];
  commandTree: DirEntry[];
  skillsTree: DirEntry[];
  presetsDir: string;
  backupsDir: string;
}

export const KNOWN_AGENTS: readonly string[] = [
  "hephaestus",
  "oracle",
  "librarian",
  "explore",
  "multimodal-looker",
  "prometheus",
  "metis",
  "momus",
  "atlas",
  "sisyphus",
  "sisyphus-junior",
];

export const KNOWN_CATEGORIES: readonly string[] = [
  "visual-engineering",
  "ultrabrain",
  "deep",
  "artistry",
  "quick",
  "unspecified-low",
  "unspecified-high",
  "writing",
  "architect",
  "backend",
  "frontend",
  "qa",
  "product",
];
