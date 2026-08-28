// Canonical KNOWN/VARIANT/ModelOption values live in shared/protocol.ts (single source,
// also consumed by the webview via @shared); re-exported here so every existing
// `import ... from "./types"` keeps working unchanged.
import type { ModelOption } from "../shared/protocol";

export { KNOWN_AGENTS, KNOWN_CATEGORIES, VARIANTS, VARIANT_ORDER } from "../shared/protocol";
export type { ModelOption, Variant } from "../shared/protocol";

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

/**
 * Chinese display labels for {@link BackupReason} values (tree rows, QuickPick items).
 * Lookups fall back to the raw reason string when a foreign value sneaks in from a
 * hand-edited manifest.
 */
export const BACKUP_REASON_LABELS: Record<string, string> = {
  manual: "手动",
  "pre-apply": "应用前",
  "pre-save": "保存前",
  "pre-restore": "恢复前",
};

/** Selectable parts of a backup: what create() may include and restore() may limit itself to. */
export type BackupScope = "config" | "presets" | "models";

/** Canonical scope order (single source) — create/restore/availability all follow it. */
export const BACKUP_SCOPES: readonly BackupScope[] = ["config", "presets", "models"];

/** Chinese display labels for {@link BackupScope} (QuickPick items, backup summaries). */
export const BACKUP_SCOPE_LABELS: Record<BackupScope, string> = {
  config: "配置",
  presets: "模板",
  models: "模型",
};

/** QuickPick detail lines explaining what each {@link BackupScope} covers. */
export const BACKUP_SCOPE_DETAILS: Record<BackupScope, string> = {
  config: "opencode/agent 配置、command、skills",
  presets: "presets 模板",
  models: "models.json 模型清单",
};

export interface BackupManifest {
  version: 1;
  reason: BackupReason;
  /** User-facing display name; purely presentational — the dir keeps its timestamp id. */
  name?: string;
  preset?: string;
  /**
   * Scopes recorded at create time; absent = legacy full backup. Restore-time
   * availability is always detected from the backup CONTENT instead (see
   * BackupService.availableScopes), so this field is informational only.
   */
  scopes?: BackupScope[];
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

/** An existing skills candidate dir — the path-level row discoverPaths() reports, without tree/skill names. */
export interface SkillDirLocation {
  scope: SkillLocation["scope"];
  /** Display path: `~/…` for home dirs, workspace-relative for project dirs. */
  label: string;
  dir: string;
}

export interface DiscoveredConfig {
  configDir: string;
  opencodeJson: string;
  agentConfig: AgentConfigTarget;
  agentsMd: { scope: "global" | "project"; path: string; exists: boolean }[];
  commandDir: string;
  commandFiles: string[];
  skillLocations: SkillLocation[];
  commandTree: DirEntry[];
  presetsDir: string;
  backupsDir: string;
}

/**
 * Cheap path-level subset of discover(): everything activation wiring needs (paths +
 * existence flags) WITHOUT scanning skills/command trees or reading any file contents.
 */
export interface DiscoveredPaths {
  configDir: string;
  opencodeJson: string;
  agentConfig: AgentConfigTarget;
  agentsMd: { scope: "global" | "project"; path: string; exists: boolean }[];
  commandDir: string;
  /** The opencode-native skills dir (<configDir>/skills). */
  skillsDir: string;
  /** Existing skills candidate dirs in canonical order (dir-level rows only). */
  skillLocations: SkillDirLocation[];
  presetsDir: string;
  backupsDir: string;
}
