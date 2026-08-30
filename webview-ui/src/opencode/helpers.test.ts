import type { ModelOption, OpencodeSetting } from "@shared/protocol";
import { OPENCODE_SETTINGS, OPENCODE_STRING_VALUE_MAX_LENGTH, TUI_THEME_MAX_LENGTH } from "@shared/protocol";
import { describe, expect, it } from "vitest";

import {
  effectiveOpencodeBoolean,
  groupOpencodeSettings,
  parseOpencodeStringInput,
  parseTuiThemeInput,
  toggleProviderValue,
  tristateFromSelectValue,
  tristateToSelectValue,
  uniqueProviderNames,
} from "./helpers";

function setting(key: string, kind: OpencodeSetting["kind"], extra: Partial<OpencodeSetting> = {}): OpencodeSetting {
  return { key, path: [key], kind, label: key, group: "其他", ...extra };
}

function model(id: string, provider: string): ModelOption {
  return { id, provider, model: id, label: id };
}

describe("groupOpencodeSettings", () => {
  it("groups by the descriptor group field in first-appearance order", () => {
    const groups = groupOpencodeSettings(OPENCODE_SETTINGS);
    expect(groups.map((g) => g.label)).toEqual([
      "模型",
      "行为",
      "其他",
      "权限",
      "规则文件",
      "MCP 服务器",
      "上下文",
      "智能体",
      "终端界面",
      "高级",
      "终端与输出",
    ]);
    expect(groups[0]?.settings.map((s) => s.key)).toEqual(["model", "smallModel", "agentBuildModel", "agentPlanModel"]);
    expect(groups[1]?.settings.map((s) => s.key)).toEqual(["defaultAgent", "share", "autoupdate", "snapshot"]);
    expect(groups[2]?.settings.map((s) => s.key)).toEqual(["username", "disabledProviders"]);
    expect(groups[3]?.settings.map((s) => s.key)).toEqual(["permissionShorthand", "permissionTools"]);
    expect(groups[7]?.settings.map((s) => s.key)).toEqual([
      "agentBuildDisable",
      "agentBuildTemperature",
      "agentPlanDisable",
      "agentPlanTemperature",
      "agentGeneralModel",
      "agentExploreModel",
    ]);
    expect(groups[9]?.settings.map((s) => s.key)).toEqual(["logLevel", "shell", "subagentDepth", "watcherIgnore"]);
    expect(groups[10]?.settings.map((s) => s.key)).toEqual(["toolOutput", "attachmentImage"]);
  });

  it("covers every OPENCODE_SETTINGS descriptor exactly once", () => {
    const groups = groupOpencodeSettings(OPENCODE_SETTINGS);
    const keys = groups.flatMap((g) => g.settings.map((s) => s.key));
    expect(keys).toHaveLength(OPENCODE_SETTINGS.length);
    expect(new Set(keys).size).toBe(OPENCODE_SETTINGS.length);
  });

  it("gives a new descriptor group its own section in first-appearance order", () => {
    const groups = groupOpencodeSettings([...OPENCODE_SETTINGS, setting("future", "string", { group: "实验" })]);
    const last = groups[groups.length - 1];
    expect(last?.label).toBe("实验");
    expect(last?.settings.map((s) => s.key)).toEqual(["future"]);
  });

  it("falls back to a trailing 其他 for a descriptor without a group (defensive — group is required)", () => {
    const groups = groupOpencodeSettings([
      setting("model", "model", { group: "模型" }),
      setting("future", "string", { group: "" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["模型", "其他"]);
    expect(groups[1]?.settings.map((s) => s.key)).toEqual(["future"]);
  });

  it("returns no groups for no settings", () => {
    expect(groupOpencodeSettings([])).toEqual([]);
  });
});

describe("tristate mapping", () => {
  it("maps values to select strings (null/garbage → 未设置)", () => {
    expect(tristateToSelectValue(true)).toBe("true");
    expect(tristateToSelectValue(false)).toBe("false");
    expect(tristateToSelectValue("notify")).toBe("notify");
    expect(tristateToSelectValue(null)).toBe("");
    expect(tristateToSelectValue(undefined)).toBe("");
    expect(tristateToSelectValue("manual")).toBe("");
  });

  it('maps select strings back to values ("" → null = remove the key)', () => {
    expect(tristateFromSelectValue("true")).toBe(true);
    expect(tristateFromSelectValue("false")).toBe(false);
    expect(tristateFromSelectValue("notify")).toBe("notify");
    expect(tristateFromSelectValue("")).toBeNull();
  });
});

describe("effectiveOpencodeBoolean", () => {
  it("uses the file value when set", () => {
    expect(effectiveOpencodeBoolean(true, setting("k", "boolean"))).toBe(true);
    expect(effectiveOpencodeBoolean(false, setting("k", "boolean", { default: true }))).toBe(false);
  });

  it("falls back to the documented default when the key is unset", () => {
    expect(effectiveOpencodeBoolean(null, setting("k", "boolean", { default: true }))).toBe(true);
    expect(effectiveOpencodeBoolean(undefined, setting("k", "boolean", { default: true }))).toBe(true);
    expect(effectiveOpencodeBoolean(undefined, setting("k", "boolean"))).toBe(false);
  });
});

describe("uniqueProviderNames", () => {
  it("dedupes providers preserving first-appearance order", () => {
    expect(uniqueProviderNames([model("a", "kimi"), model("b", "glm"), model("c", "kimi")])).toEqual(["kimi", "glm"]);
  });

  it("returns an empty list for no models", () => {
    expect(uniqueProviderNames([])).toEqual([]);
  });
});

describe("toggleProviderValue", () => {
  it("checks append and uncheck removes, preserving order", () => {
    expect(toggleProviderValue(["kimi"], "glm", true)).toEqual(["kimi", "glm"]);
    expect(toggleProviderValue(["kimi", "glm"], "kimi", false)).toEqual(["glm"]);
  });

  it("is a no-op for redundant toggles", () => {
    expect(toggleProviderValue(["kimi"], "kimi", true)).toEqual(["kimi"]);
    expect(toggleProviderValue([], "kimi", false)).toEqual([]);
  });
});

describe("parseOpencodeStringInput", () => {
  it("trims the text into a commit", () => {
    expect(parseOpencodeStringInput("  dev  ")).toEqual({ kind: "commit", value: "dev" });
  });

  it("commits null for empty input (remove the key)", () => {
    expect(parseOpencodeStringInput("")).toEqual({ kind: "commit", value: null });
    expect(parseOpencodeStringInput("   ")).toEqual({ kind: "commit", value: null });
  });

  it("commits a value at exactly the max length", () => {
    const text = "x".repeat(OPENCODE_STRING_VALUE_MAX_LENGTH);
    expect(parseOpencodeStringInput(text)).toEqual({ kind: "commit", value: text });
  });

  it("rejects over-length input with the length error (no post, keep the draft)", () => {
    expect(parseOpencodeStringInput("x".repeat(OPENCODE_STRING_VALUE_MAX_LENGTH + 1))).toEqual({
      kind: "invalid",
      error: "最长 64 个字符",
    });
  });
});

describe("parseTuiThemeInput", () => {
  it("trims the theme into a commit and commits null for empty input", () => {
    expect(parseTuiThemeInput("  catppuccin  ")).toEqual({ kind: "commit", value: "catppuccin" });
    expect(parseTuiThemeInput("   ")).toEqual({ kind: "commit", value: null });
  });

  it("bounds the theme with TUI_THEME_MAX_LENGTH (the shared isValidTuiTheme constant)", () => {
    const text = "x".repeat(TUI_THEME_MAX_LENGTH);
    expect(parseTuiThemeInput(text)).toEqual({ kind: "commit", value: text });
    expect(parseTuiThemeInput("x".repeat(TUI_THEME_MAX_LENGTH + 1))).toEqual({
      kind: "invalid",
      error: `最长 ${TUI_THEME_MAX_LENGTH} 个字符`,
    });
  });
});
