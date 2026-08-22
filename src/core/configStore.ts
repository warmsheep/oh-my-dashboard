import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getValue, parseSafe } from "./jsoncEditor";
import { ensureLocalModelsFile, mergeModelOptions } from "./builtinModels";
import type {
  AgentConfigTarget,
  DirEntry,
  DiscoveredConfig,
  ModelEntry,
  ModelOption,
  ModelSetting,
  ParseResult,
  PluginEntry,
  SkillLocation,
} from "./types";

export interface ConfigStoreOptions {
  configDirOverride?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

const PLUGIN_TREE_EXCLUDES = new Set(["node_modules", ".git"]);

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

function isPathPluginSpecifier(specifier: string): boolean {
  // Mirrors upstream isPathPluginSpec (file:// / . / absolute) plus ~, which npm names cannot contain.
  return specifier.startsWith("file://") || specifier.startsWith("~") || specifier.startsWith(".") || path.isAbsolute(specifier);
}

function npmPluginName(specifier: string): string {
  // @scope/name@1.0.0 → cut at the 2nd @; name@1.0.0 → cut at the 1st.
  const from = specifier.startsWith("@") ? specifier.indexOf("@", 1) : specifier.indexOf("@");
  return from === -1 ? specifier : specifier.slice(0, from);
}

/** Dirent.isDirectory() is false for symlinks — follow the link before classifying. */
function isDirEntry(entry: fs.Dirent, entryPath: string): boolean {
  if (entry.isDirectory()) {
    return true;
  }
  if (entry.isSymbolicLink()) {
    try {
      return fs.statSync(entryPath).isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

function readDirTree(dir: string, depth = 0, exclude?: ReadonlySet<string>): DirEntry[] {
  if (depth > 8 || !fs.existsSync(dir)) {
    return [];
  }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !exclude?.has(entry.name))
    .sort((a, b) => {
      const aDir = isDirEntry(a, path.join(dir, a.name));
      const bDir = isDirEntry(b, path.join(dir, b.name));
      if (aDir !== bDir) {
        return aDir ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  return entries.map((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (isDirEntry(entry, entryPath)) {
      const children = readDirTree(entryPath, depth + 1, exclude);
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

export class ConfigStore {
  private readonly env: Record<string, string | undefined>;
  private readonly homeDir: string;
  private readonly configDirOverride?: string;

  constructor(opts: ConfigStoreOptions = {}) {
    this.env = opts.env ?? process.env;
    this.homeDir = opts.homeDir ?? os.homedir();
    this.configDirOverride = opts.configDirOverride;
  }

  static resolveConfigDir(
    env?: Record<string, string | undefined>,
    homeDir?: string,
    platform?: NodeJS.Platform,
  ): string {
    const effectiveEnv = env ?? process.env;
    const home = homeDir ?? os.homedir();
    const effectivePlatform = platform ?? process.platform;
    const xdg = effectiveEnv.XDG_CONFIG_HOME;
    if (typeof xdg === "string" && xdg.trim() !== "") {
      return path.join(xdg, "opencode");
    }
    if (effectivePlatform === "darwin") {
      return path.join(home, "Library", "Application Support", "opencode");
    }
    return path.join(home, ".config", "opencode");
  }

  get configDir(): string {
    return this.configDirOverride ?? ConfigStore.resolveConfigDir(this.env, this.homeDir);
  }

  /** oh-my-openagent's unified config home (`~/.omo` on every platform). */
  get omoDir(): string {
    return path.join(this.homeDir, ".omo");
  }

  /** Cross-agent user-level skills dir (`~/.agents/skills`). */
  get userSkillsDir(): string {
    return path.join(this.homeDir, ".agents", "skills");
  }

  /**
   * The opencode runtime's npm plugin cache: plugins from the `plugin` array are
   * bun-installed here (~/.cache/opencode/node_modules on linux). XDG_CACHE_HOME and
   * the darwin caches dir are honored like resolveConfigDir honors their config twins.
   */
  get pluginCacheDir(): string {
    const xdg = this.env.XDG_CACHE_HOME;
    if (typeof xdg === "string" && xdg.trim() !== "") {
      return path.join(xdg, "opencode");
    }
    if (process.platform === "darwin") {
      return path.join(this.homeDir, "Library", "Caches", "opencode");
    }
    return path.join(this.homeDir, ".cache", "opencode");
  }

  /**
   * Plugins declared in opencode.json[c]: the `plugin` string array (V2 `plugins` as
   * fallback, whose object entries expose a `package` field). npm entries resolve against
   * the runtime cache first, then <configDir>/node_modules; path entries (~/, ./, /,
   * file://) resolve against home / configDir. Declaration order is preserved.
   */
  listPlugins(): PluginEntry[] {
    const text = this.readTextOrEmpty(this.resolveOpencodeConfigPath());
    if (!text) {
      return [];
    }
    const raw = getValue<unknown>(text, ["plugin"]) ?? getValue<unknown>(text, ["plugins"]);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.flatMap((item) => {
      const specifier =
        typeof item === "string" ? item.trim() : item && typeof item === "object" && typeof (item as { package?: unknown }).package === "string" ? (item as { package: string }).package.trim() : "";
      return specifier ? [this.resolvePlugin(specifier)] : [];
    });
  }

  private resolvePlugin(specifier: string): PluginEntry {
    return isPathPluginSpecifier(specifier) ? this.resolvePathPlugin(specifier) : this.resolveNpmPlugin(specifier);
  }

  private resolvePathPlugin(specifier: string): PluginEntry {
    const spec = specifier.startsWith("file://") ? specifier.slice("file://".length) : specifier;
    const resolved = spec.startsWith("~") ? path.join(this.homeDir, spec.slice(1)) : path.resolve(this.configDir, spec);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(resolved);
    } catch {
      stat = undefined;
    }
    const tree = stat?.isDirectory()
      ? readDirTree(resolved, 0, PLUGIN_TREE_EXCLUDES)
      : stat?.isFile()
        ? [{ name: path.basename(resolved), path: resolved, isDir: false }]
        : [];
    return { name: path.basename(resolved), specifier, kind: "path", resolvedPath: resolved, installed: stat !== undefined, tree };
  }

  private resolveNpmPlugin(specifier: string): PluginEntry {
    const name = npmPluginName(specifier);
    const isInstalledDir = (candidate: string): boolean => {
      try {
        return fs.statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    };
    const cacheCandidate = path.join(this.pluginCacheDir, "node_modules", name);
    const configCandidate = path.join(this.configDir, "node_modules", name);
    const cacheHit = isInstalledDir(cacheCandidate);
    const configHit = !cacheHit && isInstalledDir(configCandidate);
    const resolvedPath = cacheHit ? cacheCandidate : configHit ? configCandidate : cacheCandidate;
    const installed = cacheHit || configHit;
    const version = installed ? this.installedPluginVersion(resolvedPath) : undefined;
    return { name, specifier, kind: "npm", resolvedPath, installed, ...(version !== undefined ? { version } : {}), tree: installed ? readDirTree(resolvedPath, 0, PLUGIN_TREE_EXCLUDES) : [] };
  }

  private installedPluginVersion(dir: string): string | undefined {
    const parsed = this.readParse<{ version?: unknown }>(path.join(dir, "package.json"));
    return typeof parsed.value?.version === "string" ? parsed.value.version : undefined;
  }

  /**
   * The opencode base config that actually exists on this machine: opencode.json wins, then
   * opencode.jsonc, then opencode.json as the creation default.
   */
  resolveOpencodeConfigPath(): string {
    const json = path.join(this.configDir, "opencode.json");
    if (fs.existsSync(json)) {
      return json;
    }
    const jsonc = path.join(this.configDir, "opencode.jsonc");
    return fs.existsSync(jsonc) ? jsonc : json;
  }

  /**
   * The agent/category config this machine actually uses. Current oh-my-openagent reads only
   * ~/.omo/omo.jsonc (legacy files are migrated away); older installs read the legacy basenames
   * in the runtime's compat order (oh-my-opencode before oh-my-openagent, .jsonc before .json).
   * When nothing exists, an existing ~/.omo dir or an "oh-my-openagent" plugin entry in
   * opencode.json selects the omo creation target; otherwise the legacy file is created.
   */
  resolveAgentConfig(): AgentConfigTarget {
    const omoJsonc = path.join(this.omoDir, "omo.jsonc");
    const omoJson = path.join(this.omoDir, "omo.json");
    const omo = (p: string, exists: boolean): AgentConfigTarget => ({
      kind: "omo",
      path: p,
      sectionPath: ["[opencode]"],
      reasoningKey: "reasoning",
      exists,
    });
    if (fs.existsSync(omoJsonc)) {
      return omo(omoJsonc, true);
    }
    if (fs.existsSync(omoJson)) {
      return omo(omoJson, true);
    }
    for (const name of [
      "oh-my-opencode.jsonc",
      "oh-my-opencode.json",
      "oh-my-openagent.jsonc",
      "oh-my-openagent.json",
    ]) {
      const candidate = path.join(this.configDir, name);
      if (fs.existsSync(candidate)) {
        return { kind: "legacy", path: candidate, sectionPath: [], reasoningKey: "variant", exists: true };
      }
    }
    const plugins = getValue<unknown>(this.readTextOrEmpty(this.resolveOpencodeConfigPath()), ["plugin"]);
    const usesOpenagent =
      Array.isArray(plugins) &&
      plugins.some((entry) => typeof entry === "string" && entry.startsWith("oh-my-openagent"));
    if (fs.existsSync(this.omoDir) || usesOpenagent) {
      return omo(omoJsonc, false);
    }
    return {
      kind: "legacy",
      path: path.join(this.configDir, "oh-my-opencode.json"),
      sectionPath: [],
      reasoningKey: "variant",
      exists: false,
    };
  }

  discover(workspaceFolders?: string[]): DiscoveredConfig {
    const configDir = this.configDir;
    const opencodeJson = this.resolveOpencodeConfigPath();
    const ohMyOpencodeJson = path.join(configDir, "oh-my-opencode.json");
    const agentConfig = this.resolveAgentConfig();
    const commandDir = path.join(configDir, "command");

    const commandFiles = fs.existsSync(commandDir)
      ? fs
          .readdirSync(commandDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
          .map((entry) => entry.name)
          .sort()
      : [];

    const isSkillDir = (dir: string, entry: fs.Dirent): boolean =>
      isDirEntry(entry, path.join(dir, entry.name)) && fs.existsSync(path.join(dir, entry.name, "SKILL.md"));

    const listSkillNames = (dir: string): string[] =>
      fs.existsSync(dir)
        ? fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((entry) => isSkillDir(dir, entry))
            .map((entry) => entry.name)
            .sort()
        : [];

    const homePrefix = this.homeDir + path.sep;
    const displayPath = (dir: string): string =>
      dir === this.homeDir || dir.startsWith(homePrefix) ? `~${dir.slice(this.homeDir.length)}` : dir;

    const skillLocation = (scope: SkillLocation["scope"], label: string, dir: string): SkillLocation => ({
      scope,
      label,
      dir,
      skillNames: listSkillNames(dir),
      tree: readDirTree(dir),
    });

    // Home-level convention dirs in canonical order (cross-tool standard → Claude → opencode →
    // Amp XDG → Copilot → Gemini → Cursor → Windsurf → Codex legacy); the opencode runtime's
    // own ~/.cache/opencode/skills plugin cache is deliberately not a candidate. Rows appear
    // only when the dir exists; configDir/skills may coincide with a home candidate → dedupe.
    const xdgConfig = typeof this.env.XDG_CONFIG_HOME === "string" && this.env.XDG_CONFIG_HOME.trim() !== ""
      ? this.env.XDG_CONFIG_HOME
      : path.join(this.homeDir, ".config");
    const globalSkillCandidates = [
      path.join(this.homeDir, ".agents", "skills"),
      path.join(this.homeDir, ".claude", "skills"),
      path.join(configDir, "skills"),
      path.join(xdgConfig, "agents", "skills"),
      path.join(xdgConfig, "amp", "skills"),
      path.join(this.homeDir, ".copilot", "skills"),
      path.join(this.homeDir, ".gemini", "skills"),
      path.join(this.homeDir, ".cursor", "skills"),
      path.join(this.homeDir, ".codeium", "windsurf", "skills"),
      path.join(this.homeDir, ".codex", "skills"),
    ];
    const seenSkillDirs = new Set<string>();
    const skillLocations: SkillLocation[] = [];
    for (const candidate of globalSkillCandidates) {
      if (!seenSkillDirs.has(candidate) && fs.existsSync(candidate)) {
        seenSkillDirs.add(candidate);
        skillLocations.push(skillLocation("global", displayPath(candidate), candidate));
      }
    }
    for (const folder of workspaceFolders ?? []) {
      for (const rel of PROJECT_SKILL_DIRS) {
        const projectSkillsDir = path.join(folder, rel);
        if (fs.existsSync(projectSkillsDir)) {
          skillLocations.push(skillLocation("project", rel, projectSkillsDir));
        }
      }
    }

    const agentsMd: DiscoveredConfig["agentsMd"] = [
      {
        scope: "global",
        path: path.join(configDir, "AGENTS.md"),
        exists: fs.existsSync(path.join(configDir, "AGENTS.md")),
      },
      ...(workspaceFolders ?? []).map((folder) => {
        const projectAgentsMd = path.join(folder, "AGENTS.md");
        return { scope: "project" as const, path: projectAgentsMd, exists: fs.existsSync(projectAgentsMd) };
      }),
    ];

    return {
      configDir,
      opencodeJson,
      ohMyOpencodeJson,
      agentConfig,
      agentsMd,
      commandDir,
      commandFiles,
      skillLocations,
      commandTree: readDirTree(commandDir),
      presetsDir: path.join(configDir, "presets"),
      backupsDir: path.join(configDir, "backups"),
    };
  }

  readText(filePath: string): string {
    return fs.readFileSync(filePath, "utf8");
  }

  readTextOrEmpty(filePath: string): string {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  }

  readParse<T>(filePath: string): ParseResult<T> {
    return parseSafe<T>(this.readTextOrEmpty(filePath));
  }

  writeAtomic(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    const tmpPath = path.join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (error) {
      fs.rmSync(tmpPath, { force: true });
      throw error;
    }
  }

  listModels(): ModelOption[] {
    const options = this.opencodeModels();
    const local = ensureLocalModelsFile(this.configDir);
    return mergeModelOptions(options, local);
  }

  listModelEntries(): ModelEntry[] {
    const fromOpencode = this.opencodeModels();
    const fromLocal = ensureLocalModelsFile(this.configDir);
    const opencodeIds = new Set(fromOpencode.map((m) => m.id));
    const localIds = new Set(fromLocal.map((m) => m.id));
    return mergeModelOptions(fromOpencode, fromLocal).map((option) => ({
      option,
      source: opencodeIds.has(option.id)
        ? localIds.has(option.id)
          ? "both"
          : "opencode"
        : "local",
    }));
  }

  private opencodeModels(): ModelOption[] {
    const result = this.readParse<{ provider?: Record<string, { models?: Record<string, unknown> }> }>(
      this.resolveOpencodeConfigPath(),
    );
    const options: ModelOption[] = [];
    const providers = result.value?.provider;
    if (providers && typeof providers === "object") {
      for (const [provider, providerConfig] of Object.entries(providers)) {
        const models = providerConfig?.models;
        if (!models || typeof models !== "object") {
          continue;
        }
        for (const [model, modelConfig] of Object.entries(models)) {
          const label =
            modelConfig && typeof modelConfig === "object" && typeof (modelConfig as { name?: unknown }).name === "string"
              ? (modelConfig as { name: string }).name
              : model;
          options.push({ id: `${provider}/${model}`, provider, model, label });
        }
      }
    }
    return options;
  }

  defaultModel(): string | null {
    const text = this.readTextOrEmpty(this.resolveOpencodeConfigPath());
    if (!text) {
      return null;
    }
    const model = getValue<unknown>(text, ["model"]);
    return typeof model === "string" ? model : null;
  }

  ohMyAssignments(): { agents: Record<string, ModelSetting>; categories: Record<string, ModelSetting> } {
    const target = this.resolveAgentConfig();
    const text = this.readTextOrEmpty(target.path);
    if (!text) {
      return { agents: {}, categories: {} };
    }
    if (target.kind === "legacy") {
      return {
        agents: getValue<Record<string, ModelSetting>>(text, ["agents"]) ?? {},
        categories: getValue<Record<string, ModelSetting>>(text, ["categories"]) ?? {},
      };
    }
    // omo: OpenCode plugin settings live under the "[opencode]" block; agents/categories may
    // also sit at the shared base level so every harness sees them.
    const read = (section: "agents" | "categories"): Record<string, ModelSetting> => {
      const raw =
        getValue<Record<string, unknown>>(text, [...target.sectionPath, section]) ??
        getValue<Record<string, unknown>>(text, [section]) ??
        {};
      const out: Record<string, ModelSetting> = {};
      for (const [key, entry] of Object.entries(raw)) {
        const setting = toModelSetting(entry);
        if (setting) {
          out[key] = setting;
        }
      }
      return out;
    };
    return { agents: read("agents"), categories: read("categories") };
  }
}

/** Normalize an omo entry ({model, reasoning} or a {models: [...]} chain) into a ModelSetting. */
function toModelSetting(entry: unknown): ModelSetting | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const chainHead =
    Array.isArray(record.models) && record.models.length > 0 && record.models[0] && typeof record.models[0] === "object"
      ? (record.models[0] as Record<string, unknown>)
      : undefined;
  const model =
    typeof record.model === "string"
      ? record.model
      : typeof chainHead?.model === "string"
        ? chainHead.model
        : null;
  if (model === null) {
    return null;
  }
  const reasoning = record.reasoning ?? record.variant ?? chainHead?.reasoning ?? chainHead?.variant;
  const setting: ModelSetting = { model };
  if (typeof reasoning === "string") {
    setting.variant = reasoning;
  }
  return setting;
}
