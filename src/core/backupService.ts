import type { BackupEntry, BackupReason } from "./types";

export interface BackupServiceOptions {
  configDir: string;
  hostname?: string;
  now?: () => Date;
  fs?: typeof import("node:fs");
  retention?: Partial<Record<BackupReason, number>>;
}

export const DEFAULT_RETENTION: Record<BackupReason, number | null> = {
  manual: null,
  "pre-apply": 20,
  "pre-save": 20,
  "pre-restore": 20,
};

export function isoFs(_d: Date): string {
  throw new Error("NOT_IMPLEMENTED");
}

export class BackupService {
  constructor(_opts: BackupServiceOptions) {
    void _opts;
  }

  create(_reason: BackupReason, _meta?: { preset?: string }): BackupEntry {
    throw new Error("NOT_IMPLEMENTED");
  }

  list(): BackupEntry[] {
    throw new Error("NOT_IMPLEMENTED");
  }

  remove(_dirName: string): void {
    throw new Error("NOT_IMPLEMENTED");
  }

  restore(_dirName: string): { preRestore: BackupEntry } {
    throw new Error("NOT_IMPLEMENTED");
  }

  diffPairs(_entry: BackupEntry): { label: string; backup: string; current: string }[] {
    throw new Error("NOT_IMPLEMENTED");
  }

  prune(_reason?: BackupReason): BackupEntry[] {
    throw new Error("NOT_IMPLEMENTED");
  }
}
