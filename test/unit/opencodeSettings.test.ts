import { describe, expect, it } from "vitest";

import { applyEdits, getValue } from "../../src/core/jsoncEditor";
import {
  extractShallowObjectValue,
  isValidOpencodeSettingValue,
  isValidShallowObjectLeaf,
  opencodeSettingEdits,
  readMcpServers,
  readOpencodeSettingValues,
  readPermissionState,
  readRecordState,
  readRecordStates,
  recordEditorEdits,
  recordMasterEdits,
} from "../../src/core/opencodeSettings";
import { OPENCODE_PERMISSION_TOOLS, OPENCODE_SETTINGS } from "../../src/shared/protocol";
import type { OpencodeSetting, OpencodeSettingField, RecordFieldDef } from "../../src/shared/protocol";

/** Descriptor lookup by key; throws on typos so a bad test key fails loudly. */
function setting(key: string): OpencodeSetting {
  const found = OPENCODE_SETTINGS.find((entry) => entry.key === key);
  if (found === undefined) {
    throw new Error(`unknown test key: ${key}`);
  }
  return found;
}

/** Descriptor keys whose data rides dedicated payload fields, not the scalar values map. */
const NON_SCALAR_KEYS = [
  "mcpServers",
  "tuiTheme",
  "command",
  "formatterMaster",
  "formatterEntries",
  "lspMaster",
  "lspEntries",
];

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
      logLevel: "WARN",
      shell: "/bin/fish",
      subagent_depth: 2,
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
      logLevel: "WARN",
      shell: "/bin/fish",
      subagentDepth: 2,
      toolOutput: null,
      attachmentImage: null,
      watcherIgnore: null,
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

describe("batch-3 descriptors (OpenCode tab: 高级 / 终端与输出)", () => {
  it("logLevel: enum accepts DEBUG/INFO/WARN/ERROR only", () => {
    const logLevel = setting("logLevel");
    for (const level of ["DEBUG", "INFO", "WARN", "ERROR"]) {
      expect(isValidOpencodeSettingValue(logLevel, level)).toBe(true);
    }
    expect(isValidOpencodeSettingValue(logLevel, "debug")).toBe(false); // case-sensitive
    expect(isValidOpencodeSettingValue(logLevel, 42)).toBe(false);
    expect(isValidOpencodeSettingValue(logLevel, null)).toBe(true);
  });

  it("shell: string 1..64 chars", () => {
    const shell = setting("shell");
    expect(isValidOpencodeSettingValue(shell, "/bin/zsh")).toBe(true);
    expect(isValidOpencodeSettingValue(shell, "")).toBe(false);
    expect(isValidOpencodeSettingValue(shell, "x".repeat(65))).toBe(false);
    expect(isValidOpencodeSettingValue(shell, 7)).toBe(false);
  });

  it("subagentDepth: integer 0–16 only", () => {
    const depth = setting("subagentDepth");
    expect(isValidOpencodeSettingValue(depth, 0)).toBe(true);
    expect(isValidOpencodeSettingValue(depth, 16)).toBe(true);
    expect(isValidOpencodeSettingValue(depth, -1)).toBe(false);
    expect(isValidOpencodeSettingValue(depth, 17)).toBe(false);
    expect(isValidOpencodeSettingValue(depth, 2.5)).toBe(false); // integer enforced
    expect(isValidOpencodeSettingValue(depth, "3")).toBe(false);
  });

  it("toolOutput: integer leaves; null leaf = unset; unknown field rejected", () => {
    const toolOutput = setting("toolOutput");
    expect(isValidOpencodeSettingValue(toolOutput, { max_lines: 2000, max_bytes: 51200 })).toBe(true);
    expect(isValidOpencodeSettingValue(toolOutput, { max_lines: null })).toBe(true);
    expect(isValidOpencodeSettingValue(toolOutput, { max_lines: 10.5 })).toBe(false); // integer enforced
    expect(isValidOpencodeSettingValue(toolOutput, { max_lines: "2000" })).toBe(false);
    expect(isValidOpencodeSettingValue(toolOutput, { unknown: 1 })).toBe(false);
  });

  it("attachmentImage: auto_resize bool + integer size leaves", () => {
    const image = setting("attachmentImage");
    expect(
      isValidOpencodeSettingValue(image, {
        auto_resize: true,
        max_width: 2000,
        max_height: 2000,
        max_base64_bytes: 5242880,
      }),
    ).toBe(true);
    expect(isValidOpencodeSettingValue(image, { auto_resize: "yes" })).toBe(false);
    expect(isValidOpencodeSettingValue(image, { max_width: 1.5 })).toBe(false);
    expect(isValidOpencodeSettingValue(image, { made_up: 1 })).toBe(false);
  });

  it("watcherIgnore: shared stringList rules (1–16 unique trimmed non-empty ≤256)", () => {
    const watcherIgnore = setting("watcherIgnore");
    expect(isValidOpencodeSettingValue(watcherIgnore, ["node_modules", "*.log"])).toBe(true);
    expect(isValidOpencodeSettingValue(watcherIgnore, ["a", "a"])).toBe(false);
    expect(isValidOpencodeSettingValue(watcherIgnore, [])).toBe(false);
  });

  it("reads the batch-3 keys and degrades wrong shapes to null", () => {
    const values = readOpencodeSettingValues(
      JSON.stringify({
        logLevel: "WARN",
        shell: "/bin/bash",
        subagent_depth: 3,
        tool_output: { max_lines: 500, surprise: "hi" },
        attachment: { image: { auto_resize: false, max_width: 100 } },
        watcher: { ignore: ["*.log"] },
      }),
    );
    expect(values.logLevel).toBe("WARN");
    expect(values.shell).toBe("/bin/bash");
    expect(values.subagentDepth).toBe(3);
    expect(values.toolOutput).toEqual({ max_lines: 500, max_bytes: null });
    expect(values.attachmentImage).toEqual({
      auto_resize: false,
      max_width: 100,
      max_height: null,
      max_base64_bytes: null,
    });
    expect(values.watcherIgnore).toEqual(["*.log"]);

    const bad = readOpencodeSettingValues(
      JSON.stringify({ logLevel: 42, shell: 7, subagent_depth: "3", tool_output: "nope", watcher: { ignore: "x" } }),
    );
    expect(bad.logLevel).toBeNull();
    expect(bad.shell).toBeNull();
    expect(bad.subagentDepth).toBeNull();
    expect(bad.toolOutput).toBeNull();
    expect(bad.watcherIgnore).toBeNull();
  });

  it("edits: logLevel and watcherIgnore whole-key writes round-trip through jsoncEditor", () => {
    const seeded = '{\n  "model": "a/b", // keep\n}\n';
    const set = applyEdits(seeded, opencodeSettingEdits(setting("logLevel"), "WARN"));
    expect(getValue(set, ["logLevel"])).toBe("WARN");
    const removed = applyEdits(set, opencodeSettingEdits(setting("logLevel"), null));
    expect(getValue(removed, ["logLevel"])).toBeUndefined();
    const nested = applyEdits(seeded, opencodeSettingEdits(setting("watcherIgnore"), ["*.log"]));
    expect(getValue(nested, ["watcher", "ignore"])).toEqual(["*.log"]);
  });

  it("toolOutput per-leaf edits preserve sibling keys and comments inside the parent object", () => {
    const seeded = '{\n  "tool_output": {\n    // user note\n    "custom": "keep",\n    "max_lines": 100,\n  },\n}\n';
    const next = applyEdits(seeded, opencodeSettingEdits(setting("toolOutput"), { max_lines: 500, max_bytes: null }));
    expect(getValue(next, ["tool_output"])).toEqual({ custom: "keep", max_lines: 500 });
    expect(next).toContain("// user note");
  });
});

describe("shallowObject enum leaves", () => {
  const enumLeafDescriptor: OpencodeSetting = {
    ...setting("compaction"),
    fields: [
      { key: "mode", kind: "enum", label: "模式", options: ["a", "b"] },
      { key: "flag", kind: "boolean", label: "开关" },
    ],
  };

  it("validator accepts listed options only (∉ options rejected, null leaf = unset)", () => {
    expect(isValidOpencodeSettingValue(enumLeafDescriptor, { mode: "a" })).toBe(true);
    expect(isValidOpencodeSettingValue(enumLeafDescriptor, { mode: "z" })).toBe(false);
    expect(isValidOpencodeSettingValue(enumLeafDescriptor, { mode: 42 })).toBe(false);
    expect(isValidOpencodeSettingValue(enumLeafDescriptor, { mode: null })).toBe(true);
  });

  it("extractShallowObjectValue passes valid enum leaves through and degrades invalid ones to null", () => {
    expect(extractShallowObjectValue(enumLeafDescriptor.fields ?? [], { mode: "b" })).toEqual({
      mode: "b",
      flag: null,
    });
    expect(extractShallowObjectValue(enumLeafDescriptor.fields ?? [], { mode: "zzz" })).toEqual({
      mode: null,
      flag: null,
    });
    expect(extractShallowObjectValue(enumLeafDescriptor.fields ?? [], { mode: 7 })).toEqual({ mode: null, flag: null });
  });

  it("an options-less enum field rejects every value (options ?? [] fallback)", () => {
    const bare: OpencodeSettingField = { key: "mode", kind: "enum", label: "模式" };
    expect(isValidShallowObjectLeaf(bare, "a")).toBe(false);
  });

  it("enum leaf edits set the string / remove on null like every other leaf", () => {
    expect(opencodeSettingEdits(enumLeafDescriptor, { mode: "a", flag: true })).toEqual([
      { path: ["compaction", "mode"], value: "a", op: "set" },
      { path: ["compaction", "flag"], value: true, op: "set" },
    ]);
    expect(opencodeSettingEdits(enumLeafDescriptor, { mode: null, flag: false })).toEqual([
      { path: ["compaction", "mode"], value: undefined, op: "remove" },
      { path: ["compaction", "flag"], value: false, op: "set" },
    ]);
  });
});

describe("orderedList kind", () => {
  // No shipped OpenCode descriptor uses orderedList yet — probe the kind with a
  // synthetic descriptor (the shipped OMO agentOrder rides the same read/edit/validate paths).
  const ordered: OpencodeSetting = { ...setting("instructions"), kind: "orderedList" };
  const names = (count: number) => Array.from({ length: count }, (_, i) => `agent-${i}`);

  it("validator: 1–64 unique trimmed non-empty entries of ≤64 chars", () => {
    expect(isValidOpencodeSettingValue(ordered, ["atlas", "oracle"])).toBe(true);
    expect(isValidOpencodeSettingValue(ordered, names(64))).toBe(true);
    expect(isValidOpencodeSettingValue(ordered, names(65))).toBe(false);
    expect(isValidOpencodeSettingValue(ordered, ["ok", ""])).toBe(false); // empty entry
    expect(isValidOpencodeSettingValue(ordered, ["ok", "   "])).toBe(false); // blank entry
    expect(isValidOpencodeSettingValue(ordered, ["x".repeat(64)])).toBe(true);
    expect(isValidOpencodeSettingValue(ordered, ["x".repeat(65)])).toBe(false);
    expect(isValidOpencodeSettingValue(ordered, ["a", "a"])).toBe(false); // dupes
    expect(isValidOpencodeSettingValue(ordered, ["a", " a "])).toBe(false); // trimmed dupes
    expect(isValidOpencodeSettingValue(ordered, [])).toBe(false);
    expect(isValidOpencodeSettingValue(ordered, ["a", 3])).toBe(false);
    expect(isValidOpencodeSettingValue(ordered, "atlas")).toBe(false);
    expect(isValidOpencodeSettingValue(ordered, null)).toBe(true);
  });

  it("whole-key edit: set writes the array as-is, null removes the key", () => {
    expect(opencodeSettingEdits(ordered, ["a", "b"])).toEqual([
      { path: ["instructions"], value: ["a", "b"], op: "set" },
    ]);
    expect(opencodeSettingEdits(ordered, null)).toEqual([{ path: ["instructions"], value: undefined, op: "remove" }]);
  });
});

describe("batch-4 record kinds (readRecordState / readRecordStates)", () => {
  const commandFields: readonly RecordFieldDef[] = setting("command").record?.fields ?? [];
  const formatterFields: readonly RecordFieldDef[] = setting("formatterEntries").record?.fields ?? [];

  it("absent and wrong-shaped values read as unset", () => {
    const unset = { mode: "unset", booleanValue: null, entries: {} };
    expect(readRecordState("{}", ["command"], commandFields)).toEqual(unset);
    expect(readRecordState(JSON.stringify({ command: 42 }), ["command"], commandFields)).toEqual(unset);
    expect(readRecordState(JSON.stringify({ command: "yes" }), ["command"], commandFields)).toEqual(unset);
  });

  it("boolean value reads as the master boolean form", () => {
    expect(readRecordState(JSON.stringify({ formatter: false }), ["formatter"], formatterFields)).toEqual({
      mode: "boolean",
      booleanValue: false,
      entries: {},
    });
    expect(readRecordState(JSON.stringify({ formatter: true }), ["formatter"], formatterFields).booleanValue).toBe(
      true,
    );
  });

  it("object form reads entries, skipping non-object entries entirely", () => {
    const state = readRecordState(
      JSON.stringify({
        command: {
          fix: {
            template: "run fix $ARGUMENTS",
            agent: "build",
            model: "zhipuai/glm-5",
            subtask: true,
            description: "修复",
          },
          broken: "not an object",
          also_broken: 42,
        },
      }),
      ["command"],
      commandFields,
    );
    expect(state).toEqual({
      mode: "entries",
      booleanValue: null,
      entries: {
        fix: {
          template: "run fix $ARGUMENTS",
          agent: "build",
          model: "zhipuai/glm-5",
          subtask: true,
          description: "修复",
        },
      },
    });
  });

  it("wrong-typed leaves are omitted per field; a missing-template entry survives for repair", () => {
    const state = readRecordState(
      JSON.stringify({
        command: { repair: { description: "no template yet", agent: 42, subtask: "yes", model: "no-slash" } },
      }),
      ["command"],
      commandFields,
    );
    expect(state.entries.repair).toEqual({ description: "no template yet" });
  });

  it("enum leaf outside the options and wrong-shaped stringList leaves are omitted on read", () => {
    const state = readRecordState(
      JSON.stringify({ command: { x: { template: "t", agent: "bogus" } } }),
      ["command"],
      commandFields,
    );
    expect(state.entries.x).toEqual({ template: "t" });

    const formatter = readRecordState(
      JSON.stringify({ formatter: { prettier: { command: ["npx", "prettier"], extensions: "ts", disabled: 1 } } }),
      ["formatter"],
      formatterFields,
    );
    expect(formatter.entries.prettier).toEqual({ command: ["npx", "prettier"] });
  });

  it("validator-incompatible leaves are omitted on read: empty/whitespace and over-maxLen text", () => {
    const state = readRecordState(
      JSON.stringify({
        command: {
          x: { template: "t", description: " ", subtask: true },
          y: { template: "t", description: "x".repeat(257) },
        },
      }),
      ["command"],
      commandFields,
    );
    expect(state.entries.x).toEqual({ template: "t", subtask: true });
    expect(state.entries.y).toEqual({ template: "t" });
  });

  it("stringList reads filter to unique entries within maxEntries (0 → omit)", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `e${i}`);
    const state = readRecordState(
      JSON.stringify({
        lsp: {
          dup: { extensions: ["ts", "ts", " ts "] },
          empty: { extensions: [] },
          capped: { extensions: nine },
        },
      }),
      ["lsp"],
      setting("lspEntries").record?.fields ?? [],
    );
    expect(state.entries.dup).toEqual({ extensions: ["ts"] });
    expect(state.entries.empty).toEqual({});
    expect(state.entries.capped).toEqual({ extensions: nine.slice(0, 8) });
  });

  it("readRecordStates materializes the three payload slots from the recordEditor descriptors", () => {
    const states = readRecordStates(
      JSON.stringify({ command: { fix: { template: "t" } }, formatter: false, lsp: { broken: "skip me" } }),
    );
    expect(states.command).toEqual({ mode: "entries", booleanValue: null, entries: { fix: { template: "t" } } });
    expect(states.formatter).toEqual({ mode: "boolean", booleanValue: false, entries: {} });
    expect(states.lsp).toEqual({ mode: "entries", booleanValue: null, entries: {} });
    expect(readRecordStates("{}")).toEqual({
      command: { mode: "unset", booleanValue: null, entries: {} },
      formatter: { mode: "unset", booleanValue: null, entries: {} },
      lsp: { mode: "unset", booleanValue: null, entries: {} },
    });
  });
});

describe("recordEditorEdits / recordMasterEdits", () => {
  it("emits one set/remove per name; object entries set with null leaves pruned", () => {
    expect(recordEditorEdits(["command"], { fix: { template: "t", description: null }, old: null })).toEqual([
      { path: ["command", "fix"], value: { template: "t" }, op: "set" },
      { path: ["command", "old"], value: undefined, op: "remove" },
    ]);
  });

  it("a pruned-empty entry removes the name instead of writing {}", () => {
    expect(recordEditorEdits(["command"], { fix: { template: null, description: null } })).toEqual([
      { path: ["command", "fix"], value: undefined, op: "remove" },
    ]);
    expect(
      applyEdits('{"command":{"fix":{"template":"t"}}}', recordEditorEdits(["command"], { fix: {} })),
    ).not.toContain('"fix"');
  });

  it("names absent from the map stay untouched (broken + intact siblings survive a write)", () => {
    const seeded = '{\n  "command": {\n    "broken": "not an object",\n    "keep": { "template": "k" },\n  },\n}\n';
    const next = applyEdits(seeded, recordEditorEdits(["command"], { fresh: { template: "n" } }));
    expect(getValue(next, ["command", "broken"])).toBe("not an object");
    expect(getValue(next, ["command", "keep"])).toEqual({ template: "k" });
    expect(getValue(next, ["command", "fresh"])).toEqual({ template: "n" });
  });

  it("rename = old name null + new name set in one value", () => {
    const next = applyEdits(
      '{"command":{"old":{"template":"t"}}}',
      recordEditorEdits(["command"], { old: null, new: { template: "t" } }),
    );
    expect(getValue(next, ["command"])).toEqual({ new: { template: "t" } });
  });

  it("sibling JSONC comments survive the per-name edits", () => {
    const seeded = '// top\n{\n  "command": {\n    // user note\n    "a": { "template": "t", "custom": 1 },\n  },\n}\n';
    const next = applyEdits(seeded, recordEditorEdits(["command"], { b: { template: "x" } }));
    expect(next).toContain("// top");
    expect(next).toContain("// user note");
    expect(getValue(next, ["command", "a"])).toEqual({ template: "t", custom: 1 });
  });

  it("recordEditorEdits itself null-guards raw null / non-record input to no edits", () => {
    expect(recordEditorEdits(["command"], null)).toEqual([]);
    expect(recordEditorEdits(["command"], "nope")).toEqual([]);
    expect(recordEditorEdits(["command"], {})).toEqual([]);
  });

  it("descriptor dispatch turns a null recordEditor value into a whole-key remove (empty → null 整键)", () => {
    expect(opencodeSettingEdits(setting("command"), null)).toEqual([
      { path: ["command"], value: undefined, op: "remove" },
    ]);
    expect(opencodeSettingEdits(setting("formatterEntries"), null)).toEqual([
      { path: ["formatter"], value: undefined, op: "remove" },
    ]);
    // Deleting the LAST entry must leave no `command` key on disk (not a `{}` residue).
    expect(
      applyEdits('{"command":{"fix":{"template":"t"}}}', opencodeSettingEdits(setting("command"), null)),
    ).not.toContain('"command"');
  });

  it("recordMasterEdits: true/false set the boolean, null removes the key", () => {
    expect(recordMasterEdits(["formatter"], false)).toEqual([{ path: ["formatter"], value: false, op: "set" }]);
    expect(recordMasterEdits(["formatter"], true)).toEqual([{ path: ["formatter"], value: true, op: "set" }]);
    expect(recordMasterEdits(["formatter"], null)).toEqual([{ path: ["formatter"], value: undefined, op: "remove" }]);
  });

  it("opencodeSettingEdits dispatches the new kinds to the record builders", () => {
    expect(opencodeSettingEdits(setting("formatterMaster"), false)).toEqual([
      { path: ["formatter"], value: false, op: "set" },
    ]);
    expect(opencodeSettingEdits(setting("lspMaster"), null)).toEqual([
      { path: ["lsp"], value: undefined, op: "remove" },
    ]);
    expect(opencodeSettingEdits(setting("lspEntries"), { rust: { command: ["rust-analyzer"] } })).toEqual([
      { path: ["lsp", "rust"], value: { command: ["rust-analyzer"] }, op: "set" },
    ]);
  });
});

describe("recordEditor / recordMaster validation", () => {
  const command = setting("command");
  const lspEntries = setting("lspEntries");
  const formatterMaster = setting("formatterMaster");

  it("recordEditor: accepts well-formed entries, delete markers, empty maps and null", () => {
    expect(
      isValidOpencodeSettingValue(command, {
        fix: { template: "run $ARGUMENTS", agent: "build", model: "zhipuai/glm-5", subtask: true, description: "x" },
      }),
    ).toBe(true);
    expect(isValidOpencodeSettingValue(command, { fix: null })).toBe(true);
    expect(isValidOpencodeSettingValue(command, {})).toBe(true);
    expect(isValidOpencodeSettingValue(command, null)).toBe(true);
  });

  it("recordEditor: name charset, name length and the 32-entry cap", () => {
    expect(isValidOpencodeSettingValue(command, { "bad name!": { template: "t" } })).toBe(false);
    expect(isValidOpencodeSettingValue(command, { "with/slash": { template: "t" } })).toBe(false);
    expect(isValidOpencodeSettingValue(command, { ["x".repeat(64)]: { template: "t" } })).toBe(true);
    expect(isValidOpencodeSettingValue(command, { ["x".repeat(65)]: { template: "t" } })).toBe(false);
    const entries = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`cmd-${i}`, { template: "t" }]));
    expect(isValidOpencodeSettingValue(command, entries(32))).toBe(true);
    expect(isValidOpencodeSettingValue(command, entries(33))).toBe(false);
  });

  it("recordEditor: required template must be present as a non-empty trimmed string", () => {
    expect(isValidOpencodeSettingValue(command, { fix: {} })).toBe(false);
    expect(isValidOpencodeSettingValue(command, { fix: { template: null } })).toBe(false);
    expect(isValidOpencodeSettingValue(command, { fix: { template: "" } })).toBe(false);
    expect(isValidOpencodeSettingValue(command, { fix: { template: "   " } })).toBe(false);
    expect(isValidOpencodeSettingValue(command, { fix: { description: "no template" } })).toBe(false);
  });

  it("recordEditor: text ≤256 and multiline ≤8000 default bounds", () => {
    expect(isValidOpencodeSettingValue(command, { fix: { template: "x".repeat(8000) } })).toBe(true);
    expect(isValidOpencodeSettingValue(command, { fix: { template: "x".repeat(8001) } })).toBe(false);
    expect(isValidOpencodeSettingValue(command, { fix: { template: "t", description: "x".repeat(256) } })).toBe(true);
    expect(isValidOpencodeSettingValue(command, { fix: { template: "t", description: "x".repeat(257) } })).toBe(false);
  });

  it("recordEditor: enum ∈ options, model id shape, boolean leaves, unknown field keys rejected", () => {
    expect(isValidOpencodeSettingValue(command, { fix: { template: "t", agent: "explore" } })).toBe(true);
    expect(isValidOpencodeSettingValue(command, { fix: { template: "t", agent: "bogus" } })).toBe(false);
    expect(isValidOpencodeSettingValue(command, { fix: { template: "t", model: "zhipuai/glm-5" } })).toBe(true);
    expect(isValidOpencodeSettingValue(command, { fix: { template: "t", model: "bad" } })).toBe(false);
    expect(isValidOpencodeSettingValue(command, { fix: { template: "t", subtask: false } })).toBe(true);
    expect(isValidOpencodeSettingValue(command, { fix: { template: "t", subtask: "yes" } })).toBe(false);
    expect(isValidOpencodeSettingValue(command, { fix: { template: "t", made_up: 1 } })).toBe(false);
    expect(isValidOpencodeSettingValue(command, { fix: "not an object" })).toBe(false);
    expect(isValidOpencodeSettingValue(command, "nope")).toBe(false);
  });

  it("recordEditor: stringList fields cap at 8 unique trimmed non-empty ≤256-char entries; null = unset", () => {
    expect(
      isValidOpencodeSettingValue(lspEntries, { typescript: { command: ["tsgo"], extensions: ["ts", "tsx"] } }),
    ).toBe(true);
    const exts = (count: number) => Array.from({ length: count }, (_, i) => `e${i}`);
    expect(isValidOpencodeSettingValue(lspEntries, { l: { extensions: exts(8) } })).toBe(true);
    expect(isValidOpencodeSettingValue(lspEntries, { l: { extensions: exts(9) } })).toBe(false);
    expect(isValidOpencodeSettingValue(lspEntries, { l: { extensions: ["ts", "ts"] } })).toBe(false);
    expect(isValidOpencodeSettingValue(lspEntries, { l: { extensions: [] } })).toBe(false);
    expect(isValidOpencodeSettingValue(lspEntries, { l: { extensions: ["  "] } })).toBe(false);
    expect(isValidOpencodeSettingValue(lspEntries, { l: { extensions: ["x".repeat(256)] } })).toBe(true);
    expect(isValidOpencodeSettingValue(lspEntries, { l: { extensions: ["x".repeat(257)] } })).toBe(false);
    expect(isValidOpencodeSettingValue(lspEntries, { l: { extensions: null, command: null, disabled: null } })).toBe(
      true,
    );
  });

  it("recordMaster: true/false/null only", () => {
    expect(isValidOpencodeSettingValue(formatterMaster, true)).toBe(true);
    expect(isValidOpencodeSettingValue(formatterMaster, false)).toBe(true);
    expect(isValidOpencodeSettingValue(formatterMaster, null)).toBe(true);
    expect(isValidOpencodeSettingValue(formatterMaster, "yes")).toBe(false);
    expect(isValidOpencodeSettingValue(formatterMaster, { a: {} })).toBe(false);
  });

  it("recordEditor/recordMaster keys stay out of the scalar values map", () => {
    const values = readOpencodeSettingValues(
      JSON.stringify({ command: { fix: { template: "t" } }, formatter: false, lsp: true }),
    );
    for (const key of ["command", "formatterMaster", "formatterEntries", "lspMaster", "lspEntries"]) {
      expect(Object.hasOwn(values, key)).toBe(false);
    }
  });
});

describe("record read coercion stays validator-aligned (golden pin)", () => {
  const fieldKinds: readonly RecordFieldDef[] = [
    { key: "text", kind: "text", label: "文本" },
    { key: "multiline", kind: "multiline", label: "多行" },
    { key: "boolean", kind: "boolean", label: "开关" },
    { key: "enum", kind: "enum", label: "枚举", options: ["a"] },
    { key: "model", kind: "model", label: "模型" },
    { key: "list", kind: "stringList", label: "列表" },
  ];
  // Synthetic recordEditor descriptor over the same fields: validating the read
  // result through it exercises exactly isValidRecordFieldLeaf per surviving leaf.
  const descriptor: OpencodeSetting = { ...setting("command"), record: { fields: [...fieldKinds] } };
  const badValues: unknown[] = [
    "",
    " ",
    [],
    ["a", "a"],
    Array.from({ length: 9 }, (_, i) => `e${i}`),
    "x".repeat(257),
    true,
    42,
  ];

  it("coerceRecordField(f, x) !== undefined implies isValidRecordFieldLeaf(f, x) for every kind", () => {
    for (const field of fieldKinds) {
      for (const bad of badValues) {
        const state = readRecordState(
          JSON.stringify({ command: { entry: { [field.key]: bad } } }),
          ["command"],
          fieldKinds,
        );
        const leaf = state.entries.entry?.[field.key];
        if (leaf !== undefined) {
          expect(isValidOpencodeSettingValue(descriptor, { entry: { [field.key]: leaf } })).toBe(true);
        }
      }
    }
  });
});
