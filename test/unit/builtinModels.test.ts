import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BUILTIN_MODELS, ensureLocalModelsFile, LOCAL_MODELS_FILE, mergeModelOptions } from "../../src/core/builtinModels";
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

  it("self-heals an empty models array", () => {
    const dir = tmpConfigDir();
    const file = path.join(dir, LOCAL_MODELS_FILE);
    fs.writeFileSync(file, JSON.stringify({ models: [] }));
    expect(ensureLocalModelsFile(dir).length).toBe(BUILTIN_MODELS.length);
  });

  it("builtin catalog covers all required families with unique ids", () => {
    const families: Record<string, RegExp> = {
      GLM: /^zhipuai-coding-plan\/glm-/,
      Kimi: /^moonshotai\/kimi-/,
      MiniMax: /^minimax-cn-coding-plan\/MiniMax-/,
      Mimo: /^xiaomi\/mimo-/,
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
