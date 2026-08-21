import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BackupService } from "../../src/core/backupService";
import { ConfigStore } from "../../src/core/configStore";
import { applyEdits, getValue, JsoncSyntaxError, validate } from "../../src/core/jsoncEditor";
import { PresetService } from "../../src/core/presetService";

const FIXTURES_DIR = path.resolve(process.cwd(), "test/fixtures");

const AGENTS_MD_SEED = "# Global agents\n\nBaseline global agent instructions.\n";
const COMMAND_A_SEED = "# Command A\n\nSeed command payload.\n";
const SKILL_X_SEED = "# Skill one\n\nSeed skill instructions.\n";

const sandboxes: string[] = [];

interface PipelineEnv {
  configDir: string;
  presetsDir: string;
  backupsDir: string;
  opencodePath: string;
  ohMyPath: string;
  agentsMdPath: string;
  store: ConfigStore;
  backup: BackupService;
  service: PresetService;
}

interface EnvOptions {
  opencodeFixture?: string;
  now?: () => Date;
}

function makeEnv(opts: EnvOptions = {}): PipelineEnv {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-"));
  sandboxes.push(configDir);
  fs.copyFileSync(path.join(FIXTURES_DIR, opts.opencodeFixture ?? "opencode.jsonc"), path.join(configDir, "opencode.json"));
  fs.copyFileSync(path.join(FIXTURES_DIR, "oh-my-opencode.json"), path.join(configDir, "oh-my-opencode.json"));
  fs.writeFileSync(path.join(configDir, "AGENTS.md"), AGENTS_MD_SEED);
  fs.mkdirSync(path.join(configDir, "command"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "command", "a.md"), COMMAND_A_SEED);
  fs.mkdirSync(path.join(configDir, "skills", "one"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "skills", "one", "x.md"), SKILL_X_SEED);

  const store = new ConfigStore({ configDirOverride: configDir });
  const backup = new BackupService({
    configDir,
    hostname: "pipeline-test-host",
    ...(opts.now ? { now: opts.now } : {}),
  });
  const discovered = store.discover();
  const service = new PresetService({
    presetsDir: discovered.presetsDir,
    configStore: store,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return {
    configDir,
    presetsDir: discovered.presetsDir,
    backupsDir: discovered.backupsDir,
    opencodePath: discovered.opencodeJson,
    ohMyPath: discovered.ohMyOpencodeJson,
    agentsMdPath: path.join(configDir, "AGENTS.md"),
    store,
    backup,
    service,
  };
}

function seqNow(startIso: string, stepMs = 1000): () => Date {
  let t = Date.parse(startIso);
  return () => {
    const d = new Date(t);
    t += stepMs;
    return d;
  };
}

function readBytes(p: string): Buffer {
  return fs.readFileSync(p);
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("integration: core pipeline (capture → mutate → apply → backup → restore)", () => {
  it("scenario A: full lifecycle round-trip over one temp config dir", () => {
    const env = makeEnv({ now: seqNow("2026-08-21T10:00:00.000Z") });
    const fixtureOhMy = readBytes(path.join(FIXTURES_DIR, "oh-my-opencode.json"));
    const fixtureOpencode = readBytes(path.join(FIXTURES_DIR, "opencode.jsonc"));

    const captured = env.service.capture("baseline");
    expect(captured.defaults.model).toBeNull();

    const first = env.service.apply("baseline");
    expect(first.changes).toEqual([]);
    expect(readBytes(env.ohMyPath)).toEqual(fixtureOhMy);
    expect(readBytes(env.opencodePath)).toEqual(fixtureOpencode);

    const manual = env.backup.create("manual");
    expect(manual.manifest.reason).toBe("manual");

    const mutatedOhMy = applyEdits(readBytes(env.ohMyPath).toString("utf8"), [
      { path: ["agents", "oracle", "model"], value: "WindsurfAI/gpt-5.5", op: "set" },
      { path: ["agents", "foo"], value: { model: "WindsurfAI/gpt-5.4", variant: "low" }, op: "set" },
    ]);
    env.store.writeAtomic(env.ohMyPath, mutatedOhMy);
    fs.appendFileSync(env.agentsMdPath, "\njunk line appended by hand\n");
    fs.rmSync(path.join(env.configDir, "command", "a.md"));

    const second = env.service.apply("baseline");
    expect(second.changes).toEqual([
      {
        file: "oh-my-opencode.json",
        path: ["agents", "oracle", "model"],
        from: "WindsurfAI/gpt-5.5",
        to: "zhipuai-coding-plan/glm-5.2",
      },
    ]);

    const ohMyText = readBytes(env.ohMyPath).toString("utf8");
    expect(getValue(ohMyText, ["agents", "oracle", "model"])).toBe("zhipuai-coding-plan/glm-5.2");
    expect(getValue(ohMyText, ["agents", "foo", "model"])).toBe("WindsurfAI/gpt-5.4");
    expect(getValue(ohMyText, ["agents", "foo", "variant"])).toBe("low");
    expect(validate(ohMyText)).toEqual([]);

    const opencodeText = readBytes(env.opencodePath).toString("utf8");
    expect(getValue(opencodeText, ["model"])).toBeUndefined();
    expect(readBytes(env.opencodePath)).toEqual(fixtureOpencode);

    expect(readBytes(env.agentsMdPath).toString("utf8")).toContain("junk line appended by hand");
    expect(fs.existsSync(path.join(env.configDir, "command", "a.md"))).toBe(false);

    expect(env.backup.list()).toHaveLength(1);

    env.backup.restore(manual.dirName);

    expect(readBytes(env.ohMyPath)).toEqual(fixtureOhMy);
    expect(readBytes(env.agentsMdPath)).toEqual(Buffer.from(AGENTS_MD_SEED, "utf8"));
    expect(readBytes(path.join(env.configDir, "command", "a.md"))).toEqual(Buffer.from(COMMAND_A_SEED, "utf8"));
    expect(readBytes(path.join(env.configDir, "skills", "one", "x.md"))).toEqual(Buffer.from(SKILL_X_SEED, "utf8"));

    expect(env.backup.list()).toHaveLength(1);
  });

  it("scenario B: comments, tabs and trailing commas survive set/clear of defaults.model", () => {
    const env = makeEnv({ opencodeFixture: "opencode.comments.jsonc" });
    const captured = env.service.capture("commented");
    expect(captured.defaults.model).toBeNull();

    const originalText = readBytes(env.opencodePath).toString("utf8");
    const commentLines = originalText.split("\n").filter((line) => line.trimStart().startsWith("//"));
    expect(commentLines.length).toBeGreaterThanOrEqual(2);

    const setModel = { ...captured, name: "commented-glm5", defaults: { model: "zhipuai-coding-plan/glm-5" } };
    env.service.save(setModel);
    env.service.apply("commented-glm5");

    const appliedText = readBytes(env.opencodePath).toString("utf8");
    expect(getValue(appliedText, ["model"])).toBe("zhipuai-coding-plan/glm-5");
    expect(validate(appliedText)).toEqual([]);
    const appliedLines = appliedText.split("\n");
    for (const line of commentLines) {
      expect(appliedLines).toContain(line);
    }

    const clearModel = { ...captured, name: "commented-clear", defaults: { model: null } };
    env.service.save(clearModel);
    env.service.apply("commented-clear");

    const clearedText = readBytes(env.opencodePath).toString("utf8");
    expect(getValue(clearedText, ["model"])).toBeUndefined();
    expect(validate(clearedText)).toEqual([]);
    const clearedLines = clearedText.split("\n");
    for (const line of commentLines) {
      expect(clearedLines).toContain(line);
    }
  });

  it("scenario C: applies create no backups; manual backups are never pruned", () => {
    const env = makeEnv({ now: seqNow("2026-08-21T11:00:00.000Z") });
    env.service.capture("keep");

    for (let i = 0; i < 5; i++) {
      env.service.apply("keep");
    }
    expect(env.backup.list()).toEqual([]);
    expect(fs.existsSync(env.backupsDir)).toBe(false);

    const manualNames: string[] = [];
    for (let i = 0; i < 5; i++) {
      manualNames.push(env.backup.create("manual").dirName);
    }

    expect(env.backup.list().map((e) => e.dirName)).toEqual([...manualNames].reverse());
    expect(env.backup.prune()).toEqual([]);
    expect(fs.readdirSync(env.backupsDir).sort()).toEqual([...manualNames].sort());
  });

  it("scenario D: apply on a corrupted oh-my-opencode.json throws, keeps bytes, creates no backups", () => {
    const env = makeEnv({ now: seqNow("2026-08-21T12:00:00.000Z") });
    env.service.capture("snap");

    fs.writeFileSync(env.ohMyPath, "{ broken");
    const ohMyBefore = readBytes(env.ohMyPath);
    const opencodeBefore = readBytes(env.opencodePath);

    expect(() => env.service.apply("snap")).toThrow(JsoncSyntaxError);

    expect(readBytes(env.ohMyPath)).toEqual(ohMyBefore);
    expect(readBytes(env.opencodePath)).toEqual(opencodeBefore);

    expect(env.backup.list()).toEqual([]);

    expect(env.service.load("snap").appliedAt).toBeNull();
  });
});
