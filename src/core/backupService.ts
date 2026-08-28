import * as defaultFs from "node:fs";
import type { Dirent } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { strFromU8, unzip, zip, type AsyncZipOptions, type UnzipOptions } from "fflate";

import { writeFileAtomic } from "./atomicFile";
import { LOCAL_MODELS_FILE } from "./builtinModels";
import { assertContainedFileName } from "./pathSafety";
import { BACKUP_SCOPES } from "./types";
import type { BackupEntry, BackupManifest, BackupReason, BackupScope } from "./types";

/**
 * Deflate/inflate MUST stay off the extension-host event loop: fflate's async
 * zip/unzip run on worker_threads (own workers, not the shared libuv pool), so a
 * multi-hundred-MB export/import never freezes every other extension's messages.
 * The sync-looking file walk/reads around them are bounded by the caps below.
 */
function zipAsync(files: Record<string, Uint8Array>, opts: AsyncZipOptions): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, opts, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

function unzipAsync(data: Uint8Array, opts: UnzipOptions): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(data, opts, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

/** Zip size caps shared by import AND export so the two directions stay symmetric. */
const ZIP_MAX_ENTRIES = 20_000;
const ZIP_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/**
 * A single entry declaring far more original bytes than its compressed size is a bomb.
 * 1000 sits just under deflate's theoretical 1032:1 ceiling: extreme bomb shapes are
 * still caught while honest low-entropy files (zero-filled/sparse, ~400-1000:1) that
 * this extension itself exports survive import. The total-bytes cap and the
 * declared-size re-verification do the real bomb defense; this is a redundant layer.
 */
const ZIP_MAX_RATIO = 1000;
/** Max directory levels the backup copier descends (source-side cycles are impossible, hostile depth is not). */
const MAX_COPY_DEPTH = 16;

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
  /**
   * Absolute path of the local model catalog (the "models" scope source). Defaults
   * to <configDir>/models.json; the backup entry label is the file's basename.
   */
  modelsFile?: string;
  /**
   * Overridable copy caps (tests). Defaults mirror the zip caps (20k entries / 256MB)
   * and bound BOTH create() and restore(): a foreign oversized backup dir planted by
   * hand must not translate restore into an unbounded synchronous main-thread copy.
   */
  caps?: { maxEntries?: number; maxTotalBytes?: number };
}

export const DEFAULT_RETENTION: Record<BackupReason, number | null> = {
  manual: null,
  "pre-apply": 20,
  "pre-save": 20,
  "pre-restore": 20,
};

const MANAGED_FILES = ["opencode.json", "oh-my-opencode.json", "AGENTS.md"] as const;
/** configDir sub-dirs belonging to the "config" scope ("presets" is its own scope). */
const CONFIG_DIRS = ["command", "skills"] as const;
const MANIFEST_FILE = "manifest.json";
const ALL_REASONS = Object.keys(DEFAULT_RETENTION) as BackupReason[];

/** DOS device names are illegal file names on Windows even with an extension (CON.txt) — same set as pathSafety's preset check. */
const WINDOWS_RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Zip entry names use "/" on every platform; reject anything that could escape the
 * staging dir when joined (absolute, drive letters, backslashes, ".." segments, NUL),
 * plus statically hostile names: any segment over 255 bytes (ENAMETOOLONG on ext4/NTFS)
 * and, on win32, DOS device segments (CON.txt etc. — EINVAL/EPERM at write time).
 */
export function assertZipEntryName(name: string, platform: NodeJS.Platform = process.platform): void {
  const bad =
    name.length === 0 ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").some((seg) => seg === ".." || Buffer.byteLength(seg, "utf8") > 255) ||
    (platform === "win32" && name.split("/").some((seg) => WINDOWS_RESERVED_SEGMENT.test(seg.split(".")[0] ?? seg)));
  if (bad) {
    throw new Error("BACKUP_IMPORT_INVALID");
  }
}

export function isoFs(d: Date): string {
  return d.toISOString().replace(/:/g, "-").replace(/\./g, "-");
}

/**
 * Years outside 0-9999 fall outside the ISO-8601 four-digit scheme the dirName relies
 * on: modern engines render them as extended years ("+100000-…"), older ones throw
 * RangeError from toISOString. Either way the documented fallback is now().
 */
function isoYearOutOfRange(d: Date): boolean {
  const year = d.getUTCFullYear();
  return year < 0 || year > 9999;
}

export class BackupService {
  private readonly configDir: string;
  private readonly backupsDir: string;
  private readonly hostname: string;
  private readonly now: () => Date;
  private readonly fsMod: typeof import("node:fs");
  private readonly retention: Record<BackupReason, number | null>;
  private readonly managedFiles: readonly { label: string; src: string }[];
  private readonly extraDirs: readonly { label: string; src: string }[];
  private readonly modelsFile: string;
  /** Backup-entry label of the models catalog (its basename, default "models.json"). */
  private readonly modelsLabel: string;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly manifestCache = new Map<string, { mtimeMs: number; entry: BackupEntry | null }>();

  constructor(opts: BackupServiceOptions) {
    this.configDir = opts.configDir;
    this.backupsDir = path.join(opts.configDir, "backups");
    this.hostname = opts.hostname ?? os.hostname();
    this.now = opts.now ?? (() => new Date());
    this.fsMod = opts.fs ?? defaultFs;
    this.retention = { ...DEFAULT_RETENTION, ...opts.retention };
    this.managedFiles = opts.managedFiles
      ? opts.managedFiles.map((src) => ({ label: path.basename(src), src }))
      : MANAGED_FILES.map((name) => ({ label: name, src: path.join(opts.configDir, name) }));
    this.extraDirs = opts.extraDirs ?? [];
    this.modelsFile = opts.modelsFile ?? path.join(opts.configDir, LOCAL_MODELS_FILE);
    this.modelsLabel = path.basename(this.modelsFile);
    this.maxEntries = opts.caps?.maxEntries ?? ZIP_MAX_ENTRIES;
    this.maxTotalBytes = opts.caps?.maxTotalBytes ?? ZIP_MAX_TOTAL_BYTES;
  }

  /**
   * Snapshot the selected scopes into a new backup dir. `scopes` omitted = ALL scopes
   * (the auto pre-apply/pre-save/pre-restore callers' legacy full-backup contract);
   * the manifest always records the effective scope list in canonical order.
   */
  create(
    reason: BackupReason,
    meta?: { preset?: string; name?: string },
    scopes?: readonly BackupScope[],
  ): BackupEntry {
    const at = this.now();
    const baseDirName = `${isoFs(at)}-${reason}`;
    // Same-millisecond double backup: negotiate a -N suffix instead of failing the
    // final rename with a raw ENOTEMPTY (same loop importZip uses for collisions).
    let dirName = baseDirName;
    for (let n = 1; this.fsMod.existsSync(path.join(this.backupsDir, dirName)); n += 1) {
      dirName = `${baseDirName}-${n}`;
    }
    const dir = path.join(this.backupsDir, dirName);
    // Build in a hidden staging sibling and publish by rename: a mid-copy failure
    // (EPERM/ENOSPC/ENOENT race) must not leave a manifest-less partial backup that
    // list() can never see or prune.
    const staging = path.join(this.backupsDir, `.tmp-${dirName}`);
    this.sweepStaging();
    this.fsMod.rmSync(staging, { recursive: true, force: true });
    this.fsMod.mkdirSync(staging, { recursive: true });

    const effective = this.normalizeScopes(scopes);
    try {
      const budget = { files: 0, bytes: 0, entries: 0 };
      if (effective.includes("config")) {
        this.stageConfigScope(staging, budget);
      }
      if (effective.includes("presets")) {
        this.stagePresetsScope(staging, budget);
      }
      if (effective.includes("models")) {
        this.stageModelsScope(staging, budget);
      }

      const manifest: BackupManifest = {
        version: 1,
        reason,
        ...(meta?.name !== undefined && meta.name.length > 0 ? { name: meta.name } : {}),
        ...(meta?.preset !== undefined ? { preset: meta.preset } : {}),
        scopes: effective,
        createdAt: at.toISOString(),
        fileCount: budget.files,
        machine: this.hostname,
      };
      writeFileAtomic(path.join(staging, MANIFEST_FILE), JSON.stringify(manifest, null, 2), this.fsMod);
      this.fsMod.renameSync(staging, dir);
    } catch (error) {
      this.fsMod.rmSync(staging, { recursive: true, force: true });
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

  /** Canonicalize a scope selection: BACKUP_SCOPES order, deduped, unknown values dropped. */
  private normalizeScopes(scopes: readonly BackupScope[] | undefined): BackupScope[] {
    return scopes === undefined ? [...BACKUP_SCOPES] : BACKUP_SCOPES.filter((scope) => scopes.includes(scope));
  }

  /** Stage the "config" scope: managed files + command/ + skills/ + extraDirs, existing sources only. */
  private stageConfigScope(staging: string, budget: { files: number; bytes: number; entries: number }): void {
    for (const { label, src } of this.managedFiles) {
      if (this.fsMod.existsSync(src)) {
        this.chargeBudget(budget, this.fsMod.statSync(src).size);
        this.fsMod.copyFileSync(src, path.join(staging, label));
      }
    }
    for (const name of CONFIG_DIRS) {
      const src = path.join(this.configDir, name);
      if (!this.fsMod.existsSync(src)) {
        continue;
      }
      this.copyTreeSafe(src, path.join(staging, name), budget, 1);
    }
    for (const { label, src } of this.extraDirs) {
      if (!this.fsMod.existsSync(src)) {
        continue;
      }
      this.copyTreeSafe(src, path.join(staging, label), budget, 1);
    }
  }

  /** Stage the "presets" scope: the configDir presets/ dir, when it exists. */
  private stagePresetsScope(staging: string, budget: { files: number; bytes: number; entries: number }): void {
    const src = path.join(this.configDir, "presets");
    if (this.fsMod.existsSync(src)) {
      this.copyTreeSafe(src, path.join(staging, "presets"), budget, 1);
    }
  }

  /** Stage the "models" scope: the local model catalog file, when it exists. */
  private stageModelsScope(staging: string, budget: { files: number; bytes: number; entries: number }): void {
    if (this.fsMod.existsSync(this.modelsFile)) {
      this.chargeBudget(budget, this.fsMod.statSync(this.modelsFile).size);
      this.fsMod.copyFileSync(this.modelsFile, path.join(staging, this.modelsLabel));
    }
  }

  /**
   * Symlink-safe recursive copy: every entry is lstat'd and symbolic links are SKIPPED
   * (never dereferenced). cpSync({dereference:true}) would follow a third-party-planted
   * link inside a skills dir and copy secrets (auth.json) or entire home dirs into a
   * backup that exportZip can then ship anywhere — and on restore() the same walk keeps
   * a hand-planted link inside a backup dir from materializing its target into the
   * managed config dir. The walk is bounded by the same caps as zip import
   * (entries/bytes — directories count as entries, mirroring the zip walks) plus a
   * depth limit; exceeding any aborts the operation. Skipped links are intentionally
   * not recorded in the manifest (BackupManifest is a frozen shape shared with the
   * tree/UI layers). `budget` is omitted on the restore() path (no create-side caps).
   */
  private copyTreeSafe(
    src: string,
    dest: string,
    budget: { files: number; bytes: number; entries: number } | undefined,
    depth: number,
    exceedError = "BACKUP_CREATE_TOO_LARGE",
  ): void {
    const st = this.fsMod.lstatSync(src);
    if (st.isSymbolicLink()) {
      return; // skipped: see method doc
    }
    if (st.isDirectory()) {
      if (depth >= MAX_COPY_DEPTH) {
        throw new Error(exceedError);
      }
      if (budget !== undefined) {
        this.chargeDirEntry(budget, exceedError);
      }
      this.fsMod.mkdirSync(dest, { recursive: true });
      for (const ent of this.fsMod.readdirSync(src, { withFileTypes: true })) {
        this.copyTreeSafe(path.join(src, ent.name), path.join(dest, ent.name), budget, depth + 1, exceedError);
      }
      return;
    }
    if (st.isFile()) {
      if (budget !== undefined) {
        this.chargeBudget(budget, st.size, exceedError);
      }
      this.fsMod.copyFileSync(src, dest);
    }
    // Other node types (fifo/socket/device) are skipped.
  }

  private chargeBudget(
    budget: { files: number; bytes: number; entries: number },
    bytes: number,
    exceedError = "BACKUP_CREATE_TOO_LARGE",
  ): void {
    budget.files += 1;
    budget.entries += 1;
    budget.bytes += bytes;
    this.assertWithinCaps(budget, exceedError);
  }

  /** Directory entries consume the entry budget (export/import count them too) but not fileCount. */
  private chargeDirEntry(budget: { files: number; bytes: number; entries: number }, exceedError?: string): void {
    budget.entries += 1;
    this.assertWithinCaps(budget, exceedError);
  }

  private assertWithinCaps(budget: { files: number; bytes: number; entries: number }, exceedError?: string): void {
    if (budget.entries > this.maxEntries || budget.bytes > this.maxTotalBytes) {
      throw new Error(exceedError ?? "BACKUP_CREATE_TOO_LARGE");
    }
  }

  private sweepStaging(): void {
    if (!this.fsMod.existsSync(this.backupsDir)) {
      return;
    }
    for (const ent of this.fsMod.readdirSync(this.backupsDir, { withFileTypes: true })) {
      if (ent.isDirectory() && ent.name.startsWith(".tmp-")) {
        this.fsMod.rmSync(path.join(this.backupsDir, ent.name), { recursive: true, force: true });
      }
    }
  }

  list(): BackupEntry[] {
    if (!this.fsMod.existsSync(this.backupsDir)) {
      return [];
    }
    let dirents: Dirent[];
    try {
      dirents = this.fsMod.readdirSync(this.backupsDir, { withFileTypes: true });
    } catch {
      // An unreadable backups dir (EACCES, AV lock) must not take the whole tree down —
      // degrade this section to empty, mirroring configStore's readdirSafe contract.
      return [];
    }
    const entries: BackupEntry[] = [];
    for (const ent of dirents) {
      if (!ent.isDirectory() || ent.name.startsWith(".tmp-")) {
        continue;
      }
      const entry = this.readEntry(ent.name);
      if (entry) {
        entries.push(entry);
      }
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
    this.fsMod.rmSync(path.join(this.backupsDir, dirName), { recursive: true, force: true });
  }

  rename(dirName: string, name: string): BackupEntry {
    this.assertDirName(dirName);
    const entry = this.list().find((e) => e.dirName === dirName);
    if (!entry) {
      throw new Error("BACKUP_NOT_FOUND");
    }
    const manifest: BackupManifest = { ...entry.manifest, name };
    writeFileAtomic(path.join(entry.dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), this.fsMod);
    return { ...entry, manifest };
  }

  /**
   * Restore the selected scopes from a backup. `scopes` omitted = restore everything
   * present (legacy full-restore contract); a scope the backup does not hold is a no-op.
   */
  restore(dirName: string, scopes?: readonly BackupScope[]): void {
    this.assertDirName(dirName);
    const srcDir = path.join(this.backupsDir, dirName);
    // Foreign backup dirs (planted by hand, uncapped at create time) must not turn
    // restore into an unbounded synchronous copy on the extension-host main thread.
    const budget = { files: 0, bytes: 0, entries: 0 };
    const effective = this.normalizeScopes(scopes);
    if (effective.includes("config")) {
      this.restoreConfigScope(srcDir, budget);
    }
    if (effective.includes("presets")) {
      this.restorePresetsScope(srcDir, budget);
    }
    if (effective.includes("models")) {
      this.restoreModelsScope(srcDir);
    }
  }

  /** Restore the "config" scope: managed files (atomic) + command/ + skills/ + extraDirs. */
  private restoreConfigScope(srcDir: string, budget: { files: number; bytes: number; entries: number }): void {
    // Managed config files are restored through the atomic writer: a mid-copy failure
    // (ENOSPC/EPERM) must never truncate the live opencode.json / omo.jsonc.
    for (const { label, src } of this.managedFiles) {
      const backup = path.join(srcDir, label);
      if (this.fsMod.existsSync(backup)) {
        this.fsMod.mkdirSync(path.dirname(src), { recursive: true });
        writeFileAtomic(src, this.fsMod.readFileSync(backup, "utf8"), this.fsMod);
      }
    }
    for (const name of CONFIG_DIRS) {
      const src = path.join(srcDir, name);
      if (this.fsMod.existsSync(src)) {
        const target = path.join(this.configDir, name);
        this.removeSymlinksInWay(src, target);
        // Same symlink-skipping walk as create(): a hand-planted link inside the
        // backup dir must not materialize its target into the managed config dir.
        this.copyTreeSafe(src, target, budget, 1, "BACKUP_RESTORE_TOO_LARGE");
      }
    }
    for (const { label, src } of this.extraDirs) {
      const backup = path.join(srcDir, label);
      if (this.fsMod.existsSync(backup)) {
        this.fsMod.mkdirSync(path.dirname(src), { recursive: true });
        this.removeSymlinksInWay(backup, src);
        this.copyTreeSafe(backup, src, budget, 1, "BACKUP_RESTORE_TOO_LARGE");
      }
    }
  }

  /** Restore the "presets" scope: the presets/ dir back into configDir. */
  private restorePresetsScope(srcDir: string, budget: { files: number; bytes: number; entries: number }): void {
    const src = path.join(srcDir, "presets");
    if (this.fsMod.existsSync(src)) {
      const target = path.join(this.configDir, "presets");
      this.removeSymlinksInWay(src, target);
      this.copyTreeSafe(src, target, budget, 1, "BACKUP_RESTORE_TOO_LARGE");
    }
  }

  /** Restore the "models" scope: the catalog file back to its live path (atomic write). */
  private restoreModelsScope(srcDir: string): void {
    const backup = path.join(srcDir, this.modelsLabel);
    if (this.fsMod.existsSync(backup)) {
      this.fsMod.mkdirSync(path.dirname(this.modelsFile), { recursive: true });
      writeFileAtomic(this.modelsFile, this.fsMod.readFileSync(backup, "utf8"), this.fsMod);
    }
  }

  /**
   * Content-based scope detection: which scopes this backup could actually restore.
   * Works for legacy backups without manifest.scopes — the manifest is not consulted,
   * only cheap existsSync checks against the per-scope entry sets.
   */
  availableScopes(dirName: string): BackupScope[] {
    this.assertDirName(dirName);
    const srcDir = path.join(this.backupsDir, dirName);
    const present: BackupScope[] = [];
    if (
      this.managedFiles.some(({ label }) => this.fsMod.existsSync(path.join(srcDir, label))) ||
      CONFIG_DIRS.some((name) => this.fsMod.existsSync(path.join(srcDir, name))) ||
      this.extraDirs.some(({ label }) => this.fsMod.existsSync(path.join(srcDir, label)))
    ) {
      present.push("config");
    }
    if (this.fsMod.existsSync(path.join(srcDir, "presets"))) {
      present.push("presets");
    }
    if (this.fsMod.existsSync(path.join(srcDir, this.modelsLabel))) {
      present.push("models");
    }
    return present;
  }

  /**
   * Delete symlink entries in `target` that sit where `src`'s content will land:
   * cpSync/copyFileSync follow existing links on the TARGET side, so a planted
   * ~/.agents/skills/x -> ~/.bashrc would otherwise turn restore into an arbitrary
   * file overwrite. Backup trees themselves contain no symlinks (create() skips them).
   */
  private removeSymlinksInWay(src: string, target: string): void {
    let dirents: Dirent[];
    try {
      dirents = this.fsMod.readdirSync(src, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of dirents) {
      const from = path.join(src, ent.name);
      const to = path.join(target, ent.name);
      let st: defaultFs.Stats;
      try {
        st = this.fsMod.lstatSync(to);
      } catch {
        continue; // nothing planted at this path
      }
      if (st.isSymbolicLink()) {
        this.fsMod.rmSync(to, { recursive: true, force: true });
      } else if (ent.isDirectory() && st.isDirectory()) {
        this.removeSymlinksInWay(from, to);
      }
    }
  }

  diffPairs(entry: BackupEntry): { label: string; backup: string; current: string }[] {
    const pairs: { label: string; backup: string; current: string }[] = [];
    for (const { label, src } of this.managedFiles) {
      const backup = path.join(entry.dir, label);
      if (this.fsMod.existsSync(backup) && this.fsMod.existsSync(src)) {
        pairs.push({ label, backup, current: src });
      }
    }
    return pairs;
  }

  /**
   * Export a backup as a zip (entry names use "/" per the zip spec — platform-neutral).
   * Backups hold no symlinks (create() skips them, never dereferences), so a foreign
   * link placed by hand matches neither isDirectory nor isFile and is skipped here too.
   * The walk enforces the SAME caps as importZip (entries/total bytes) and fails with
   * BACKUP_EXPORT_TOO_LARGE before the zip is built in memory.
   */
  async exportZip(dirName: string, targetFile: string): Promise<void> {
    this.assertDirName(dirName);
    if (!this.readEntry(dirName)) {
      throw new Error("BACKUP_NOT_FOUND");
    }
    const srcDir = path.join(this.backupsDir, dirName);
    const files: Record<string, Uint8Array> = {};
    let entryCount = 0;
    let totalBytes = 0;
    const walk = (dir: string, rel: string): void => {
      for (const ent of this.fsMod.readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          entryCount += 1;
          if (entryCount > ZIP_MAX_ENTRIES) {
            throw new Error("BACKUP_EXPORT_TOO_LARGE");
          }
          files[`${childRel}/`] = new Uint8Array(0); // explicit entry keeps empty dirs
          walk(path.join(dir, ent.name), childRel);
        } else if (ent.isFile()) {
          const full = path.join(dir, ent.name);
          const size = this.fsMod.statSync(full).size;
          entryCount += 1;
          totalBytes += size;
          if (entryCount > ZIP_MAX_ENTRIES || totalBytes > ZIP_MAX_TOTAL_BYTES) {
            throw new Error("BACKUP_EXPORT_TOO_LARGE");
          }
          files[childRel] = new Uint8Array(this.fsMod.readFileSync(full));
        }
      }
    };
    walk(srcDir, "");
    writeFileAtomic(targetFile, await zipAsync(files, { level: 6 }), this.fsMod);
  }

  /**
   * Import a backup zip into the backups dir (staging + rename publish, same as create()).
   * Entries are validated against traversal and capped in count/size; the manifest must be
   * a version-1 backup manifest, and the target dirName is rebuilt from it (foreign reasons
   * downgrade to "manual"; name collisions get an -import-N suffix).
   */
  async importZip(zipFile: string): Promise<BackupEntry> {
    // Cap the compressed file itself first — readFileSync of a multi-GB "zip" would OOM
    // before any other check runs.
    const zipSize = this.fsMod.statSync(zipFile).size;
    if (zipSize > ZIP_MAX_TOTAL_BYTES) {
      throw new Error("BACKUP_IMPORT_INVALID");
    }
    // fflate's filter runs BEFORE inflating each entry and carries the header's declared
    // originalSize — enforcing caps here keeps a well-formed zip bomb from ever being
    // decompressed into extension-host memory. The compression-ratio guard rejects
    // entries declaring far more bytes than they compress to (classic bomb shape).
    let entryCount = 0;
    let totalBytes = 0;
    let capsExceeded = false;
    const declaredSizes: Record<string, number> = {};
    let entries: Record<string, Uint8Array>;
    try {
      entries = await unzipAsync(new Uint8Array(this.fsMod.readFileSync(zipFile)), {
        filter: (file) => {
          entryCount += 1;
          totalBytes += file.originalSize;
          declaredSizes[file.name] = file.originalSize;
          if (
            entryCount > ZIP_MAX_ENTRIES ||
            totalBytes > ZIP_MAX_TOTAL_BYTES ||
            file.originalSize > ZIP_MAX_RATIO * Math.max(1, file.size)
          ) {
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
    // fflate preallocates the declared buffer and silently truncates overflow — a
    // lying central directory must not slip truncated content through: re-verify the
    // materialized length of every entry against its declared originalSize.
    for (const name of Object.keys(entries)) {
      const content = entries[name];
      if (!(content instanceof Uint8Array) || content.length !== declaredSizes[name]) {
        throw new Error("BACKUP_IMPORT_INVALID");
      }
      assertZipEntryName(name);
    }
    const raw = entries[MANIFEST_FILE];
    if (!(raw instanceof Uint8Array)) {
      throw new Error("BACKUP_IMPORT_INVALID");
    }
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(strFromU8(raw)) as BackupManifest;
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
    if (Number.isNaN(createdAt.getTime()) || isoYearOutOfRange(createdAt)) {
      createdAt = this.now();
    }
    const baseDirName = `${isoFs(createdAt)}-${reason}`;
    let dirName = baseDirName;
    for (let n = 1; this.fsMod.existsSync(path.join(this.backupsDir, dirName)); n += 1) {
      dirName = `${baseDirName}-import-${n}`;
    }

    const staging = path.join(this.backupsDir, `.tmp-import-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    this.sweepStaging();
    this.fsMod.mkdirSync(staging, { recursive: true });
    try {
      for (const name of Object.keys(entries)) {
        const content = entries[name]!;
        if (name.endsWith("/")) {
          this.fsMod.mkdirSync(path.join(staging, ...name.split("/")), { recursive: true });
          continue;
        }
        const target = path.join(staging, ...name.split("/"));
        this.fsMod.mkdirSync(path.dirname(target), { recursive: true });
        this.fsMod.writeFileSync(target, content);
      }
      this.fsMod.renameSync(staging, path.join(this.backupsDir, dirName));
    } catch (error) {
      this.fsMod.rmSync(staging, { recursive: true, force: true });
      // Structural conflicts in a hostile zip (file `a` + `a/b`, dir `a/` + file `a`,
      // Windows-illegal or over-long names) map to "bad archive", while ENOSPC/EACCES
      // are real disk problems worth surfacing as-is.
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === "EEXIST" ||
        code === "ENOTDIR" ||
        code === "EISDIR" ||
        code === "ENAMETOOLONG" ||
        code === "EINVAL" ||
        code === "ERR_INVALID_FILE_NAME"
      ) {
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
      if (typeof keep !== "number") {
        continue;
      }
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
      if (!this.fsMod.existsSync(manifestPath)) {
        this.manifestCache.delete(dirName);
        return null;
      }
      // Memoize the read+parse per dirName, invalidated by mtime: list() runs on every
      // tree refresh and long-lived installs accumulate dozens of manifests.
      const mtimeMs = this.fsMod.statSync(manifestPath).mtimeMs;
      const cached = this.manifestCache.get(dirName);
      if (cached && cached.mtimeMs === mtimeMs) {
        return cached.entry;
      }
      const manifest = JSON.parse(this.fsMod.readFileSync(manifestPath, "utf8")) as BackupManifest;
      const entry =
        manifest.version !== 1 || typeof manifest.reason !== "string"
          ? null
          : { dirName, dir: path.join(this.backupsDir, dirName), manifest };
      this.manifestCache.set(dirName, { mtimeMs, entry });
      return entry;
    } catch {
      return null;
    }
  }
}
