import * as os from "node:os";
import * as path from "node:path";
import * as defaultFs from "node:fs";
import { writeFileAtomic } from "./atomicFile";
import { assertContainedFileName } from "./pathSafety";
import type { BackupEntry, BackupManifest, BackupReason } from "./types";

export interface BackupServiceOptions {
  configDir: string;
  hostname?: string;
  now?: () => Date;
  fs?: typeof import("node:fs");
  retention?: Partial<Record<BackupReason, number>>;
  /**
   * Absolute paths of the managed config files on this machine (e.g. detected
   * opencode.json + ~/.omo/omo.jsonc). Defaults to the legacy configDir-relative trio.
   */
  managedFiles?: readonly string[];
  /**
   * Extra absolute directories outside configDir to snapshot and restore (e.g. the
   * user-level ~/.agents/skills dir). Each existing src is copied into the backup under
   * label and restored back to the absolute src. Project-level skills are intentionally
   * NOT passed here — they live in the user's repo.
   */
  extraDirs?: readonly { label: string; src: string }[];
}

export const DEFAULT_RETENTION: Record<BackupReason, number | null> = {
  manual: null,
  "pre-apply": 20,
  "pre-save": 20,
  "pre-restore": 20,
};

const MANAGED_FILES = ["opencode.json", "oh-my-opencode.json", "AGENTS.md"] as const;
const MANAGED_DIRS = ["command", "skills", "presets"] as const;
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
  private readonly managedFiles: readonly { label: string; src: string }[];
  private readonly extraDirs: readonly { label: string; src: string }[];

  constructor(opts: BackupServiceOptions) {
    this.configDir = opts.configDir;
    this.backupsDir = path.join(opts.configDir, "backups");
    this.hostname = opts.hostname ?? os.hostname();
    this.now = opts.now ?? (() => new Date());
    this.fs = opts.fs ?? defaultFs;
    this.retention = { ...DEFAULT_RETENTION, ...opts.retention };
    this.managedFiles = opts.managedFiles
      ? opts.managedFiles.map((src) => ({ label: path.basename(src), src }))
      : MANAGED_FILES.map((name) => ({ label: name, src: path.join(opts.configDir, name) }));
    this.extraDirs = opts.extraDirs ?? [];
  }

  create(reason: BackupReason, meta?: { preset?: string; name?: string }): BackupEntry {
    const at = this.now();
    const dirName = `${isoFs(at)}-${reason}`;
    const dir = path.join(this.backupsDir, dirName);
    // Build in a hidden staging sibling and publish by rename: a mid-copy failure
    // (EPERM/ENOSPC/ENOENT race) must not leave a manifest-less partial backup that
    // list() can never see or prune.
    const staging = path.join(this.backupsDir, `.tmp-${dirName}`);
    this.sweepStaging();
    this.fs.rmSync(staging, { recursive: true, force: true });
    this.fs.mkdirSync(staging, { recursive: true });

    try {
      let fileCount = 0;
      for (const { label, src } of this.managedFiles) {
        if (this.fs.existsSync(src)) {
          this.fs.copyFileSync(src, path.join(staging, label));
          fileCount++;
        }
      }
      for (const name of MANAGED_DIRS) {
        const src = path.join(this.configDir, name);
        if (!this.fs.existsSync(src)) continue;
        const dest = path.join(staging, name);
        if (this.fs.statSync(src).isDirectory()) {
          // dereference: snapshots store real content — recreating symlinks needs
          // privileges on Windows (EPERM without Developer Mode).
          this.fs.cpSync(src, dest, { recursive: true, dereference: true });
        } else {
          this.fs.copyFileSync(src, dest);
        }
        fileCount += this.countFiles(dest);
      }
      for (const { label, src } of this.extraDirs) {
        if (!this.fs.existsSync(src)) continue;
        const dest = path.join(staging, label);
        if (this.fs.statSync(src).isDirectory()) {
          this.fs.cpSync(src, dest, { recursive: true, dereference: true });
        } else {
          this.fs.copyFileSync(src, dest);
        }
        fileCount += this.countFiles(dest);
      }

      const manifest: BackupManifest = {
        version: 1,
        reason,
        ...(meta?.name !== undefined && meta.name.length > 0 ? { name: meta.name } : {}),
        ...(meta?.preset !== undefined ? { preset: meta.preset } : {}),
        createdAt: at.toISOString(),
        fileCount,
        machine: this.hostname,
      };
      writeFileAtomic(path.join(staging, MANIFEST_FILE), JSON.stringify(manifest, null, 2), this.fs);
      this.fs.renameSync(staging, dir);
    } catch (error) {
      this.fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }

    const manifest = this.readEntry(dirName)?.manifest;
    if (!manifest) {
      throw new Error("BACKUP_PUBLISH_FAILED");
    }
    const entry: BackupEntry = { dirName, dir, manifest };
    this.prune(reason);
    return entry;
  }

  private sweepStaging(): void {    if (!this.fs.existsSync(this.backupsDir)) {
      return;
    }
    for (const ent of this.fs.readdirSync(this.backupsDir, { withFileTypes: true })) {
      if (ent.isDirectory() && ent.name.startsWith(".tmp-")) {
        this.fs.rmSync(path.join(this.backupsDir, ent.name), { recursive: true, force: true });
      }
    }
  }

  list(): BackupEntry[] {
    if (!this.fs.existsSync(this.backupsDir)) return [];
    const entries: BackupEntry[] = [];
    for (const ent of this.fs.readdirSync(this.backupsDir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith(".tmp-")) continue;
      const entry = this.readEntry(ent.name);
      if (entry) entries.push(entry);
    }
    return entries.sort((a, b) => (a.dirName < b.dirName ? 1 : a.dirName > b.dirName ? -1 : 0));
  }

  private assertDirName(dirName: string): void {
    // Commands can be invoked programmatically with arbitrary strings — never let a
    // dirName escape backupsDir (path traversal → rmSync outside the sandbox).
    assertContainedFileName(dirName, "INVALID_BACKUP_NAME");
  }

  remove(dirName: string): void {
    this.assertDirName(dirName);
    this.fs.rmSync(path.join(this.backupsDir, dirName), { recursive: true, force: true });
  }

  rename(dirName: string, name: string): BackupEntry {
    this.assertDirName(dirName);
    const entry = this.list().find((e) => e.dirName === dirName);
    if (!entry) {
      throw new Error("BACKUP_NOT_FOUND");
    }
    const manifest: BackupManifest = { ...entry.manifest, name };
    writeFileAtomic(path.join(entry.dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), this.fs);
    return { ...entry, manifest };
  }

  restore(dirName: string): void {
    this.assertDirName(dirName);
    const srcDir = path.join(this.backupsDir, dirName);
    // Managed config files are restored through the atomic writer: a mid-copy failure
    // (ENOSPC/EPERM) must never truncate the live opencode.json / omo.jsonc.
    for (const { label, src } of this.managedFiles) {
      const backup = path.join(srcDir, label);
      if (this.fs.existsSync(backup)) {
        this.fs.mkdirSync(path.dirname(src), { recursive: true });
        writeFileAtomic(src, this.fs.readFileSync(backup, "utf8"), this.fs);
      }
    }
    for (const name of MANAGED_DIRS) {
      const src = path.join(srcDir, name);
      if (this.fs.existsSync(src)) {
        this.fs.cpSync(src, path.join(this.configDir, name), { recursive: true, dereference: true });
      }
    }
    for (const { label, src } of this.extraDirs) {
      const backup = path.join(srcDir, label);
      if (this.fs.existsSync(backup)) {
        this.fs.mkdirSync(path.dirname(src), { recursive: true });
        this.fs.cpSync(backup, src, { recursive: true, dereference: true });
      }
    }
  }

  diffPairs(entry: BackupEntry): { label: string; backup: string; current: string }[] {
    const pairs: { label: string; backup: string; current: string }[] = [];
    for (const { label, src } of this.managedFiles) {
      const backup = path.join(entry.dir, label);
      if (this.fs.existsSync(backup) && this.fs.existsSync(src)) {
        pairs.push({ label, backup, current: src });
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
        // A foreign/unremovable dir (odd name, locked on Windows) must not poison
        // every future create() of this reason — skip it and keep pruning the rest.
        try {
          this.remove(entry.dirName);
          removed.push(entry);
        } catch {
          // skipped
        }
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
