import { describe, expect, it } from "vitest";

import { applyEdits, getValue } from "../../src/core/jsoncEditor";
import { isValidTuiTheme, readTuiTheme, tuiThemeEdits } from "../../src/core/tuiSettings";

describe("readTuiTheme", () => {
  it("reads a present string theme", () => {
    expect(readTuiTheme('{ "theme": "opencode" }\n')).toBe("opencode");
  });

  it("returns null for an absent theme key", () => {
    expect(readTuiTheme('{ "leader_key": "ctrl+k" }\n')).toBeNull();
  });

  it("returns null for empty and unparsable text", () => {
    expect(readTuiTheme("")).toBeNull();
    expect(readTuiTheme("{ broken")).toBeNull();
  });

  it("returns null for a non-string theme value (wrong shape)", () => {
    expect(readTuiTheme('{ "theme": 42 }\n')).toBeNull();
    expect(readTuiTheme('{ "theme": true }\n')).toBeNull();
    expect(readTuiTheme('{ "theme": null }\n')).toBeNull();
  });
});

describe("tuiThemeEdits", () => {
  it('builds a single set edit at ["theme"]', () => {
    expect(tuiThemeEdits("catppuccin")).toEqual([{ path: ["theme"], value: "catppuccin", op: "set" }]);
  });

  it("builds a single remove edit for null", () => {
    expect(tuiThemeEdits(null)).toEqual([{ path: ["theme"], value: undefined, op: "remove" }]);
  });

  it("applies through jsoncEditor: set creates the key, remove drops it and preserves comments", () => {
    const seeded = applyEdits('// tui prefs\n{\n  "leader_key": "ctrl+k",\n}\n', tuiThemeEdits("dracula"));
    expect(getValue(seeded, ["theme"])).toBe("dracula");
    expect(seeded).toContain("// tui prefs");
    expect(getValue(seeded, ["leader_key"])).toBe("ctrl+k");

    const removed = applyEdits(seeded, tuiThemeEdits(null));
    expect(getValue(removed, ["theme"])).toBeUndefined();
    expect(removed).toContain("// tui prefs");
    expect(getValue(removed, ["leader_key"])).toBe("ctrl+k");
  });
});

describe("isValidTuiTheme", () => {
  it("accepts a trimmed non-empty name of up to 64 chars", () => {
    expect(isValidTuiTheme("opencode")).toBe(true);
    expect(isValidTuiTheme("  spaced-theme  ")).toBe(true);
    expect(isValidTuiTheme("x".repeat(64))).toBe(true);
  });

  it("rejects empty / whitespace-only / over-64 names and non-strings", () => {
    expect(isValidTuiTheme("")).toBe(false);
    expect(isValidTuiTheme("   ")).toBe(false);
    expect(isValidTuiTheme("x".repeat(65))).toBe(false);
    expect(isValidTuiTheme(42)).toBe(false);
    expect(isValidTuiTheme(null)).toBe(false);
  });
});
