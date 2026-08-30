import { describe, expect, it } from "vitest";

import { applyEdits, getValue } from "../../src/core/jsoncEditor";
import { isValidOmoMiscValue, omoMiscEdits, readOmoMiscValues } from "../../src/core/omoSettings";
import { OMO_MISC_SETTINGS } from "../../src/shared/protocol";
import type { OmoMiscSetting } from "../../src/shared/protocol";

/** Descriptor lookup by key; throws on typos so a bad test key fails loudly. */
function setting(key: string): OmoMiscSetting {
  const found = OMO_MISC_SETTINGS.find((entry) => entry.key === key);
  if (found === undefined) {
    throw new Error(`unknown test key: ${key}`);
  }
  return found;
}

/** omo-target config text; the top-level `telemetry` is a decoy the prefixed read must ignore. */
const OMO_TEXT = JSON.stringify({
  "[opencode]": {
    telemetry: false,
    team_mode: { enabled: true, tmux_visualization: false },
    sisyphus_agent: { tdd: false },
    background_task: { defaultConcurrency: 8 },
  },
  telemetry: true,
});

describe("readOmoMiscValues", () => {
  it("reads at [opencode]-prefixed paths for the omo target and ignores shared-base decoys", () => {
    const values = readOmoMiscValues(OMO_TEXT, ["[opencode]"]);
    expect(values.telemetry).toBe(false);
    expect(values.teamMode).toBe(true);
    expect(values.teamTmuxVisualization).toBe(false);
    expect(values.sisyphusTdd).toBe(false);
    expect(values.backgroundConcurrency).toBe(8);
    expect(values.tmuxEnabled).toBeNull();
  });

  it("reads top-level paths for the legacy target", () => {
    const values = readOmoMiscValues(JSON.stringify({ telemetry: false, tmux: { enabled: true } }), []);
    expect(values.telemetry).toBe(false);
    expect(values.tmuxEnabled).toBe(true);
  });

  it("returns null for absent keys and degrades wrong shapes to null", () => {
    const values = readOmoMiscValues(
      JSON.stringify({ telemetry: "yes", background_task: { defaultConcurrency: "8" } }),
      [],
    );
    expect(values.telemetry).toBeNull();
    expect(values.backgroundConcurrency).toBeNull();
    expect(values.runtimeFallback).toBeNull();
    const empty = readOmoMiscValues("", ["[opencode]"]);
    expect(Object.keys(empty).length).toBe(OMO_MISC_SETTINGS.length);
  });
});

describe("omoMiscEdits", () => {
  it("prefixes the omo sectionPath and creates nested containers when applied", () => {
    const edits = omoMiscEdits(["[opencode]"], setting("teamMode"), true);
    expect(edits).toEqual([{ path: ["[opencode]", "team_mode", "enabled"], value: true, op: "set" }]);
    const text = applyEdits("{}", edits);
    expect(getValue(text, ["[opencode]", "team_mode", "enabled"])).toBe(true);
  });

  it("writes top-level paths for the legacy target", () => {
    const text = applyEdits("{}", omoMiscEdits([], setting("runtimeFallback"), true));
    expect(getValue(text, ["runtime_fallback", "enabled"])).toBe(true);
  });

  it("removes the leaf key on null and leaves the container behind", () => {
    const seeded = applyEdits("{}", omoMiscEdits(["[opencode]"], setting("teamMode"), true));
    const removed = applyEdits(seeded, omoMiscEdits(["[opencode]"], setting("teamMode"), null));
    expect(getValue(removed, ["[opencode]", "team_mode", "enabled"])).toBeUndefined();
    expect(getValue(removed, ["[opencode]", "team_mode"])).toEqual({});
  });
});

describe("isValidOmoMiscValue", () => {
  it("accepts null for both kinds (remove op / 恢复默认)", () => {
    expect(isValidOmoMiscValue(setting("telemetry"), null)).toBe(true);
    expect(isValidOmoMiscValue(setting("backgroundConcurrency"), null)).toBe(true);
  });

  it("boolean kind accepts booleans only", () => {
    expect(isValidOmoMiscValue(setting("telemetry"), false)).toBe(true);
    expect(isValidOmoMiscValue(setting("telemetry"), 1)).toBe(false);
    expect(isValidOmoMiscValue(setting("telemetry"), "true")).toBe(false);
  });

  it("number kind accepts integers 0–100 only", () => {
    const concurrency = setting("backgroundConcurrency");
    expect(isValidOmoMiscValue(concurrency, 0)).toBe(true);
    expect(isValidOmoMiscValue(concurrency, 5)).toBe(true);
    expect(isValidOmoMiscValue(concurrency, 100)).toBe(true);
    expect(isValidOmoMiscValue(concurrency, -1)).toBe(false);
    expect(isValidOmoMiscValue(concurrency, 101)).toBe(false);
    expect(isValidOmoMiscValue(concurrency, 3.5)).toBe(false);
    expect(isValidOmoMiscValue(concurrency, "5")).toBe(false);
  });

  it("number kind reads bounds from the descriptor, not a hardcoded 0–100", () => {
    const custom: OmoMiscSetting = { ...setting("backgroundConcurrency"), min: 10, max: 20 };
    expect(isValidOmoMiscValue(custom, 10)).toBe(true);
    expect(isValidOmoMiscValue(custom, 20)).toBe(true);
    expect(isValidOmoMiscValue(custom, 5)).toBe(false);
    expect(isValidOmoMiscValue(custom, 21)).toBe(false);
  });
});
