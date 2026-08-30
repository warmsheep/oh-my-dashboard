import type { OmoMiscSetting, PresetRow } from "@shared/protocol";
import { OMO_MISC_SETTINGS } from "@shared/protocol";
import { describe, expect, it } from "vitest";

import { effectiveOmoValue, groupOmoMiscSettings, parseOmoNumberInput, upsertRow } from "./helpers";

function booleanSetting(key: string, group: string): OmoMiscSetting {
  return { key, path: [key], kind: "boolean", label: key, group, default: false };
}

describe("groupOmoMiscSettings", () => {
  it("groups by the group field preserving first-appearance order", () => {
    const groups = groupOmoMiscSettings([
      booleanSetting("a", "团队模式"),
      booleanSetting("b", "遥测"),
      booleanSetting("c", "团队模式"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["团队模式", "遥测"]);
    expect(groups[0]?.settings.map((s) => s.key)).toEqual(["a", "c"]);
    expect(groups[1]?.settings.map((s) => s.key)).toEqual(["b"]);
  });

  it("returns an empty array for no settings", () => {
    expect(groupOmoMiscSettings([])).toEqual([]);
  });

  it("covers every OMO_MISC_SETTINGS descriptor exactly once", () => {
    const groups = groupOmoMiscSettings(OMO_MISC_SETTINGS);
    const keys = groups.flatMap((g) => g.settings.map((s) => s.key));
    expect(keys).toHaveLength(OMO_MISC_SETTINGS.length);
    expect(new Set(keys).size).toBe(OMO_MISC_SETTINGS.length);
  });
});

describe("effectiveOmoValue", () => {
  const setting: OmoMiscSetting = { key: "k", path: ["k"], kind: "boolean", label: "k", group: "g", default: true };

  it("returns the file value when set", () => {
    expect(effectiveOmoValue(false, setting)).toBe(false);
    expect(effectiveOmoValue(5, { ...setting, kind: "number", default: 0 })).toBe(5);
  });

  it("falls back to the descriptor default when the file does not set the key", () => {
    expect(effectiveOmoValue(null, setting)).toBe(true);
    expect(effectiveOmoValue(undefined, setting)).toBe(true);
  });

  it("falls back to false when the descriptor carries no default (optional since the composite kinds)", () => {
    const noDefault: OmoMiscSetting = { key: "k", path: ["k"], kind: "boolean", label: "k", group: "g" };
    expect(effectiveOmoValue(null, noDefault)).toBe(false);
    expect(effectiveOmoValue(undefined, noDefault)).toBe(false);
  });
});

describe("parseOmoNumberInput", () => {
  /** Real descriptor lookup by key; throws on typos so a bad test key fails loudly. */
  function descriptor(key: string): OmoMiscSetting {
    const found = OMO_MISC_SETTINGS.find((entry) => entry.key === key);
    if (found === undefined) {
      throw new Error(`unknown test key: ${key}`);
    }
    return found;
  }
  const concurrency = descriptor("backgroundConcurrency");

  it("parses integer text (with surrounding whitespace and sign) into a commit", () => {
    expect(parseOmoNumberInput("5", concurrency)).toEqual({ kind: "commit", value: 5 });
    expect(parseOmoNumberInput("  12 ", concurrency)).toEqual({ kind: "commit", value: 12 });
    expect(parseOmoNumberInput("0", concurrency)).toEqual({ kind: "commit", value: 0 });
    expect(parseOmoNumberInput("+7", concurrency)).toEqual({ kind: "commit", value: 7 });
  });

  it("commits null for empty input (remove the key, back to default)", () => {
    expect(parseOmoNumberInput("", concurrency)).toEqual({ kind: "commit", value: null });
    expect(parseOmoNumberInput("   ", concurrency)).toEqual({ kind: "commit", value: null });
  });

  it("is a noop for non-integer text (no commit, no error, keep state)", () => {
    expect(parseOmoNumberInput("abc", concurrency)).toEqual({ kind: "noop" });
    expect(parseOmoNumberInput("1.5", concurrency)).toEqual({ kind: "noop" });
    expect(parseOmoNumberInput("1e3", concurrency)).toEqual({ kind: "noop" });
  });

  it("rejects out-of-bounds integers with the descriptor-bounds error", () => {
    expect(parseOmoNumberInput("-1", concurrency)).toEqual({ kind: "invalid", error: "需为 0–100 的整数" });
    expect(parseOmoNumberInput("101", concurrency)).toEqual({ kind: "invalid", error: "需为 0–100 的整数" });
    expect(parseOmoNumberInput("100", concurrency)).toEqual({ kind: "commit", value: 100 });
  });

  it("reads bounds from the descriptor, not a hardcoded 0–100", () => {
    const custom: OmoMiscSetting = { ...concurrency, min: 10, max: 20 };
    expect(parseOmoNumberInput("5", custom)).toEqual({ kind: "invalid", error: "需为 10–20 的整数" });
    expect(parseOmoNumberInput("15", custom)).toEqual({ kind: "commit", value: 15 });
    expect(parseOmoNumberInput("21", custom)).toEqual({ kind: "invalid", error: "需为 10–20 的整数" });
  });
});

describe("upsertRow", () => {
  const rows: PresetRow[] = [
    { section: "agents", name: "oracle", model: "a/b", variant: "high" },
    { section: "categories", name: "quick", model: null, variant: null },
  ];

  it("patches an existing row in place", () => {
    expect(upsertRow(rows, "agents", "oracle", { model: "c/d", variant: "low" })).toEqual([
      { section: "agents", name: "oracle", model: "c/d", variant: "low" },
      { section: "categories", name: "quick", model: null, variant: null },
    ]);
  });

  it("matches rows by section AND name (a same-named row in the other section is untouched)", () => {
    const dup: PresetRow[] = [
      { section: "agents", name: "quick", model: null, variant: null },
      { section: "categories", name: "quick", model: null, variant: null },
    ];
    const next = upsertRow(dup, "categories", "quick", { model: "c/d", variant: null });
    expect(next[0]).toEqual({ section: "agents", name: "quick", model: null, variant: null });
    expect(next[1]).toEqual({ section: "categories", name: "quick", model: "c/d", variant: null });
  });

  it("appends a full row when the section+name is absent (host may send configured rows only)", () => {
    const next = upsertRow(rows, "agents", "explore", { model: "e/f", variant: null });
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ section: "agents", name: "explore", model: "e/f", variant: null });
  });

  it("does not mutate the input array", () => {
    const before = rows.map((r) => ({ ...r }));
    upsertRow(rows, "agents", "oracle", { model: "x/y", variant: "max" });
    expect(rows).toEqual(before);
  });
});
