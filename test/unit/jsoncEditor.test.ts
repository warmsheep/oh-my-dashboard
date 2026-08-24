import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyEdits,
  getValue,
  JsoncSyntaxError,
  parseSafe,
  removeKey,
  setValues,
  validate,
} from "../../src/core/jsoncEditor";

const fixturesDir = join(process.cwd(), "test", "fixtures");
const readFixture = (name: string): string => readFileSync(join(fixturesDir, name), "utf8");

const commentsText = readFixture("opencode.comments.jsonc");
const opencodeText = readFixture("opencode.jsonc");
const invalidText = readFixture("opencode.invalid.jsonc");
const ohMyText = readFixture("oh-my-opencode.json");

describe("parseSafe", () => {
  it("parses valid JSONC with comments and trailing commas without errors", () => {
    const result = parseSafe<Record<string, unknown>>(commentsText);
    expect(result.errors).toEqual([]);
    expect(result.value).not.toBeNull();
    expect(Object.keys(result.value as Record<string, unknown>)).toContain("provider");
  });

  it("returns null value and no errors for empty content", () => {
    const result = parseSafe<unknown>("");
    expect(result.value).toBeNull();
    expect(result.errors).toEqual([]);
  });

  it("collects errors for syntactically broken JSONC", () => {
    const result = parseSafe<unknown>(invalidText);
    expect(result.errors.length).toBeGreaterThan(0);
    for (const err of result.errors) {
      expect(err.offset).toBeGreaterThanOrEqual(0);
      expect(err.offset).toBeLessThanOrEqual(invalidText.length);
      expect(typeof err.message).toBe("string");
    }
  });
});

describe("validate", () => {
  it("accepts trailing commas and comments", () => {
    expect(validate(commentsText)).toEqual([]);
    expect(validate('{"a": [1, 2,], // c\n"b": 1,}')).toEqual([]);
  });

  it("reports errors for invalid input", () => {
    const errors = validate(invalidText);
    expect(errors.length).toBeGreaterThan(0);
    for (const err of errors) {
      expect(err.offset).toBeGreaterThanOrEqual(0);
      expect(err.offset).toBeLessThanOrEqual(invalidText.length);
    }
  });
});

describe("getValue", () => {
  it("reads a deep path from JSONC with trailing commas", () => {
    expect(getValue(commentsText, ["provider", "zhipuai-coding-plan", "models", "glm-5"])).toEqual({
      limit: { context: 200000, output: 128000 },
    });
  });

  it("returns undefined for a missing path", () => {
    expect(getValue(commentsText, ["provider", "does-not-exist"])).toBeUndefined();
    expect(getValue(ohMyText, ["agents", "oracle", "nope"])).toBeUndefined();
  });
});

describe("applyEdits", () => {
  it("round-trips opencode.comments.jsonc preserving comment lines, trailing-comma block, and validity", () => {
    const result = applyEdits(commentsText, [
      {
        path: ["provider", "zhipuai-coding-plan", "models", "glm-5"],
        value: { limit: { context: 300000, output: 131072 } },
      },
    ]);

    const commentLines = commentsText.split("\n").filter((line) => line.trimStart().startsWith("//"));
    expect(commentLines.length).toBeGreaterThan(0);
    const resultLines = result.split("\n");
    for (const line of commentLines) {
      expect(resultLines).toContain(line);
    }

    expect(result).toContain('        },\n      }\n    },\n    "minimax-cn-coding-plan": {');

    expect(validate(result)).toEqual([]);
    expect(getValue(result, ["provider", "zhipuai-coding-plan", "models", "glm-5"])).toEqual({
      limit: { context: 300000, output: 131072 },
    });
  });

  it("keeps every line outside the edited model entry byte-identical on opencode.jsonc", () => {
    const result = applyEdits(opencodeText, [
      { path: ["provider", "WindsurfAI", "models", "gpt-9"], value: { name: "GPT-9 By WindsurfAI" } },
    ]);

    const originalLines = opencodeText.split("\n");
    const resultLines = result.split("\n");

    // all 11 tab-indented lines survive byte-identical
    const tabLines = originalLines.filter((line) => line.startsWith("\t"));
    expect(tabLines).toHaveLength(11);
    for (const line of tabLines) {
      expect(resultLines).toContain(line);
    }

    // everything from the "LocalAI" anchor to EOF is byte-identical
    const anchor = originalLines.indexOf('    "LocalAI": {');
    expect(anchor).toBeGreaterThan(0);
    const resultAnchor = resultLines.indexOf('    "LocalAI": {');
    expect(resultAnchor).toBeGreaterThan(0);
    expect(resultLines.slice(resultAnchor)).toEqual(originalLines.slice(anchor));

    expect(validate(result)).toEqual([]);
    expect(getValue(result, ["provider", "WindsurfAI", "models", "gpt-9"])).toEqual({
      name: "GPT-9 By WindsurfAI",
    });
  });

  it("inserts a brand-new nested key with 2-space indentation and valid JSONC", () => {
    const result = applyEdits(opencodeText, [
      { path: ["provider", "WindsurfAI", "models", "brand-new"], value: { name: "Brand New" } },
    ]);

    const keyLine = result.split("\n").find((line) => line.includes('"brand-new"'));
    expect(keyLine).toBeDefined();
    expect(keyLine).toMatch(/^ {8}"brand-new": \{$/);

    expect(validate(result)).toEqual([]);
    expect(getValue(result, ["provider", "WindsurfAI", "models", "brand-new"])).toEqual({
      name: "Brand New",
    });
  });

  it("applies a batch of three different edits in one call", () => {
    const result = applyEdits(ohMyText, [
      { path: ["agents", "oracle", "variant"], value: "low" },
      { path: ["default_run_agent"], value: "atlas" },
      { path: ["agents", "prometheus", "variant"], value: undefined, op: "remove" },
    ]);

    expect(getValue<string>(result, ["agents", "oracle", "variant"])).toBe("low");
    expect(getValue<string>(result, ["default_run_agent"])).toBe("atlas");
    expect(getValue(result, ["agents", "prometheus", "variant"])).toBeUndefined();
    expect(getValue<string>(result, ["agents", "prometheus", "model"])).toBe("zhipuai-coding-plan/glm-5.2");
    expect(validate(result)).toEqual([]);
  });

  it("treats op:'remove' the same as removeKey", () => {
    const viaOp = applyEdits(ohMyText, [{ path: ["agents", "metis", "variant"], value: undefined, op: "remove" }]);
    const viaFn = removeKey(ohMyText, ["agents", "metis", "variant"]);
    expect(viaOp).toBe(viaFn);
    expect(getValue(viaOp, ["agents", "metis", "variant"])).toBeUndefined();
  });

  it("returns text unchanged for an empty edit list", () => {
    expect(applyEdits(opencodeText, [])).toBe(opencodeText);
  });

  it("throws JsoncSyntaxError on invalid input", () => {
    expect(() => applyEdits(invalidText, [{ path: ["$schema"], value: "x" }])).toThrow(JsoncSyntaxError);
  });
});

describe("setValues", () => {
  it("sets multiple paths in one call and stays valid", () => {
    const result = setValues(ohMyText, [
      { path: ["agents", "explore", "variant"], value: "medium" },
      { path: ["tmux", "main_pane_size"], value: 55 },
    ]);

    expect(getValue<string>(result, ["agents", "explore", "variant"])).toBe("medium");
    expect(getValue<number>(result, ["tmux", "main_pane_size"])).toBe(55);
    expect(validate(result)).toEqual([]);
  });

  it("throws JsoncSyntaxError on invalid input with in-range error offsets", () => {
    let caught: unknown;
    try {
      setValues(invalidText, [{ path: ["$schema"], value: "x" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JsoncSyntaxError);
    const syntaxError = caught as JsoncSyntaxError;
    expect(syntaxError.errors.length).toBeGreaterThan(0);
    for (const err of syntaxError.errors) {
      expect(err.offset).toBeGreaterThanOrEqual(0);
      expect(err.offset).toBeLessThanOrEqual(invalidText.length);
    }
  });
});

describe("removeKey", () => {
  it("removes only the targeted key, leaving siblings untouched", () => {
    const result = removeKey(ohMyText, ["agents", "oracle", "variant"]);

    expect(getValue(result, ["agents", "oracle", "variant"])).toBeUndefined();
    expect(getValue<string>(result, ["agents", "oracle", "model"])).toBe("zhipuai-coding-plan/glm-5.2");
    expect(getValue<Record<string, unknown>>(result, ["agents", "oracle"])).toEqual({
      model: "zhipuai-coding-plan/glm-5.2",
    });
    expect(getValue<string>(result, ["agents", "prometheus", "variant"])).toBe("max");
    expect(validate(result)).toEqual([]);
  });

  it("returns text unchanged for a non-existent path", () => {
    expect(removeKey(ohMyText, ["agents", "no-such-agent", "variant"])).toBe(ohMyText);
    expect(removeKey(opencodeText, ["provider", "WindsurfAI", "models", "ghost"])).toBe(opencodeText);
  });

  it("throws JsoncSyntaxError on invalid input", () => {
    let caught: unknown;
    try {
      removeKey(invalidText, ["provider"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JsoncSyntaxError);
    expect((caught as JsoncSyntaxError).errors.length).toBeGreaterThan(0);
  });
});

describe("UTF-8 BOM handling", () => {
  // readFileSync(path, "utf8") keeps a leading \uFEFF — a file saved as "UTF-8 with BOM"
  // (old Notepad, PowerShell redirect) must still parse and stay editable.
  const bomText = `\uFEFF${ohMyText}`;

  it("parseSafe accepts a BOM-prefixed valid file without errors", () => {
    const result = parseSafe<Record<string, unknown>>(bomText);
    expect(result.errors).toEqual([]);
    expect(result.value).not.toBeNull();
  });

  it("validate accepts a BOM-prefixed valid file (edit paths are not blocked)", () => {
    expect(validate(bomText)).toEqual([]);
  });

  it("applyEdits preserves the original BOM and applies the edit", () => {
    const result = applyEdits(bomText, [{ path: ["agents", "oracle", "variant"], value: "low" }]);
    expect(result.startsWith("\uFEFF")).toBe(true);
    expect(getValue<string>(result, ["agents", "oracle", "variant"])).toBe("low");
    expect(validate(result)).toEqual([]);
  });

  it("applyEdits does not introduce a BOM when the input had none", () => {
    const result = applyEdits(ohMyText, [{ path: ["agents", "oracle", "variant"], value: "low" }]);
    expect(result.startsWith("\uFEFF")).toBe(false);
  });

  it("still reports real syntax errors in a BOM-prefixed file with offsets shifted past the BOM", () => {
    const result = parseSafe<unknown>(`\uFEFF${invalidText}`);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("strips ALL leading BOMs: a double-BOM file (script/PowerShell concatenation) parses clean", () => {
    const result = parseSafe<Record<string, unknown>>(`\uFEFF\uFEFF${ohMyText}`);
    expect(result.errors).toEqual([]);
    expect(result.value).not.toBeNull();
  });

  it("applyEdits works on a double-BOM file and preserves the full original BOM prefix", () => {
    const result = applyEdits(`\uFEFF\uFEFF${ohMyText}`, [{ path: ["agents", "oracle", "variant"], value: "low" }]);
    expect(result.startsWith("\uFEFF\uFEFF")).toBe(true);
    expect(getValue<string>(result, ["agents", "oracle", "variant"])).toBe("low");
    expect(validate(result)).toEqual([]);
  });
});

describe("user-facing parse-error message", () => {
  it("reports parser error codes in Chinese (tree labels render the message verbatim)", () => {
    const errors = validate("{ broken");
    expect(errors.length).toBeGreaterThan(0);
    for (const err of errors) {
      expect(err.message).toMatch(/^语法错误（错误码 \d+）$/);
    }
  });
});

describe("JsoncSyntaxError", () => {
  it("is an Error with a descriptive name", () => {
    const err = new JsoncSyntaxError([{ offset: 3, length: 1, message: "boom" }]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("JsoncSyntaxError");
    expect(err.errors).toEqual([{ offset: 3, length: 1, message: "boom" }]);
  });
});
