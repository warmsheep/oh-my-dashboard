import * as defaultFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { OMO_MISC_SETTINGS, OPENCODE_SETTINGS } from "../shared/protocol";
import type {
  OmoMiscValues,
  OmoSettingValue,
  OpencodePermissionState,
  OpencodeRecordStates,
  OpencodeSettingValue,
} from "../shared/protocol";
import { agentAssignmentEdits } from "./agentAssignment";
import { writeFileAtomic } from "./atomicFile";
import { ensureLocalModelsFile, mergeModelOptions } from "./builtinModels";
import { applyEdits, getValue, JsoncSyntaxError, parseSafe } from "./jsoncEditor";
import { isValidOmoMiscValue, omoMiscEdits, readOmoMiscValues } from "./omoSettings";
import {
  isValidOpencodeSettingValue,
  opencodeSettingEdits,
  readOpencodeSettingValues,
  readPermissionState,
  readPluginProtected,
  readRecordStates,
} from "./opencodeSettings";
import { declaredPluginSpecifiers, listDeclaredPlugins } from "./pluginResolver";
import { readdirSafe, readDirTree, skillDirCandidates, skillNamesFromTree, TREE_EXCLUDES } from "./skillScanner";
import { isValidTuiTheme, readTuiTheme, tuiThemeEdits } from "./tuiSettings";
import type {
  AgentConfigTarget,
  DiscoveredConfig,
  DiscoveredPaths,
  ModelEntry,
  ModelOption,
  ModelSetting,
  ParseResult,
  PluginEntry,
  SkillDirLocation,
  SkillLocation,
} from "./types";

// Kept for test imports; production code imports writeFileAtomic from ./atomicFile directly.
export { writeFileAtomic } from "./atomicFile";

export interface ConfigStoreOptions {
  configDirOverride?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /** Defaults to process.platform; injectable so win32/darwin branches are unit-testable. */
  platform?: NodeJS.Platform;
}

export class ConfigStore {
  private readonly env: Record<string, string | undefined>;
  private readonly homeDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly configDirOverride?: string;
  private readonly fileMemo = new Map<
    string,
    { mtimeMs: number; size: number; text: string; parse?: ParseResult<unknown> }
  >();

  constructor(opts: ConfigStoreOptions = {}) {
    this.env = opts.env ?? process.env;
    this.homeDir = opts.homeDir ?? os.homedir();
    this.platform = opts.platform ?? process.platform;
    this.configDirOverride = opts.configDirOverride;
  }

  static resolveConfigDir(env?: Record<string, string | undefined>, homeDir?: string): string {
    const effectiveEnv = env ?? process.env;
    const home = homeDir ?? os.homedir();
    // opencode resolves its config dir via xdg-basedir, which has NO platform branches:
    // $XDG_CONFIG_HOME/opencode else ~/.config/opencode on Linux, macOS AND Windows alike
    // (darwin does NOT use ~/Library/Application Support). OPENCODE_CONFIG_DIR overrides all.
    const explicit = effectiveEnv.OPENCODE_CONFIG_DIR;
    if (typeof explicit === "string" && explicit.trim() !== "") {
      return explicit.trim();
    }
    const xdg = effectiveEnv.XDG_CONFIG_HOME;
    if (typeof xdg === "string" && xdg.trim() !== "") {
      return path.join(xdg, "opencode");
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
   * The opencode runtime's npm plugin cache root ($XDG_CACHE_HOME/opencode else
   * ~/.cache/opencode on every platform — same xdg-basedir semantics as the config dir).
   * Modern opencode (arborist) installs each plugin under packages/<spec>/node_modules/<name>;
   * bun-era installs lived at node_modules/<name> directly under this root.
   */
  get pluginCacheDir(): string {
    const xdg = this.env.XDG_CACHE_HOME;
    if (typeof xdg === "string" && xdg.trim() !== "") {
      return path.join(xdg, "opencode");
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
    const text = this.readMemoizedText(this.resolveOpencodeConfigPath());
    if (!text) {
      return [];
    }
    return listDeclaredPlugins(text, {
      configDir: this.configDir,
      pluginCacheDir: this.pluginCacheDir,
      homeDir: this.homeDir,
      platform: this.platform,
      readPackageJson: (filePath) => this.readParseMemoized(filePath),
    });
  }

  /**
   * The opencode base config that actually exists on this machine: opencode.json wins, then
   * opencode.jsonc, then opencode.json as the creation default.
   */
  resolveOpencodeConfigPath(): string {
    const json = path.join(this.configDir, "opencode.json");
    if (defaultFs.existsSync(json)) {
      return json;
    }
    const jsonc = path.join(this.configDir, "opencode.jsonc");
    return defaultFs.existsSync(jsonc) ? jsonc : json;
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
    if (defaultFs.existsSync(omoJsonc)) {
      return omo(omoJsonc, true);
    }
    if (defaultFs.existsSync(omoJson)) {
      return omo(omoJson, true);
    }
    for (const name of [
      "oh-my-opencode.jsonc",
      "oh-my-opencode.json",
      "oh-my-openagent.jsonc",
      "oh-my-openagent.json",
    ]) {
      const candidate = path.join(this.configDir, name);
      if (defaultFs.existsSync(candidate)) {
        return { kind: "legacy", path: candidate, sectionPath: [], reasoningKey: "variant", exists: true };
      }
    }
    // Same normalized declaration read as listPlugins (V1 `plugin` + V2 `plugins`).
    const usesOpenagent = declaredPluginSpecifiers(this.readMemoizedText(this.resolveOpencodeConfigPath())).some(
      (specifier) => specifier.startsWith("oh-my-openagent"),
    );
    if (defaultFs.existsSync(this.omoDir) || usesOpenagent) {
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
    const agentConfig = this.resolveAgentConfig();
    const commandDir = path.join(configDir, "command");

    const commandFiles = defaultFs.existsSync(commandDir)
      ? readdirSafe(commandDir)
          .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
          .map((entry) => entry.name)
          .sort()
      : [];

    // Skill names derive from the SAME walk that builds the tree (one scan per dir,
    // not two): top-level entries that are dirs with a regular-file SKILL.md.
    // TREE_EXCLUDES prunes .git/node_modules — a cloned skills repo must not put its
    // VCS internals into every refresh walk.
    const skillLocations: SkillLocation[] = this.skillDirLocationsFor(workspaceFolders).map((candidate) => {
      const tree = readDirTree(candidate.dir, 0, TREE_EXCLUDES);
      return { ...candidate, skillNames: skillNamesFromTree(tree), tree };
    });

    return {
      configDir,
      opencodeJson,
      agentConfig,
      agentsMd: this.agentsMdEntries(workspaceFolders),
      commandDir,
      commandFiles,
      skillLocations,
      commandTree: readDirTree(commandDir, 0, TREE_EXCLUDES),
      presetsDir: path.join(configDir, "presets"),
      backupsDir: path.join(configDir, "backups"),
    };
  }

  /**
   * Cheap path-level discovery for activation wiring: the same config/agent/skill/AGENTS.md
   * path resolution as discover(), but WITHOUT building skills/command trees, scanning dir
   * contents, or touching plugins/presets/backups. discover() reuses the same helpers, so
   * the two can never disagree.
   */
  discoverPaths(workspaceFolders?: string[]): DiscoveredPaths {
    const configDir = this.configDir;
    return {
      configDir,
      opencodeJson: this.resolveOpencodeConfigPath(),
      agentConfig: this.resolveAgentConfig(),
      agentsMd: this.agentsMdEntries(workspaceFolders),
      commandDir: path.join(configDir, "command"),
      skillsDir: path.join(configDir, "skills"),
      skillLocations: this.skillDirLocationsFor(workspaceFolders),
      presetsDir: path.join(configDir, "presets"),
      backupsDir: path.join(configDir, "backups"),
    };
  }

  /** Existing skills candidate dirs (canonical order) via the pure core/skillScanner. */
  private skillDirLocationsFor(workspaceFolders?: string[]): SkillDirLocation[] {
    return skillDirCandidates({
      configDir: this.configDir,
      homeDir: this.homeDir,
      env: this.env,
      platform: this.platform,
      workspaceFolders,
    });
  }

  private agentsMdEntries(workspaceFolders?: string[]): DiscoveredConfig["agentsMd"] {
    const configDir = this.configDir;
    return [
      {
        scope: "global",
        path: path.join(configDir, "AGENTS.md"),
        exists: defaultFs.existsSync(path.join(configDir, "AGENTS.md")),
      },
      ...(workspaceFolders ?? []).map((folder) => {
        const projectAgentsMd = path.join(folder, "AGENTS.md");
        return { scope: "project" as const, path: projectAgentsMd, exists: defaultFs.existsSync(projectAgentsMd) };
      }),
    ];
  }

  readTextOrEmpty(filePath: string): string {
    // existsSync guards absence, not permission: a chmod-000 or AV-locked config must
    // degrade to "empty" rather than kill discovery/activation.
    try {
      return defaultFs.existsSync(filePath) ? defaultFs.readFileSync(filePath, "utf8") : "";
    } catch {
      return "";
    }
  }

  /**
   * Read-before-write variant: "" only when the file is genuinely absent. An existing
   * but unreadable file must ABORT the edit — treating it as empty would let apply()
   * overwrite real user config with a fabricated minimal one.
   */
  readTextForEdit(filePath: string): string {
    try {
      return defaultFs.existsSync(filePath) ? defaultFs.readFileSync(filePath, "utf8") : "";
    } catch {
      throw new Error("CONFIG_UNREADABLE");
    }
  }

  readParse<T>(filePath: string): ParseResult<T> {
    return parseSafe<T>(this.readTextOrEmpty(filePath));
  }

  /**
   * Memoized hot-config read (readTextOrEmpty semantics). Keyed by stat (mtimeMs, size):
   * opencode.json is read by listPlugins / opencodeModels / defaultModel /
   * resolveAgentConfig within a single refresh, so an unchanged file is read (and for
   * readParseMemoized, parsed) at most once. Writes through writeAtomic delete the
   * entry; external edits change the stat key and miss the cache.
   */
  private memoizedFile(filePath: string): {
    mtimeMs: number;
    size: number;
    text: string;
    parse?: ParseResult<unknown>;
  } {
    let stat: { mtimeMs: number; size: number } | null;
    try {
      const s = defaultFs.statSync(filePath);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      stat = null;
    }
    const cached = this.fileMemo.get(filePath);
    if (cached && stat !== null && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached;
    }
    let text: string | null = null;
    try {
      text = defaultFs.readFileSync(filePath, "utf8");
    } catch {
      text = null;
    }
    if (text === null && stat !== null) {
      // stat succeeded but the read failed (EACCES, AV lock): degrade to "" for THIS
      // call without caching under the still-valid stat key — chmod recovery must not
      // be fed a stale "" (chmod does not change mtime/size).
      return { mtimeMs: stat.mtimeMs, size: stat.size, text: "" };
    }
    const entry = { mtimeMs: stat?.mtimeMs ?? -1, size: stat?.size ?? -1, text: text ?? "" };
    this.fileMemo.set(filePath, entry);
    return entry;
  }

  private readMemoizedText(filePath: string): string {
    return this.memoizedFile(filePath).text;
  }

  private readParseMemoized<T>(filePath: string): ParseResult<T> {
    const entry = this.memoizedFile(filePath);
    entry.parse ??= parseSafe<unknown>(entry.text);
    return entry.parse as ParseResult<T>;
  }

  /**
   * Assign one agent/category entry on this machine's agent config: set the model and
   * the target's reasoning key (or remove it when variant is null), clearing the sibling
   * reasoning key and any `models` chain — the exact rules PresetService.apply() uses,
   * via the shared agentAssignmentEdits() builder. Aborts with CONFIG_UNREADABLE /
   * JsoncSyntaxError before writing anything; creates the file when missing.
   */
  setAgentModel(section: "agents" | "categories", name: string, model: string, variant: string | null): void {
    const target = this.resolveAgentConfig();
    const raw = this.readTextForEdit(target.path);
    const parse = parseSafe<unknown>(raw);
    if (parse.errors.length > 0) {
      // Never touch a broken file — same contract as presetService.apply().
      throw new JsoncSyntaxError(parse.errors);
    }
    const edits = agentAssignmentEdits(target.sectionPath, target.reasoningKey, section, name, model, variant);
    const next = applyEdits(raw.length > 0 ? raw : "{}", edits);
    defaultFs.mkdirSync(path.dirname(target.path), { recursive: true });
    this.writeAtomic(target.path, next);
  }

  /**
   * Read the OpenCode tab's settings from the machine's opencode.json[c] (display path:
   * readTextOrEmpty-tolerant, missing file reads as all-null values).
   */
  opencodeSettingValues(): Record<string, OpencodeSettingValue> {
    return readOpencodeSettingValues(this.readTextOrEmpty(this.resolveOpencodeConfigPath()));
  }

  /**
   * Write (or remove, value=null) one OPENCODE_SETTINGS entry into its target file.
   * Descriptors carrying file:"tui" route to tui.json ({@link setTuiTheme}); the rest
   * write opencode.json[c] with the same contract as setAgentModel: descriptor key +
   * value validated first (OPENCODE_SETTING_INVALID), readTextForEdit, JSONC syntax
   * abort, atomic write; creates the file when missing. A record root whose file shape
   * conflicts with the write (e.g. `"command": "x"`) aborts with OPENCODE_SETTING_CONFLICT.
   */
  setOpencodeSetting(key: string, value: OpencodeSettingValue): void {
    const setting = OPENCODE_SETTINGS.find((entry) => entry.key === key);
    if (setting === undefined || !isValidOpencodeSettingValue(setting, value)) {
      throw new Error("OPENCODE_SETTING_INVALID");
    }
    if (setting.file === "tui") {
      // Kind string + file tui validation guarantees a string-or-null value here.
      this.setTuiTheme(value as string | null);
      return;
    }
    const target = this.resolveOpencodeConfigPath();
    const raw = this.readTextForEdit(target);
    const parse = parseSafe<unknown>(raw);
    if (parse.errors.length > 0) {
      throw new JsoncSyntaxError(parse.errors);
    }
    if (setting.kind === "pluginList" && readPluginProtected(raw)) {
      // Defense in depth: pluginList writes are whole-array replacements, so a
      // stale UI must never run one over entries it cannot express —
      // hand-written [名称, 选项] tuples or sanity-failing strings.
      throw new Error("PLUGIN_PROTECTED");
    }
    let next: string;
    try {
      next = applyEdits(raw.length > 0 ? raw : "{}", opencodeSettingEdits(setting, value));
    } catch (error) {
      // jsonc-parser leaks raw English on shape conflicts (e.g. adding an entry under
      // a string-typed `command` root throws "Can not add index to parent of type
      // string"); translate exactly those to the coded error FRIENDLY_ERRORS maps.
      // Everything else propagates untouched.
      if (error instanceof Error && /^Can not (add|remove|delete)/i.test(error.message)) {
        throw new Error("OPENCODE_SETTING_CONFLICT");
      }
      throw error;
    }
    defaultFs.mkdirSync(path.dirname(target), { recursive: true });
    this.writeAtomic(target, next);
  }

  /** The permission aggregate (shorthand + per-tool actions + advanced tool list) for the OpenCode tab payload. */
  permissionState(): OpencodePermissionState {
    return readPermissionState(this.readTextOrEmpty(this.resolveOpencodeConfigPath()));
  }

  /** Record aggregates of the 命令/格式化/LSP/MCP 服务器 groups (OpenCode tab payload view, display-tolerant). */
  recordStates(): OpencodeRecordStates {
    return readRecordStates(this.readTextOrEmpty(this.resolveOpencodeConfigPath()));
  }

  /** pluginList protection flag of the OpenCode tab payload (true = tuple entries, row renders read-only). */
  pluginProtected(): boolean {
    return readPluginProtected(this.readTextOrEmpty(this.resolveOpencodeConfigPath()));
  }

  /** Path of the standalone tui.json face (the TUI theme lives here, never in opencode.json). */
  tuiConfigPath(): string {
    return path.join(this.configDir, "tui.json");
  }

  /** Current tui.json theme (display-tolerant: missing/unparsable file reads as null). */
  tuiTheme(): string | null {
    return readTuiTheme(this.readTextOrEmpty(this.tuiConfigPath()));
  }

  /**
   * Write (or remove, theme=null) the `theme` key of configDir/tui.json. Same contract
   * as setOpencodeSetting: isValidTuiTheme gate (TUI_THEME_INVALID — null passes as the
   * remove op), readTextForEdit, JSONC syntax abort, atomic write; creates the file
   * when missing.
   */
  setTuiTheme(theme: string | null): void {
    if (theme !== null && !isValidTuiTheme(theme)) {
      throw new Error("TUI_THEME_INVALID");
    }
    const target = this.tuiConfigPath();
    const raw = this.readTextForEdit(target);
    const parse = parseSafe<unknown>(raw);
    if (parse.errors.length > 0) {
      throw new JsoncSyntaxError(parse.errors);
    }
    const next = applyEdits(raw.length > 0 ? raw : "{}", tuiThemeEdits(theme));
    defaultFs.mkdirSync(path.dirname(target), { recursive: true });
    this.writeAtomic(target, next);
  }

  /** Read the OMO tab's misc feature values from the resolved agent-config target (display-tolerant). */
  omoMiscValues(): OmoMiscValues {
    const target = this.resolveAgentConfig();
    return readOmoMiscValues(this.readTextOrEmpty(target.path), target.sectionPath);
  }

  /**
   * Write (or remove, value=null) one OMO_MISC_SETTINGS entry into the resolved agent
   * config at its scope: plugin keys go inside the `[opencode]` block on omo targets
   * (top level on legacy targets), shared keys go TOP LEVEL on both targets — the
   * sectionPath-prefix/scope routing lives in omoMiscEdits. Same contract as
   * setAgentModel: key + value validated first (OMO_SETTING_INVALID), readTextForEdit,
   * JSONC syntax abort, atomic write; creates the file when missing.
   */
  setOmoMiscSetting(key: string, value: OmoSettingValue): void {
    const setting = OMO_MISC_SETTINGS.find((entry) => entry.key === key);
    if (setting === undefined || !isValidOmoMiscValue(setting, value)) {
      throw new Error("OMO_SETTING_INVALID");
    }
    const target = this.resolveAgentConfig();
    const raw = this.readTextForEdit(target.path);
    const parse = parseSafe<unknown>(raw);
    if (parse.errors.length > 0) {
      throw new JsoncSyntaxError(parse.errors);
    }
    const next = applyEdits(raw.length > 0 ? raw : "{}", omoMiscEdits(target.sectionPath, setting, value));
    defaultFs.mkdirSync(path.dirname(target.path), { recursive: true });
    this.writeAtomic(target.path, next);
  }

  writeAtomic(filePath: string, content: string): void {
    writeFileAtomic(filePath, content);
    this.fileMemo.delete(filePath);
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
      source: opencodeIds.has(option.id) ? (localIds.has(option.id) ? "both" : "opencode") : "local",
    }));
  }

  private opencodeModels(): ModelOption[] {
    const result = this.readParseMemoized<{ provider?: Record<string, { models?: Record<string, unknown> }> }>(
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
            modelConfig &&
            typeof modelConfig === "object" &&
            typeof (modelConfig as { name?: unknown }).name === "string"
              ? (modelConfig as { name: string }).name
              : model;
          options.push({ id: `${provider}/${model}`, provider, model, label });
        }
      }
    }
    return options;
  }

  defaultModel(): string | null {
    const text = this.readMemoizedText(this.resolveOpencodeConfigPath());
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
    typeof record.model === "string" ? record.model : typeof chainHead?.model === "string" ? chainHead.model : null;
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
