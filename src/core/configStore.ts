import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getValue, parseSafe } from "./jsoncEditor";
import { ensureLocalModelsFile, mergeModelOptions } from "./builtinModels";
import type { AgentConfigTarget, DirEntry, DiscoveredConfig, ModelEntry, ModelOption, ModelSetting, ParseResult } from "./types";

export interface ConfigStoreOptions {
  configDirOverride?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

function readDirTree(dir: string, depth = 0): DirEntry[] {
  if (depth > 8 || !fs.existsSync(dir)) {
    return [];
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return entries.map((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const children = readDirTree(entryPath, depth + 1);
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
    const skillsDir = path.join(configDir, "skills");

    const commandFiles = fs.existsSync(commandDir)
      ? fs
          .readdirSync(commandDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
          .map((entry) => entry.name)
          .sort()
      : [];

    const skillNames = fs.existsSync(skillsDir)
      ? fs
          .readdirSync(skillsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
      : [];

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
      skillsDir,
      skillNames,
      commandTree: readDirTree(commandDir),
      skillsTree: readDirTree(skillsDir),
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
