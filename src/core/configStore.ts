import { parseSafe } from "./jsoncEditor";
import type { DiscoveredConfig, ModelOption, ModelSetting, ParseResult } from "./types";

export interface ConfigStoreOptions {
  configDirOverride?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

export class ConfigStore {
  constructor(_opts: ConfigStoreOptions = {}) {
    void _opts;
  }

  static resolveConfigDir(_env?: Record<string, string | undefined>, _homeDir?: string): string {
    throw new Error("NOT_IMPLEMENTED");
  }

  get configDir(): string {
    throw new Error("NOT_IMPLEMENTED");
  }

  discover(_workspaceFolders?: string[]): DiscoveredConfig {
    throw new Error("NOT_IMPLEMENTED");
  }

  readText(_path: string): string {
    throw new Error("NOT_IMPLEMENTED");
  }

  readTextOrEmpty(_path: string): string {
    throw new Error("NOT_IMPLEMENTED");
  }

  readParse<T>(_path: string): ParseResult<T> {
    return parseSafe<T>(this.readTextOrEmpty(_path));
  }

  writeAtomic(_path: string, _content: string): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  listModels(): ModelOption[] {
    throw new Error("NOT_IMPLEMENTED");
  }

  defaultModel(): string | null {
    throw new Error("NOT_IMPLEMENTED");
  }

  ohMyAssignments(): { agents: Record<string, ModelSetting>; categories: Record<string, ModelSetting> } {
    throw new Error("NOT_IMPLEMENTED");
  }
}
