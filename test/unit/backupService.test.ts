import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BackupService,
  DEFAULT_RETENTION,
  isoFs,
} from "../../src/core/backupService";

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
  fs.writeFileSync(
    path.join(configDir, "oh-my-opencode.json"),
    '{"agents":{}}'
  );
  fs.writeFileSync(path.join(configDir, "AGENTS.md"), "# AGENTS\n");
  fs.mkdirSync(path.join(configDir, "command", "sub"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "command", "a.md"), "a");
  fs.writeFileSync(path.join(configDir, "command", "sub", "b.md"), "b");
  fs.mkdirSync(path.join(configDir, "skills", "one"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "skills", "one", "x.md"), "x");
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
  it("formats an ISO timestamp with colons/dots replaced by dashes (fs-safe)", () => {
    expect(isoFs(new Date("2026-08-21T15:04:05.123Z"))).toBe(
      "2026-08-21T15-04-05-123Z"
    );
  });
});

describe("DEFAULT_RETENTION (frozen contract)", () => {
  it("manual is infinite (null), auto reasons keep 20", () => {
    expect(DEFAULT_RETENTION).toEqual({
      manual: null,
      "pre-apply": 20,
      "pre-save": 20,
      "pre-restore": 20,
    });
  });
});

describe("BackupService.create", () => {
  it("snapshots the full managed tree and writes an exact manifest (manual)", () => {
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
    expect(fs.readFileSync(path.join(entry.dir, "opencode.json"), "utf8")).toBe(
      '{"model":"glm"}'
    );
    expect(
      fs.readFileSync(path.join(entry.dir, "oh-my-opencode.json"), "utf8")
    ).toBe('{"agents":{}}');
    expect(fs.readFileSync(path.join(entry.dir, "AGENTS.md"), "utf8")).toBe(
      "# AGENTS\n"
    );
    expect(
      fs.readFileSync(path.join(entry.dir, "command", "a.md"), "utf8")
    ).toBe("a");
    expect(
      fs.readFileSync(path.join(entry.dir, "command", "sub", "b.md"), "utf8")
    ).toBe("b");
    expect(
      fs.readFileSync(path.join(entry.dir, "skills", "one", "x.md"), "utf8")
    ).toBe("x");

    // manifest fields exact
    expect(entry.manifest.version).toBe(1);
    expect(entry.manifest.reason).toBe("manual");
    expect(entry.manifest.preset).toBe("heavy");
    expect(entry.manifest.fileCount).toBe(6);
    expect(entry.manifest.machine).toBe("test-host");
    expect(entry.manifest.createdAt).toBe("2026-08-21T15:04:05.123Z");
    expect(() => Date.parse(entry.manifest.createdAt)).not.toBeNull();

    // manifest.json persisted on disk matches the returned entry
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(entry.dir, "manifest.json"), "utf8")
    );
    expect(onDisk).toEqual(entry.manifest);
  });

  it("copies only existing sources on a partially-seeded tree (no command/, no skills/)", () => {
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

describe("BackupService.list / remove", () => {
  it("lists sorted by dirName DESC (newest first) and remove() deletes the dir", () => {
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

  it("returns [] when the backups dir does not exist", () => {
    const svc = new BackupService({ configDir });
    expect(svc.list()).toEqual([]);
  });
});

describe("BackupService.prune", () => {
  it("keeps newest N for a reason, removes and returns exactly the oldest excess (25 created, retention 20 → 5 removed)", () => {
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
    expect(
      fs.existsSync(path.join(configDir, "backups", created[24]))
    ).toBe(true);
  });

  it("manual backups survive prune() with no args; retention null for manual honored", () => {
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
    expect(
      removed.every((e) => e.manifest.reason !== "manual")
    ).toBe(true);
    const remaining = svc.list();
    // manual (null retention) fully survives; newest 2 pre-save kept per retention
    expect(remaining.filter((e) => e.manifest.reason === "manual").map((e) => e.dirName).sort()).toEqual(
      [...manualNames].sort()
    );
    expect(remaining.filter((e) => e.manifest.reason === "pre-save")).toHaveLength(2);
  });

  it("create() auto-prunes its own reason down to the retention limit", () => {
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
  it("round-trips: safety pre-restore backup captures mutated state, then backup is restored byte-identical", () => {
    seedFullTree();
    const svc = new BackupService({
      configDir,
      now: seqNow("2026-08-21T15:04:00.000Z"),
    });
    const snap = svc.create("manual");
    const original = fs.readFileSync(
      path.join(configDir, "opencode.json"),
      "utf8"
    );

    // mutate: append garbage + delete command/a.md
    fs.appendFileSync(path.join(configDir, "opencode.json"), "\n//garbage");
    fs.rmSync(path.join(configDir, "command", "a.md"));

    const { preRestore } = svc.restore(snap.dirName);

    // config restored byte-identical, deleted file back
    expect(fs.readFileSync(path.join(configDir, "opencode.json"), "utf8")).toBe(
      original
    );
    expect(
      fs.readFileSync(path.join(configDir, "command", "a.md"), "utf8")
    ).toBe("a");
    expect(
      fs.readFileSync(path.join(configDir, "command", "sub", "b.md"), "utf8")
    ).toBe("b");

    // a *-pre-restore-* backup exists and equals the mutated state
    expect(preRestore.dirName).toMatch(/-pre-restore$/);
    expect(preRestore.manifest.reason).toBe("pre-restore");
    expect(
      fs.readFileSync(path.join(preRestore.dir, "opencode.json"), "utf8")
    ).toBe(original + "\n//garbage");
    expect(fs.existsSync(path.join(preRestore.dir, "command", "a.md"))).toBe(
      false
    );
    expect(preRestore.manifest.fileCount).toBe(5); // 3 top-level + sub/b.md + skills/one/x.md
  });
});

describe("BackupService.diffPairs", () => {
  it("returns exactly the pairs where both backup and current sides exist", () => {
    seedFullTree();
    const svc = new BackupService({
      configDir,
      now: () => new Date("2026-08-21T15:04:05.123Z"),
    });
    const entry = svc.create("manual");

    // full tree → 3 pairs
    let pairs = svc.diffPairs(entry);
    expect(pairs.map((p) => p.label).sort()).toEqual([
      "AGENTS.md",
      "oh-my-opencode.json",
      "opencode.json",
    ]);
    for (const p of pairs) {
      expect(p.backup).toBe(path.join(entry.dir, p.label));
      expect(p.current).toBe(path.join(configDir, p.label));
      expect(fs.existsSync(p.backup)).toBe(true);
      expect(fs.existsSync(p.current)).toBe(true);
    }

    // AGENTS.md gone from current → only 2 pairs
    fs.rmSync(path.join(configDir, "AGENTS.md"));
    pairs = svc.diffPairs(entry);
    expect(pairs.map((p) => p.label).sort()).toEqual([
      "oh-my-opencode.json",
      "opencode.json",
    ]);
  });
});
