import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addLocalModel,
  BUILTIN_PROVIDERS,
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

describe("ensureLocalModelsFile (pure read — no seeding, no writes)", () => {
  it("returns [] when models.json is missing and creates nothing", () => {
    const dir = tmpConfigDir();
    expect(ensureLocalModelsFile(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, LOCAL_MODELS_FILE))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${LOCAL_MODELS_FILE}.bak`))).toBe(false);
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

  it("accepts hand-edited JSONC comments and trailing commas without any rewrite", () => {
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

  it("an empty models array is a valid empty catalog — [] with no .bak and no rewrite", () => {
    const dir = tmpConfigDir();
    const file = path.join(dir, LOCAL_MODELS_FILE);
    const userBytes = '{ "models": [], "note": "cleared by hand" }\n';
    fs.writeFileSync(file, userBytes);
    expect(ensureLocalModelsFile(dir)).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(userBytes);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it("a shape-broken file degrades to [], keeps its bytes and backs them up once", () => {
    const dir = tmpConfigDir();
    const file = path.join(dir, LOCAL_MODELS_FILE);
    const broken = '{ "models": "x", "note": "hand edit gone wrong" }\n';
    fs.writeFileSync(file, broken);
    expect(ensureLocalModelsFile(dir)).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(broken); // untouched until a network rebuild
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe(broken);

    // Repeated reads never re-copy the .bak and never rewrite the file.
    const mtime = fs.statSync(file).mtimeMs;
    ensureLocalModelsFile(dir);
    ensureLocalModelsFile(dir);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe(broken);
  });

  it("degrades to [] for every shape-broken variant (syntax error / non-object / models not an array)", () => {
    const dir = tmpConfigDir();
    const file = path.join(dir, LOCAL_MODELS_FILE);
    for (const broken of ['"just a string"', "[1, 2]", '{ "models": "x" }']) {
      fs.writeFileSync(file, broken);
      expect(ensureLocalModelsFile(dir)).toEqual([]);
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "degrades read-only when models.json exists but is unreadable (no rewrite attempt)",
    () => {
      const dir = tmpConfigDir();
      const file = path.join(dir, LOCAL_MODELS_FILE);
      fs.writeFileSync(file, '{"models":[{"provider":"p","model":"m"}]}');
      fs.chmodSync(file, 0o000);
      const mtimeBefore = fs.statSync(file).mtimeMs;

      expect(ensureLocalModelsFile(dir)).toEqual([]);

      expect(fs.statSync(file).mtimeMs).toBe(mtimeBefore); // never rewritten
      expect(fs.existsSync(`${file}.bak`)).toBe(false);
    },
  );

  it("builtin provider allowlist is unique and covers every curated family", () => {
    expect(new Set(BUILTIN_PROVIDERS).size).toBe(BUILTIN_PROVIDERS.length);
    const required = [
      "zhipuai-coding-plan",
      "kimi-for-coding",
      "minimax-cn-coding-plan",
      "xiaomi-token-plan-cn",
      "deepseek",
      "openai",
      "anthropic",
      "xai",
      "google",
    ];
    for (const provider of required) {
      expect(BUILTIN_PROVIDERS).toContain(provider);
    }
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

  it("addLocalModel defaults the label to the model name and creates the file with ONLY that entry when absent", () => {
    const dir = tmpConfigDir();
    const added = addLocalModel(dir, { provider: "p", model: "bare" });
    expect(added.label).toBe("bare");
    const models = JSON.parse(fs.readFileSync(path.join(dir, LOCAL_MODELS_FILE), "utf8")).models;
    expect(models).toEqual([{ provider: "p", model: "bare", label: "bare" }]);
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

  it("removing the LAST local model deletes models.json; reads then yield [] (no implicit re-seed)", () => {
    const dir = tmpConfigDir();
    const file = writeModels(dir, [{ provider: "p", model: "only", label: "only" }]);
    expect(removeLocalModel(dir, "p/only")).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
    expect(ensureLocalModelsFile(dir)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false); // reading still creates nothing
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
