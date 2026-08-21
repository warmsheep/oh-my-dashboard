import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigStore } from "../../src/core/configStore";
import { BackupService } from "../../src/core/backupService";
import { PresetService } from "../../src/core/presetService";
import { applyEdits, getValue, validate } from "../../src/core/jsoncEditor";
import type { Preset } from "../../src/core/types";

const FIXTURES_DIR = path.resolve(process.cwd(), "test/fixtures");

// All tests run against throwaway sandboxes — NEVER the real ~/.config/opencode.
const sandboxes: string[] = [];

interface Env {
  configDir: string;
  homeDir: string;
  presetsDir: string;
  opencodePath: string;
  ohMyPath: string;
  store: ConfigStore;
  backup: BackupService;
  service: PresetService;
}

/** Full-fidelity environment: REAL ConfigStore + REAL BackupService over a temp config dir seeded from fixtures. */
function makeEnv(now?: () => Date): Env {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-"));
  sandboxes.push(configDir);
  fs.copyFileSync(path.join(FIXTURES_DIR, "opencode.jsonc"), path.join(configDir, "opencode.json"));
  fs.copyFileSync(path.join(FIXTURES_DIR, "oh-my-opencode.json"), path.join(configDir, "oh-my-opencode.json"));

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-home-"));
  sandboxes.push(homeDir);
  const store = new ConfigStore({ configDirOverride: configDir, homeDir });
  const backup = new BackupService({
    configDir,
    hostname: "test-host",
    ...(now ? { now } : {}),
  });
  const discovered = store.discover();
  const service = new PresetService({
    presetsDir: discovered.presetsDir,
    configStore: store,
    ...(now ? { now } : {}),
  });
  return {
    configDir,
    homeDir,
    presetsDir: discovered.presetsDir,
    opencodePath: discovered.opencodeJson,
    ohMyPath: discovered.ohMyOpencodeJson,
    store,
    backup,
    service,
  };
}

/** Deterministic clock: each call advances by stepMs, producing distinct stamps. */
function seqNow(startIso: string, stepMs = 1000): () => Date {
  let t = Date.parse(startIso);
  return () => {
    const d = new Date(t);
    t += stepMs;
    return d;
  };
}

function readOhMy(env: Env): string {
  return fs.readFileSync(env.ohMyPath, "utf8");
}

function readOpencode(env: Env): string {
  return fs.readFileSync(env.opencodePath, "utf8");
}

const OMO_SEED = `// unified omo config
{
  "[opencode]": {
    "agents": {
      "oracle": { "model": "old/old", "variant": "low" },
      "explore": { "models": [{ "model": "a/b", "reasoning": "max" }, { "model": "c/d" }] },
      "librarian": { "model": "keep/keep", "reasoning": "high" },
    },
    "categories": {},
  },
}
`;

function seedOmoMachine(env: Env): Env {
  fs.rmSync(env.ohMyPath);
  fs.mkdirSync(path.join(env.homeDir, ".omo"), { recursive: true });
  fs.writeFileSync(path.join(env.homeDir, ".omo", "omo.jsonc"), OMO_SEED);
  return env;
}

function readOmo(env: Env): string {
  return fs.readFileSync(path.join(env.homeDir, ".omo", "omo.jsonc"), "utf8");
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("PresetService.capture", () => {
  it("captures the full fixture state: 10 agents, 13 categories, cleaned settings, null default model, persisted on disk", () => {
    const env = makeEnv(() => new Date("2026-08-21T15:04:05.123Z"));

    const preset = env.service.capture("e2e");

    expect(Object.keys(preset.agents)).toHaveLength(10);
    expect(Object.keys(preset.categories)).toHaveLength(13);
    expect(preset.agents.oracle?.model).toBe("zhipuai-coding-plan/glm-5.2");
    expect(preset.agents.oracle?.variant).toBe("high");
    expect(preset.defaults.model).toBeNull(); // fixture has no top-level model
    expect(preset.createdAt).toBe("2026-08-21T15:04:05.123Z");
    expect(preset.appliedAt).toBeNull();

    // cleaning: extra fixture keys (description / prompt_append) are dropped, variant kept only when present
    expect(Object.keys(preset.categories.architect)).toEqual(["model", "variant"]);
    expect(Object.keys(preset.agents.librarian)).toEqual(["model"]);
    expect(JSON.stringify(preset)).not.toContain("prompt_append");

    // persisted on disk with a trailing newline
    const file = path.join(env.presetsDir, "e2e.json");
    expect(fs.existsSync(file)).toBe(true);
    const raw = fs.readFileSync(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw).name).toBe("e2e");
  });
});

describe("PresetService.save / load / exists", () => {
  it("round-trips all fields; rejects invalid names; load/exists on missing preset", () => {
    const env = makeEnv();
    const preset: Preset = {
      name: "full",
      description: "round trip",
      createdAt: "2026-01-01T00:00:00.000Z",
      appliedAt: "2026-02-02T00:00:00.000Z",
      defaults: { model: "p/m" },
      agents: { oracle: { model: "a/b", variant: "high" }, atlas: { model: "c/d" } },
      categories: { quick: { model: "e/f" } },
    };

    env.service.save(preset);
    expect(env.service.load("full")).toEqual(preset);
    expect(env.service.exists("full")).toBe(true);
    expect(env.service.exists("missing")).toBe(false);

    expect(() => env.service.save({ ...preset, name: "a/b" })).toThrow("INVALID_PRESET_NAME");
    expect(() => env.service.save({ ...preset, name: "" })).toThrow("INVALID_PRESET_NAME");
    expect(() => env.service.save({ ...preset, name: "x".repeat(65) })).toThrow("INVALID_PRESET_NAME");
    expect(() => env.service.load("missing")).toThrow("PRESET_NOT_FOUND");
  });
});

describe("PresetService.list", () => {
  it("returns presets sorted by name and silently skips invalid entries", () => {
    const env = makeEnv();
    env.service.capture("zeta");
    env.service.capture("alpha");
    env.service.capture("mid");
    fs.writeFileSync(path.join(env.presetsDir, "broken.json"), "{not json");
    fs.writeFileSync(path.join(env.presetsDir, "notes.txt"), "not a preset");

    const list = env.service.list();
    expect(list.map((p) => p.name)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("returns [] when the presets dir does not exist", () => {
    const env = makeEnv();
    expect(env.service.list()).toEqual([]);
  });
});

describe("PresetService.apply — merge semantics", () => {
  it("restores drifted values but never touches keys absent from the preset, reporting exact changes", () => {
    const env = makeEnv();
    env.service.capture("snap");

    // drift: change oracle model + add an EXTRA agent not present in the preset
    const drifted = applyEdits(readOhMy(env), [
      { path: ["agents", "oracle", "model"], value: "WindsurfAI/gpt-5.5", op: "set" },
      { path: ["agents", "foo"], value: { model: "WindsurfAI/gpt-5.4", variant: "low" }, op: "set" },
    ]);
    env.store.writeAtomic(env.ohMyPath, drifted);

    const result = env.service.apply("snap");

    const text = readOhMy(env);
    expect(getValue(text, ["agents", "oracle", "model"])).toBe("zhipuai-coding-plan/glm-5.2");
    // extra agent untouched (byte-level via getValue)
    expect(getValue(text, ["agents", "foo", "model"])).toBe("WindsurfAI/gpt-5.4");
    expect(getValue(text, ["agents", "foo", "variant"])).toBe("low");
    expect(validate(text)).toEqual([]);

    // exactly one actual change: the drifted oracle model
    expect(result.changes).toEqual([
      {
        file: "oh-my-opencode.json",
        path: ["agents", "oracle", "model"],
        from: "WindsurfAI/gpt-5.5",
        to: "zhipuai-coding-plan/glm-5.2",
      },
    ]);
  });

  it("variant merge: preset without variant REMOVES it from config; preset with variant restores it", () => {
    const env = makeEnv();
    const withVariant = env.service.capture("with-variant");
    const noVariant: Preset = {
      ...withVariant,
      name: "no-variant",
      agents: { ...withVariant.agents, oracle: { model: withVariant.agents.oracle.model } },
    };
    env.service.save(noVariant);

    // fixture config has oracle.variant 'high'; applying a preset without it removes the key
    const r1 = env.service.apply("no-variant");
    expect(getValue(readOhMy(env), ["agents", "oracle", "variant"])).toBeUndefined();
    expect(r1.changes).toContainEqual({
      file: "oh-my-opencode.json",
      path: ["agents", "oracle", "variant"],
      from: "high",
      to: "<<removed>>",
    });

    // applying the preset that still carries the variant sets it again
    env.service.apply("with-variant");
    expect(getValue(readOhMy(env), ["agents", "oracle", "variant"])).toBe("high");
  });

  it("defaults.model: inserted at 2-space style when absent, removed again when null", () => {
    const env = makeEnv();
    const setModel: Preset = {
      ...env.service.capture("setmodel"),
      defaults: { model: "zhipuai-coding-plan/glm-5" },
    };
    env.service.save(setModel);

    const r1 = env.service.apply("setmodel");
    const text1 = readOpencode(env);
    expect(getValue(text1, ["model"])).toBe("zhipuai-coding-plan/glm-5");
    expect(validate(text1)).toEqual([]);
    expect(text1).toMatch(/^\s{2}"model":/m);
    expect(r1.changes).toContainEqual({
      file: "opencode.json",
      path: ["model"],
      from: undefined,
      to: "zhipuai-coding-plan/glm-5",
    });
    // rest of the (JSONC, trailing-comma) fixture survives the edit
    expect(getValue(text1, ["provider", "zhipuai-coding-plan", "models", "glm-5"])).toBeDefined();

    const clearModel: Preset = {
      ...env.service.capture("nomodel"),
      defaults: { model: null },
    };
    env.service.save(clearModel);
    env.service.apply("nomodel");

    const text2 = readOpencode(env);
    expect(getValue(text2, ["model"])).toBeUndefined();
    expect(validate(text2)).toEqual([]);
  });
});

describe("PresetService.apply — bookkeeping", () => {
  it("stamps appliedAt, persists it, and creates NO backups (manual backups only)", () => {
    const startMs = Date.parse("2026-08-21T15:04:00.000Z");
    const env = makeEnv(seqNow("2026-08-21T15:04:00.000Z"));
    env.service.capture("snap");

    env.store.writeAtomic(
      env.ohMyPath,
      applyEdits(readOhMy(env), [
        { path: ["agents", "oracle", "model"], value: "minimax-cn-coding-plan/MiniMax-M2.5", op: "set" },
      ]),
    );

    const result = env.service.apply("snap");

    expect(env.backup.list()).toEqual([]);
    expect(fs.existsSync(path.join(env.configDir, "backups"))).toBe(false);

    // appliedAt stamped with the fake clock (>= start) both in the result and on disk
    expect(Date.parse(result.preset.appliedAt ?? "")).toBeGreaterThanOrEqual(startMs);
    const persisted = env.service.load("snap");
    expect(Date.parse(persisted.appliedAt ?? "")).toBeGreaterThanOrEqual(startMs);

    // changes report the exact drift
    expect(result.changes).toEqual([
      {
        file: "oh-my-opencode.json",
        path: ["agents", "oracle", "model"],
        from: "minimax-cn-coding-plan/MiniMax-M2.5",
        to: "zhipuai-coding-plan/glm-5.2",
      },
    ]);
  });
});

describe("PresetService.apply — failure modes", () => {
  it("throws PRESET_NOT_FOUND when the preset does not exist", () => {
    const env = makeEnv();
    expect(() => env.service.apply("ghost")).toThrow("PRESET_NOT_FOUND");
  });

  it("throws on an unparsable oh-my file and leaves config bytes untouched", () => {
    const env = makeEnv();
    env.service.capture("snap");

    env.store.writeAtomic(env.ohMyPath, '{"agents": tr|ailing garbage');
    const ohMyBefore = fs.readFileSync(env.ohMyPath);
    const opencodeBefore = fs.readFileSync(env.opencodePath);

    expect(() => env.service.apply("snap")).toThrow();
    expect(fs.readFileSync(env.ohMyPath)).toEqual(ohMyBefore);
    expect(fs.readFileSync(env.opencodePath)).toEqual(opencodeBefore);
  });
});

describe("PresetService.rename / remove / exportTo", () => {
  it("rename moves the file preserving data; remove deletes; exportTo writes identical bytes", () => {
    const env = makeEnv();
    const preset = env.service.capture("alpha");

    env.service.rename("alpha", "beta");
    expect(env.service.exists("alpha")).toBe(false);
    expect(env.service.exists("beta")).toBe(true);
    expect(env.service.load("beta")).toEqual({ ...preset, name: "beta" });

    const target = path.join(env.configDir, "exported.json");
    env.service.exportTo("beta", target);
    expect(fs.readFileSync(target)).toEqual(fs.readFileSync(path.join(env.presetsDir, "beta.json")));

    env.service.remove("beta");
    expect(env.service.exists("beta")).toBe(false);
    expect(() => env.service.remove("beta")).toThrow("PRESET_NOT_FOUND");
    expect(() => env.service.rename("nope", "x")).toThrow("PRESET_NOT_FOUND");
  });
});

describe("PresetService.currentPresetName", () => {
  it("returns null when nothing was applied; returns the preset with the latest appliedAt", () => {
    const env = makeEnv(seqNow("2026-08-21T15:04:00.000Z"));
    expect(env.service.currentPresetName()).toBeNull();

    env.service.capture("a");
    env.service.capture("b");
    expect(env.service.currentPresetName()).toBeNull(); // captured but never applied

    env.service.apply("b");
    env.service.apply("a");
    expect(env.service.currentPresetName()).toBe("a");
  });
});

describe("PresetService.apply — omo target", () => {
  it("writes into ~/.omo/omo.jsonc [opencode] with reasoning, clearing variant/models conflicts; untouched entries preserved", () => {
    const env = seedOmoMachine(makeEnv());
    env.service.save({
      name: "switch",
      createdAt: "2026-01-01T00:00:00.000Z",
      appliedAt: null,
      defaults: { model: "p/m" },
      agents: {
        oracle: { model: "x/y", variant: "max" },
        explore: { model: "e/f" },
      },
      categories: { quick: { model: "q/q", variant: "low" } },
    });

    const result = env.service.apply("switch");

    const text = readOmo(env);
    expect(validate(text)).toEqual([]);
    expect(getValue(text, ["[opencode]", "agents", "oracle", "model"])).toBe("x/y");
    expect(getValue(text, ["[opencode]", "agents", "oracle", "reasoning"])).toBe("max");
    expect(getValue(text, ["[opencode]", "agents", "oracle", "variant"])).toBeUndefined();
    expect(getValue(text, ["[opencode]", "agents", "explore", "model"])).toBe("e/f");
    expect(getValue(text, ["[opencode]", "agents", "explore", "models"])).toBeUndefined();
    expect(getValue(text, ["[opencode]", "agents", "explore", "reasoning"])).toBeUndefined();
    expect(getValue(text, ["[opencode]", "agents", "librarian"])).toEqual({
      model: "keep/keep",
      reasoning: "high",
    });
    expect(getValue(text, ["[opencode]", "categories", "quick"])).toEqual({ model: "q/q", reasoning: "low" });
    // comment survived the round-trip
    expect(text).toContain("// unified omo config");
    // legacy file stays absent — nothing written there
    expect(fs.existsSync(env.ohMyPath)).toBe(false);
    // defaults.model lands in opencode.json
    expect(getValue(readOpencode(env), ["model"])).toBe("p/m");

    const files = result.changes.map((c) => c.file);
    expect(files).toContain("omo.jsonc");
    expect(files).toContain("opencode.json");
    expect(files).not.toContain("oh-my-opencode.json");
    expect(result.changes).toContainEqual({
      file: "omo.jsonc",
      path: ["[opencode]", "agents", "oracle", "model"],
      from: "old/old",
      to: "x/y",
    });
  });

  it("captures an omo machine: reasoning→variant, chain head from models[]", () => {
    const env = seedOmoMachine(makeEnv(() => new Date("2026-08-22T00:00:00.000Z")));

    const preset = env.service.capture("omo-snap");

    expect(preset.agents).toEqual({
      oracle: { model: "old/old", variant: "low" },
      explore: { model: "a/b", variant: "max" },
      librarian: { model: "keep/keep", variant: "high" },
    });
    expect(preset.categories).toEqual({});
    expect(preset.defaults.model).toBeNull();
  });

  it("creates ~/.omo/omo.jsonc from scratch when the machine hints at omo but the file is missing", () => {
    const env = makeEnv();
    fs.rmSync(env.ohMyPath);
    fs.mkdirSync(path.join(env.homeDir, ".omo"), { recursive: true });
    env.service.save({
      name: "fresh",
      createdAt: "2026-01-01T00:00:00.000Z",
      appliedAt: null,
      defaults: { model: null },
      agents: { oracle: { model: "x/y", variant: "high" } },
      categories: {},
    });

    env.service.apply("fresh");

    const created = path.join(env.homeDir, ".omo", "omo.jsonc");
    const text = fs.readFileSync(created, "utf8");
    expect(validate(text)).toEqual([]);
    expect(getValue(text, ["[opencode]", "agents", "oracle"])).toEqual({ model: "x/y", reasoning: "high" });
  });
});
