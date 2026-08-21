import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getValue, parseSafe } from "./jsoncEditor";
import type { DiscoveredConfig, ModelOption, ModelSetting, ParseResult } from "./types";

export interface ConfigStoreOptions {
  configDirOverride?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
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

  discover(workspaceFolders?: string[]): DiscoveredConfig {
    const configDir = this.configDir;
    const opencodeJson = path.join(configDir, "opencode.json");
    const ohMyOpencodeJson = path.join(configDir, "oh-my-opencode.json");
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
      agentsMd,
      commandDir,
      commandFiles,
      skillsDir,
      skillNames,
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
    const result = this.readParse<{ provider?: Record<string, { models?: Record<string, unknown> }> }>(
      path.join(this.configDir, "opencode.json"),
    );
    const providers = result.value?.provider;
    if (!providers || typeof providers !== "object") {
      return [];
    }
    const options: ModelOption[] = [];
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
    options.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return options;
  }

  defaultModel(): string | null {
    const text = this.readTextOrEmpty(path.join(this.configDir, "opencode.json"));
    if (!text) {
      return null;
    }
    const model = getValue<unknown>(text, ["model"]);
    return typeof model === "string" ? model : null;
  }

  ohMyAssignments(): { agents: Record<string, ModelSetting>; categories: Record<string, ModelSetting> } {
    const text = this.readTextOrEmpty(path.join(this.configDir, "oh-my-opencode.json"));
    if (!text) {
      return { agents: {}, categories: {} };
    }
    return {
      agents: getValue<Record<string, ModelSetting>>(text, ["agents"]) ?? {},
      categories: getValue<Record<string, ModelSetting>>(text, ["categories"]) ?? {},
    };
  }
}
