import type {
  OpencodePermissionState,
  OpencodeSettingField,
  RecordAggregate,
  RecordEditorValue,
  RecordFieldDef,
  ShallowObjectValue,
} from "@shared/protocol";
import { OMO_MISC_SETTINGS, OPENCODE_PERMISSION_TOOLS, OPENCODE_SETTINGS } from "@shared/protocol";
import { describe, expect, it } from "vitest";

import {
  effectiveShallowBoolean,
  isPermissionShorthandLocked,
  isPermissionToolsLocked,
  isRecordEntriesLocked,
  isRecordMasterLocked,
  isWideSettingKind,
  mcpToggleEdit,
  modelAliasError,
  moveListEntry,
  parseNumberFieldInput,
  parseOrderedListEntry,
  parseRecordTextField,
  parseStringListEntry,
  permissionToolEdit,
  planRecordCommit,
  recordAggregateAfterCommit,
  recordBlockedCommitError,
  recordEntryNameError,
  recordFieldMaxLen,
  recordRequiredGaps,
  removeListEntry,
  toggleChipValue,
  withCatalogEntry,
  withoutCatalogAlias,
  withoutRecordEntry,
  withRecordEntry,
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

describe("removeListEntry (shared by stringList + orderedList)", () => {
  it("removes by index and returns null when the list becomes empty (remove the key)", () => {
    expect(removeListEntry(["a", "b", "c"], 1)).toEqual(["a", "c"]);
    expect(removeListEntry(["a"], 0)).toBeNull();
  });

  it("ignores out-of-range indices (defensive)", () => {
    expect(removeListEntry(["a"], 5)).toEqual(["a"]);
  });
});

describe("parseOrderedListEntry (add-row validation, orderedList bounds 64/64)", () => {
  it("commits trimmed non-empty unique entries", () => {
    expect(parseOrderedListEntry("  build  ", [])).toEqual({ kind: "commit", value: "build" });
    expect(parseOrderedListEntry("plan", ["build"])).toEqual({ kind: "commit", value: "plan" });
  });

  it("rejects empty and whitespace-only input", () => {
    expect(parseOrderedListEntry("", [])).toEqual({ kind: "invalid", error: "条目不能为空" });
    expect(parseOrderedListEntry("   ", ["build"])).toEqual({ kind: "invalid", error: "条目不能为空" });
  });

  it("rejects duplicates against the current list (after trimming)", () => {
    expect(parseOrderedListEntry("build", ["build"])).toEqual({ kind: "invalid", error: "该条目已存在" });
    expect(parseOrderedListEntry(" build ", ["build"])).toEqual({ kind: "invalid", error: "该条目已存在" });
  });

  it("rejects entries longer than 64 characters", () => {
    expect(parseOrderedListEntry("x".repeat(65), [])).toEqual({ kind: "invalid", error: "最长 64 个字符" });
    expect(parseOrderedListEntry("x".repeat(64), [])).toEqual({ kind: "commit", value: "x".repeat(64) });
  });

  it("rejects adds once the list holds 64 entries", () => {
    const full = Array.from({ length: 64 }, (_, i) => `agent-${i}`);
    expect(parseOrderedListEntry("new", full)).toEqual({ kind: "invalid", error: "最多 64 条" });
    expect(parseOrderedListEntry("new", full.slice(0, 63))).toEqual({ kind: "commit", value: "new" });
  });
});

describe("moveListEntry", () => {
  it("swaps neighbours in both directions and keeps the rest in place", () => {
    expect(moveListEntry(["build", "plan", "general"], 1, -1)).toEqual(["plan", "build", "general"]);
    expect(moveListEntry(["build", "plan", "general"], 0, 1)).toEqual(["plan", "build", "general"]);
    expect(moveListEntry(["build", "plan", "general"], 2, -1)).toEqual(["build", "general", "plan"]);
  });

  it("is a no-op at the list edges (the ↑/↓ buttons are disabled there)", () => {
    expect(moveListEntry(["build", "plan"], 0, -1)).toEqual(["build", "plan"]);
    expect(moveListEntry(["build", "plan"], 1, 1)).toEqual(["build", "plan"]);
  });

  it("ignores out-of-range indices (defensive)", () => {
    expect(moveListEntry(["build"], 5, -1)).toEqual(["build"]);
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

// ---------------------------------------------------------------------------
// recordEditor / recordMaster kinds (命令 / 格式化 / LSP)
// ---------------------------------------------------------------------------

/** The real command descriptor fields (template multiline required + friends). */
const COMMAND_FIELDS: RecordFieldDef[] = [
  (OPENCODE_SETTINGS.find((setting) => setting.key === "command")?.record?.fields ?? []) as RecordFieldDef[],
][0];
const FORMATTER_FIELDS: RecordFieldDef[] = [
  (OPENCODE_SETTINGS.find((setting) => setting.key === "formatterEntries")?.record?.fields ?? []) as RecordFieldDef[],
][0];

function aggregate(partial: Partial<RecordAggregate>): RecordAggregate {
  return { mode: "unset", booleanValue: null, entries: {}, ...partial };
}

describe("recordEntryNameError (add-row validation)", () => {
  it("accepts trimmed npm-ish names and rejects empty / charset / length violations", () => {
    expect(recordEntryNameError("  review-notes  ", [], {})).toBeNull();
    expect(recordEntryNameError("ts-server.v2_x", [], {})).toBeNull();
    expect(recordEntryNameError("", [], {})).toBe("名称不能为空");
    expect(recordEntryNameError("bad name!", [], {})).toBe("仅限字母、数字与 . _ -");
    expect(recordEntryNameError("x".repeat(65), [], {})).toBe("最长 64 个字符");
    expect(recordEntryNameError("x".repeat(64), [], {})).toBeNull();
  });

  it("rejects duplicates against live AND draft names, and enforces the entry cap", () => {
    expect(recordEntryNameError("review", ["review", "lint"], {})).toBe("名称已存在");
    expect(recordEntryNameError(" review ", ["review"], {})).toBe("名称已存在");
    const full = Array.from({ length: 32 }, (_, i) => `cmd-${i}`);
    expect(recordEntryNameError("new", full, {})).toBe("最多 32 条");
    expect(recordEntryNameError("new", full.slice(0, 31), {})).toBeNull();
  });

  it("honours descriptor overrides of the name rules", () => {
    expect(recordEntryNameError("a b", [], { namePattern: "^[a-z ]+$" })).toBeNull();
    expect(recordEntryNameError("abcdef", [], { nameMaxLen: 4 })).toBe("最长 4 个字符");
    expect(recordEntryNameError("new", ["a"], { maxEntries: 1 })).toBe("最多 1 条");
  });
});

describe("parseRecordTextField (text/multiline field commits)", () => {
  it("trims into a commit and commits null for empty input (field unset)", () => {
    expect(parseRecordTextField("  do the thing  ", { key: "t", kind: "text", label: "t" })).toEqual({
      kind: "commit",
      value: "do the thing",
    });
    expect(parseRecordTextField("   ", { key: "t", kind: "multiline", label: "t" })).toEqual({
      kind: "commit",
      value: null,
    });
  });

  it("bounds text at 256 and multiline at 8000 by default, honouring field.maxLen", () => {
    expect(parseRecordTextField("x".repeat(257), { key: "t", kind: "text", label: "t" })).toEqual({
      kind: "invalid",
      error: "最长 256 个字符",
    });
    expect(parseRecordTextField("x".repeat(256), { key: "t", kind: "text", label: "t" })).toEqual({
      kind: "commit",
      value: "x".repeat(256),
    });
    expect(parseRecordTextField("x".repeat(8001), { key: "t", kind: "multiline", label: "t" })).toEqual({
      kind: "invalid",
      error: "最长 8000 个字符",
    });
    expect(parseRecordTextField("x".repeat(11), { key: "t", kind: "text", label: "t", maxLen: 10 })).toEqual({
      kind: "invalid",
      error: "最长 10 个字符",
    });
  });
});

describe("recordFieldMaxLen (shared bound derivation of parseRecordTextField + the inline error)", () => {
  it("bounds text at 256 and multiline at 8000 by default, honouring field.maxLen", () => {
    expect(recordFieldMaxLen({ key: "t", kind: "text", label: "t" })).toBe(256);
    expect(recordFieldMaxLen({ key: "m", kind: "multiline", label: "m" })).toBe(8000);
    expect(recordFieldMaxLen({ key: "t", kind: "text", label: "t", maxLen: 10 })).toBe(10);
    expect(recordFieldMaxLen({ key: "m", kind: "multiline", label: "m", maxLen: 100 })).toBe(100);
  });
});

describe("record snapshot row ops", () => {
  it("upserts entries into the full snapshot (withRecordEntry)", () => {
    expect(withRecordEntry(null, "lint", { template: "run lint" })).toEqual({ lint: { template: "run lint" } });
    expect(withRecordEntry({ lint: { template: "a" } }, "lint", { template: "b" })).toEqual({
      lint: { template: "b" },
    });
  });

  it("deletes live names with a null marker and collapses to null when nothing live remains", () => {
    expect(withoutRecordEntry({ a: { template: "x" }, b: { template: "y" } }, "a")).toEqual({
      a: null,
      b: { template: "y" },
    });
    expect(withoutRecordEntry({ a: { template: "x" } }, "a")).toBeNull();
    expect(withoutRecordEntry(null, "a")).toBeNull();
  });
});

describe("recordRequiredGaps (commit block)", () => {
  it("flags only required fields left empty by live entries (null markers skipped)", () => {
    const value: RecordEditorValue = {
      ok: { template: "x" },
      broken: {},
      deleted: null,
      blank: { template: "   " },
    };
    expect(recordRequiredGaps(COMMAND_FIELDS, value)).toEqual([
      { name: "broken", label: "模板" },
      { name: "blank", label: "模板" },
    ]);
    expect(recordRequiredGaps(COMMAND_FIELDS, null)).toEqual([]);
  });

  it("reports nothing for descriptors without required fields", () => {
    expect(recordRequiredGaps(FORMATTER_FIELDS, { empty: {} })).toEqual([]);
  });

  it("names the blocking entry in the Chinese blocked-commit notice (others first)", () => {
    const gaps = [
      { name: "edited", label: "模板" },
      { name: "other", label: "模板" },
    ];
    expect(recordBlockedCommitError(gaps, "edited")).toBe("「other」的模板不能为空，修改已暂存");
    expect(recordBlockedCommitError(gaps, "elsewhere")).toBe("「edited」的模板不能为空，修改已暂存");
    expect(recordBlockedCommitError(gaps.slice(0, 1), "edited")).toBe("「edited」的模板不能为空，修改已暂存");
    expect(recordBlockedCommitError([], "edited")).toBeNull();
  });
});

describe("planRecordCommit (full-snapshot assembly)", () => {
  it("applies held overlays onto live entries and posts the full snapshot", () => {
    const value: RecordEditorValue = { lint: { template: "a" }, fmt: {} };
    const plan = planRecordCommit(FORMATTER_FIELDS, value, { lint: { template: "a", disabled: true } }, null);
    expect(plan).toEqual({
      kind: "commit",
      value: { lint: { template: "a", disabled: true }, fmt: {} },
      postedNames: ["lint", "fmt"],
    });
  });

  it("blocks while any live entry leaves a required field empty", () => {
    const value: RecordEditorValue = { ok: { template: "x" }, broken: {} };
    const plan = planRecordCommit(COMMAND_FIELDS, value, { ok: { template: "y" } }, null);
    expect(plan).toEqual({ kind: "blocked", gaps: [{ name: "broken", label: "模板" }] });
  });

  it("marks deletions with null entries and collapses to null when nothing live remains", () => {
    const value: RecordEditorValue = { a: { template: "x" }, b: { template: "y" } };
    expect(planRecordCommit(COMMAND_FIELDS, value, {}, "a")).toEqual({
      kind: "commit",
      value: { a: null, b: { template: "y" } },
      postedNames: ["a", "b"],
    });
    expect(planRecordCommit(COMMAND_FIELDS, { a: { template: "x" } }, {}, "a")).toEqual({
      kind: "commit",
      value: null,
      postedNames: ["a"],
    });
  });

  it("rename rides along as delete-marker + new entry in one snapshot", () => {
    const value: RecordEditorValue = { old: { template: "x" } };
    const plan = planRecordCommit(COMMAND_FIELDS, value, { new: { template: "x" } }, "old");
    expect(plan).toEqual({
      kind: "commit",
      value: { old: null, new: { template: "x" } },
      postedNames: ["old", "new"],
    });
  });

  it("includes committable drafts (no gaps + at least one set leaf) and holds the rest", () => {
    const value: RecordEditorValue = { keep: { template: "x" } };
    const edits = {
      ready: { template: "t", agent: "build" },
      gapped: { agent: "build" },
      hollow: {},
    };
    const plan = planRecordCommit(COMMAND_FIELDS, value, edits, null);
    expect(plan.kind).toBe("commit");
    if (plan.kind === "commit") {
      expect(plan.value).toEqual({ keep: { template: "x" }, ready: { template: "t", agent: "build" } });
      expect(plan.postedNames).toEqual(["keep", "ready"]);
    }
  });

  it("skips null markers defensively present in the read form", () => {
    const plan = planRecordCommit(FORMATTER_FIELDS, { ghost: null, live: {} }, {}, null);
    expect(plan).toEqual({ kind: "commit", value: { live: {} }, postedNames: ["live"] });
  });
});

describe("record interlocks + optimistic aggregate patch", () => {
  it("locks the master while named entries exist and the entries while the boolean form is set", () => {
    expect(isRecordMasterLocked(aggregate({ mode: "entries", entries: { prettier: {} } }))).toBe(true);
    expect(isRecordMasterLocked(aggregate({ mode: "entries", entries: {} }))).toBe(false);
    expect(isRecordMasterLocked(aggregate({ mode: "boolean", booleanValue: true }))).toBe(false);
    expect(isRecordMasterLocked(aggregate({}))).toBe(false);
    expect(isRecordEntriesLocked(aggregate({ mode: "boolean", booleanValue: false }))).toBe(true);
    expect(isRecordEntriesLocked(aggregate({ mode: "entries", entries: { prettier: {} } }))).toBe(false);
    expect(isRecordEntriesLocked(aggregate({}))).toBe(false);
  });

  it("derives the next entries-mode aggregate from a snapshot diff", () => {
    const before = aggregate({ mode: "entries", entries: { a: { template: "x" }, b: {} } });
    expect(recordAggregateAfterCommit(before, { a: null, b: { template: "y" }, c: { template: "z" } })).toEqual(
      aggregate({ mode: "entries", entries: { b: { template: "y" }, c: { template: "z" } } }),
    );
  });

  it("maps null to unset and booleans to the master form", () => {
    const before = aggregate({ mode: "entries", entries: { a: {} } });
    expect(recordAggregateAfterCommit(before, null)).toEqual(aggregate({}));
    expect(recordAggregateAfterCommit(before, false)).toEqual(aggregate({ mode: "boolean", booleanValue: false }));
    expect(recordAggregateAfterCommit(before, true)).toEqual(
      aggregate({ mode: "boolean", booleanValue: true, entries: {} }),
    );
  });
});

describe("isWideSettingKind", () => {
  it("marks exactly the composite kinds for the full-width set-row layout", () => {
    for (const kind of [
      "providers",
      "stringList",
      "orderedList",
      "enumChips",
      "shallowObject",
      "permissionTools",
      "mcpServers",
      "modelCatalog",
      "recordEditor",
      "recordMaster",
    ]) {
      expect(isWideSettingKind(kind)).toBe(true);
    }
    for (const kind of ["model", "enum", "tristate", "boolean", "string", "number"]) {
      expect(isWideSettingKind(kind)).toBe(false);
    }
  });
});
