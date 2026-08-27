import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BackupService } from "../../src/core/backupService";
import { updateLocalModelsFromCatalog } from "../../src/core/builtinModels";
import { ConfigStore } from "../../src/core/configStore";
import { applyEdits, getValue, JsoncSyntaxError, validate } from "../../src/core/jsoncEditor";
import { PresetService } from "../../src/core/presetService";
import type { ModelOption } from "../../src/core/types";

const FIXTURES_DIR = path.resolve(process.cwd(), "test/fixtures");

const AGENTS_MD_SEED = "# Global agents\n\nBaseline global agent instructions.\n";
const COMMAND_A_SEED = "# Command A\n\nSeed command payload.\n";
const SKILL_X_SEED = "# Skill one\n\nSeed skill instructions.\n";

const sandboxes: string[] = [];

interface PipelineEnv {
  configDir: string;
  homeDir: string;
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
  fs.copyFileSync(
    path.join(FIXTURES_DIR, opts.opencodeFixture ?? "opencode.jsonc"),
    path.join(configDir, "opencode.json"),
  );
  fs.copyFileSync(path.join(FIXTURES_DIR, "oh-my-opencode.json"), path.join(configDir, "oh-my-opencode.json"));
  fs.writeFileSync(path.join(configDir, "AGENTS.md"), AGENTS_MD_SEED);
  fs.mkdirSync(path.join(configDir, "command"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "command", "a.md"), COMMAND_A_SEED);
  fs.mkdirSync(path.join(configDir, "skills", "one"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "skills", "one", "x.md"), SKILL_X_SEED);
  fs.mkdirSync(path.join(configDir, "presets"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "presets", "seeded.json"), '{"name":"seeded"}');

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-home-"));
  sandboxes.push(homeDir);
  const store = new ConfigStore({ configDirOverride: configDir, homeDir });
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
    homeDir,
    presetsDir: discovered.presetsDir,
    backupsDir: discovered.backupsDir,
    opencodePath: discovered.opencodeJson,
    ohMyPath: discovered.agentConfig.path,
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
  it("scenario A: full lifecycle round-trip over one temp config dir", async () => {
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
    fs.rmSync(path.join(env.configDir, "presets", "seeded.json"));

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
    expect(readBytes(path.join(env.configDir, "presets", "seeded.json"))).toEqual(
      Buffer.from('{"name":"seeded"}', "utf8"),
    );

    expect(env.backup.list()).toHaveLength(1);
  });

  it("scenario B: comments, tabs and trailing commas survive set/clear of defaults.model", async () => {
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

  it("scenario C: applies create no backups; manual backups are never pruned", async () => {
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

  it("scenario D: apply on a corrupted oh-my-opencode.json throws, keeps bytes, creates no backups", async () => {
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

  it("scenario E: omo machine — preset lifecycle targets ~/.omo/omo.jsonc end to end", async () => {
    const env = makeEnv({ now: seqNow("2026-08-22T10:00:00.000Z") });
    fs.rmSync(env.ohMyPath);
    const omoPath = path.join(env.homeDir, ".omo", "omo.jsonc");
    fs.mkdirSync(path.dirname(omoPath), { recursive: true });
    fs.writeFileSync(
      omoPath,
      '{\n  "[opencode]": {\n    "agents": {\n      "oracle": { "model": "old/old", "reasoning": "low" }\n    },\n    "categories": {}\n  }\n}\n',
    );
    const backup = new BackupService({
      configDir: env.configDir,
      hostname: "pipeline-test-host",
      managedFiles: [env.opencodePath, omoPath, env.agentsMdPath],
    });

    const captured = env.service.capture("omo-base");
    expect(captured.agents.oracle).toEqual({ model: "old/old", variant: "low" });

    const drifted = applyEdits(fs.readFileSync(omoPath, "utf8"), [
      { path: ["[opencode]", "agents", "oracle", "model"], value: "x/drifted", op: "set" },
    ]);
    env.store.writeAtomic(omoPath, drifted);

    const applied = env.service.apply("omo-base");
    expect(applied.changes).toEqual([
      {
        file: "omo.jsonc",
        path: ["[opencode]", "agents", "oracle", "model"],
        from: "x/drifted",
        to: "old/old",
      },
    ]);
    const appliedText = fs.readFileSync(omoPath, "utf8");
    expect(getValue(appliedText, ["[opencode]", "agents", "oracle", "reasoning"])).toBe("low");
    expect(fs.existsSync(env.ohMyPath)).toBe(false);

    const manual = backup.create("manual");
    expect(fs.existsSync(path.join(manual.dir, "omo.jsonc"))).toBe(true);

    env.store.writeAtomic(
      omoPath,
      applyEdits(appliedText, [{ path: ["[opencode]", "agents", "oracle", "model"], value: "y/mutated", op: "set" }]),
    );
    const pairs = backup.diffPairs(manual);
    expect(pairs.map((p) => p.label)).toContain("omo.jsonc");
    expect(pairs.find((p) => p.label === "omo.jsonc")?.current).toBe(omoPath);

    backup.restore(manual.dirName);
    expect(fs.readFileSync(omoPath, "utf8")).toBe(appliedText);
  });

  it("scenario F: home-level skills (~/.agents/skills) round-trip via extraDirs, project skills untouched", async () => {
    const env = makeEnv({ now: seqNow("2026-08-22T12:00:00.000Z") });
    const userSkillsDir = env.store.userSkillsDir;
    expect(userSkillsDir).toBe(path.join(env.homeDir, ".agents", "skills"));
    fs.mkdirSync(path.join(userSkillsDir, "pdf"), { recursive: true });
    fs.writeFileSync(path.join(userSkillsDir, "pdf", "SKILL.md"), "# user pdf skill\n");
    const discovered = env.store.discover();
    const userLocation = discovered.skillLocations.find((l) => l.dir === userSkillsDir);
    expect(userLocation?.scope).toBe("global");
    expect(userLocation?.label).toBe("~/.agents/skills");
    expect(userLocation?.skillNames).toEqual(["pdf"]);

    // Mirrors the extension.ts wiring: user skills ride along via extraDirs.
    const backup = new BackupService({
      configDir: env.configDir,
      hostname: "pipeline-test-host",
      now: seqNow("2026-08-22T12:30:00.000Z"),
      extraDirs: [{ label: "skills-user", src: userSkillsDir }],
    });
    const snap = backup.create("manual");
    expect(fs.readFileSync(path.join(snap.dir, "skills-user", "pdf", "SKILL.md"), "utf8")).toBe("# user pdf skill\n");

    fs.writeFileSync(path.join(userSkillsDir, "pdf", "SKILL.md"), "# vandalized\n");
    fs.rmSync(path.join(env.configDir, "skills", "one", "x.md"));

    backup.restore(snap.dirName);
    expect(fs.readFileSync(path.join(userSkillsDir, "pdf", "SKILL.md"), "utf8")).toBe("# user pdf skill\n");
    expect(readBytes(path.join(env.configDir, "skills", "one", "x.md"))).toEqual(Buffer.from(SKILL_X_SEED, "utf8"));
  });

  it("scenario G: models.json is never seeded implicitly; corrupt files degrade with a one-time .bak, and a catalog update rebuilds", async () => {
    const env = makeEnv({ now: seqNow("2026-08-23T09:00:00.000Z") });
    const modelsFile = path.join(env.configDir, "models.json");
    expect(fs.existsSync(modelsFile)).toBe(false);

    // Reading the model list writes nothing — the network is the catalog's source of truth.
    const before = env.store.listModels();
    expect(before.length).toBeGreaterThan(0); // opencode.json fixture models only
    expect(fs.existsSync(modelsFile)).toBe(false);

    const userBytes = '{ "models": "gone wrong", "note": "hand edit" }\n';
    fs.writeFileSync(modelsFile, userBytes);
    const degraded = env.store.listModels();
    expect(degraded).toEqual(before); // local catalog contributes nothing
    expect(fs.readFileSync(modelsFile, "utf8")).toBe(userBytes); // untouched
    expect(fs.readFileSync(`${modelsFile}.bak`, "utf8")).toBe(userBytes); // backed up once

    // A network-style update rebuilds the file from the fetched catalog.
    const fetched = new Map<string, ModelOption[]>([
      ["deepseek", [{ id: "deepseek/deepseek-v4", provider: "deepseek", model: "deepseek-v4", label: "DeepSeek V4" }]],
    ]);
    const result = updateLocalModelsFromCatalog(env.configDir, fetched, new Set());
    expect(result.addedIds).toEqual(["deepseek/deepseek-v4"]);
    expect(JSON.parse(fs.readFileSync(modelsFile, "utf8")).models).toEqual([
      { provider: "deepseek", model: "deepseek-v4", label: "DeepSeek V4" },
    ]);
    expect(fs.readFileSync(`${modelsFile}.bak`, "utf8")).toBe(userBytes); // original preserved
  });

  it("scenario H: backup → exportZip → wipe machine → importZip → restore is byte-identical", async () => {
    const env = makeEnv({ now: seqNow("2026-08-23T10:00:00.000Z") });
    env.service.capture("handcuff");
    fs.appendFileSync(env.agentsMdPath, "\nhand-added line\n");
    const entry = env.backup.create("manual");
    const originalOhMy = readBytes(env.ohMyPath);
    const originalOpencode = readBytes(env.opencodePath);
    const originalAgentsMd = readBytes(env.agentsMdPath);
    const originalCommandA = readBytes(path.join(env.configDir, "command", "a.md"));

    const zipPath = path.join(env.configDir, "portable.zip");
    await env.backup.exportZip(entry.dirName, zipPath);
    expect(fs.existsSync(zipPath)).toBe(true);

    fs.rmSync(entry.dir, { recursive: true, force: true });
    fs.writeFileSync(env.ohMyPath, '{"agents":{}}');
    fs.writeFileSync(env.opencodePath, "{}");
    fs.writeFileSync(env.agentsMdPath, "# wiped");
    fs.rmSync(path.join(env.configDir, "command", "a.md"));

    const imported = await env.backup.importZip(zipPath);
    env.backup.restore(imported.dirName);

    expect(readBytes(env.ohMyPath)).toEqual(originalOhMy);
    expect(readBytes(env.opencodePath)).toEqual(originalOpencode);
    expect(readBytes(env.agentsMdPath)).toEqual(originalAgentsMd);
    expect(readBytes(path.join(env.configDir, "command", "a.md"))).toEqual(originalCommandA);
  });
});
