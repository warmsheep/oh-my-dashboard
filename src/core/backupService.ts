import * as os from "node:os";
import * as path from "node:path";
import * as defaultFs from "node:fs";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { writeFileAtomic } from "./atomicFile";
import { assertContainedFileName } from "./pathSafety";
import type { BackupEntry, BackupManifest, BackupReason } from "./types";

/** Zip import caps — a backup is a handful of config files; anything bigger is hostile. */
const ZIP_MAX_ENTRIES = 20_000;
const ZIP_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

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

/**
 * Zip entry names use "/" on every platform; reject anything that could escape the
 * staging dir when joined (absolute, drive letters, backslashes, ".." segments, NUL).
 */
function assertZipEntryName(name: string): void {
  const bad =
    name.length === 0 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").some((seg) => seg === "..");
  if (bad) {
    throw new Error("BACKUP_IMPORT_INVALID");
  }
}

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

  /**
   * Export a backup as a zip (entry names use "/" per the zip spec — platform-neutral).
   * Backups hold no symlinks (create/restore dereference); a foreign symlink placed by
   * hand matches neither isDirectory nor isFile and is skipped, never followed.
   */
  exportZip(dirName: string, targetFile: string): void {
    this.assertDirName(dirName);
    if (!this.readEntry(dirName)) {
      throw new Error("BACKUP_NOT_FOUND");
    }
    const srcDir = path.join(this.backupsDir, dirName);
    const files: Record<string, Uint8Array> = {};
    const walk = (dir: string, rel: string): void => {
      for (const ent of this.fs.readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          files[`${childRel}/`] = new Uint8Array(0); // explicit entry keeps empty dirs
          walk(path.join(dir, ent.name), childRel);
        } else if (ent.isFile()) {
          files[childRel] = new Uint8Array(this.fs.readFileSync(path.join(dir, ent.name)));
        }
      }
    };
    walk(srcDir, "");
    writeFileAtomic(targetFile, zipSync(files, { level: 6 }), this.fs);
  }

  /**
   * Import a backup zip into the backups dir (staging + rename publish, same as create()).
   * Entries are validated against traversal and capped in count/size; the manifest must be
   * a version-1 backup manifest, and the target dirName is rebuilt from it (foreign reasons
   * downgrade to "manual"; name collisions get an -import-N suffix).
   */
  importZip(zipFile: string): BackupEntry {
    // Cap the compressed file itself first — readFileSync of a multi-GB "zip" would OOM
    // before any other check runs.
    const zipSize = this.fs.statSync(zipFile).size;
    if (zipSize > ZIP_MAX_TOTAL_BYTES) {
      throw new Error("BACKUP_IMPORT_INVALID");
    }
    // fflate's filter runs BEFORE inflating each entry and carries the header's declared
    // originalSize — enforcing caps here keeps a well-formed zip bomb from ever being
    // decompressed into extension-host memory.
    let entryCount = 0;
    let totalBytes = 0;
    let capsExceeded = false;
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(this.fs.readFileSync(zipFile)), {
        filter: (file) => {
          entryCount += 1;
          totalBytes += file.originalSize;
          if (entryCount > ZIP_MAX_ENTRIES || totalBytes > ZIP_MAX_TOTAL_BYTES) {
            capsExceeded = true;
            return false;
          }
          return true;
        },
      });
    } catch {
      throw new Error("BACKUP_IMPORT_INVALID");
    }
    if (capsExceeded) {
      throw new Error("BACKUP_IMPORT_INVALID");
    }
    for (const name of Object.keys(entries)) {
      assertZipEntryName(name);
    }
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(strFromU8(entries[MANIFEST_FILE]!)) as BackupManifest;
    } catch {
      throw new Error("BACKUP_IMPORT_INVALID");
    }
    if (manifest.version !== 1 || typeof manifest.reason !== "string") {
      throw new Error("BACKUP_IMPORT_INVALID");
    }
    // `in` walks the prototype chain ("constructor" would pass) — own-property only.
    const reason: BackupReason = Object.hasOwn(DEFAULT_RETENTION, manifest.reason)
      ? (manifest.reason as BackupReason)
      : "manual";
    let createdAt = new Date(manifest.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      createdAt = this.now();
    }
    const baseDirName = `${isoFs(createdAt)}-${reason}`;
    let dirName = baseDirName;
    for (let n = 1; this.fs.existsSync(path.join(this.backupsDir, dirName)); n += 1) {
      dirName = `${baseDirName}-import-${n}`;
    }

    const staging = path.join(this.backupsDir, `.tmp-import-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    this.sweepStaging();
    this.fs.mkdirSync(staging, { recursive: true });
    try {
      for (const name of Object.keys(entries)) {
        const content = entries[name]!;
        if (name.endsWith("/")) {
          this.fs.mkdirSync(path.join(staging, ...name.split("/")), { recursive: true });
          continue;
        }
        const target = path.join(staging, ...name.split("/"));
        this.fs.mkdirSync(path.dirname(target), { recursive: true });
        this.fs.writeFileSync(target, content);
      }
      this.fs.renameSync(staging, path.join(this.backupsDir, dirName));
    } catch (error) {
      this.fs.rmSync(staging, { recursive: true, force: true });
      // Structural conflicts in a hostile zip (file `a` + `a/b`, dir `a/` + file `a`,
      // Windows-illegal names) throw EEXIST/ENOTDIR/EISDIR — those mean "bad archive",
      // while ENOSPC/EACCES are real disk problems worth surfacing as-is.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR") {
        throw new Error("BACKUP_IMPORT_INVALID");
      }
      throw error;
    }
    const entry = this.readEntry(dirName);
    if (!entry) {
      throw new Error("BACKUP_IMPORT_INVALID");
    }
    return entry;
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
