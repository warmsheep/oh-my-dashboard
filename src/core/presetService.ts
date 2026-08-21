import type { BackupEntry } from "./types";
import type { ConfigStore } from "./configStore";
import type { BackupService } from "./backupService";
import type * as jsoncEditorModule from "./jsoncEditor";

export interface JsoncEditorApi {
  parseSafe: typeof jsoncEditorModule.parseSafe;
  getValue: typeof jsoncEditorModule.getValue;
  applyEdits: typeof jsoncEditorModule.applyEdits;
}

export interface PresetServiceOptions {
  presetsDir: string;
  configStore: ConfigStore;
  backupService: BackupService;
  now?: () => Date;
  fs?: typeof import("node:fs");
  editor?: JsoncEditorApi;
}

export interface ApplyChange {
  file: "oh-my-opencode.json" | "opencode.json";
  path: (string | number)[];
  from: unknown;
  to: unknown;
}

export interface ApplyResult {
  preset: import("./types").Preset;
  backup: BackupEntry;
  changes: ApplyChange[];
}

export class PresetService {
  constructor(_opts: PresetServiceOptions) {
    void _opts;
  }

  list(): import("./types").Preset[] {
    throw new Error("NOT_IMPLEMENTED");
  }

  load(_name: string): import("./types").Preset {
    throw new Error("NOT_IMPLEMENTED");
  }

  exists(_name: string): boolean {
    throw new Error("NOT_IMPLEMENTED");
  }

  save(_preset: import("./types").Preset): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  capture(_name: string, _description?: string): import("./types").Preset {
    throw new Error("NOT_IMPLEMENTED");
  }

  rename(_oldName: string, _newName: string): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  remove(_name: string): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  exportTo(_name: string, _targetFile: string): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  apply(_name: string): ApplyResult {
    throw new Error("NOT_IMPLEMENTED");
  }

  currentPresetName(): string | null {
    throw new Error("NOT_IMPLEMENTED");
  }
}
