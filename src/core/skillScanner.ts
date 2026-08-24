import * as defaultFs from "node:fs";
import * as path from "node:path";

import type { DirEntry, SkillDirLocation } from "./types";

/**
 * Project-level skills dir conventions, in display order: the cross-tool standard
 * first, then per-tool native paths (agentskills.io spec + Claude Code / opencode /
 * GitHub Copilot / Gemini CLI / Cursor / Windsurf docs).
 */
const PROJECT_SKILL_DIRS = [
  ".agents/skills",
  ".claude/skills",
  ".opencode/skills",
  ".github/skills",
  ".gemini/skills",
  ".cursor/skills",
  ".windsurf/skills",
] as const;

/** statSync follows symlinks (intended: `~/.claude/skills` is often a link to `~/.agents/skills`). */
export function isDirectoryPath(p: string): boolean {
  try {
    return defaultFs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A single unreadable dir (EACCES/EPERM) or one deleted mid-scan (ENOENT race) must not
 * break discovery of everything else — degrade that subtree to empty instead.
 */
export function readdirSafe(dir: string): defaultFs.Dirent[] {
  try {
    return defaultFs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Dirent.isDirectory() is false for symlinks — follow the link before classifying. */
function isDirEntry(entry: defaultFs.Dirent, entryPath: string): boolean {
  if (entry.isDirectory()) {
    return true;
  }
  if (entry.isSymbolicLink()) {
    return isDirectoryPath(entryPath);
  }
  return false;
}

/**
 * Generic bounded directory-tree walk (shared by skills/command trees in configStore
 * and plugin file trees in pluginResolver). Depth-capped at 8; a realpath visited-set
 * kills symlink cycles and fan-out; dir-ness is computed once per entry so only
 * symlinks pay a statSync. Unreadable subdirs degrade to empty (readdirSafe).
 */
export function readDirTree(
  dir: string,
  depth = 0,
  exclude?: ReadonlySet<string>,
  visited: Set<string> = new Set(),
): DirEntry[] {
  if (depth > 8 || !defaultFs.existsSync(dir)) {
    return [];
  }
  // Symlink cycles terminate via the depth cap, but k self-links still fan out k^8 —
  // a visited set of real paths kills both cycles and fan-out.
  let real: string;
  try {
    real = defaultFs.realpathSync(dir);
  } catch {
    real = dir;
  }
  if (visited.has(real)) {
    return [];
  }
  visited.add(real);
  const entries = readdirSafe(dir).filter((entry) => !exclude?.has(entry.name));
  // Dir-ness is computed ONCE per entry (Dirent.isDirectory() is free; only symlinks pay
  // one statSync) and shared by the sort comparator and the map phase below — a sort
  // comparator calling isDirEntry directly would stat O(n log n) times per directory.
  const dirness = new Map<string, boolean>();
  for (const entry of entries) {
    dirness.set(entry.name, isDirEntry(entry, path.join(dir, entry.name)));
  }
  entries.sort((a, b) => {
    const aDir = dirness.get(a.name) ?? false;
    const bDir = dirness.get(b.name) ?? false;
    if (aDir !== bDir) {
      return aDir ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return entries.map((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (dirness.get(entry.name) ?? false) {
      const children = readDirTree(entryPath, depth + 1, exclude, visited);
      return {
        name: entry.name,
        path: entryPath,
        isDir: true,
        ...(children.length > 0 ? { children } : {}),
      };
    }
    return { name: entry.name, path: entryPath, isDir: false };
  });
}

/** A skill is a dir whose SKILL.md is a regular FILE (following links) — a dir named SKILL.md is not one. */
function isSkillMdFile(dir: string): boolean {
  try {
    return defaultFs.statSync(path.join(dir, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

/** Skill names derived from an already-built dir tree (dirs whose SKILL.md is a file) — no second scan. */
export function skillNamesFromTree(tree: DirEntry[]): string[] {
  return tree
    .filter((entry) => entry.isDir && isSkillMdFile(entry.path))
    .map((entry) => entry.name)
    .sort();
}

/** NTFS and default APFS are case-insensitive: compare folded, display original. */
function foldCase(p: string, platform: NodeJS.Platform): string {
  return platform === "win32" || platform === "darwin" ? p.toLowerCase() : p;
}

function displayPathFor(dir: string, homeDir: string, platform: NodeJS.Platform): string {
  const homePrefix = homeDir + path.sep;
  return foldCase(dir, platform) === foldCase(homeDir, platform) ||
    foldCase(dir, platform).startsWith(foldCase(homePrefix, platform))
    ? `~${dir.slice(homeDir.length)}`
    : dir;
}

/**
 * Existing skills candidate dirs in canonical order. Home-level convention dirs
 * (cross-tool standard → Claude → opencode → Amp XDG → Copilot → Gemini → Cursor →
 * Windsurf → Codex legacy); the opencode runtime's own ~/.cache/opencode/skills plugin
 * cache is deliberately not a candidate. Rows appear only when the path is an existing
 * DIRECTORY (statSync follows the ~/.claude/skills symlink — intended); configDir/skills
 * may coincide with a home candidate → dedupe folded.
 */
export function skillDirCandidates(args: {
  configDir: string;
  homeDir: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  workspaceFolders?: string[];
}): SkillDirLocation[] {
  const { configDir, homeDir, env, platform, workspaceFolders } = args;
  const xdgConfig =
    typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim() !== ""
      ? env.XDG_CONFIG_HOME
      : path.join(homeDir, ".config");
  const globalSkillCandidates = [
    path.join(homeDir, ".agents", "skills"),
    path.join(homeDir, ".claude", "skills"),
    path.join(configDir, "skills"),
    path.join(xdgConfig, "agents", "skills"),
    path.join(xdgConfig, "amp", "skills"),
    path.join(homeDir, ".copilot", "skills"),
    path.join(homeDir, ".gemini", "skills"),
    path.join(homeDir, ".cursor", "skills"),
    path.join(homeDir, ".codeium", "windsurf", "skills"),
    path.join(homeDir, ".codex", "skills"),
  ];
  const seenSkillDirs = new Set<string>();
  const locations: SkillDirLocation[] = [];
  for (const candidate of globalSkillCandidates) {
    if (!seenSkillDirs.has(foldCase(candidate, platform)) && isDirectoryPath(candidate)) {
      seenSkillDirs.add(foldCase(candidate, platform));
      locations.push({ scope: "global", label: displayPathFor(candidate, homeDir, platform), dir: candidate });
    }
  }
  for (const folder of workspaceFolders ?? []) {
    for (const rel of PROJECT_SKILL_DIRS) {
      const projectSkillsDir = path.join(folder, rel);
      if (isDirectoryPath(projectSkillsDir)) {
        locations.push({ scope: "project", label: rel, dir: projectSkillsDir });
      }
    }
  }
  return locations;
}
