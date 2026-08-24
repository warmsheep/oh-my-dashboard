import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addLocalModel,
  BUILTIN_MODELS,
  ensureLocalModelsFile,
  LOCAL_MODELS_FILE,
  mergeModelOptions,
  removeLocalModel,
} from "../../src/core/builtinModels";
import type { ModelOption } from "../../src/core/types";

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tmpConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-models-"));
  sandboxes.push(dir);
  return dir;
}

describe("ensureLocalModelsFile", () => {
  it("creates models.json from the builtin catalog on first use", () => {
    const dir = tmpConfigDir();
    const models = ensureLocalModelsFile(dir);
    expect(models.length).toBe(BUILTIN_MODELS.length);
    const file = path.join(dir, LOCAL_MODELS_FILE);
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { models: ModelOption[] };
    expect(parsed.models.length).toBe(BUILTIN_MODELS.length);
    expect(parsed.models[0]).toEqual({
      provider: BUILTIN_MODELS[0].provider,
      model: BUILTIN_MODELS[0].model,
      label: BUILTIN_MODELS[0].label,
    });
  });

  it("returns hand-edited entries from an existing file", () => {
    const dir = tmpConfigDir();
    const file = path.join(dir, LOCAL_MODELS_FILE);
    fs.writeFileSync(
      file,
      JSON.stringify({
        models: [
          { provider: "custom-relay", model: "my-model", label: "My Model" },
          { provider: "bare-entry", model: "no-label" },
        ],
      }),
    );
    const models = ensureLocalModelsFile(dir);
    expect(models).toEqual([
      { id: "custom-relay/my-model", provider: "custom-relay", model: "my-model", label: "My Model" },
      { id: "bare-entry/no-label", provider: "bare-entry", model: "no-label", label: "no-label" },
    ]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).models.length).toBe(2);
  });

  it("self-heals a corrupted file by rewriting the builtin catalog", () => {
    const dir = tmpConfigDir();
    const file = path.join(dir, LOCAL_MODELS_FILE);
    fs.writeFileSync(file, "{ broken json");
    const models = ensureLocalModelsFile(dir);
    expect(models.length).toBe(BUILTIN_MODELS.length);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).models.length).toBe(BUILTIN_MODELS.length);
  });

  it("backs up the corrupted original to models.json.bak byte-identical before self-healing", () => {
    const dir = tmpConfigDir();
    const file = path.join(dir, LOCAL_MODELS_FILE);
    const broken = '{\n  "models": [],\n  "note": "user hand-edit to recover"\n}';
    fs.writeFileSync(file, broken); // parses to an empty models array → triggers the heal
    ensureLocalModelsFile(dir);
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe(broken);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).models.length).toBe(BUILTIN_MODELS.length);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "degrades read-only when models.json exists but is unreadable (no rewrite attempt)",
    () => {
      const dir = tmpConfigDir();
      const file = path.join(dir, LOCAL_MODELS_FILE);
      fs.writeFileSync(file, '{"models":[{"provider":"p","model":"m"}]}');
      fs.chmodSync(file, 0o000);
      const mtimeBefore = fs.statSync(file).mtimeMs;

      const models = ensureLocalModelsFile(dir);

      expect(models.length).toBe(BUILTIN_MODELS.length);
      expect(fs.statSync(file).mtimeMs).toBe(mtimeBefore); // never rewritten, never healed
      expect(fs.existsSync(`${file}.bak`)).toBe(false);
    },
  );

  it("self-heals an empty models array", () => {
    const dir = tmpConfigDir();
    const file = path.join(dir, LOCAL_MODELS_FILE);
    fs.writeFileSync(file, JSON.stringify({ models: [] }));
    expect(ensureLocalModelsFile(dir).length).toBe(BUILTIN_MODELS.length);
  });

  it("healed file is not rewritten again: repeated calls leave mtime unchanged", () => {
    const dir = tmpConfigDir();
    const file = path.join(dir, LOCAL_MODELS_FILE);
    fs.writeFileSync(file, "{ broken json");
    ensureLocalModelsFile(dir);
    const mtimeAfterHeal = fs.statSync(file).mtimeMs;
    ensureLocalModelsFile(dir);
    ensureLocalModelsFile(dir);
    expect(fs.statSync(file).mtimeMs).toBe(mtimeAfterHeal);
  });

  it("builtin catalog covers all required families with unique ids", () => {
    const families: Record<string, RegExp> = {
      GLM: /^zhipuai-coding-plan\/glm-/,
      Kimi: /^kimi-for-coding\//,
      MiniMax: /^minimax-cn-coding-plan\/MiniMax-/,
      Mimo: /^xiaomi-token-plan-cn\/mimo-/,
      Deepseek: /^deepseek\/deepseek-/,
      GPT: /^openai\/gpt-/,
      Claude: /^anthropic\/claude-/,
      Grok: /^xai\/grok-/,
      Gemini: /^google\/gemini-/,
    };
    const ids = BUILTIN_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const pattern of Object.values(families)) {
      expect(ids.some((id) => pattern.test(id))).toBe(true);
    }
  });

  it("accepts hand-edited comments and trailing commas without a self-heal rewrite", () => {
    const dir = tmpConfigDir();
    const file = path.join(dir, LOCAL_MODELS_FILE);
    const handEdited = `{
  // my custom relay
  "models": [
    { "provider": "custom-relay", "model": "m1", "label": "M1", },
  ],
}`;
    fs.writeFileSync(file, handEdited);
    const models = ensureLocalModelsFile(dir);
    expect(models).toEqual([{ id: "custom-relay/m1", provider: "custom-relay", model: "m1", label: "M1" }]);
    expect(fs.readFileSync(file, "utf8")).toBe(handEdited);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it("self-heals when the parsed value is not an object or models is not an array", () => {
    const dir = tmpConfigDir();
    const file = path.join(dir, LOCAL_MODELS_FILE);
    for (const broken of ['"just a string"', "[1, 2]", '{ "models": "x" }']) {
      fs.writeFileSync(file, broken);
      expect(ensureLocalModelsFile(dir).length).toBe(BUILTIN_MODELS.length);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).models.length).toBe(BUILTIN_MODELS.length);
    }
  });

  it("degrades to the in-memory builtin catalog when the seed write fails", () => {
    const dir = tmpConfigDir();
    const denied = new Error("EACCES: permission denied, open") as NodeJS.ErrnoException;
    denied.code = "EACCES";
    const failingWriteFs = {
      ...fs,
      openSync: () => {
        throw denied;
      },
    } as typeof fs;
    const models = ensureLocalModelsFile(dir, failingWriteFs);
    expect(models.length).toBe(BUILTIN_MODELS.length);
    expect(models[0]).toEqual(BUILTIN_MODELS[0]);
    expect(fs.existsSync(path.join(dir, LOCAL_MODELS_FILE))).toBe(false);
  });
});

describe("addLocalModel / removeLocalModel", () => {
  const writeModels = (dir: string, models: { provider: string; model: string; label?: string }[]): string => {
    const file = path.join(dir, LOCAL_MODELS_FILE);
    fs.writeFileSync(file, JSON.stringify({ models }));
    return file;
  };

  it("addLocalModel appends a new entry and persists it; a second call with the same id updates in place", () => {
    const dir = tmpConfigDir();
    writeModels(dir, [{ provider: "p", model: "existing" }]);
    const added = addLocalModel(dir, { provider: "custom", model: "m1", label: "M1" });
    expect(added).toEqual({ id: "custom/m1", provider: "custom", model: "m1", label: "M1" });

    const file = path.join(dir, LOCAL_MODELS_FILE);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).models).toEqual([
      { provider: "p", model: "existing", label: "existing" },
      { provider: "custom", model: "m1", label: "M1" },
    ]);

    const updated = addLocalModel(dir, { provider: "custom", model: "m1", label: "Renamed" });
    expect(updated.label).toBe("Renamed");
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")).models;
    expect(
      persisted.filter((m: { provider: string; model: string }) => `${m.provider}/${m.model}` === "custom/m1"),
    ).toHaveLength(1);
  });

  it("addLocalModel defaults the label to the model name and seeds the file when absent", () => {
    const dir = tmpConfigDir();
    const added = addLocalModel(dir, { provider: "p", model: "bare" });
    expect(added.label).toBe("bare");
    const models = JSON.parse(fs.readFileSync(path.join(dir, LOCAL_MODELS_FILE), "utf8")).models;
    expect(models).toContainEqual({ provider: "p", model: "bare", label: "bare" });
    expect(models.length).toBe(BUILTIN_MODELS.length + 1);
  });

  it("removing one of several entries keeps the file with the remaining entry", () => {
    const dir = tmpConfigDir();
    const file = writeModels(dir, [
      { provider: "p", model: "a", label: "a" },
      { provider: "p", model: "b", label: "b" },
    ]);
    expect(removeLocalModel(dir, "p/a")).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).models).toEqual([{ provider: "p", model: "b", label: "b" }]);
    expect(removeLocalModel(dir, "p/missing")).toBe(false);
  });

  it("removing the LAST local model deletes models.json instead of writing an empty array", () => {
    const dir = tmpConfigDir();
    const file = writeModels(dir, [{ provider: "p", model: "only", label: "only" }]);
    expect(removeLocalModel(dir, "p/only")).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);

    // next first-use re-seeds cleanly, still without a .bak
    expect(ensureLocalModelsFile(dir).length).toBe(BUILTIN_MODELS.length);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });
});

describe("mergeModelOptions", () => {
  const a1: ModelOption = { id: "p/m1", provider: "p", model: "m1", label: "From opencode" };
  const a2: ModelOption = { id: "p/m2", provider: "p", model: "m2", label: "m2" };
  const dup: ModelOption = { id: "p/m1", provider: "p", model: "m1", label: "From local" };
  const b2: ModelOption = { id: "q/n1", provider: "q", model: "n1", label: "n1" };

  it("deduplicates by id with primary (opencode.json) winning", () => {
    expect(mergeModelOptions([a1, a2], [dup, b2])).toEqual([a1, a2, b2]);
  });

  it("returns the sorted union when disjoint, including empty primary", () => {
    expect(mergeModelOptions([], [b2, dup])).toEqual([dup, b2].sort((x, y) => (x.id < y.id ? -1 : 1)));
    expect(mergeModelOptions([a2], [])).toEqual([a2]);
  });
});
