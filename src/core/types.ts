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

/** One plugin declared in opencode.json[c] `plugin` (or V2 `plugins`) with its on-disk state. */
export interface PluginEntry {
  /** npm: package name without version suffix; path: basename of the resolved path. */
  name: string;
  /** Raw config entry (string form; `package` value for V2 object entries). */
  specifier: string;
  kind: "npm" | "path";
  /**
   * Existing install location, or the canonical would-be location when uninstalled
   * (npm: runtime-cache node_modules path; path: the resolved file path).
   */
  resolvedPath: string;
  /** Installed package.json version (npm installs only). */
  version?: string;
  installed: boolean;
  /** Plugin file tree (nested node_modules / .git excluded); [] when not installed. */
  tree: DirEntry[];
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

/**
 * One discovered skills directory. Every home-level convention dir (cross-tool
 * `~/.agents/skills`, Claude/opencode/Amp/Gemini/Cursor/Windsurf/Codex/… — see
 * configStore for the ordered candidate list) carries the global scope; workspace
 * `.agents| .claude | .opencode | .github | .gemini | .cursor | .windsurf`/skills dirs
 * carry the project scope. Rows are reported only when the dir exists on disk.
 */
export interface SkillLocation {
  scope: "global" | "project";
  /** Display path: `~/…` for home dirs, workspace-relative for project dirs. */
  label: string;
  dir: string;
  skillNames: string[];
  tree: DirEntry[];
}

export interface DiscoveredConfig {
  configDir: string;
  opencodeJson: string;
  ohMyOpencodeJson: string;
  agentConfig: AgentConfigTarget;
  agentsMd: { scope: "global" | "project"; path: string; exists: boolean }[];
  commandDir: string;
  commandFiles: string[];
  skillLocations: SkillLocation[];
  commandTree: DirEntry[];
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
