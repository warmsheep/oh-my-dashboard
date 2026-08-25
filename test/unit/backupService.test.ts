import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { deflateSync, strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertZipEntryName, BackupService, DEFAULT_RETENTION, isoFs } from "../../src/core/backupService";

// All tests run against throwaway sandboxes — NEVER the real ~/.config/opencode.
let configDir: string;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-"));
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

/** Full managed tree: 2 jsons + AGENTS.md + command/{a.md,sub/b.md} + skills/one/x.md = 6 files. */
function seedFullTree(): void {
  fs.writeFileSync(path.join(configDir, "opencode.json"), '{"model":"glm"}');
  fs.writeFileSync(path.join(configDir, "oh-my-opencode.json"), '{"agents":{}}');
  fs.writeFileSync(path.join(configDir, "AGENTS.md"), "# AGENTS\n");
  fs.mkdirSync(path.join(configDir, "command", "sub"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "command", "a.md"), "a");
  fs.writeFileSync(path.join(configDir, "command", "sub", "b.md"), "b");
  fs.mkdirSync(path.join(configDir, "skills", "one"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "skills", "one", "x.md"), "x");
  fs.mkdirSync(path.join(configDir, "presets"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "presets", "work.json"), '{"name":"work"}');
}

/** Deterministic clock: each call advances by stepMs, producing distinct fs-safe stamps. */
function seqNow(startIso: string, stepMs = 1000): () => Date {
  let t = Date.parse(startIso);
  return () => {
    const d = new Date(t);
    t += stepMs;
    return d;
  };
}

describe("isoFs", () => {
  it("formats an ISO timestamp with colons/dots replaced by dashes (fs-safe)", async () => {
    expect(isoFs(new Date("2026-08-21T15:04:05.123Z"))).toBe("2026-08-21T15-04-05-123Z");
  });
});

describe("DEFAULT_RETENTION (frozen contract)", () => {
  it("manual is infinite (null), auto reasons keep 20", async () => {
    expect(DEFAULT_RETENTION).toEqual({
      manual: null,
      "pre-apply": 20,
      "pre-save": 20,
      "pre-restore": 20,
    });
  });
});

describe("BackupService.create", () => {
  it("snapshots the full managed tree and writes an exact manifest (manual)", async () => {
    seedFullTree();
    const svc = new BackupService({
      configDir,
      hostname: "test-host",
      now: () => new Date("2026-08-21T15:04:05.123Z"),
    });

    const entry = svc.create("manual", { preset: "heavy" });

    expect(entry.dirName).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-manual$/);
    expect(entry.dirName).toBe("2026-08-21T15-04-05-123Z-manual");
    expect(entry.dir).toBe(path.join(configDir, "backups", entry.dirName));

    // every file copied at the correct relative path
    expect(fs.readFileSync(path.join(entry.dir, "opencode.json"), "utf8")).toBe('{"model":"glm"}');
    expect(fs.readFileSync(path.join(entry.dir, "oh-my-opencode.json"), "utf8")).toBe('{"agents":{}}');
    expect(fs.readFileSync(path.join(entry.dir, "AGENTS.md"), "utf8")).toBe("# AGENTS\n");
    expect(fs.readFileSync(path.join(entry.dir, "command", "a.md"), "utf8")).toBe("a");
    expect(fs.readFileSync(path.join(entry.dir, "command", "sub", "b.md"), "utf8")).toBe("b");
    expect(fs.readFileSync(path.join(entry.dir, "skills", "one", "x.md"), "utf8")).toBe("x");
    expect(fs.readFileSync(path.join(entry.dir, "presets", "work.json"), "utf8")).toBe('{"name":"work"}');

    // manifest fields exact
    expect(entry.manifest.version).toBe(1);
    expect(entry.manifest.reason).toBe("manual");
    expect(entry.manifest.preset).toBe("heavy");
    expect(entry.manifest.fileCount).toBe(7);
    expect(entry.manifest.machine).toBe("test-host");
    expect(entry.manifest.createdAt).toBe("2026-08-21T15:04:05.123Z");
    expect(Number.isNaN(Date.parse(entry.manifest.createdAt))).toBe(false);

    // manifest.json persisted on disk matches the returned entry
    const onDisk = JSON.parse(fs.readFileSync(path.join(entry.dir, "manifest.json"), "utf8"));
    expect(onDisk).toEqual(entry.manifest);
  });

  it("copies only existing sources on a partially-seeded tree (no command/, no skills/)", async () => {
    fs.writeFileSync(path.join(configDir, "opencode.json"), "{}");
    const svc = new BackupService({
      configDir,
      now: () => new Date("2026-08-21T15:04:05.123Z"),
    });

    const entry = svc.create("pre-save");

    expect(entry.manifest.fileCount).toBe(1);
    expect(fs.existsSync(path.join(entry.dir, "opencode.json"))).toBe(true);
    expect(fs.existsSync(path.join(entry.dir, "command"))).toBe(false);
    expect(fs.existsSync(path.join(entry.dir, "skills"))).toBe(false);
    expect(fs.existsSync(path.join(entry.dir, "manifest.json"))).toBe(true);
  });
});

describe("BackupService named backups", () => {
  it("create() persists the user-supplied name into the manifest", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir, hostname: "h", now: () => new Date("2026-08-22T10:00:00.000Z") });

    const entry = svc.create("manual", { name: "升级前" });

    expect(entry.manifest.name).toBe("升级前");
    const onDisk = JSON.parse(fs.readFileSync(path.join(entry.dir, "manifest.json"), "utf8"));
    expect(onDisk.name).toBe("升级前");
  });

  it("rename() updates the manifest name and leaves every other field untouched", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir, hostname: "h", now: () => new Date("2026-08-22T10:00:00.000Z") });
    const entry = svc.create("manual", { name: "旧名字" });

    const renamed = svc.rename(entry.dirName, "新名字");

    expect(renamed.manifest.name).toBe("新名字");
    const onDisk = JSON.parse(fs.readFileSync(path.join(entry.dir, "manifest.json"), "utf8"));
    expect(onDisk.name).toBe("新名字");
    expect(onDisk.reason).toBe("manual");
    expect(onDisk.createdAt).toBe("2026-08-22T10:00:00.000Z");
    expect(onDisk.machine).toBe("h");
    expect(onDisk.fileCount).toBe(entry.manifest.fileCount);
  });

  it("rename() throws for an unknown dir", async () => {
    const svc = new BackupService({ configDir, hostname: "h" });
    expect(() => svc.rename("nope", "x")).toThrow("BACKUP_NOT_FOUND");
  });
});

describe("BackupService extraDirs (user-level skills outside configDir)", () => {
  let extraRoot: string;

  beforeEach(() => {
    extraRoot = fs.mkdtempSync(path.join(os.tmpdir(), "extra-"));
  });

  afterEach(() => {
    fs.rmSync(extraRoot, { recursive: true, force: true });
  });

  it("create() snapshots each existing extra dir under its label and counts its files", async () => {
    seedFullTree();
    const userSkills = path.join(extraRoot, ".agents", "skills");
    fs.mkdirSync(path.join(userSkills, "pdf"), { recursive: true });
    fs.writeFileSync(path.join(userSkills, "pdf", "SKILL.md"), "# pdf");
    fs.writeFileSync(path.join(userSkills, "top.md"), "top");
    const svc = new BackupService({
      configDir,
      hostname: "h",
      now: () => new Date("2026-08-22T10:00:00.000Z"),
      extraDirs: [{ label: "skills-user", src: userSkills }],
    });

    const entry = svc.create("manual");

    expect(fs.readFileSync(path.join(entry.dir, "skills-user", "pdf", "SKILL.md"), "utf8")).toBe("# pdf");
    expect(fs.readFileSync(path.join(entry.dir, "skills-user", "top.md"), "utf8")).toBe("top");
    expect(entry.manifest.fileCount).toBe(7 + 2);
  });

  it("create() skips extra dirs that do not exist", async () => {
    fs.writeFileSync(path.join(configDir, "opencode.json"), "{}");
    const svc = new BackupService({
      configDir,
      now: () => new Date("2026-08-22T10:00:00.000Z"),
      extraDirs: [{ label: "skills-user", src: path.join(extraRoot, "missing", "skills") }],
    });

    const entry = svc.create("manual");

    expect(entry.manifest.fileCount).toBe(1);
    expect(fs.existsSync(path.join(entry.dir, "skills-user"))).toBe(false);
  });

  it("restore() copies extra dirs back to their absolute src, recreating missing parents", async () => {
    seedFullTree();
    const userSkills = path.join(extraRoot, ".agents", "skills");
    fs.mkdirSync(path.join(userSkills, "pdf"), { recursive: true });
    fs.writeFileSync(path.join(userSkills, "pdf", "SKILL.md"), "# pdf");
    const svc = new BackupService({
      configDir,
      now: seqNow("2026-08-22T10:00:00.000Z"),
      extraDirs: [{ label: "skills-user", src: userSkills }],
    });
    const snap = svc.create("manual");

    fs.rmSync(path.join(extraRoot, ".agents"), { recursive: true, force: true });
    svc.restore(snap.dirName);

    expect(fs.readFileSync(path.join(userSkills, "pdf", "SKILL.md"), "utf8")).toBe("# pdf");
  });
});

describe("BackupService.list / remove", () => {
  it("lists sorted by dirName DESC (newest first) and remove() deletes the dir", async () => {
    seedFullTree();
    const svc = new BackupService({
      configDir,
      now: seqNow("2026-08-21T15:04:00.000Z"),
    });
    svc.create("pre-apply");
    svc.create("manual");
    svc.create("pre-save");
    svc.create("manual");

    const list = svc.list();
    expect(list.map((e) => e.dirName)).toEqual([
      "2026-08-21T15-04-03-000Z-manual",
      "2026-08-21T15-04-02-000Z-pre-save",
      "2026-08-21T15-04-01-000Z-manual",
      "2026-08-21T15-04-00-000Z-pre-apply",
    ]);

    const target = list[0];
    svc.remove(target.dirName);
    expect(fs.existsSync(target.dir)).toBe(false);
    const after = svc.list();
    expect(after).toHaveLength(3);
    expect(after.map((e) => e.dirName)).not.toContain(target.dirName);
  });

  it("returns [] when the backups dir does not exist", async () => {
    const svc = new BackupService({ configDir });
    expect(svc.list()).toEqual([]);
  });
});

describe("BackupService.prune", () => {
  it("keeps newest N for a reason, removes and returns exactly the oldest excess (25 created, retention 20 → 5 removed)", async () => {
    seedFullTree();
    // Create 25 backups under a cap of 25 so creation itself trims nothing,
    // then prune under the retention override { 'pre-apply': 20 }.
    const creator = new BackupService({
      configDir,
      now: seqNow("2026-08-01T00:00:00.000Z"),
      retention: { "pre-apply": 25 },
    });
    const created: string[] = [];
    for (let i = 0; i < 25; i++) {
      created.push(creator.create("pre-apply").dirName);
    }
    expect(creator.list()).toHaveLength(25);

    const svc = new BackupService({
      configDir,
      retention: { "pre-apply": 20 },
    });
    const removed = svc.prune();

    expect(removed).toHaveLength(5);
    expect(removed.map((e) => e.dirName).sort()).toEqual(created.slice(0, 5)); // the 5 oldest
    expect(svc.list()).toHaveLength(20);
    expect(svc.list().map((e) => e.dirName)).toEqual(created.slice(5).reverse()); // newest 20, DESC
    expect(fs.existsSync(path.join(configDir, "backups", created[0]))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "backups", created[24]))).toBe(true);
  });

  it("manual backups survive prune() with no args; retention null for manual honored", async () => {
    seedFullTree();
    const creator = new BackupService({
      configDir,
      now: seqNow("2026-08-01T00:00:00.000Z"),
      retention: { "pre-save": 10 },
    });
    const manualNames: string[] = [];
    for (let i = 0; i < 3; i++) {
      manualNames.push(creator.create("manual").dirName);
    }
    for (let i = 0; i < 4; i++) {
      creator.create("pre-save");
    }

    const svc = new BackupService({
      configDir,
      retention: { "pre-save": 2 },
    });
    const removed = svc.prune(); // no args → all reasons

    expect(removed).toHaveLength(2); // only the 2 oldest pre-save
    expect(removed.every((e) => e.manifest.reason !== "manual")).toBe(true);
    const remaining = svc.list();
    // manual (null retention) fully survives; newest 2 pre-save kept per retention
    expect(
      remaining
        .filter((e) => e.manifest.reason === "manual")
        .map((e) => e.dirName)
        .sort(),
    ).toEqual([...manualNames].sort());
    expect(remaining.filter((e) => e.manifest.reason === "pre-save")).toHaveLength(2);
  });

  it("create() auto-prunes its own reason down to the retention limit", async () => {
    seedFullTree();
    const svc = new BackupService({
      configDir,
      now: seqNow("2026-08-01T00:00:00.000Z"),
      retention: { "pre-apply": 3 },
    });
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      names.push(svc.create("pre-apply").dirName);
    }

    expect(svc.list().map((e) => e.dirName)).toEqual(names.slice(2).reverse()); // newest 3, DESC
    expect(fs.existsSync(path.join(configDir, "backups", names[0]))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "backups", names[1]))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "backups", names[4]))).toBe(true);
  });
});

describe("BackupService.restore", () => {
  it("restores the backup byte-identical and creates NO pre-restore backup (manual backups only)", async () => {
    seedFullTree();
    const svc = new BackupService({
      configDir,
      now: seqNow("2026-08-21T15:04:00.000Z"),
    });
    const snap = svc.create("manual");
    const original = fs.readFileSync(path.join(configDir, "opencode.json"), "utf8");

    fs.appendFileSync(path.join(configDir, "opencode.json"), "\n//garbage");
    fs.rmSync(path.join(configDir, "command", "a.md"));
    fs.writeFileSync(path.join(configDir, "presets", "work.json"), '{"name":"work-mutated"}');

    svc.restore(snap.dirName);

    expect(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8")).toBe(original);
    expect(fs.readFileSync(path.join(configDir, "command", "a.md"), "utf8")).toBe("a");
    expect(fs.readFileSync(path.join(configDir, "command", "sub", "b.md"), "utf8")).toBe("b");
    expect(fs.readFileSync(path.join(configDir, "presets", "work.json"), "utf8")).toBe('{"name":"work"}');

    expect(svc.list()).toHaveLength(1);
    expect(svc.list()[0].dirName).toBe(snap.dirName);
  });
});

describe("BackupService.diffPairs", () => {
  it("returns exactly the pairs where both backup and current sides exist", async () => {
    seedFullTree();
    const svc = new BackupService({
      configDir,
      now: () => new Date("2026-08-21T15:04:05.123Z"),
    });
    const entry = svc.create("manual");

    // full tree → 3 pairs
    let pairs = svc.diffPairs(entry);
    expect(pairs.map((p) => p.label).sort()).toEqual(["AGENTS.md", "oh-my-opencode.json", "opencode.json"]);
    for (const p of pairs) {
      expect(p.backup).toBe(path.join(entry.dir, p.label));
      expect(p.current).toBe(path.join(configDir, p.label));
      expect(fs.existsSync(p.backup)).toBe(true);
      expect(fs.existsSync(p.current)).toBe(true);
    }

    // AGENTS.md gone from current → only 2 pairs
    fs.rmSync(path.join(configDir, "AGENTS.md"));
    pairs = svc.diffPairs(entry);
    expect(pairs.map((p) => p.label).sort()).toEqual(["oh-my-opencode.json", "opencode.json"]);
  });
});

describe("BackupService path-traversal guard", () => {
  it("remove/rename/restore reject dirNames that escape the backups dir", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir, now: seqNow("2026-08-21T15:04:00.000Z") });
    const entry = svc.create("manual");

    for (const evil of ["../escape", "..", "/abs/name", "a/b"]) {
      expect(() => svc.remove(evil)).toThrow("INVALID_BACKUP_NAME");
      expect(() => svc.rename(evil, "x")).toThrow("INVALID_BACKUP_NAME");
      expect(() => svc.restore(evil)).toThrow("INVALID_BACKUP_NAME");
    }
    if (process.platform === "win32") {
      // Backslash is a separator only on Windows; on POSIX it's a legal (contained) filename char.
      expect(() => svc.remove("..\\escape")).toThrow("INVALID_BACKUP_NAME");
    }
    expect(fs.existsSync(entry.dir)).toBe(true);
  });
});

describe("BackupService staging + symlink handling", () => {
  it("create() publishes via staging: no .tmp-* residue, staged dirs invisible to list()", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir, now: seqNow("2026-08-21T15:04:00.000Z") });
    // A leftover staging dir from a crashed run (even with a manifest) must stay invisible.
    const stale = path.join(configDir, "backups", ".tmp-2026-01-01T00-00-00-000Z-manual");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(
      path.join(stale, "manifest.json"),
      JSON.stringify({
        version: 1,
        reason: "manual",
        createdAt: "2026-01-01T00:00:00.000Z",
        fileCount: 0,
        machine: "x",
      }),
    );

    const entry = svc.create("manual");
    expect(fs.existsSync(entry.dir)).toBe(true);
    const names = fs.readdirSync(path.join(configDir, "backups"));
    expect(names.filter((n) => n.startsWith(".tmp-"))).toEqual([]); // stale swept, nothing left behind
    expect(svc.list().map((e) => e.dirName)).toEqual([entry.dirName]);
  });

  it("create() SKIPS symlinked dir entries instead of dereferencing them (no exfiltration)", async () => {
    seedFullTree();
    const realDir = path.join(configDir, "skills", "real-skill");
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, "SKILL.md"), "# real");
    fs.symlinkSync(
      realDir,
      path.join(configDir, "skills", "linked-skill"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const svc = new BackupService({ configDir, now: seqNow("2026-08-21T15:04:00.000Z") });
    const entry = svc.create("manual");

    expect(fs.existsSync(path.join(entry.dir, "skills", "linked-skill"))).toBe(false);
    expect(fs.readFileSync(path.join(entry.dir, "skills", "real-skill", "SKILL.md"), "utf8")).toBe("# real");
    // fileCount counts only real files (2 seeded skills files + 1 new SKILL.md = 3)
    expect(entry.manifest.fileCount).toBe(7 + 1);
  });

  it.runIf(process.platform !== "win32")(
    "create() skips file symlinks pointing outside the tree (link target never copied)",
    () => {
      seedFullTree();
      const victim = path.join(configDir, "secret.txt");
      fs.writeFileSync(victim, "SECRET-API-KEY");
      fs.symlinkSync(victim, path.join(configDir, "skills", "leak.txt"), "file");

      const svc = new BackupService({ configDir, now: seqNow("2026-08-21T15:04:00.000Z") });
      const entry = svc.create("manual");

      expect(fs.existsSync(path.join(entry.dir, "skills", "leak.txt"))).toBe(false);
      const exported = fs.readFileSync(path.join(entry.dir, "skills", "one", "x.md"), "utf8");
      expect(exported).toBe("x");
    },
  );

  it("create() skips a managed dir that is itself a symlink", async () => {
    fs.writeFileSync(path.join(configDir, "opencode.json"), "{}");
    const realSkills = path.join(configDir, "real-skills");
    fs.mkdirSync(realSkills, { recursive: true });
    fs.writeFileSync(path.join(realSkills, "SKILL.md"), "# s");
    fs.symlinkSync(realSkills, path.join(configDir, "skills"), process.platform === "win32" ? "junction" : "dir");
    const svc = new BackupService({ configDir, now: () => new Date("2026-08-21T15:04:05.123Z") });
    const entry = svc.create("manual");
    expect(fs.existsSync(path.join(entry.dir, "skills"))).toBe(false);
    expect(entry.manifest.fileCount).toBe(1);
  });

  it("create() aborts with BACKUP_CREATE_TOO_LARGE past the byte cap and leaves no residue", async () => {
    seedFullTree();
    const blob = path.join(configDir, "skills", "blob.bin");
    fs.writeFileSync(blob, "x");
    fs.truncateSync(blob, 256 * 1024 * 1024 + 1); // sparse: stat size over cap, no real disk use

    const svc = new BackupService({ configDir, now: () => new Date("2026-08-21T15:04:05.123Z") });
    expect(() => svc.create("manual")).toThrow("BACKUP_CREATE_TOO_LARGE");

    const backupsDir = path.join(configDir, "backups");
    expect(fs.readdirSync(backupsDir)).toEqual([]); // staging swept, nothing published
  });

  it("create() aborts with BACKUP_CREATE_TOO_LARGE beyond the max directory depth", async () => {
    seedFullTree();
    let deep = path.join(configDir, "skills");
    for (let i = 0; i < 20; i++) {
      deep = path.join(deep, `d${i}`);
    }
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "bottom.md"), "x");

    const svc = new BackupService({ configDir, now: () => new Date("2026-08-21T15:04:05.123Z") });
    expect(() => svc.create("manual")).toThrow("BACKUP_CREATE_TOO_LARGE");
    expect(fs.readdirSync(path.join(configDir, "backups"))).toEqual([]);
  });

  it("create() counts DIRECTORY entries into the 20k-entry budget — >20k empty dirs fails at create (export parity)", async () => {
    // Real empty dirs (mkdir is cheap); fake-fs scaffolding would cost more than the
    // 20k syscalls it stubs. exportZip counts dir entries, so a create() that ignores
    // them would mint a backup that can never be exported (BACKUP_EXPORT_TOO_LARGE).
    fs.writeFileSync(path.join(configDir, "opencode.json"), "{}");
    const skillsDir = path.join(configDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    for (let i = 0; i <= 20_000; i += 1) {
      // 20,001 empty dirs: skills/ itself + 20,001 children = 20,002 dir entries.
      fs.mkdirSync(path.join(skillsDir, `d${i}`));
    }
    const svc = new BackupService({ configDir, now: () => new Date("2026-08-21T15:04:05.123Z") });
    expect(() => svc.create("manual")).toThrow("BACKUP_CREATE_TOO_LARGE");
    expect(fs.readdirSync(path.join(configDir, "backups"))).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "restore() skips a symlink planted INSIDE the backup dir — its target never materializes",
    () => {
      seedFullTree();
      const svc = new BackupService({ configDir, now: seqNow("2026-08-21T15:04:00.000Z") });
      const snap = svc.create("manual");

      // Hand-plant a link inside the published backup (zip import cannot do this):
      // a dereferencing restore would copy the victim's CONTENT into skills/loot,
      // after which create()/exportZip happily ship it out.
      const victim = path.join(configDir, "id_rsa");
      fs.writeFileSync(victim, "PRIVATE-KEY");
      fs.symlinkSync(victim, path.join(snap.dir, "skills", "loot"), "file");
      fs.rmSync(path.join(configDir, "skills", "one"), { recursive: true, force: true });

      svc.restore(snap.dirName);

      expect(fs.existsSync(path.join(configDir, "skills", "loot"))).toBe(false);
      expect(fs.readFileSync(victim, "utf8")).toBe("PRIVATE-KEY");
      // real backup entries still restore
      expect(fs.readFileSync(path.join(configDir, "skills", "one", "x.md"), "utf8")).toBe("x");
    },
  );

  it("restore() replaces a symlinked dir planted in the target instead of writing through it", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir, now: seqNow("2026-08-21T15:04:00.000Z") });
    const snap = svc.create("manual");

    const victim = path.join(configDir, "victim-profile.txt");
    fs.writeFileSync(victim, "VICTIM-CONTENT");
    fs.rmSync(path.join(configDir, "skills"), { recursive: true, force: true });
    fs.mkdirSync(path.join(configDir, "skills"));
    // backup holds skills/one/x.md — plant a link AT skills/one so restore would
    // otherwise write x.md THROUGH it into the victim file
    fs.symlinkSync(victim, path.join(configDir, "skills", "one"), process.platform === "win32" ? "junction" : "dir");

    svc.restore(snap.dirName);

    expect(fs.lstatSync(path.join(configDir, "skills", "one")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(configDir, "skills", "one", "x.md"), "utf8")).toBe("x");
    expect(fs.readFileSync(victim, "utf8")).toBe("VICTIM-CONTENT");
  });

  it.runIf(process.platform !== "win32")(
    "restore() replaces a symlinked FILE planted in the target; link target untouched",
    () => {
      seedFullTree();
      const svc = new BackupService({ configDir, now: seqNow("2026-08-21T15:04:00.000Z") });
      const snap = svc.create("manual");

      const victim = path.join(configDir, "victim-bashrc");
      fs.writeFileSync(victim, "VICTIM-CONTENT");
      fs.rmSync(path.join(configDir, "command", "a.md"));
      fs.symlinkSync(victim, path.join(configDir, "command", "a.md"), "file");

      svc.restore(snap.dirName);

      expect(fs.lstatSync(path.join(configDir, "command", "a.md")).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(configDir, "command", "a.md"), "utf8")).toBe("a");
      expect(fs.readFileSync(victim, "utf8")).toBe("VICTIM-CONTENT");
    },
  );

  it("restore() keeps the live config intact when a managed file copy is impossible", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir, now: seqNow("2026-08-21T15:04:00.000Z") });
    const entry = svc.create("manual");
    // Make the backup's opencode.json a directory — readFileSync will throw, and the
    // live file must not be truncated (atomic write never starts).
    fs.rmSync(path.join(entry.dir, "opencode.json"));
    fs.mkdirSync(path.join(entry.dir, "opencode.json"));
    const before = fs.readFileSync(path.join(configDir, "opencode.json"), "utf8");
    expect(() => svc.restore(entry.dirName)).toThrow();
    expect(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8")).toBe(before);
  });
});

describe("BackupService zip export/import", () => {
  it("deflates OFF the event loop: timers keep firing during a CPU-heavy export; import stays async", async () => {
    seedFullTree();
    // ~64MB at a 4:1 ratio: level-6 deflate is guaranteed CPU-heavy (hundreds of ms —
    // a sync zipSync would freeze every 5ms tick), while the ratio stays far below
    // the 1000:1 bomb guard. Import shares the same fflate worker path, so its
    // coverage here is the API shape (returns a promise) — inflate of 4:1 data is
    // memcpy-fast and a tick-count assertion on it would be timing-flaky.
    fs.mkdirSync(path.join(configDir, "skills", "big-pkg"), { recursive: true });
    const block = crypto.randomBytes(1024 * 1024);
    for (let i = 0; i < 16; i += 1) {
      fs.writeFileSync(
        path.join(configDir, "skills", "big-pkg", `f${i}.bin`),
        Buffer.concat([block, block, block, block]),
      );
    }
    const svc = new BackupService({ configDir, now: seqNow("2026-08-21T15:04:00.000Z") });
    const entry = svc.create("manual");

    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 5);
    try {
      const zipPath = path.join(configDir, "export.zip");
      await svc.exportZip(entry.dirName, zipPath);
      // A fully synchronous deflate freezes the timer for the whole call — this
      // fails with 0 ticks on the sync zipSync implementation.
      expect(ticks).toBeGreaterThan(0);

      const imported = svc.importZip(zipPath);
      expect(imported instanceof Promise).toBe(true);
      const resolved = await imported;
      // The original still exists, so the import lands under the -import-N suffix.
      expect(resolved.dirName.startsWith(entry.dirName)).toBe(true);
    } finally {
      clearInterval(ticker);
    }
  });

  it("round-trips a backup through zip: files, manifest, empty dirs, CJK names", async () => {
    seedFullTree();
    fs.mkdirSync(path.join(configDir, "command", "空目录"));
    fs.writeFileSync(path.join(configDir, "command", "说明.md"), "# 说明");
    const svc = new BackupService({ configDir, now: seqNow("2026-08-21T15:04:00.000Z") });
    const entry = svc.create("manual", { name: "往返" });

    const zipPath = path.join(configDir, "export.zip");
    await svc.exportZip(entry.dirName, zipPath);
    expect(fs.statSync(zipPath).size).toBeGreaterThan(100);

    const originalOpencode = fs.readFileSync(path.join(entry.dir, "opencode.json"), "utf8");
    svc.remove(entry.dirName);
    expect(fs.existsSync(entry.dir)).toBe(false);

    const imported = await svc.importZip(zipPath);
    expect(imported.dirName).toBe(entry.dirName);
    expect(imported.manifest.reason).toBe("manual");
    expect(imported.manifest.name).toBe("往返");
    expect(fs.readFileSync(path.join(imported.dir, "opencode.json"), "utf8")).toBe(originalOpencode);
    expect(fs.readFileSync(path.join(imported.dir, "command", "说明.md"), "utf8")).toBe("# 说明");
    expect(fs.statSync(path.join(imported.dir, "command", "空目录")).isDirectory()).toBe(true);
  });

  it("importing the same zip twice yields a suffixed copy and keeps both", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir, now: seqNow("2026-08-21T15:04:00.000Z") });
    const entry = svc.create("manual");
    const zipPath = path.join(configDir, "export.zip");
    await svc.exportZip(entry.dirName, zipPath);

    const second = await svc.importZip(zipPath);
    expect(second.dirName).toBe(`${entry.dirName}-import-1`);
    expect(
      svc
        .list()
        .map((e) => e.dirName)
        .sort(),
    ).toEqual([entry.dirName, second.dirName].sort());
  });

  it("rejects traversal entries and writes nothing", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir });
    const backupsBefore = fs.existsSync(path.join(configDir, "backups"))
      ? fs.readdirSync(path.join(configDir, "backups"))
      : [];
    for (const bad of ["../evil.txt", "a/../../evil.txt", "/abs.txt", "C:\\\\evil.txt", "a\\\\b.txt"]) {
      const zipPath = path.join(configDir, `bad-${bad.length}.zip`);
      fs.writeFileSync(
        zipPath,
        zipSync({
          "manifest.json": strToU8(
            JSON.stringify({
              version: 1,
              reason: "manual",
              createdAt: "2026-01-01T00:00:00.000Z",
              fileCount: 1,
              machine: "x",
            }),
          ),
          [bad]: strToU8("x"),
        }),
      );
      await expect(svc.importZip(zipPath)).rejects.toThrow("BACKUP_IMPORT_INVALID");
    }
    const backupsAfter = fs.existsSync(path.join(configDir, "backups"))
      ? fs.readdirSync(path.join(configDir, "backups"))
      : [];
    expect(backupsAfter.filter((n) => !n.endsWith(".zip"))).toEqual(backupsBefore);
    expect(fs.existsSync(path.join(configDir, "evil.txt"))).toBe(false);
  });

  it("rejects zips without a valid version-1 manifest", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir });
    const noManifest = path.join(configDir, "no-manifest.zip");
    fs.writeFileSync(noManifest, zipSync({ "opencode.json": strToU8("{}") }));
    await expect(svc.importZip(noManifest)).rejects.toThrow("BACKUP_IMPORT_INVALID");

    const badManifest = path.join(configDir, "bad-manifest.zip");
    fs.writeFileSync(badManifest, zipSync({ "manifest.json": strToU8('{"version":2}') }));
    await expect(svc.importZip(badManifest)).rejects.toThrow("BACKUP_IMPORT_INVALID");

    const notZip = path.join(configDir, "not-a-zip.zip");
    fs.writeFileSync(notZip, "this is not a zip file");
    await expect(svc.importZip(notZip)).rejects.toThrow("BACKUP_IMPORT_INVALID");
  });

  it("a foreign manifest reason downgrades to manual", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir });
    const zipPath = path.join(configDir, "foreign.zip");
    fs.writeFileSync(
      zipPath,
      zipSync({
        "manifest.json": strToU8(
          JSON.stringify({
            version: 1,
            reason: "weird-reason",
            createdAt: "2026-01-01T00:00:00.000Z",
            fileCount: 1,
            machine: "x",
          }),
        ),
        "opencode.json": strToU8("{}"),
      }),
    );
    const imported = await svc.importZip(zipPath);
    expect(imported.dirName.endsWith("-manual")).toBe(true);
  });

  it("exportZip guards dirName and unknown backups", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir });
    const zipPath = path.join(configDir, "x.zip");
    await expect(svc.exportZip("../escape", zipPath)).rejects.toThrow("INVALID_BACKUP_NAME");
    await expect(svc.exportZip("2026-01-01T00-00-00-000Z-manual", zipPath)).rejects.toThrow("BACKUP_NOT_FOUND");
  });
});

describe("BackupService zip import hardening", () => {
  const manifestEntry = {
    "manifest.json": strToU8(
      JSON.stringify({
        version: 1,
        reason: "manual",
        createdAt: "2026-01-01T00:00:00.000Z",
        fileCount: 2,
        machine: "x",
      }),
    ),
  };

  it("rejects a file/dir name collision with BACKUP_IMPORT_INVALID", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir });
    const zipPath = path.join(configDir, "collision.zip");
    fs.writeFileSync(zipPath, zipSync({ ...manifestEntry, a: strToU8("x"), "a/b": strToU8("y") }));
    await expect(svc.importZip(zipPath)).rejects.toThrow("BACKUP_IMPORT_INVALID");
    expect(fs.readdirSync(path.join(configDir, "backups")).filter((n) => !n.endsWith(".zip"))).toEqual([]);
  });

  it("downgrades prototype-chain reasons (constructor) to manual", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir });
    const zipPath = path.join(configDir, "ctor.zip");
    fs.writeFileSync(
      zipPath,
      zipSync({
        "manifest.json": strToU8(
          JSON.stringify({
            version: 1,
            reason: "constructor",
            createdAt: "2026-01-01T00:00:00.000Z",
            fileCount: 1,
            machine: "x",
          }),
        ),
        "opencode.json": strToU8("{}"),
      }),
    );
    const imported = await svc.importZip(zipPath);
    expect(imported.dirName.endsWith("-manual")).toBe(true);
  });

  it("rejects archives exceeding the entry cap before materializing them", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir });
    const many: Record<string, Uint8Array> = { ...manifestEntry };
    for (let i = 0; i < 20_001; i += 1) {
      many[`f${i}.txt`] = new Uint8Array(0);
    }
    const zipPath = path.join(configDir, "many.zip");
    fs.writeFileSync(zipPath, zipSync(many));
    await expect(svc.importZip(zipPath)).rejects.toThrow("BACKUP_IMPORT_INVALID");
    const backupsDir = path.join(configDir, "backups");
    const residue = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((n) => !n.endsWith(".zip")) : [];
    expect(residue).toEqual([]);
  });

  it("rejects an out-of-range createdAt (year > 9999) by falling back to now()", async () => {
    seedFullTree();
    const svc = new BackupService({
      configDir,
      now: () => new Date("2026-08-22T10:00:00.000Z"),
    });
    const zipPath = path.join(configDir, "future.zip");
    fs.writeFileSync(
      zipPath,
      zipSync({
        "manifest.json": strToU8(
          JSON.stringify({
            version: 1,
            reason: "manual",
            createdAt: "+100000-01-01T00:00:00Z",
            fileCount: 1,
            machine: "x",
          }),
        ),
        "opencode.json": strToU8("{}"),
      }),
    );
    const imported = await svc.importZip(zipPath);
    expect(imported.dirName).toBe("2026-08-22T10-00-00-000Z-manual");
  });
});

describe("BackupService lying-zip hardening", () => {
  type CraftedEntry = { name: string; data: Buffer; declaredOriginalSize: number; method?: 0 | 8 };

  /**
   * Minimal zip writer with per-entry originalSize control — fflate's zipSync always
   * writes honest central-directory headers, so hostile/truncated cases need raw bytes.
   * CRC32 is left zero (fflate's sync unzip path does not verify it).
   */
  function craftZip(items: CraftedEntry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const item of items) {
      const nameBuf = Buffer.from(item.name, "utf8");
      const method = item.method ?? 0;
      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(0x04034b50, 0);
      lfh.writeUInt16LE(20, 4);
      lfh.writeUInt16LE(0x0800, 6); // UTF-8 names
      lfh.writeUInt16LE(method, 8);
      lfh.writeUInt32LE(item.data.length, 18);
      lfh.writeUInt32LE(item.declaredOriginalSize, 22);
      lfh.writeUInt16LE(nameBuf.length, 26);
      locals.push(lfh, nameBuf, item.data);

      const cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(0x02014b50, 0);
      cdh.writeUInt16LE(20, 4);
      cdh.writeUInt16LE(20, 6);
      cdh.writeUInt16LE(0x0800, 8);
      cdh.writeUInt16LE(method, 10);
      cdh.writeUInt32LE(item.data.length, 20);
      cdh.writeUInt32LE(item.declaredOriginalSize, 24);
      cdh.writeUInt16LE(nameBuf.length, 28);
      cdh.writeUInt32LE(offset, 42);
      centrals.push(cdh, nameBuf);

      offset += 30 + nameBuf.length + item.data.length;
    }
    const central = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(items.length, 8);
    eocd.writeUInt16LE(items.length, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, central, eocd]);
  }

  const manifest = (createdAt = "2026-01-01T00:00:00.000Z"): CraftedEntry => {
    const data = Buffer.from(
      JSON.stringify({ version: 1, reason: "manual", createdAt, fileCount: 1, machine: "x" }),
      "utf8",
    );
    return { name: "manifest.json", data, declaredOriginalSize: data.length };
  };

  const honest = (entry: CraftedEntry): CraftedEntry => ({
    ...entry,
    declaredOriginalSize: entry.data.length,
  });

  it("rejects a stored entry whose materialized size differs from the declared originalSize", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir });
    const zipPath = path.join(configDir, "lying.zip");
    fs.writeFileSync(
      zipPath,
      craftZip([
        honest(manifest()),
        { name: "skills/blob.bin", data: Buffer.alloc(10, 0x41), declaredOriginalSize: 5 },
      ]),
    );
    await expect(svc.importZip(zipPath)).rejects.toThrow("BACKUP_IMPORT_INVALID");
  });

  it("rejects an honest-header zip bomb via the compression-ratio guard", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir });
    // 4MB of zeros deflate to ~4KB (~1022:1, near deflate's 1032:1 ceiling) — above
    // the 1000:1 cap while the declared 4MB stays under the 256MB total cap, so ONLY
    // the per-entry ratio guard fires here.
    const bomb = Buffer.alloc(4 * 1024 * 1024, 0);
    const zipPath = path.join(configDir, "bomb.zip");
    fs.writeFileSync(
      zipPath,
      craftZip([
        honest(manifest()),
        { name: "skills/bomb.bin", data: Buffer.from(deflateSync(bomb)), declaredOriginalSize: bomb.length, method: 8 },
      ]),
    );
    await expect(svc.importZip(zipPath)).rejects.toThrow("BACKUP_IMPORT_INVALID");
  });

  it("imports its own export of low-entropy files (zero-filled ~394:1) — the 1000:1 cap must not reject them", async () => {
    seedFullTree();
    // A 10KB zero-filled (sparse) file: ~394:1 under fflate level 6 — the exact shape
    // the old 200:1 cap false-rejected as "损坏" even though we exported it ourselves.
    const sparse = path.join(configDir, "skills", "sparse.bin");
    fs.writeFileSync(sparse, "");
    fs.truncateSync(sparse, 10 * 1024);
    const svc = new BackupService({ configDir, now: seqNow("2026-08-21T15:04:00.000Z") });
    const entry = svc.create("manual");
    const zipPath = path.join(configDir, "low-entropy.zip");
    await svc.exportZip(entry.dirName, zipPath);
    svc.remove(entry.dirName);

    const imported = await svc.importZip(zipPath);

    expect(fs.statSync(path.join(imported.dir, "skills", "sparse.bin")).size).toBe(10 * 1024);
  });

  it("rejects few-entry zips whose declared originalSize sum exceeds the total-bytes cap", async () => {
    seedFullTree();
    const svc = new BackupService({ configDir });
    // 300MB declared against a ~1.5MB stored payload is a 150:1 ratio — it passes the
    // per-entry ratio guard (200:1) but crosses the 256MB declared-total cap on the very
    // first filter call, so nothing is ever inflated into memory.
    const declared = 300 * 1024 * 1024;
    const zipPath = path.join(configDir, "sum-bomb.zip");
    fs.writeFileSync(
      zipPath,
      craftZip([
        honest(manifest()),
        { name: "skills/huge.bin", data: Buffer.alloc(declared / 200 + 1024), declaredOriginalSize: declared },
      ]),
    );
    await expect(svc.importZip(zipPath)).rejects.toThrow("BACKUP_IMPORT_INVALID");
    const backupsDir = path.join(configDir, "backups");
    const residue = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((n) => !n.endsWith(".zip")) : [];
    expect(residue).toEqual([]);
  });

  it("rejects a zip whose on-disk size exceeds the cap before reading any bytes", async () => {
    seedFullTree();
    const zipPath = path.join(configDir, "huge-on-disk.zip");
    fs.writeFileSync(zipPath, "placeholder");
    let reads = 0;
    const oversizedFs = {
      ...fs,
      statSync: (p: Parameters<typeof fs.statSync>[0]) => ({ ...fs.statSync(p), size: 256 * 1024 * 1024 + 1 }),
      readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
        reads += 1;
        return fs.readFileSync(...args);
      },
    } as typeof fs;
    const svc = new BackupService({ configDir, fs: oversizedFs });
    await expect(svc.importZip(zipPath)).rejects.toThrow("BACKUP_IMPORT_INVALID");
    expect(reads).toBe(0); // the statSync precheck fires before readFileSync of the archive
  });

  it("maps write-phase ENAMETOOLONG / ERR_INVALID_FILE_NAME to BACKUP_IMPORT_INVALID", async () => {
    seedFullTree();
    const zipPath = path.join(configDir, "ok.zip");
    fs.writeFileSync(
      zipPath,
      zipSync({
        "manifest.json": strToU8(
          JSON.stringify({
            version: 1,
            reason: "manual",
            createdAt: "2026-01-01T00:00:00.000Z",
            fileCount: 1,
            machine: "x",
          }),
        ),
        "opencode.json": strToU8("{}"),
      }),
    );
    for (const code of ["ENAMETOOLONG", "ERR_INVALID_FILE_NAME"] as const) {
      const denied = new Error(`${code}: boom`) as NodeJS.ErrnoException;
      denied.code = code;
      const failingFs = {
        ...fs,
        writeFileSync: () => {
          throw denied;
        },
      } as typeof fs;
      const svc = new BackupService({ configDir, fs: failingFs });
      await expect(svc.importZip(zipPath)).rejects.toThrow("BACKUP_IMPORT_INVALID");
    }
  });
});

describe("assertZipEntryName (static hardening)", () => {
  it("rejects path segments longer than 255 bytes on every platform", async () => {
    expect(() => assertZipEntryName(`dir/${"a".repeat(256)}.txt`, "linux")).toThrow("BACKUP_IMPORT_INVALID");
    expect(() => assertZipEntryName("b".repeat(255), "win32")).not.toThrow();
    expect(() => assertZipEntryName(`г/${"д".repeat(128)}`, "linux")).toThrow("BACKUP_IMPORT_INVALID"); // 256 bytes of 2-byte chars
  });

  it("rejects Windows reserved device names as segments on win32 only (any extension)", async () => {
    for (const evil of ["CON", "con.txt", "LPT1", "dir/Com7.md", "aux/skills"]) {
      expect(() => assertZipEntryName(evil, "win32")).toThrow("BACKUP_IMPORT_INVALID");
    }
    expect(() => assertZipEntryName("CON", "linux")).not.toThrow();
    expect(() => assertZipEntryName("console.txt", "win32")).not.toThrow();
    expect(() => assertZipEntryName("contact.md", "win32")).not.toThrow();
  });
});

describe("BackupService exportZip caps (symmetric with import)", () => {
  function craftBackupDir(extra: (dir: string) => void): string {
    const dirName = "2026-08-21T15-04-05-123Z-manual";
    const backupDir = path.join(configDir, "backups", dirName);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(
      path.join(backupDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        reason: "manual",
        createdAt: "2026-08-21T15:04:05.123Z",
        fileCount: 1,
        machine: "x",
      }),
    );
    extra(backupDir);
    return dirName;
  }

  it("refuses to export content over the total-bytes cap before building the zip", async () => {
    const dirName = craftBackupDir((backupDir) => {
      const blob = path.join(backupDir, "skills", "blob.bin");
      fs.mkdirSync(path.join(backupDir, "skills"));
      fs.writeFileSync(blob, "x");
      fs.truncateSync(blob, 256 * 1024 * 1024 + 1); // sparse — never actually read
    });
    const svc = new BackupService({ configDir });
    const out = path.join(configDir, "out.zip");
    await expect(svc.exportZip(dirName, out)).rejects.toThrow("BACKUP_EXPORT_TOO_LARGE");
    expect(fs.existsSync(out)).toBe(false);
  });

  it("refuses to export content over the entry cap before building the zip", async () => {
    const dirName = craftBackupDir((backupDir) => {
      for (let i = 0; i < 20_001; i += 1) {
        fs.writeFileSync(path.join(backupDir, `f${i}.txt`), "");
      }
    });
    const svc = new BackupService({ configDir });
    const out = path.join(configDir, "out.zip");
    await expect(svc.exportZip(dirName, out)).rejects.toThrow("BACKUP_EXPORT_TOO_LARGE");
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe("BackupService same-millisecond create collision", () => {
  it("create() negotiates a -N suffix instead of throwing ENOTEMPTY on rename", async () => {
    seedFullTree();
    const frozen = () => new Date("2026-08-21T15:04:05.123Z");
    const svc = new BackupService({ configDir, now: frozen });

    const first = svc.create("manual");
    const second = svc.create("manual");
    const third = svc.create("manual");

    expect(second.dirName).toBe(`${first.dirName}-1`);
    expect(third.dirName).toBe(`${first.dirName}-2`);
    for (const entry of [first, second, third]) {
      expect(fs.existsSync(entry.dir)).toBe(true);
      expect(fs.readFileSync(path.join(entry.dir, "opencode.json"), "utf8")).toBe('{"model":"glm"}');
    }
    expect(
      svc
        .list()
        .map((e) => e.dirName)
        .sort(),
    ).toEqual([first.dirName, second.dirName, third.dirName].sort());
  });
});

describe("BackupService.list resilience", () => {
  it("degrades to [] when the backups dir is unreadable (EACCES)", async () => {
    fs.mkdirSync(path.join(configDir, "backups"), { recursive: true });
    const denied = new Error("EACCES: permission denied, scandir") as NodeJS.ErrnoException;
    denied.code = "EACCES";
    const failingFs = {
      ...fs,
      readdirSync: () => {
        throw denied;
      },
    } as typeof fs;
    const svc = new BackupService({ configDir, fs: failingFs });
    expect(svc.list()).toEqual([]);
  });

  it("memoizes the manifest parse per dirName and re-reads only when mtime changes", async () => {
    seedFullTree();
    let manifestReads = 0;
    const countingFs = {
      ...fs,
      readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
        manifestReads += 1;
        return fs.readFileSync(...args);
      },
    } as typeof fs;
    const svc = new BackupService({
      configDir,
      now: seqNow("2026-08-21T15:04:00.000Z"),
      fs: countingFs,
    });
    svc.create("manual");
    expect(manifestReads).toBe(1); // create()'s publish check read (and warmed) it once
    svc.list();
    svc.list();
    expect(manifestReads).toBe(1); // both list() calls reused the cached parse

    const entry = svc.list()[0];
    fs.utimesSync(path.join(entry.dir, "manifest.json"), new Date(), new Date());
    svc.list();
    expect(manifestReads).toBe(2); // mtime bumped → re-read
  });
});
