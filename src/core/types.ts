export type Variant = "low" | "medium" | "high" | "xhigh" | "max";
export const VARIANTS: readonly Variant[] = ["low", "medium", "high", "xhigh", "max"];

export type JsonPath = (string | number)[];

export interface ModelSetting {
  model: string;
  variant?: Variant | null;
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

export interface DiscoveredConfig {
  configDir: string;
  opencodeJson: string;
  ohMyOpencodeJson: string;
  agentsMd: { scope: "global" | "project"; path: string; exists: boolean }[];
  commandDir: string;
  commandFiles: string[];
  skillsDir: string;
  skillNames: string[];
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
