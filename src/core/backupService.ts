import * as os from "node:os";
import * as path from "node:path";
import * as defaultFs from "node:fs";
import type { BackupEntry, BackupManifest, BackupReason } from "./types";

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

const MANAGED_FILES = ["opencode.json", "oh-my-opencode.json", "AGENTS.md"] as const;
const MANAGED_DIRS = ["command", "skills"] as const;
const MANIFEST_FILE = "manifest.json";
const ALL_REASONS = Object.keys(DEFAULT_RETENTION) as BackupReason[];

export function isoFs(d: Date): string {
  return d.toISOString().replace(/:/g, "-").replace(/\./g, "-");
}

export class BackupService {
  private readonly configDir: string;
  private readonly backupsDir: string;
  private readonly hostname: string;
  private readonly now: () => Date;
  private readonly fs: typeof import("node:fs");
  private readonly retention: Record<BackupReason, number | null>;

  constructor(opts: BackupServiceOptions) {
    this.configDir = opts.configDir;
    this.backupsDir = path.join(opts.configDir, "backups");
    this.hostname = opts.hostname ?? os.hostname();
    this.now = opts.now ?? (() => new Date());
    this.fs = opts.fs ?? defaultFs;
    this.retention = { ...DEFAULT_RETENTION, ...opts.retention };
  }

  create(reason: BackupReason, meta?: { preset?: string }): BackupEntry {
    const at = this.now();
    const dirName = `${isoFs(at)}-${reason}`;
    const dir = path.join(this.backupsDir, dirName);
    this.fs.mkdirSync(dir, { recursive: true });

    let fileCount = 0;
    for (const name of MANAGED_FILES) {
      const src = path.join(this.configDir, name);
      if (this.fs.existsSync(src)) {
        this.fs.copyFileSync(src, path.join(dir, name));
        fileCount++;
      }
    }
    for (const name of MANAGED_DIRS) {
      const src = path.join(this.configDir, name);
      if (!this.fs.existsSync(src)) continue;
      const dest = path.join(dir, name);
      if (this.fs.statSync(src).isDirectory()) {
        this.fs.cpSync(src, dest, { recursive: true });
      } else {
        this.fs.copyFileSync(src, dest);
      }
      fileCount += this.countFiles(dest);
    }

    const manifest: BackupManifest = {
      version: 1,
      reason,
      ...(meta?.preset !== undefined ? { preset: meta.preset } : {}),
      createdAt: at.toISOString(),
      fileCount,
      machine: this.hostname,
    };
    this.fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));

    const entry: BackupEntry = { dirName, dir, manifest };
    this.prune(reason);
    return entry;
  }

  list(): BackupEntry[] {
    if (!this.fs.existsSync(this.backupsDir)) return [];
    const entries: BackupEntry[] = [];
    for (const ent of this.fs.readdirSync(this.backupsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const entry = this.readEntry(ent.name);
      if (entry) entries.push(entry);
    }
    return entries.sort((a, b) => (a.dirName < b.dirName ? 1 : a.dirName > b.dirName ? -1 : 0));
  }

  remove(dirName: string): void {
    this.fs.rmSync(path.join(this.backupsDir, dirName), { recursive: true, force: true });
  }

  restore(dirName: string): void {
    const srcDir = path.join(this.backupsDir, dirName);
    for (const name of MANAGED_FILES) {
      const src = path.join(srcDir, name);
      if (this.fs.existsSync(src)) {
        this.fs.copyFileSync(src, path.join(this.configDir, name));
      }
    }
    for (const name of MANAGED_DIRS) {
      const src = path.join(srcDir, name);
      if (this.fs.existsSync(src)) {
        this.fs.cpSync(src, path.join(this.configDir, name), { recursive: true });
      }
    }
  }

  diffPairs(entry: BackupEntry): { label: string; backup: string; current: string }[] {
    const pairs: { label: string; backup: string; current: string }[] = [];
    for (const name of MANAGED_FILES) {
      const backup = path.join(entry.dir, name);
      const current = path.join(this.configDir, name);
      if (this.fs.existsSync(backup) && this.fs.existsSync(current)) {
        pairs.push({ label: name, backup, current });
      }
    }
    return pairs;
  }

  prune(reason?: BackupReason): BackupEntry[] {
    const reasons = reason ? [reason] : ALL_REASONS;
    const all = this.list();
    const removed: BackupEntry[] = [];
    for (const r of reasons) {
      const keep = this.retention[r];
      if (typeof keep !== "number") continue;
      const excess = all.filter((e) => e.manifest.reason === r).slice(keep);
      for (const entry of excess) {
        this.remove(entry.dirName);
        removed.push(entry);
      }
    }
    return removed;
  }

  private readEntry(dirName: string): BackupEntry | null {
    const manifestPath = path.join(this.backupsDir, dirName, MANIFEST_FILE);
    try {
      if (!this.fs.existsSync(manifestPath)) return null;
      const manifest = JSON.parse(this.fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
      if (manifest.version !== 1 || typeof manifest.reason !== "string") return null;
      return { dirName, dir: path.join(this.backupsDir, dirName), manifest };
    } catch {
      return null;
    }
  }

  private countFiles(p: string): number {
    const st = this.fs.statSync(p);
    if (st.isFile()) return 1;
    if (!st.isDirectory()) return 0;
    let n = 0;
    for (const ent of this.fs.readdirSync(p, { withFileTypes: true })) {
      n += this.countFiles(path.join(p, ent.name));
    }
    return n;
  }
}
