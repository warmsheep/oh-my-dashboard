import type { OpencodePermissionState, OpencodeSettingField, ShallowObjectValue } from "@shared/protocol";
import { OMO_MISC_SETTINGS, OPENCODE_PERMISSION_TOOLS } from "@shared/protocol";
import { describe, expect, it } from "vitest";

import {
  effectiveShallowBoolean,
  isPermissionShorthandLocked,
  isPermissionToolsLocked,
  isWideSettingKind,
  mcpToggleEdit,
  modelAliasError,
  parseNumberFieldInput,
  parseStringListEntry,
  permissionToolEdit,
  removeStringListEntry,
  toggleChipValue,
  withCatalogEntry,
  withoutCatalogAlias,
} from "./helpers";

describe("parseStringListEntry (add-row validation)", () => {
  it("commits trimmed non-empty unique entries", () => {
    expect(parseStringListEntry("  ~/.cursor/rules  ", [])).toEqual({ kind: "commit", value: "~/.cursor/rules" });
    expect(parseStringListEntry("b", ["a"])).toEqual({ kind: "commit", value: "b" });
  });

  it("rejects empty and whitespace-only input", () => {
    expect(parseStringListEntry("", [])).toEqual({ kind: "invalid", error: "条目不能为空" });
    expect(parseStringListEntry("   ", ["a"])).toEqual({ kind: "invalid", error: "条目不能为空" });
  });

  it("rejects duplicates against the current list (after trimming)", () => {
    expect(parseStringListEntry("a", ["a"])).toEqual({ kind: "invalid", error: "该条目已存在" });
    expect(parseStringListEntry(" a ", ["a"])).toEqual({ kind: "invalid", error: "该条目已存在" });
  });

  it("rejects entries longer than 256 characters", () => {
    expect(parseStringListEntry("x".repeat(257), [])).toEqual({ kind: "invalid", error: "最长 256 个字符" });
    expect(parseStringListEntry("x".repeat(256), [])).toEqual({ kind: "commit", value: "x".repeat(256) });
  });

  it("rejects adds once the list holds 16 entries", () => {
    const full = Array.from({ length: 16 }, (_, i) => `rule-${i}`);
    expect(parseStringListEntry("new", full)).toEqual({ kind: "invalid", error: "最多 16 条" });
    expect(parseStringListEntry("new", full.slice(0, 15))).toEqual({ kind: "commit", value: "new" });
  });
});

describe("removeStringListEntry", () => {
  it("removes by index and returns null when the list becomes empty (remove the key)", () => {
    expect(removeStringListEntry(["a", "b", "c"], 1)).toEqual(["a", "c"]);
    expect(removeStringListEntry(["a"], 0)).toBeNull();
  });

  it("ignores out-of-range indices (defensive)", () => {
    expect(removeStringListEntry(["a"], 5)).toEqual(["a"]);
  });
});

describe("toggleChipValue", () => {
  it("appends unchecked options and removes checked ones, preserving order", () => {
    expect(toggleChipValue(["oracle"], "explore", true)).toEqual(["oracle", "explore"]);
    expect(toggleChipValue(["oracle", "explore"], "oracle", false)).toEqual(["explore"]);
  });

  it("returns null when the selection becomes empty (remove the key)", () => {
    expect(toggleChipValue(["oracle"], "oracle", false)).toBeNull();
  });

  it("does not duplicate redundant checks", () => {
    expect(toggleChipValue(["oracle"], "oracle", true)).toEqual(["oracle"]);
  });
});

describe("parseNumberFieldInput (shallowObject + number kinds)", () => {
  const integerField: OpencodeSettingField = { key: "n", kind: "number", label: "n", min: 1, max: 20, integer: true };
  const decimalField: OpencodeSettingField = { key: "t", kind: "number", label: "t", min: 0, max: 2 };

  it("commits integers and decimals (with sign/whitespace) within bounds", () => {
    expect(parseNumberFieldInput("15", integerField)).toEqual({ kind: "commit", value: 15 });
    expect(parseNumberFieldInput("  +7 ", integerField)).toEqual({ kind: "commit", value: 7 });
    expect(parseNumberFieldInput("0.7", decimalField)).toEqual({ kind: "commit", value: 0.7 });
    expect(parseNumberFieldInput("2", decimalField)).toEqual({ kind: "commit", value: 2 });
  });

  it("commits null for empty input (field 未设置)", () => {
    expect(parseNumberFieldInput("", integerField)).toEqual({ kind: "commit", value: null });
    expect(parseNumberFieldInput("   ", decimalField)).toEqual({ kind: "commit", value: null });
  });

  it("is a noop for non-numeric text (keep the draft, post nothing)", () => {
    expect(parseNumberFieldInput("abc", integerField)).toEqual({ kind: "noop" });
    expect(parseNumberFieldInput("1..2", decimalField)).toEqual({ kind: "noop" });
  });

  it("rejects out-of-bounds values with the Chinese bounds error (integer vs decimal wording)", () => {
    expect(parseNumberFieldInput("0", integerField)).toEqual({ kind: "invalid", error: "需为 1–20 的整数" });
    expect(parseNumberFieldInput("21", integerField)).toEqual({ kind: "invalid", error: "需为 1–20 的整数" });
    expect(parseNumberFieldInput("-0.1", decimalField)).toEqual({ kind: "invalid", error: "需为 0–2 的数值" });
    expect(parseNumberFieldInput("2.5", decimalField)).toEqual({ kind: "invalid", error: "需为 0–2 的数值" });
  });

  it("rejects decimals for integer-only fields even when inside the bounds", () => {
    expect(parseNumberFieldInput("1.5", integerField)).toEqual({ kind: "invalid", error: "需为 1–20 的整数" });
  });

  it("handles unbounded and one-sided bounds", () => {
    const free: OpencodeSettingField = { key: "f", kind: "number", label: "f" };
    expect(parseNumberFieldInput("1.5", free)).toEqual({ kind: "commit", value: 1.5 });
    const minOnly: OpencodeSettingField = { key: "m", kind: "number", label: "m", min: 3 };
    expect(parseNumberFieldInput("2", minOnly)).toEqual({ kind: "invalid", error: "需为不小于 3 的数值" });
    const intFree: OpencodeSettingField = { key: "i", kind: "number", label: "i", integer: true };
    expect(parseNumberFieldInput("1.5", intFree)).toEqual({ kind: "invalid", error: "需为整数" });
  });

  it("validates the real compaction tail_turns field bounds from the descriptor table", () => {
    const compaction = OMO_MISC_SETTINGS.find((setting) => setting.key === "runtimeFallbackParams");
    const field = compaction?.fields?.find((entry) => entry.key === "max_fallback_attempts");
    expect(field).toBeDefined();
    expect(parseNumberFieldInput("0", field!)).toEqual({ kind: "invalid", error: "需为 1–20 的整数" });
    expect(parseNumberFieldInput("20", field!)).toEqual({ kind: "commit", value: 20 });
  });
});

describe("effectiveShallowBoolean", () => {
  const field: OpencodeSettingField = { key: "auto", kind: "boolean", label: "auto", default: true };

  it("uses the file leaf when set, the field default when null/absent, false without a default", () => {
    const value: ShallowObjectValue = { auto: false };
    expect(effectiveShallowBoolean(value, field)).toBe(false);
    expect(effectiveShallowBoolean({ auto: true }, field)).toBe(true);
    expect(effectiveShallowBoolean({}, field)).toBe(true);
    expect(effectiveShallowBoolean(null, field)).toBe(true);
    expect(effectiveShallowBoolean(null, { ...field, default: undefined })).toBe(false);
  });
});

describe("modelCatalog row ops", () => {
  it("validates alias pattern, length, duplicates and the 32-entry cap", () => {
    expect(modelAliasError("kimi-max", [])).toBeNull();
    expect(modelAliasError("  kimi-max  ", [])).toBeNull();
    expect(modelAliasError("", [])).toBe("别名不能为空");
    expect(modelAliasError("bad alias!", [])).toBe("仅限字母、数字与 . _ -");
    expect(modelAliasError("x".repeat(33), [])).toBe("最长 32 个字符");
    expect(modelAliasError("a", ["a", "b"])).toBe("别名已存在");
    const full = Array.from({ length: 32 }, (_, i) => `alias-${i}`);
    expect(modelAliasError("new", full)).toBe("最多 32 条别名");
  });

  it("upserts entries (reasoning 未设置 = null) and merges into the current snapshot", () => {
    expect(withCatalogEntry(null, "kimi-max", { model: "kimi/kimi-k2", reasoning: null })).toEqual({
      "kimi-max": { model: "kimi/kimi-k2", reasoning: null },
    });
    expect(
      withCatalogEntry({ "kimi-max": { model: "kimi/kimi-k2", reasoning: null } }, "glm", {
        model: "opencode/glm-4.7",
        reasoning: "high",
      }),
    ).toEqual({
      "kimi-max": { model: "kimi/kimi-k2", reasoning: null },
      glm: { model: "opencode/glm-4.7", reasoning: "high" },
    });
  });

  it("deletes with a null marker for file-existing aliases and drops to null when nothing live remains", () => {
    const catalog = { "kimi-max": { model: "kimi/kimi-k2", reasoning: null } };
    expect(withoutCatalogAlias(catalog, "kimi-max")).toBeNull();
    expect(withoutCatalogAlias({ ...catalog, glm: { model: "g", reasoning: null } }, "kimi-max")).toEqual({
      "kimi-max": null,
      glm: { model: "g", reasoning: null },
    });
  });
});

describe("permission partial-map semantics", () => {
  it("builds single-key edit maps (null = remove that tool's key)", () => {
    expect(permissionToolEdit("bash", "ask")).toEqual({ bash: "ask" });
    expect(permissionToolEdit("webfetch", null)).toEqual({ webfetch: null });
  });

  it("derives the interlocks: object form locks the shorthand, string form locks the tools", () => {
    const stringForm: OpencodePermissionState = { shorthand: "ask", tools: {}, advancedTools: [] };
    expect(isPermissionToolsLocked(stringForm)).toBe(true);
    expect(isPermissionShorthandLocked(stringForm)).toBe(false);

    const objectForm: OpencodePermissionState = { shorthand: null, tools: { bash: "allow" }, advancedTools: [] };
    expect(isPermissionToolsLocked(objectForm)).toBe(false);
    expect(isPermissionShorthandLocked(objectForm)).toBe(true);

    const advancedOnly: OpencodePermissionState = { shorthand: null, tools: {}, advancedTools: ["bash"] };
    expect(isPermissionShorthandLocked(advancedOnly)).toBe(true);

    const empty: OpencodePermissionState = { shorthand: null, tools: {}, advancedTools: [] };
    expect(isPermissionShorthandLocked(empty)).toBe(false);
    expect(isPermissionToolsLocked(empty)).toBe(false);
  });

  it("keeps the tool rows aligned with the protocol tool list", () => {
    expect(OPENCODE_PERMISSION_TOOLS).toHaveLength(15);
    expect(OPENCODE_PERMISSION_TOOLS).toContain("bash");
    expect(OPENCODE_PERMISSION_TOOLS).toContain("doom_loop");
  });
});

describe("mcpToggleEdit", () => {
  it("builds the single-key snapshot map (true = disable, false = re-enable)", () => {
    expect(mcpToggleEdit("memory", true)).toEqual({ memory: true });
    expect(mcpToggleEdit("memory", false)).toEqual({ memory: false });
  });
});

describe("isWideSettingKind", () => {
  it("marks exactly the composite kinds for the full-width set-row layout", () => {
    for (const kind of [
      "providers",
      "stringList",
      "enumChips",
      "shallowObject",
      "permissionTools",
      "mcpServers",
      "modelCatalog",
    ]) {
      expect(isWideSettingKind(kind)).toBe(true);
    }
    for (const kind of ["model", "enum", "tristate", "boolean", "string", "number"]) {
      expect(isWideSettingKind(kind)).toBe(false);
    }
  });
});
