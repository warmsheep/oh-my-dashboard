import { describe, expect, it } from "vitest";

import { applyEdits, getValue } from "../../src/core/jsoncEditor";
import {
  isValidOpencodeSettingValue,
  opencodeSettingEdits,
  readMcpServers,
  readOpencodeSettingValues,
  readPermissionState,
} from "../../src/core/opencodeSettings";
import { OPENCODE_PERMISSION_TOOLS, OPENCODE_SETTINGS } from "../../src/shared/protocol";
import type { OpencodeSetting } from "../../src/shared/protocol";

/** Descriptor lookup by key; throws on typos so a bad test key fails loudly. */
function setting(key: string): OpencodeSetting {
  const found = OPENCODE_SETTINGS.find((entry) => entry.key === key);
  if (found === undefined) {
    throw new Error(`unknown test key: ${key}`);
  }
  return found;
}

/** Descriptor keys whose data rides dedicated payload fields, not the scalar values map. */
const NON_SCALAR_KEYS = ["mcpServers", "tuiTheme"];

describe("readOpencodeSettingValues", () => {
  it("reads present values of every kind, including nested agent paths", () => {
    const text = JSON.stringify({
      model: "zhipuai/glm-5",
      small_model: "kimi/k2",
      default_agent: "plan",
      share: "auto",
      autoupdate: "notify",
      snapshot: false,
      username: "alice",
      disabled_providers: ["openai", "github-copilot"],
      agent: { build: { model: "a/b", temperature: 0.7 }, plan: { model: "c/d", disable: true } },
      permission: "ask",
      instructions: [".cursor/rules", "docs/guide.md"],
      compaction: { auto: false, prune: true, tail_turns: 7, bogus: "not a descriptor field" },
    });
    expect(readOpencodeSettingValues(text)).toEqual({
      model: "zhipuai/glm-5",
      smallModel: "kimi/k2",
      defaultAgent: "plan",
      share: "auto",
      autoupdate: "notify",
      snapshot: false,
      username: "alice",
      disabledProviders: ["openai", "github-copilot"],
      agentBuildModel: "a/b",
      agentPlanModel: "c/d",
      permissionShorthand: "ask",
      permissionTools: null, // string form → the payload permission aggregate carries it
      instructions: [".cursor/rules", "docs/guide.md"],
      compaction: { auto: false, prune: true, tail_turns: 7 },
      agentBuildDisable: null,
      agentBuildTemperature: 0.7,
      agentPlanDisable: true,
      agentPlanTemperature: null,
      agentGeneralModel: null,
      agentExploreModel: null,
    });
  });

  it("returns null for absent keys on empty text; mcpServers/tuiTheme keys stay out of the scalar map", () => {
    const values = readOpencodeSettingValues("{}");
    for (const entry of OPENCODE_SETTINGS) {
      if (NON_SCALAR_KEYS.includes(entry.key)) {
        expect(Object.hasOwn(values, entry.key)).toBe(false);
      } else {
        expect(values[entry.key]).toBeNull();
      }
    }
    const empty = readOpencodeSettingValues("");
    expect(Object.keys(empty).length).toBe(OPENCODE_SETTINGS.length - NON_SCALAR_KEYS.length);
  });

  it("reads object-form permission into the permissionTools map and skips advanced/unknown entries", () => {
    const values = readOpencodeSettingValues(
      JSON.stringify({
        permission: { bash: "deny", edit: "allow", webfetch: { "https://example.com/*": "allow" }, made_up: "ask" },
      }),
    );
    expect(values.permissionTools).toEqual({ bash: "deny", edit: "allow" });
    expect(values.permissionShorthand).toBeNull();
  });

  it("shallowObject read extracts only descriptor fields and degrades wrong-shape leaves per field", () => {
    const values = readOpencodeSettingValues(
      JSON.stringify({ compaction: { auto: "yes", prune: false, tail_turns: 1.5 } }),
    );
    expect(values.compaction).toEqual({ auto: null, prune: false, tail_turns: null });
  });

  it("stringList read keeps an array of strings and degrades anything else to null", () => {
    expect(readOpencodeSettingValues(JSON.stringify({ instructions: ["a.md"] })).instructions).toEqual(["a.md"]);
    expect(readOpencodeSettingValues(JSON.stringify({ instructions: ["a.md", 3] })).instructions).toBeNull();
    expect(readOpencodeSettingValues(JSON.stringify({ instructions: "a.md" })).instructions).toBeNull();
  });

  it("degrades wrong-shaped values to null instead of lying about types", () => {
    const values = readOpencodeSettingValues(
      JSON.stringify({
        model: 42,
        share: true,
        autoupdate: "yes",
        snapshot: "true",
        username: 7,
        disabled_providers: ["ok", 3],
        permission: { bash: "sometimes" },
        instructions: { not: "an array" },
        compaction: 42,
        agent: { build: { temperature: "warm" } },
      }),
    );
    expect(values.model).toBeNull();
    expect(values.share).toBeNull();
    expect(values.autoupdate).toBeNull();
    expect(values.snapshot).toBeNull();
    expect(values.username).toBeNull();
    expect(values.disabledProviders).toBeNull();
    expect(values.permissionTools).toEqual({}); // object form with no valid simple actions
    expect(values.instructions).toBeNull();
    expect(values.compaction).toBeNull();
    expect(values.agentBuildTemperature).toBeNull();
  });
});

describe("opencodeSettingEdits", () => {
  it("builds a single set edit at the descriptor path", () => {
    expect(opencodeSettingEdits(setting("agentBuildModel"), "kimi/k2")).toEqual([
      { path: ["agent", "build", "model"], value: "kimi/k2", op: "set" },
    ]);
  });

  it("builds a single remove edit for null", () => {
    expect(opencodeSettingEdits(setting("model"), null)).toEqual([{ path: ["model"], value: undefined, op: "remove" }]);
  });

  it("applies through jsoncEditor: set creates nested containers, remove drops the leaf key", () => {
    const seeded = applyEdits("{}", opencodeSettingEdits(setting("agentPlanModel"), "a/b"));
    const removed = applyEdits(seeded, opencodeSettingEdits(setting("agentPlanModel"), null));
    expect(JSON.parse(removed)).toEqual({ agent: { plan: {} } });
  });
});

describe("isValidOpencodeSettingValue", () => {
  it("accepts null for every kind (remove op)", () => {
    for (const entry of OPENCODE_SETTINGS) {
      expect(isValidOpencodeSettingValue(entry, null)).toBe(true);
    }
  });

  it("model: accepts provider/model ids, rejects malformed strings and non-strings", () => {
    const model = setting("model");
    expect(isValidOpencodeSettingValue(model, "zhipuai/glm-5")).toBe(true);
    expect(isValidOpencodeSettingValue(model, "not-a-model-id")).toBe(false);
    expect(isValidOpencodeSettingValue(model, 42)).toBe(false);
  });

  it("enum: accepts listed options only (share and default_agent tables)", () => {
    const share = setting("share");
    expect(isValidOpencodeSettingValue(share, "manual")).toBe(true);
    expect(isValidOpencodeSettingValue(share, "auto")).toBe(true);
    expect(isValidOpencodeSettingValue(share, "disabled")).toBe(true);
    expect(isValidOpencodeSettingValue(share, "nope")).toBe(false);
    const agent = setting("defaultAgent");
    expect(isValidOpencodeSettingValue(agent, "build")).toBe(true);
    expect(isValidOpencodeSettingValue(agent, "plan")).toBe(true);
    expect(isValidOpencodeSettingValue(agent, "custom-agent")).toBe(false);
  });

  it("tristate: accepts true/false/notify only", () => {
    const autoupdate = setting("autoupdate");
    expect(isValidOpencodeSettingValue(autoupdate, true)).toBe(true);
    expect(isValidOpencodeSettingValue(autoupdate, false)).toBe(true);
    expect(isValidOpencodeSettingValue(autoupdate, "notify")).toBe(true);
    expect(isValidOpencodeSettingValue(autoupdate, "yes")).toBe(false);
  });

  it("boolean: accepts booleans only", () => {
    const snapshot = setting("snapshot");
    expect(isValidOpencodeSettingValue(snapshot, true)).toBe(true);
    expect(isValidOpencodeSettingValue(snapshot, "true")).toBe(false);
  });

  it("string: accepts 1..64 chars, rejects empty, over-long and non-string values", () => {
    const username = setting("username");
    expect(isValidOpencodeSettingValue(username, "alice")).toBe(true);
    expect(isValidOpencodeSettingValue(username, "")).toBe(false);
    expect(isValidOpencodeSettingValue(username, "x".repeat(65))).toBe(false);
    expect(isValidOpencodeSettingValue(username, 7)).toBe(false);
  });

  it("providers: unique well-formed ids only — rejects dups, bad chars, over-long entries, non-strings and non-arrays", () => {
    const providers = setting("disabledProviders");
    expect(isValidOpencodeSettingValue(providers, [])).toBe(true);
    expect(isValidOpencodeSettingValue(providers, ["zhipuai", "kimi-chat"])).toBe(true);
    expect(isValidOpencodeSettingValue(providers, ["zhipuai", "zhipuai"])).toBe(false);
    expect(isValidOpencodeSettingValue(providers, ["bad name!"])).toBe(false);
    expect(isValidOpencodeSettingValue(providers, ["x".repeat(33)])).toBe(false);
    expect(isValidOpencodeSettingValue(providers, ["ok", 3])).toBe(false);
    expect(isValidOpencodeSettingValue(providers, "zhipuai")).toBe(false);
  });

  it("providers: caps the array at 64 entries", () => {
    const providers = setting("disabledProviders");
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `provider-${i}`);
    expect(isValidOpencodeSettingValue(providers, ids(64))).toBe(true);
    expect(isValidOpencodeSettingValue(providers, ids(65))).toBe(false);
  });

  it("number: accepts finite values within descriptor bounds, decimals included", () => {
    const temperature = setting("agentBuildTemperature");
    expect(isValidOpencodeSettingValue(temperature, 0)).toBe(true);
    expect(isValidOpencodeSettingValue(temperature, 1.5)).toBe(true);
    expect(isValidOpencodeSettingValue(temperature, 2)).toBe(true);
    expect(isValidOpencodeSettingValue(temperature, -0.1)).toBe(false);
    expect(isValidOpencodeSettingValue(temperature, 2.1)).toBe(false);
    expect(isValidOpencodeSettingValue(temperature, Number.NaN)).toBe(false);
    expect(isValidOpencodeSettingValue(temperature, "0.7")).toBe(false);
  });

  it("stringList: 1–16 unique trimmed non-empty entries of ≤256 chars", () => {
    const instructions = setting("instructions");
    expect(isValidOpencodeSettingValue(instructions, [".cursor/rules"])).toBe(true);
    expect(
      isValidOpencodeSettingValue(
        instructions,
        Array.from({ length: 16 }, (_, i) => `rule-${i}.md`),
      ),
    ).toBe(true);
    expect(isValidOpencodeSettingValue(instructions, [])).toBe(false);
    expect(
      isValidOpencodeSettingValue(
        instructions,
        Array.from({ length: 17 }, (_, i) => `rule-${i}.md`),
      ),
    ).toBe(false);
    expect(isValidOpencodeSettingValue(instructions, ["a.md", ""])).toBe(false);
    expect(isValidOpencodeSettingValue(instructions, ["a.md", "   "])).toBe(false);
    expect(isValidOpencodeSettingValue(instructions, ["x".repeat(257)])).toBe(false);
    expect(isValidOpencodeSettingValue(instructions, ["x".repeat(256)])).toBe(true);
    expect(isValidOpencodeSettingValue(instructions, ["a.md", "a.md"])).toBe(false);
    expect(isValidOpencodeSettingValue(instructions, ["a.md", " a.md "])).toBe(false);
    expect(isValidOpencodeSettingValue(instructions, ["a.md", 3])).toBe(false);
    expect(isValidOpencodeSettingValue(instructions, "a.md")).toBe(false);
  });

  it("shallowObject: null leaf = field unset (accepted, mirrors the OMO-side tolerance)", () => {
    const compaction = setting("compaction");
    expect(isValidOpencodeSettingValue(compaction, { auto: false, tail_turns: null })).toBe(true);
    expect(isValidOpencodeSettingValue(compaction, { auto: null, prune: null, tail_turns: null })).toBe(true);
    // Unknown field keys stay rejected regardless of the leaf being null.
    expect(isValidOpencodeSettingValue(compaction, { unknown_field: null })).toBe(false);
  });

  it("shallowObject: bounds and integer flags come from the descriptor fields", () => {
    const compaction = setting("compaction");
    expect(isValidOpencodeSettingValue(compaction, { auto: true, prune: false, tail_turns: 2 })).toBe(true);
    expect(isValidOpencodeSettingValue(compaction, {})).toBe(true);
    expect(isValidOpencodeSettingValue(compaction, { tail_turns: 0 })).toBe(true);
    expect(isValidOpencodeSettingValue(compaction, { tail_turns: 100 })).toBe(true);
    expect(isValidOpencodeSettingValue(compaction, { tail_turns: 101 })).toBe(false);
    expect(isValidOpencodeSettingValue(compaction, { tail_turns: -1 })).toBe(false);
    expect(isValidOpencodeSettingValue(compaction, { tail_turns: 1.5 })).toBe(false); // integer enforced
    expect(isValidOpencodeSettingValue(compaction, { tail_turns: Number.NaN })).toBe(false);
    expect(isValidOpencodeSettingValue(compaction, { auto: "true" })).toBe(false);
    expect(isValidOpencodeSettingValue(compaction, { unknown_field: true })).toBe(false);
    expect(isValidOpencodeSettingValue(compaction, "compaction")).toBe(false);
    expect(isValidOpencodeSettingValue(compaction, [{ auto: true }])).toBe(false);
  });

  it("shallowObject: decimals allowed exactly when the field is not integer-flagged", () => {
    const decimalDescriptor: OpencodeSetting = {
      ...setting("compaction"),
      fields: [
        { key: "factor", kind: "number", label: "因子", min: 0, max: 2 },
        { key: "unbounded", kind: "number", label: "无界" },
      ],
    };
    expect(isValidOpencodeSettingValue(decimalDescriptor, { factor: 0.25, unbounded: 12345.6 })).toBe(true);
    expect(isValidOpencodeSettingValue(decimalDescriptor, { factor: 2.0001 })).toBe(false);
    const integerDescriptor: OpencodeSetting = {
      ...setting("compaction"),
      fields: [{ key: "count", kind: "number", label: "数量", min: 0, max: 10, integer: true }],
    };
    expect(isValidOpencodeSettingValue(integerDescriptor, { count: 3 })).toBe(true);
    expect(isValidOpencodeSettingValue(integerDescriptor, { count: 3.5 })).toBe(false);
  });

  it("enumChips: rejected on the OpenCode write path (OMO-side kind, Wave 2)", () => {
    const enumChipsDescriptor: OpencodeSetting = { ...setting("instructions"), kind: "enumChips" };
    expect(isValidOpencodeSettingValue(enumChipsDescriptor, ["hephaestus"])).toBe(false);
    expect(isValidOpencodeSettingValue(enumChipsDescriptor, null)).toBe(true);
  });

  it("permissionTools: known tools with allow/ask/deny (or null) only", () => {
    const tools = setting("permissionTools");
    expect(isValidOpencodeSettingValue(tools, { bash: "deny", edit: "allow" })).toBe(true);
    expect(isValidOpencodeSettingValue(tools, { bash: null })).toBe(true);
    expect(isValidOpencodeSettingValue(tools, {})).toBe(true);
    expect(isValidOpencodeSettingValue(tools, { made_up: "ask" })).toBe(false); // unknown tool key
    expect(isValidOpencodeSettingValue(tools, { bash: "sometimes" })).toBe(false); // bad action
    expect(isValidOpencodeSettingValue(tools, { bash: true })).toBe(false);
    expect(isValidOpencodeSettingValue(tools, ["bash"])).toBe(false);
    expect(isValidOpencodeSettingValue(tools, "deny")).toBe(false);
  });

  it("mcpServers: ≤32 well-formed names mapped to booleans", () => {
    const mcp = setting("mcpServers");
    expect(isValidOpencodeSettingValue(mcp, { filesystem: true, github: false })).toBe(true);
    expect(isValidOpencodeSettingValue(mcp, {})).toBe(true);
    const names = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`server-${i}`, i % 2 === 0]));
    expect(isValidOpencodeSettingValue(mcp, names(32))).toBe(true);
    expect(isValidOpencodeSettingValue(mcp, names(33))).toBe(false);
    expect(isValidOpencodeSettingValue(mcp, { "bad name!": true })).toBe(false);
    expect(isValidOpencodeSettingValue(mcp, { ["x".repeat(65)]: true })).toBe(false);
    expect(isValidOpencodeSettingValue(mcp, { server: "true" })).toBe(false);
    expect(isValidOpencodeSettingValue(mcp, null)).toBe(true); // no-op snapshot, never wipes mcp
  });

  it("tuiTheme: kind string + file tui validates through isValidTuiTheme", () => {
    const theme = setting("tuiTheme");
    expect(isValidOpencodeSettingValue(theme, "opencode")).toBe(true);
    expect(isValidOpencodeSettingValue(theme, "   ")).toBe(false);
    expect(isValidOpencodeSettingValue(theme, "x".repeat(65))).toBe(false);
    expect(isValidOpencodeSettingValue(theme, 42)).toBe(false);
    expect(isValidOpencodeSettingValue(theme, null)).toBe(true);
  });
});

describe("opencodeSettingEdits (new kinds)", () => {
  it("mcpServers snapshot: disable sets mcp.<name>.enabled=false, enable removes the key, null writes nothing", () => {
    const mcp = setting("mcpServers");
    expect(opencodeSettingEdits(mcp, { filesystem: true, github: false })).toEqual([
      { path: ["mcp", "filesystem", "enabled"], value: false, op: "set" },
      { path: ["mcp", "github", "enabled"], value: undefined, op: "remove" },
    ]);
    expect(opencodeSettingEdits(mcp, null)).toEqual([]);
  });

  it("mcpServers edits apply through jsoncEditor and leave sibling fields untouched", () => {
    const seeded = '{\n  "mcp": {\n    "github": { "command": "npx", "enabled": false, "args": ["-y"] },\n  },\n}\n';
    const next = applyEdits(seeded, opencodeSettingEdits(setting("mcpServers"), { github: false }));
    expect(getValue(next, ["mcp", "github"])).toEqual({ command: "npx", args: ["-y"] }); // enabled key removed
  });

  it("permissionTools: one set/remove edit per tool key present in the value", () => {
    const tools = setting("permissionTools");
    expect(opencodeSettingEdits(tools, { bash: "deny", edit: null })).toEqual([
      { path: ["permission", "bash"], value: "deny", op: "set" },
      { path: ["permission", "edit"], value: undefined, op: "remove" },
    ]);
    expect(opencodeSettingEdits(tools, null)).toEqual([]);
  });

  it("permissionTools edits preserve a sibling pattern object (set keeps it byte-identical)", () => {
    const bashProperty = '\n    "bash": { "rm *": "deny", },\n';
    const seeded = `{\n  "permission": {${bashProperty}    "read": "deny",\n  },\n}\n`;
    const set = applyEdits(seeded, opencodeSettingEdits(setting("permissionTools"), { edit: "allow" }));
    expect(set).toContain(bashProperty); // jsonc modify leaves untouched properties byte-identical
    expect(getValue(set, ["permission", "edit"])).toBe("allow");

    // Removals keep the pattern rules semantically intact (jsonc-parser may re-indent them).
    const removed = applyEdits(seeded, opencodeSettingEdits(setting("permissionTools"), { read: null }));
    expect(getValue(removed, ["permission", "bash"])).toEqual({ "rm *": "deny" });
    expect(getValue(removed, ["permission", "read"])).toBeUndefined();
  });

  it("stringList: single set/remove at the descriptor path", () => {
    expect(opencodeSettingEdits(setting("instructions"), ["a.md", "b.md"])).toEqual([
      { path: ["instructions"], value: ["a.md", "b.md"], op: "set" },
    ]);
    expect(opencodeSettingEdits(setting("instructions"), null)).toEqual([
      { path: ["instructions"], value: undefined, op: "remove" },
    ]);
  });

  it("shallowObject: one edit per field present — non-null leaf sets, null leaf removes; never a whole-object write", () => {
    expect(opencodeSettingEdits(setting("compaction"), { auto: false, tail_turns: null })).toEqual([
      { path: ["compaction", "auto"], value: false, op: "set" },
      { path: ["compaction", "tail_turns"], value: undefined, op: "remove" },
    ]);
  });

  it("shallowObject: null value and all-null (or empty) maps remove the whole key", () => {
    expect(opencodeSettingEdits(setting("compaction"), null)).toEqual([
      { path: ["compaction"], value: undefined, op: "remove" },
    ]);
    expect(opencodeSettingEdits(setting("compaction"), { auto: null, prune: null, tail_turns: null })).toEqual([
      { path: ["compaction"], value: undefined, op: "remove" },
    ]);
    expect(opencodeSettingEdits(setting("compaction"), {})).toEqual([
      { path: ["compaction"], value: undefined, op: "remove" },
    ]);
  });

  it("shallowObject per-leaf edits preserve sibling keys and comments inside the parent object", () => {
    const seeded =
      '// top\n{\n  "compaction": {\n    // user note\n    "auto": true,\n    "custom": "keep",\n  },\n}\n';
    const next = applyEdits(
      seeded,
      opencodeSettingEdits(setting("compaction"), { auto: false, prune: null, tail_turns: null }),
    );
    expect(getValue(next, ["compaction"])).toEqual({ auto: false, custom: "keep" });
    expect(next).toContain("// top");
    expect(next).toContain("// user note");
  });
});

describe("readPermissionState", () => {
  it("absent / wrong-shape permission reads as the all-empty aggregate", () => {
    expect(readPermissionState("{}")).toEqual({ shorthand: null, tools: {}, advancedTools: [] });
    expect(readPermissionState(JSON.stringify({ permission: 42 }))).toEqual({
      shorthand: null,
      tools: {},
      advancedTools: [],
    });
    expect(readPermissionState(JSON.stringify({ permission: "sometimes" }))).toEqual({
      shorthand: null,
      tools: {},
      advancedTools: [],
    });
  });

  it("string shorthand form populates only shorthand", () => {
    expect(readPermissionState(JSON.stringify({ permission: "ask" }))).toEqual({
      shorthand: "ask",
      tools: {},
      advancedTools: [],
    });
  });

  it("object form splits per-tool actions and pattern-object tools into advancedTools", () => {
    const state = readPermissionState(
      JSON.stringify({
        permission: {
          bash: "deny",
          edit: "allow",
          webfetch: { "https://example.com/*": "allow" },
          made_up: "ask",
          read: "sometimes",
        },
      }),
    );
    expect(state.shorthand).toBeNull();
    expect(state.tools).toEqual({ bash: "deny", edit: "allow" });
    expect(state.advancedTools).toEqual(["webfetch"]);
  });
});

describe("readMcpServers", () => {
  it("lists object entries with the disabled flag and skips non-object entries", () => {
    const servers = readMcpServers(
      JSON.stringify({
        mcp: {
          github: { command: "npx" },
          filesystem: { enabled: false },
          disabled_default: { enabled: false, command: "x" },
          broken: "not an object",
          also_broken: 42,
        },
      }),
    );
    expect(servers).toEqual([
      { name: "github", disabled: false },
      { name: "filesystem", disabled: true },
      { name: "disabled_default", disabled: true },
    ]);
  });

  it("returns [] for absent / non-object mcp and caps the list at 32 entries", () => {
    expect(readMcpServers("{}")).toEqual([]);
    expect(readMcpServers(JSON.stringify({ mcp: "nope" }))).toEqual([]);
    expect(readMcpServers(JSON.stringify({ mcp: [] }))).toEqual([]);
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`server-${i}`, { enabled: false }]));
    expect(readMcpServers(JSON.stringify({ mcp: many })).length).toBe(32);
  });
});

describe("OPENCODE_PERMISSION_TOOLS canon", () => {
  it("holds the 15 tools in the documented importance order", () => {
    expect([...OPENCODE_PERMISSION_TOOLS]).toEqual([
      "bash",
      "edit",
      "read",
      "glob",
      "grep",
      "list",
      "task",
      "skill",
      "lsp",
      "webfetch",
      "websearch",
      "todowrite",
      "question",
      "external_directory",
      "doom_loop",
    ]);
    expect(new Set(OPENCODE_PERMISSION_TOOLS).size).toBe(OPENCODE_PERMISSION_TOOLS.length);
  });
});
