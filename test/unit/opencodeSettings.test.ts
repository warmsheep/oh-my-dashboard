import { describe, expect, it } from "vitest";

import { applyEdits, getValue } from "../../src/core/jsoncEditor";
import {
  extractShallowObjectValue,
  isValidOpencodeSettingValue,
  isValidShallowObjectLeaf,
  opencodeSettingEdits,
  readOpencodeSettingValues,
  readPermissionState,
  readPluginProtected,
  readRecordState,
  readRecordStates,
  recordEditorEdits,
  recordMasterEdits,
  shallowObjectEdits,
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
  "mcpEntries",
  "tuiTheme",
  "command",
  "formatterMaster",
  "formatterEntries",
  "lspMaster",
  "lspEntries",
  "providerEntries",
  "referenceEntries",
];

/** All-null agent extras map — the read of an agent entry that carries no extras leaves. */
function nullAgentExtras() {
  return {
    prompt: null,
    hidden: null,
    color: null,
    top_p: null,
    "permission.edit": null,
    "permission.bash": null,
    "permission.webfetch": null,
    "permission.task": null,
    "permission.doom_loop": null,
    "permission.external_directory": null,
  };
}

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
      enabled_providers: ["zhipuai"],
      agent: {
        build: { model: "a/b", temperature: 0.7, steps: 40 },
        plan: { model: "c/d", disable: true, steps: 20 },
        general: { steps: 15 },
        explore: { steps: 25 },
      },
      permission: "ask",
      instructions: [".cursor/rules", "docs/guide.md"],
      plugin: ["@opencontext/amplify", "my-plugin@2.1.0", "@scoped/pkg@1.2.3"],
      compaction: {
        auto: false,
        prune: true,
        tail_turns: 7,
        preserve_recent_tokens: 2048,
        reserved: 1024,
        bogus: "not a descriptor field",
      },
      skills: { paths: ["/opt/skills"], urls: ["https://example.com/.well-known/skills/"] },
      experimental: {
        batch_tool: true,
        openTelemetry: false,
        disable_paste_summary: true,
        continue_loop_on_deny: false,
        mcp_timeout: 5000,
        primary_tools: ["task"],
      },
      logLevel: "WARN",
      shell: "/bin/fish",
      subagent_depth: 2,
      server: { port: 4096, hostname: "0.0.0.0", mdns: true, mdnsDomain: "lan.local", cors: ["https://a.example"] },
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
      enabledProviders: ["zhipuai"],
      agentBuildModel: "a/b",
      agentPlanModel: "c/d",
      permissionShorthand: "ask",
      permissionTools: null, // string form → the payload permission aggregate carries it
      instructions: [".cursor/rules", "docs/guide.md"],
      pluginEntries: ["@opencontext/amplify", "my-plugin@2.1.0", "@scoped/pkg@1.2.3"],
      compaction: { auto: false, prune: true, tail_turns: 7, preserve_recent_tokens: 2048, reserved: 1024 },
      agentBuildDisable: null,
      agentBuildTemperature: 0.7,
      agentBuildSteps: 40,
      agentBuildExtras: nullAgentExtras(),
      agentPlanDisable: true,
      agentPlanTemperature: null,
      agentPlanSteps: 20,
      agentPlanExtras: nullAgentExtras(),
      agentGeneralModel: null,
      agentGeneralSteps: 15,
      agentGeneralTemperature: null,
      agentGeneralDisable: null,
      agentGeneralExtras: nullAgentExtras(),
      agentExploreModel: null,
      agentExploreSteps: 25,
      agentExploreTemperature: null,
      agentExploreDisable: null,
      agentExploreExtras: nullAgentExtras(),
      skillsPaths: ["/opt/skills"],
      skillsUrls: ["https://example.com/.well-known/skills/"],
      expBatchTool: true,
      expOpenTelemetry: false,
      expDisablePasteSummary: true,
      expContinueLoopOnDeny: false,
      expMcpTimeout: 5000,
      expPrimaryTools: ["task"],
      logLevel: "WARN",
      shell: "/bin/fish",
      subagentDepth: 2,
      serverConfig: {
        port: 4096,
        hostname: "0.0.0.0",
        mdns: true,
        mdnsDomain: "lan.local",
        cors: ["https://a.example"],
      },
      toolOutput: null,
      attachmentImage: null,
      watcherIgnore: null,
    });
  });

  it("returns null for absent keys on empty text; mcpEntries/tuiTheme keys stay out of the scalar map", () => {
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
      JSON.stringify({ compaction: { auto: "yes", prune: false, tail_turns: 1.5, reserved: "1024" } }),
    );
    expect(values.compaction).toEqual({
      auto: null,
      prune: false,
      tail_turns: null,
      preserve_recent_tokens: null,
      reserved: null,
    });
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

  it("enum: accepts listed options only (share table)", () => {
    const share = setting("share");
    expect(isValidOpencodeSettingValue(share, "manual")).toBe(true);
    expect(isValidOpencodeSettingValue(share, "auto")).toBe(true);
    expect(isValidOpencodeSettingValue(share, "disabled")).toBe(true);
    expect(isValidOpencodeSettingValue(share, "nope")).toBe(false);
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

  it("string: accepts trimmed 1..64 chars, rejects empty, blank, over-long and non-string values", () => {
    const username = setting("username");
    expect(isValidOpencodeSettingValue(username, "alice")).toBe(true);
    expect(isValidOpencodeSettingValue(username, " alice ")).toBe(true); // validated on the trimmed form
    expect(isValidOpencodeSettingValue(username, "")).toBe(false);
    expect(isValidOpencodeSettingValue(username, "   ")).toBe(false); // blank after trim
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

  it("readRecordStates materializes the payload slots from the recordEditor descriptors", () => {
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
      mcp: { mode: "unset", booleanValue: null, entries: {} },
      provider: { mode: "unset", booleanValue: null, entries: {} },
      references: { mode: "unset", booleanValue: null, entries: {} },
    });
  });
});

describe("recordEditorEdits / recordMasterEdits", () => {
  // Batch-8 semantic change: entries are edited PER LEAF (one edit per field present
  // in the submitted entry object), replacing the batch-4 whole-entry set. A touched
  // entry's hand-written unknown leaves now survive UI edits (the provider safety
  // contract); name removal is ONLY the explicit null entry marker.
  it("emits one set/remove edit per LEAF; null entries remove the name", () => {
    expect(recordEditorEdits(["command"], { fix: { template: "t", description: null }, old: null })).toEqual([
      { path: ["command", "fix", "template"], value: "t", op: "set" },
      { path: ["command", "fix", "description"], value: undefined, op: "remove" },
      { path: ["command", "old"], value: undefined, op: "remove" },
    ]);
  });

  it("editing one field of a touched mcp entry is a single leaf edit (no whole-entry set)", () => {
    expect(opencodeSettingEdits(setting("mcpEntries"), { context7: { url: "https://x/mcp" } })).toEqual([
      { path: ["mcp", "context7", "url"], value: "https://x/mcp", op: "set" },
    ]);
  });

  it("unknown hand-written leaves inside a touched entry survive byte-identically", () => {
    const seeded =
      '{\n  "mcp": {\n    "ctx": { "type": "local", "command": ["x"], "oauth": { "client_id": "secret" } },\n  },\n}\n';
    const snippet = /"oauth"\s*:\s*\{[^}]*\}/.exec(seeded)?.[0] ?? "";
    const next = applyEdits(seeded, recordEditorEdits(["mcp"], { ctx: { type: "local" } }));
    expect(next).toContain(snippet);
    expect(getValue(next, ["mcp", "ctx", "command"])).toEqual(["x"]);
    expect(getValue(next, ["mcp", "ctx", "type"])).toBe("local");
  });

  it("an entry whose submitted object has no fields emits NO edits (name survives)", () => {
    expect(recordEditorEdits(["command"], { fix: {} })).toEqual([]);
    // Semantic change vs batch-4: the old pruned-empty rule removed the name; the
    // name is now removed only through the explicit null entry marker.
    const next = applyEdits('{"command":{"fix":{"template":"t"}}}', recordEditorEdits(["command"], { fix: {} }));
    expect(getValue(next, ["command", "fix"])).toEqual({ template: "t" });
  });

  it("stringMap markers under per-leaf semantics: an all-marker (or empty) map removes only the leaf", () => {
    expect(recordEditorEdits(["mcp"], { ctx: { headers: { "x-api-key": null } } })).toEqual([
      { path: ["mcp", "ctx", "headers"], value: undefined, op: "remove" },
    ]);
    expect(recordEditorEdits(["mcp"], { ctx: { headers: {} } })).toEqual([
      { path: ["mcp", "ctx", "headers"], value: undefined, op: "remove" },
    ]);
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
      { path: ["lsp", "rust", "command"], value: ["rust-analyzer"], op: "set" },
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

describe("batch-5 mcpEntries recordEditor (MCP 服务器)", () => {
  const mcpFields: readonly RecordFieldDef[] = setting("mcpEntries").record?.fields ?? [];

  it("descriptor replaces the batch-2 mcpServers kind with the batch-4+ field vocabulary", () => {
    const descriptor = setting("mcpEntries");
    expect(descriptor.kind).toBe("recordEditor");
    expect(descriptor.path).toEqual(["mcp"]);
    expect(descriptor.record?.fields.map((field) => [field.key, field.kind])).toEqual([
      ["type", "enum"],
      ["url", "text"],
      ["command", "stringList"],
      ["enabled", "boolean"],
      ["environment", "stringMap"],
      ["headers", "stringMap"],
      ["timeout", "number"],
      ["cwd", "text"],
    ]);
    expect(descriptor.record?.fields.find((field) => field.key === "type")?.required).toBe(true);
    expect(OPENCODE_SETTINGS.some((entry) => entry.key === "mcpServers")).toBe(false);
  });

  it("readRecordState on mcp: object entries surface per field, broken entries are skipped", () => {
    const state = readRecordState(
      JSON.stringify({
        mcp: {
          context7: { type: "remote", url: "https://context7.example.internal/mcp", enabled: false },
          local: { type: "local", command: ["npx", "-y", "some-server"] },
          broken: "not an object",
          partial: { url: "https://x.example/mcp" },
        },
      }),
      ["mcp"],
      mcpFields,
    );
    expect(state.mode).toBe("entries");
    expect(state.entries.context7).toEqual({
      type: "remote",
      url: "https://context7.example.internal/mcp",
      enabled: false,
    });
    expect(state.entries.local).toEqual({ type: "local", command: ["npx", "-y", "some-server"] });
    expect(state.entries.partial).toEqual({ url: "https://x.example/mcp" }); // broken enum leaf omitted, entry survives
    expect(state.entries.broken).toBeUndefined();
  });

  it("readRecordStates materializes the mcp slot alongside command/formatter/lsp", () => {
    const states = readRecordStates(JSON.stringify({ mcp: { context7: { type: "remote", url: "https://x/mcp" } } }));
    expect(states.mcp).toEqual({
      mode: "entries",
      booleanValue: null,
      entries: { context7: { type: "remote", url: "https://x/mcp" } },
    });
    expect(readRecordStates("{}").mcp).toEqual({ mode: "unset", booleanValue: null, entries: {} });
  });

  it("validator: remote entries require a non-empty url (cross-field rule), local entries tolerate a missing command", () => {
    const descriptor = setting("mcpEntries");
    expect(isValidOpencodeSettingValue(descriptor, { remote1: { type: "remote", url: "https://x/mcp" } })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, { remote2: { type: "remote" } })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { remote3: { type: "remote", url: null } })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { remote4: { type: "remote", url: "" } })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { remote5: { type: "remote", url: "   " } })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { local1: { type: "local" } })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, { local2: { type: "local", command: ["npx", "srv"] } })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, { old: null })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, {})).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, null)).toBe(true);
  });

  it("validator: type is a required enum leaf and unknown fields are rejected", () => {
    const descriptor = setting("mcpEntries");
    expect(isValidOpencodeSettingValue(descriptor, { noType: { url: "https://x/mcp" } })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { badType: { type: "hybrid", url: "https://x/mcp" } })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { extra: { type: "local", made_up: 1 } })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { notAnEntry: "nope" })).toBe(false);
  });

  it("edits round-trip: set a remote entry, toggle enabled, delete via a null entry — siblings untouched", () => {
    const seeded =
      '{\n  "mcp": {\n    // user note\n    "keep": { "type": "local", "command": ["npx", "keep"] },\n  },\n}\n';
    const next = applyEdits(
      seeded,
      opencodeSettingEdits(setting("mcpEntries"), {
        context7: { type: "remote", url: "https://context7.example.internal/mcp", enabled: false },
      }),
    );
    expect(getValue(next, ["mcp", "context7"])).toEqual({
      type: "remote",
      url: "https://context7.example.internal/mcp",
      enabled: false,
    });
    expect(getValue(next, ["mcp", "keep"])).toEqual({ type: "local", command: ["npx", "keep"] });
    expect(next).toContain("// user note");

    // Per-leaf semantics (batch-8): clearing a field needs the explicit null leaf —
    // merely omitting it would leave the on-disk enabled:false untouched.
    const toggled = applyEdits(
      next,
      opencodeSettingEdits(setting("mcpEntries"), {
        context7: { type: "remote", url: "https://context7.example.internal/mcp", enabled: null },
      }),
    );
    expect(getValue(toggled, ["mcp", "context7"])).toEqual({
      type: "remote",
      url: "https://context7.example.internal/mcp",
    });

    // The core safety property of the per-leaf refactor: an omitted field leaves the
    // on-disk leaf alone (unknown/hand-written leaves are never collateral damage).
    const untouched = applyEdits(
      toggled,
      opencodeSettingEdits(setting("mcpEntries"), { context7: { url: "https://ctx2.example.internal/mcp" } }),
    );
    expect(getValue(untouched, ["mcp", "context7"])).toEqual({
      type: "remote",
      url: "https://ctx2.example.internal/mcp",
    });

    const deleted = applyEdits(toggled, opencodeSettingEdits(setting("mcpEntries"), { context7: null }));
    expect(getValue(deleted, ["mcp", "context7"])).toBeUndefined();
    expect(getValue(deleted, ["mcp", "keep"])).toEqual({ type: "local", command: ["npx", "keep"] });
  });

  it("mcpEntries values never enter the scalar values map (rides payload.records.mcp)", () => {
    const values = readOpencodeSettingValues(
      JSON.stringify({ mcp: { context7: { type: "remote", url: "https://x/mcp" } } }),
    );
    expect(Object.hasOwn(values, "mcpEntries")).toBe(false);
  });
});

describe("batch-8 referenceEntries recordEditor (参考仓库)", () => {
  const refFields: readonly RecordFieldDef[] = setting("referenceEntries").record?.fields ?? [];

  it("descriptor pins the field vocabulary right after the instructions row", () => {
    const descriptor = setting("referenceEntries");
    expect(descriptor.kind).toBe("recordEditor");
    expect(descriptor.path).toEqual(["references"]);
    expect(descriptor.group).toBe("规则文件");
    expect(descriptor.label).toBe("参考仓库");
    expect(descriptor.record?.fields.map((field) => [field.key, field.kind])).toEqual([
      ["repository", "text"],
      ["branch", "text"],
      ["path", "text"],
      ["description", "text"],
      ["hidden", "boolean"],
    ]);
    // Semantic neighbor: the entries row sits directly under the instructions row.
    const instructionsIndex = OPENCODE_SETTINGS.findIndex((entry) => entry.key === "instructions");
    expect(OPENCODE_SETTINGS.findIndex((entry) => entry.key === "referenceEntries")).toBe(instructionsIndex + 1);
    // The deprecated singular `reference` alias stays unexposed (hand-edit only).
    expect(OPENCODE_SETTINGS.some((entry) => entry.path[0] === "reference")).toBe(false);
  });

  it("readRecordState on references: object entries (git + local variants) surface per field; string shorthand stays invisible", () => {
    const state = readRecordState(
      JSON.stringify({
        references: {
          docs: { repository: "https://github.com/opencode/docs", branch: "main", description: "docs", hidden: true },
          localrules: { path: "./docs/rules", description: "local" },
          shorthand: "https://github.com/owner/repo",
          broken: "not an object",
          wrongshaped: { repository: "https://x", branch: 3, hidden: "yes" },
        },
      }),
      ["references"],
      refFields,
    );
    expect(state.mode).toBe("entries");
    expect(state.entries.docs).toEqual({
      repository: "https://github.com/opencode/docs",
      branch: "main",
      description: "docs",
      hidden: true,
    });
    expect(state.entries.localrules).toEqual({ path: "./docs/rules", description: "local" });
    // String-shorthand entries are not representable in the recordEditor protocol
    // (entries are objects) — they stay invisible in the UI but survive on disk.
    expect(state.entries.shorthand).toBeUndefined();
    expect(state.entries.broken).toBeUndefined();
    // Wrong-shaped field values degrade per-kind (branch number / hidden string omitted).
    expect(state.entries.wrongshaped).toEqual({ repository: "https://x" });
  });

  it("readRecordStates materializes the references slot alongside command/formatter/lsp/mcp/provider", () => {
    const states = readRecordStates(JSON.stringify({ references: { docs: { repository: "https://x" } } }));
    expect(states.references).toEqual({
      mode: "entries",
      booleanValue: null,
      entries: { docs: { repository: "https://x" } },
    });
    expect(readRecordStates("{}").references).toEqual({ mode: "unset", booleanValue: null, entries: {} });
  });

  it("validator: exactly one of repository/path (cross-field rule); branch rides only on the repository form", () => {
    const descriptor = setting("referenceEntries");
    // Valid: git form (branch optional) and local form.
    expect(isValidOpencodeSettingValue(descriptor, { repo1: { repository: "https://github.com/a/b" } })).toBe(true);
    expect(
      isValidOpencodeSettingValue(descriptor, { repo2: { repository: "https://github.com/a/b", branch: "dev" } }),
    ).toBe(true);
    expect(
      isValidOpencodeSettingValue(descriptor, {
        repo3: { repository: "https://x", branch: "main", description: "d", hidden: false },
      }),
    ).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, { local1: { path: "./docs/rules" } })).toBe(true);
    expect(
      isValidOpencodeSettingValue(descriptor, { local2: { path: "./docs", description: "d", hidden: true } }),
    ).toBe(true);
    // Rejected: both set / neither / branch without repository.
    expect(isValidOpencodeSettingValue(descriptor, { both: { repository: "https://x", path: "./y" } })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { neither: {} })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { neither2: { description: "d" } })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { orphan: { path: "./y", branch: "main" } })).toBe(false);
    // Blank text leaves die at the field kind (trimmed non-empty), before the coupling.
    expect(isValidOpencodeSettingValue(descriptor, { blank: { repository: "   ", path: "./y" } })).toBe(false);
    // Null markers / empty map / null value stay valid.
    expect(isValidOpencodeSettingValue(descriptor, { old: null })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, {})).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, null)).toBe(true);
  });

  it("validator: unknown fields are rejected like every recordEditor kind", () => {
    const descriptor = setting("referenceEntries");
    expect(isValidOpencodeSettingValue(descriptor, { extra: { repository: "https://x", made_up: 1 } })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { notAnEntry: "nope" })).toBe(false);
  });

  it("edits round-trip: per-leaf writes, field edit, null-marker delete — string-shorthand sibling and comments survive", () => {
    const seeded =
      '{\n  "references": {\n    // user note\n    "shorthand": "https://github.com/owner/repo",\n  },\n}\n';
    const next = applyEdits(
      seeded,
      opencodeSettingEdits(setting("referenceEntries"), {
        docs: { repository: "https://github.com/opencode/docs", branch: "main", hidden: true },
      }),
    );
    expect(getValue(next, ["references", "docs"])).toEqual({
      repository: "https://github.com/opencode/docs",
      branch: "main",
      hidden: true,
    });
    expect(getValue(next, ["references", "shorthand"])).toBe("https://github.com/owner/repo");
    expect(next).toContain("// user note");

    // Per-leaf semantics: editing ONE field leaves the other on-disk leaves alone.
    const edited = applyEdits(next, opencodeSettingEdits(setting("referenceEntries"), { docs: { branch: "dev" } }));
    expect(getValue(edited, ["references", "docs"])).toEqual({
      repository: "https://github.com/opencode/docs",
      branch: "dev",
      hidden: true,
    });
    // The string-shorthand sibling stays byte-identical.
    expect(edited).toContain('"shorthand": "https://github.com/owner/repo"');

    // Null marker removes the name; the shorthand sibling and the comment stay.
    const deleted = applyEdits(edited, opencodeSettingEdits(setting("referenceEntries"), { docs: null }));
    expect(getValue(deleted, ["references", "docs"])).toBeUndefined();
    expect(deleted).toContain('"shorthand": "https://github.com/owner/repo"');
    expect(deleted).toContain("// user note");
  });

  it("referenceEntries values never enter the scalar values map (rides payload.records.references)", () => {
    const values = readOpencodeSettingValues(JSON.stringify({ references: { docs: { repository: "https://x" } } }));
    expect(Object.hasOwn(values, "referenceEntries")).toBe(false);
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

describe("batch-6 descriptors (供应商白名单 / 智能体步数 / 压缩缓冲 / 技能 / 实验特性)", () => {
  it("defaultAgent: string kind — trimmed non-empty ≤maxLen, custom primary names accepted", () => {
    const agent = setting("defaultAgent");
    expect(agent.kind).toBe("string");
    expect(agent.maxLen).toBe(64);
    expect(isValidOpencodeSettingValue(agent, "build")).toBe(true);
    expect(isValidOpencodeSettingValue(agent, "plan")).toBe(true);
    expect(isValidOpencodeSettingValue(agent, "custom-agent")).toBe(true); // any primary agent name
    expect(isValidOpencodeSettingValue(agent, " plan ")).toBe(true); // validated on the trimmed form
    expect(isValidOpencodeSettingValue(agent, "")).toBe(false);
    expect(isValidOpencodeSettingValue(agent, "   ")).toBe(false); // blank after trim
    expect(isValidOpencodeSettingValue(agent, "x".repeat(64))).toBe(true);
    expect(isValidOpencodeSettingValue(agent, "x".repeat(65))).toBe(false);
    expect(isValidOpencodeSettingValue(agent, 42)).toBe(false);
    expect(isValidOpencodeSettingValue(agent, null)).toBe(true);
  });

  it("defaultAgent: old enum values build/plan still write identically; reads degrade wrong shapes", () => {
    const agent = setting("defaultAgent");
    expect(opencodeSettingEdits(agent, "build")).toEqual([{ path: ["default_agent"], value: "build", op: "set" }]);
    expect(opencodeSettingEdits(agent, "plan")).toEqual([{ path: ["default_agent"], value: "plan", op: "set" }]);
    expect(opencodeSettingEdits(agent, null)).toEqual([{ path: ["default_agent"], value: undefined, op: "remove" }]);
    expect(readOpencodeSettingValues(JSON.stringify({ default_agent: "general" })).defaultAgent).toBe("general");
    expect(readOpencodeSettingValues("{}").defaultAgent).toBeNull();
    expect(readOpencodeSettingValues(JSON.stringify({ default_agent: 42 })).defaultAgent).toBeNull();
  });

  it("enabledProviders: mirrors the disabledProviders providers rules at enabled_providers", () => {
    const enabled = setting("enabledProviders");
    expect(enabled.kind).toBe("providers");
    expect(enabled.path).toEqual(["enabled_providers"]);
    expect(isValidOpencodeSettingValue(enabled, ["zhipuai", "kimi-chat"])).toBe(true);
    expect(isValidOpencodeSettingValue(enabled, ["zhipuai", "zhipuai"])).toBe(false);
    expect(isValidOpencodeSettingValue(enabled, ["bad name!"])).toBe(false);
    expect(isValidOpencodeSettingValue(enabled, "zhipuai")).toBe(false);
    expect(isValidOpencodeSettingValue(enabled, null)).toBe(true);
    expect(opencodeSettingEdits(enabled, ["zhipuai"])).toEqual([
      { path: ["enabled_providers"], value: ["zhipuai"], op: "set" },
    ]);
    expect(opencodeSettingEdits(enabled, null)).toEqual([
      { path: ["enabled_providers"], value: undefined, op: "remove" },
    ]);
    const values = readOpencodeSettingValues(
      JSON.stringify({ enabled_providers: ["zhipuai"], disabled_providers: ["kimi"] }),
    );
    expect(values.enabledProviders).toEqual(["zhipuai"]);
    expect(values.disabledProviders).toEqual(["kimi"]);
    expect(readOpencodeSettingValues(JSON.stringify({ enabled_providers: ["ok", 3] })).enabledProviders).toBeNull();
    expect(readOpencodeSettingValues("{}").enabledProviders).toBeNull();
  });

  it("agent steps ×4: integer ≥1 at agent.<name>.steps — bounds and nested-path edits", () => {
    const steps: readonly [string, string][] = [
      ["agentBuildSteps", "build"],
      ["agentPlanSteps", "plan"],
      ["agentGeneralSteps", "general"],
      ["agentExploreSteps", "explore"],
    ];
    for (const [key, name] of steps) {
      const desc = setting(key);
      expect(desc.path).toEqual(["agent", name, "steps"]);
      expect(desc.kind).toBe("number");
      expect(desc.integer).toBe(true);
      expect(desc.min).toBe(1); // schema exclusiveMinimum 0
      expect(desc.max).toBeUndefined(); // schema has no max
      expect(isValidOpencodeSettingValue(desc, 1)).toBe(true);
      expect(isValidOpencodeSettingValue(desc, 400)).toBe(true);
      expect(isValidOpencodeSettingValue(desc, 0)).toBe(false);
      expect(isValidOpencodeSettingValue(desc, 1.5)).toBe(false); // integer enforced
      expect(isValidOpencodeSettingValue(desc, "40")).toBe(false);
      expect(isValidOpencodeSettingValue(desc, null)).toBe(true);
      expect(opencodeSettingEdits(desc, 40)).toEqual([{ path: ["agent", name, "steps"], value: 40, op: "set" }]);
      // Nested container semantics: set creates the agent.<name> containers, null drops only the leaf.
      const seeded = applyEdits("{}", opencodeSettingEdits(desc, 40));
      expect(getValue(seeded, ["agent", name])).toEqual({ steps: 40 });
      const removed = applyEdits(seeded, opencodeSettingEdits(desc, null));
      expect(getValue(removed, ["agent", name, "steps"])).toBeUndefined();
      expect(getValue(removed, ["agent", name])).toEqual({});
    }
    const values = readOpencodeSettingValues(JSON.stringify({ agent: { build: { steps: 50 }, plan: { steps: "x" } } }));
    expect(values.agentBuildSteps).toBe(50);
    expect(values.agentPlanSteps).toBeNull(); // wrong shape degrades
    expect(readOpencodeSettingValues("{}").agentExploreSteps).toBeNull();
  });

  it("compaction: preserve_recent_tokens/reserved are integer ≥0 leaves (no documented defaults)", () => {
    const compaction = setting("compaction");
    const fieldKeys = (compaction.fields ?? []).map((field) => field.key);
    expect(fieldKeys).toContain("preserve_recent_tokens");
    expect(fieldKeys).toContain("reserved");
    expect(isValidOpencodeSettingValue(compaction, { preserve_recent_tokens: 0 })).toBe(true);
    expect(isValidOpencodeSettingValue(compaction, { preserve_recent_tokens: 8192, reserved: 4096 })).toBe(true);
    expect(isValidOpencodeSettingValue(compaction, { preserve_recent_tokens: -1 })).toBe(false);
    expect(isValidOpencodeSettingValue(compaction, { preserve_recent_tokens: 1.5 })).toBe(false); // integer enforced
    expect(isValidOpencodeSettingValue(compaction, { reserved: "1024" })).toBe(false);
  });

  it("compaction: a preserve_recent_tokens write keeps hand-written siblings and JSONC comments", () => {
    const compaction = setting("compaction");
    const seeded =
      '// top\n{\n  "compaction": {\n    // user note\n    "auto": true,\n    "prune": false,\n    "tail_turns": 3,\n  },\n}\n';
    const next = applyEdits(seeded, opencodeSettingEdits(compaction, { preserve_recent_tokens: 4096 }));
    expect(getValue(next, ["compaction"])).toEqual({
      auto: true,
      prune: false,
      tail_turns: 3,
      preserve_recent_tokens: 4096,
    });
    expect(next).toContain("// top");
    expect(next).toContain("// user note");
    // Clearing one field sends the full map with a null leaf (the UI contract);
    // only that leaf is removed and the hand-written siblings survive.
    const cleared = applyEdits(
      next,
      opencodeSettingEdits(compaction, { auto: true, prune: false, tail_turns: 3, preserve_recent_tokens: null }),
    );
    expect(getValue(cleared, ["compaction"])).toEqual({ auto: true, prune: false, tail_turns: 3 });
  });

  it("skills: paths/urls read from their own paths; a paths write leaves the urls sibling untouched", () => {
    const paths = setting("skillsPaths");
    const urls = setting("skillsUrls");
    expect(paths.kind).toBe("stringList");
    expect(paths.path).toEqual(["skills", "paths"]);
    expect(urls.kind).toBe("stringList");
    expect(urls.path).toEqual(["skills", "urls"]);
    expect(isValidOpencodeSettingValue(paths, ["/opt/skills"])).toBe(true);
    expect(isValidOpencodeSettingValue(urls, ["https://example.com/.well-known/skills/"])).toBe(true);
    expect(isValidOpencodeSettingValue(paths, [])).toBe(false); // shared stringList rules
    expect(isValidOpencodeSettingValue(paths, ["a", "a"])).toBe(false);
    const next = applyEdits(
      JSON.stringify({ skills: { urls: ["https://example.com/.well-known/skills/"] } }),
      opencodeSettingEdits(paths, ["/opt/skills"]),
    );
    expect(getValue(next, ["skills"])).toEqual({
      paths: ["/opt/skills"],
      urls: ["https://example.com/.well-known/skills/"],
    });
    const values = readOpencodeSettingValues(next);
    expect(values.skillsPaths).toEqual(["/opt/skills"]);
    expect(values.skillsUrls).toEqual(["https://example.com/.well-known/skills/"]);
    expect(readOpencodeSettingValues(JSON.stringify({ skills: { paths: "x" } })).skillsPaths).toBeNull();
    expect(readOpencodeSettingValues("{}").skillsUrls).toBeNull();
  });

  it("experimental: six descriptors at their experimental.* paths with the right kinds/bounds", () => {
    const expected: readonly [string, string[], string][] = [
      ["expBatchTool", ["experimental", "batch_tool"], "boolean"],
      ["expOpenTelemetry", ["experimental", "openTelemetry"], "boolean"],
      ["expDisablePasteSummary", ["experimental", "disable_paste_summary"], "boolean"],
      ["expContinueLoopOnDeny", ["experimental", "continue_loop_on_deny"], "boolean"],
      ["expMcpTimeout", ["experimental", "mcp_timeout"], "number"],
      ["expPrimaryTools", ["experimental", "primary_tools"], "stringList"],
    ];
    for (const [key, path, kind] of expected) {
      const desc = setting(key);
      expect(desc.path).toEqual(path);
      expect(desc.kind).toBe(kind);
    }
    const timeout = setting("expMcpTimeout");
    expect(timeout.integer).toBe(true);
    expect(timeout.min).toBe(1); // schema exclusiveMinimum 0
    expect(isValidOpencodeSettingValue(timeout, 1)).toBe(true);
    expect(isValidOpencodeSettingValue(timeout, 0)).toBe(false);
    expect(isValidOpencodeSettingValue(timeout, 1.5)).toBe(false);
    expect(isValidOpencodeSettingValue(setting("expBatchTool"), true)).toBe(true);
    expect(isValidOpencodeSettingValue(setting("expBatchTool"), "true")).toBe(false);
    expect(isValidOpencodeSettingValue(setting("expPrimaryTools"), ["task", "skill"])).toBe(true);
    expect(isValidOpencodeSettingValue(setting("expPrimaryTools"), [])).toBe(false);
  });

  it("experimental: siblings (incl. the unexposed policies array) survive each other's writes", () => {
    const seeded =
      '{\n  "experimental": {\n    // user note\n    "batch_tool": false,\n    "openTelemetry": true,\n    "disable_paste_summary": false,\n    "continue_loop_on_deny": true,\n    "mcp_timeout": 3000,\n    "primary_tools": ["task"],\n    "policies": [{ "effect": "allow", "resource": "provider::anthropic" }],\n  },\n}\n';
    const next = applyEdits(seeded, opencodeSettingEdits(setting("expBatchTool"), true));
    expect(getValue(next, ["experimental", "batch_tool"])).toBe(true);
    expect(getValue(next, ["experimental", "openTelemetry"])).toBe(true);
    expect(getValue(next, ["experimental", "disable_paste_summary"])).toBe(false);
    expect(getValue(next, ["experimental", "continue_loop_on_deny"])).toBe(true);
    expect(getValue(next, ["experimental", "mcp_timeout"])).toBe(3000);
    expect(getValue(next, ["experimental", "primary_tools"])).toEqual(["task"]);
    expect(getValue(next, ["experimental", "policies"])).toEqual([
      { effect: "allow", resource: "provider::anthropic" },
    ]);
    expect(next).toContain("// user note");
    const removed = applyEdits(next, opencodeSettingEdits(setting("expMcpTimeout"), null));
    expect(getValue(removed, ["experimental", "mcp_timeout"])).toBeUndefined();
    expect(getValue(removed, ["experimental", "batch_tool"])).toBe(true);
    const values = readOpencodeSettingValues(seeded);
    expect(values.expBatchTool).toBe(false);
    expect(values.expOpenTelemetry).toBe(true);
    expect(values.expDisablePasteSummary).toBe(false);
    expect(values.expContinueLoopOnDeny).toBe(true);
    expect(values.expMcpTimeout).toBe(3000);
    expect(values.expPrimaryTools).toEqual(["task"]);
    expect(
      readOpencodeSettingValues(JSON.stringify({ experimental: { mcp_timeout: "5000" } })).expMcpTimeout,
    ).toBeNull();
  });
});

describe("batch-7 serverConfig (shallowObject string/stringList leaves)", () => {
  it("descriptor: path server, group 高级, field vocabulary port/hostname/mdns/mdnsDomain/cors", () => {
    const descriptor = setting("serverConfig");
    expect(descriptor.path).toEqual(["server"]);
    expect(descriptor.kind).toBe("shallowObject");
    expect(descriptor.group).toBe("高级");
    expect(descriptor.fields?.map((field) => [field.key, field.kind])).toEqual([
      ["port", "number"],
      ["hostname", "string"],
      ["mdns", "boolean"],
      ["mdnsDomain", "string"],
      ["cors", "stringList"],
    ]);
    const port = descriptor.fields?.find((field) => field.key === "port");
    expect(port?.min).toBe(1);
    expect(port?.integer).toBe(true); // schema: integer ≥1
  });

  it("read degrades wrong-shape leaves per field and nulls the whole map for non-objects/absence", () => {
    const values = readOpencodeSettingValues(
      JSON.stringify({
        server: { port: "8080", hostname: "127.0.0.1", mdns: "yes", cors: ["https://a.example", 3] },
      }),
    );
    expect(values.serverConfig).toEqual({
      port: null,
      hostname: "127.0.0.1",
      mdns: null,
      mdnsDomain: null,
      cors: null,
    });
    expect(readOpencodeSettingValues("{}").serverConfig).toBeNull();
    expect(readOpencodeSettingValues(JSON.stringify({ server: 42 })).serverConfig).toBeNull();
  });

  it("validator: port integer ≥1, hostname/mdnsDomain bounded strings, cors shared stringList rules", () => {
    const descriptor = setting("serverConfig");
    expect(isValidOpencodeSettingValue(descriptor, { port: 8080 })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, { port: 0 })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { port: 1 })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, { port: 1.5 })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { port: -1 })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { hostname: "0.0.0.0" })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, { hostname: "" })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { hostname: "x".repeat(64) })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, { hostname: "x".repeat(65) })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { hostname: 42 })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { mdns: true })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, { mdnsDomain: "opencode.local" })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, { cors: ["https://a.example"] })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, { cors: [] })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { cors: ["a", "a"] })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { made_up: 1 })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { port: null })).toBe(true); // null leaf = unset
    expect(isValidOpencodeSettingValue(descriptor, null)).toBe(true);
  });

  it("per-leaf edits preserve sibling keys and JSONC comments inside the server object", () => {
    const seeded =
      '{\n  "server": {\n    // user note\n    "hostname": "127.0.0.1",\n    "custom": "sibling",\n  },\n}\n';
    const next = applyEdits(
      seeded,
      opencodeSettingEdits(setting("serverConfig"), {
        port: 4096,
        hostname: "0.0.0.0",
        mdns: null,
        mdnsDomain: null,
        cors: null,
      }),
    );
    expect(getValue(next, ["server"])).toEqual({
      hostname: "0.0.0.0",
      custom: "sibling",
      port: 4096,
    });
    expect(next).toContain("// user note");

    // A null leaf removes just that field key; live siblings stay.
    const removed = applyEdits(
      next,
      opencodeSettingEdits(setting("serverConfig"), {
        port: 4096,
        hostname: null,
        mdns: null,
        mdnsDomain: null,
        cors: null,
      }),
    );
    expect(getValue(removed, ["server"])).toEqual({ custom: "sibling", port: 4096 });
  });
});

describe("batch-7 shallowObject string/stringList leaf kinds", () => {
  const stringField: OpencodeSettingField = { key: "s", kind: "string", label: "字符串" };
  const listField: OpencodeSettingField = { key: "l", kind: "stringList", label: "列表" };

  it("string leaf: trimmed non-empty ≤ maxLen ?? OPENCODE_STRING_VALUE_MAX_LENGTH", () => {
    expect(isValidShallowObjectLeaf(stringField, "host")).toBe(true);
    expect(isValidShallowObjectLeaf(stringField, " host ")).toBe(true);
    expect(isValidShallowObjectLeaf(stringField, "")).toBe(false);
    expect(isValidShallowObjectLeaf(stringField, "   ")).toBe(false);
    expect(isValidShallowObjectLeaf(stringField, "x".repeat(64))).toBe(true);
    expect(isValidShallowObjectLeaf(stringField, "x".repeat(65))).toBe(false);
    expect(isValidShallowObjectLeaf(stringField, 42)).toBe(false);
    const bounded: OpencodeSettingField = { ...stringField, maxLen: 8 };
    expect(isValidShallowObjectLeaf(bounded, "12345678")).toBe(true);
    expect(isValidShallowObjectLeaf(bounded, "123456789")).toBe(false);
  });

  it("stringList leaf: the shared stringList entry rules, no duplicated bounds", () => {
    expect(isValidShallowObjectLeaf(listField, ["a", "b"])).toBe(true);
    expect(isValidShallowObjectLeaf(listField, [])).toBe(false);
    expect(isValidShallowObjectLeaf(listField, ["a", "a"])).toBe(false);
    expect(isValidShallowObjectLeaf(listField, ["a", ""])).toBe(false);
    expect(isValidShallowObjectLeaf(listField, ["x".repeat(257)])).toBe(false);
    expect(
      isValidShallowObjectLeaf(
        listField,
        Array.from({ length: 16 }, (_, i) => `e${i}`),
      ),
    ).toBe(true);
    expect(
      isValidShallowObjectLeaf(
        listField,
        Array.from({ length: 17 }, (_, i) => `e${i}`),
      ),
    ).toBe(false);
    expect(isValidShallowObjectLeaf(listField, "a")).toBe(false);
  });

  it("extractShallowObjectValue degrades invalid string/stringList leaves; valid ones pass through", () => {
    const fields = [stringField, listField];
    expect(extractShallowObjectValue(fields, { s: " x ", l: ["a"] })).toEqual({ s: " x ", l: ["a"] });
    expect(extractShallowObjectValue(fields, { s: "", l: ["a", "a"] })).toEqual({ s: null, l: null });
  });

  it("shallowObjectEdits set/remove string and string-array leaves like every other leaf", () => {
    const set = shallowObjectEdits(["server"], { s: "host", l: ["a"] });
    expect(set).toEqual([
      { path: ["server", "s"], value: "host", op: "set" },
      { path: ["server", "l"], value: ["a"], op: "set" },
    ]);
    const removed = shallowObjectEdits(["server"], { s: null, l: null });
    expect(removed).toEqual([{ path: ["server"], value: undefined, op: "remove" }]);
  });
});

describe("batch-7 mcp record fields (environment/headers/timeout/cwd)", () => {
  const descriptor = setting("mcpEntries");

  it("read: invalid leaves are omitted per field but the entry survives (repairable)", () => {
    const state = readRecordState(
      JSON.stringify({
        mcp: {
          local1: {
            type: "local",
            command: ["npx", "srv"],
            environment: { DEBUG: "1", EMPTY: "", BAD_NUM: 42, BAD_OVER: "x".repeat(513) },
            timeout: "5000",
            cwd: "/srv",
          },
          remote1: { type: "remote", url: "https://x/mcp", headers: "not an object" },
          capped: {
            type: "local",
            environment: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`K${i}`, "v"])),
          },
        },
      }),
      ["mcp"],
      descriptor.record?.fields ?? [],
    );
    expect(state.entries.local1).toEqual({
      type: "local",
      command: ["npx", "srv"],
      environment: { DEBUG: "1", EMPTY: "" },
      cwd: "/srv",
    });
    expect(state.entries.remote1).toEqual({ type: "remote", url: "https://x/mcp" });
    // Read filters to the 16-entry cap (mirror of the write validator's bound).
    expect(Object.keys((state.entries.capped?.environment as Record<string, string>) ?? {})).toHaveLength(16);
  });

  it("write round-trip: full entries incl. maps land on disk; siblings and comments survive", () => {
    const seeded = '{\n  "mcp": {\n    // user note\n    "keep": { "type": "local" },\n  },\n}\n';
    const next = applyEdits(
      seeded,
      opencodeSettingEdits(descriptor, {
        ctx: {
          type: "remote",
          url: "https://ctx.example/mcp",
          headers: { "x-api-key": "secret", "X-Custom": "" },
          timeout: 10000,
        },
        srv: {
          type: "local",
          command: ["npx", "srv"],
          environment: { DEBUG: "1", EMPTY: "" },
          cwd: "/srv",
        },
      }),
    );
    expect(getValue(next, ["mcp", "ctx"])).toEqual({
      type: "remote",
      url: "https://ctx.example/mcp",
      headers: { "x-api-key": "secret", "X-Custom": "" },
      timeout: 10000,
    });
    expect(getValue(next, ["mcp", "srv"])).toEqual({
      type: "local",
      command: ["npx", "srv"],
      environment: { DEBUG: "1", EMPTY: "" },
      cwd: "/srv",
    });
    expect(getValue(next, ["mcp", "keep"])).toEqual({ type: "local" });
    expect(next).toContain("// user note");
  });

  it("null-map entry deletion removes just that key; a null leaf prunes the whole field", () => {
    const seeded = JSON.stringify({
      mcp: { ctx: { type: "remote", url: "https://x/mcp", headers: { "x-api-key": "s", "X-Custom": "" } } },
    });
    // Full-map snapshot (the UI contract): survivors + null markers for deletions.
    const patched = applyEdits(
      seeded,
      opencodeSettingEdits(descriptor, {
        ctx: { type: "remote", url: "https://x/mcp", headers: { "x-api-key": null, "X-Custom": "" } },
      }),
    );
    expect(getValue(patched, ["mcp", "ctx"])).toEqual({
      type: "remote",
      url: "https://x/mcp",
      headers: { "X-Custom": "" },
    });

    // A markers-only map drops the whole field (nothing live remains to keep).
    const markersOnly = applyEdits(
      patched,
      opencodeSettingEdits(descriptor, {
        ctx: { type: "remote", url: "https://x/mcp", headers: { "X-Custom": null } },
      }),
    );
    expect(getValue(markersOnly, ["mcp", "ctx"])).toEqual({ type: "remote", url: "https://x/mcp" });

    const unset = applyEdits(
      markersOnly,
      opencodeSettingEdits(descriptor, {
        ctx: { type: "remote", url: "https://x/mcp", headers: null },
      }),
    );
    expect(getValue(unset, ["mcp", "ctx"])).toEqual({ type: "remote", url: "https://x/mcp" });
  });

  it("validator: timeout number field bounds (integer ≥1 — 0/1.5/-1 rejected)", () => {
    const entry = (timeout: unknown) => ({ a: { type: "local", timeout } });
    expect(isValidOpencodeSettingValue(descriptor, entry(5000))).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, entry(0))).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, entry(1))).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, entry(1.5))).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, entry(-1))).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, entry("5000"))).toBe(false);
    // Absent bounds (a synthetic field) accept any finite number, decimals included.
    const free: OpencodeSetting = {
      ...descriptor,
      record: { fields: [{ key: "n", kind: "number", label: "数" }] },
    };
    expect(isValidOpencodeSettingValue(free, { a: { n: -0.5 } })).toBe(true);
    expect(isValidOpencodeSettingValue(free, { a: { n: Number.POSITIVE_INFINITY } })).toBe(false);
  });

  it("validator: stringMap edges — empty key, long key, long value, empty value LEGAL, 17th entry, non-string", () => {
    const entry = (environment: unknown) => ({ a: { type: "local", environment } });
    expect(isValidOpencodeSettingValue(descriptor, entry({ K: "" }))).toBe(true); // env FOO="" is legal
    expect(isValidOpencodeSettingValue(descriptor, entry({ "": "v" }))).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, entry({ "   ": "v" }))).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, entry({ ["x".repeat(129)]: "v" }))).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, entry({ ["x".repeat(128)]: "v" }))).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, entry({ K: "x".repeat(513) }))).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, entry({ K: "x".repeat(512) }))).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, entry({ K: null }))).toBe(true); // delete marker
    expect(isValidOpencodeSettingValue(descriptor, entry({ K: 42 }))).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, entry("not an object"))).toBe(false);
    const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`K${i}`, "v"]));
    const seventeen = { ...sixteen, K16: "v" };
    expect(isValidOpencodeSettingValue(descriptor, entry(sixteen))).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, entry(seventeen))).toBe(false);
    // cwd rides the shared text rules; unknown field keys stay rejected.
    expect(isValidOpencodeSettingValue(descriptor, { a: { type: "local", cwd: "/srv" } })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, { a: { type: "local", made_up: 1 } })).toBe(false);
  });

  it("read coercion stays validator-aligned for the new kinds (golden pin extension)", () => {
    const fields: readonly RecordFieldDef[] = descriptor.record?.fields ?? [];
    const badValues: unknown[] = ["", [], { "": "v" }, { K: 1 }, { K: "x".repeat(513) }, 0, 1.5, -1, true];
    for (const bad of badValues) {
      for (const field of fields) {
        if (field.kind !== "number" && field.kind !== "stringMap") {
          continue;
        }
        const state = readRecordState(JSON.stringify({ mcp: { entry: { [field.key]: bad } } }), ["mcp"], fields);
        const leaf = state.entries.entry?.[field.key];
        if (leaf !== undefined) {
          expect(isValidOpencodeSettingValue(descriptor, { entry: { [field.key]: leaf } })).toBe(true);
        }
      }
    }
  });
});

describe("batch-8 dotted RecordFieldDef keys (nested leaf addressing)", () => {
  const dottedFields: readonly RecordFieldDef[] = [
    { key: "name", kind: "text", label: "名称" },
    { key: "options.apiKey", kind: "text", label: "API Key" },
    { key: "options.baseURL", kind: "text", label: "Base URL" },
  ];
  const descriptor: OpencodeSetting = {
    key: "dotted",
    path: ["provider"],
    kind: "recordEditor",
    label: "dotted",
    group: "供应商",
    record: { fields: [...dottedFields] },
  };

  it("read resolves the nested path: present leaf, absent leaf, missing container", () => {
    const state = readRecordState(
      JSON.stringify({ provider: { mygw: { name: "GW", options: { apiKey: "sk", timeout: 30 } } } }),
      ["provider"],
      dottedFields,
    );
    expect(state.entries.mygw).toEqual({ name: "GW", "options.apiKey": "sk" });
    // Absent leaf inside an existing container reads as omitted.
    expect(
      readRecordState('{"provider":{"mygw":{"options":{"timeout":30}}}}', ["provider"], dottedFields).entries.mygw,
    ).toEqual({});
    // A missing (or wrong-shaped) container reads as absent — never a crash.
    expect(readRecordState('{"provider":{"mygw":{}}}', ["provider"], dottedFields).entries.mygw).toEqual({});
    expect(
      readRecordState('{"provider":{"mygw":{"options":"string"}}}', ["provider"], dottedFields).entries.mygw,
    ).toEqual({});
  });

  it("validator accepts flat dotted keys from the protocol shape; unknown dotted keys rejected", () => {
    expect(isValidOpencodeSettingValue(descriptor, { mygw: { "options.apiKey": "sk" } })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, { mygw: { "options.apiKey": null } })).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, { mygw: { "options.bogus": "x" } })).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, { mygw: { "": "x" } })).toBe(false);
  });

  it("write emits set/remove at the nested path; the container is auto-created on set", () => {
    expect(opencodeSettingEdits(descriptor, { mygw: { "options.apiKey": "sk" } })).toEqual([
      { path: ["provider", "mygw", "options", "apiKey"], value: "sk", op: "set" },
    ]);
    expect(opencodeSettingEdits(descriptor, { mygw: { "options.apiKey": null } })).toEqual([
      { path: ["provider", "mygw", "options", "apiKey"], value: undefined, op: "remove" },
    ]);
    expect(
      getValue(applyEdits("{}", opencodeSettingEdits(descriptor, { mygw: { "options.apiKey": "sk" } })), [
        "provider",
        "mygw",
        "options",
        "apiKey",
      ]),
    ).toBe("sk");
  });

  it("sibling leaves inside the shared options container survive an options.apiKey write", () => {
    const seeded = JSON.stringify({ provider: { mygw: { options: { apiKey: "old", timeout: 30 } } } });
    const next = applyEdits(seeded, opencodeSettingEdits(descriptor, { mygw: { "options.apiKey": "new" } }));
    expect(getValue(next, ["provider", "mygw", "options"])).toEqual({ apiKey: "new", timeout: 30 });
  });
});

describe("agent extras descriptors (智能体 per-agent customization)", () => {
  it("pins the four extras descriptors: path, group, label and the shared field vocabulary", () => {
    const agents: Record<string, string> = {
      agentBuildExtras: "build",
      agentPlanExtras: "plan",
      agentGeneralExtras: "general",
      agentExploreExtras: "explore",
    };
    for (const [key, agent] of Object.entries(agents)) {
      const descriptor = setting(key);
      expect(descriptor.path).toEqual(["agent", agent]);
      expect(descriptor.kind).toBe("shallowObject");
      expect(descriptor.group).toBe("智能体");
      expect(descriptor.label).toBe(`${agent} 扩展`);
      expect(descriptor.hint).toContain("手写");
      expect(descriptor.fields?.map((field) => [field.key, field.kind, field.label])).toEqual([
        ["prompt", "multiline", "系统提示词"],
        ["hidden", "boolean", "隐藏"],
        ["color", "string", "颜色"],
        ["top_p", "number", "top_p"],
        ["permission.edit", "enum", "编辑"],
        ["permission.bash", "enum", "命令"],
        ["permission.webfetch", "enum", "网页抓取"],
        ["permission.task", "enum", "子任务"],
        ["permission.doom_loop", "enum", "死循环防护"],
        ["permission.external_directory", "enum", "外部目录"],
      ]);
      const topP = descriptor.fields?.find((field) => field.key === "top_p");
      expect(topP?.min).toBe(0);
      expect(topP?.max).toBe(1);
      const prompt = descriptor.fields?.find((field) => field.key === "prompt");
      // maxLen deliberately absent: the multiline default IS OPENCODE_MULTILINE_VALUE_MAX_LENGTH.
      expect(prompt?.maxLen).toBeUndefined();
      const color = descriptor.fields?.find((field) => field.key === "color");
      expect(color?.maxLen).toBe(32);
      for (const tool of descriptor.fields?.filter((field) => field.key.startsWith("permission.")) ?? []) {
        expect(tool.options).toEqual(["allow", "ask", "deny"]);
      }
    }
  });

  it("general/explore parity rows mirror the build/plan temperature and disable descriptors", () => {
    const generalTemperature = setting("agentGeneralTemperature");
    expect(generalTemperature.path).toEqual(["agent", "general", "temperature"]);
    expect(generalTemperature.kind).toBe("number");
    expect(generalTemperature.label).toBe("general 温度");
    expect(generalTemperature.group).toBe("智能体");
    expect(generalTemperature.min).toBe(0);
    expect(generalTemperature.max).toBe(2);
    const exploreTemperature = setting("agentExploreTemperature");
    expect(exploreTemperature.path).toEqual(["agent", "explore", "temperature"]);
    expect(exploreTemperature.kind).toBe("number");
    expect(exploreTemperature.label).toBe("explore 温度");
    expect(exploreTemperature.group).toBe("智能体");
    expect(exploreTemperature.min).toBe(0);
    expect(exploreTemperature.max).toBe(2);
    const generalDisable = setting("agentGeneralDisable");
    expect(generalDisable.path).toEqual(["agent", "general", "disable"]);
    expect(generalDisable.kind).toBe("boolean");
    expect(generalDisable.label).toBe("禁用 general 智能体");
    expect(generalDisable.group).toBe("智能体");
    const exploreDisable = setting("agentExploreDisable");
    expect(exploreDisable.path).toEqual(["agent", "explore", "disable"]);
    expect(exploreDisable.kind).toBe("boolean");
    expect(exploreDisable.label).toBe("禁用 explore 智能体");
    expect(exploreDisable.group).toBe("智能体");
  });

  it("extras sit in the 智能体 group adjacent to their agent's rows (no reordering of existing rows)", () => {
    const group = OPENCODE_SETTINGS.filter((entry) => entry.group === "智能体").map((entry) => entry.key);
    expect(group).toEqual([
      "agentBuildDisable",
      "agentBuildTemperature",
      "agentBuildSteps",
      "agentBuildExtras",
      "agentPlanDisable",
      "agentPlanTemperature",
      "agentPlanSteps",
      "agentPlanExtras",
      "agentGeneralModel",
      "agentGeneralSteps",
      "agentGeneralTemperature",
      "agentGeneralDisable",
      "agentGeneralExtras",
      "agentExploreModel",
      "agentExploreSteps",
      "agentExploreTemperature",
      "agentExploreDisable",
      "agentExploreExtras",
    ]);
  });
});

describe("dotted shallowObject leaves (agent extras nested addressing)", () => {
  const buildExtras = setting("agentBuildExtras");

  it("read resolves dotted keys through nested containers: present leaf, absent leaf, missing/wrong-shaped container", () => {
    const values = readOpencodeSettingValues(
      JSON.stringify({
        agent: {
          build: {
            prompt: "p",
            top_p: 0.5,
            permission: { edit: "allow", bash: { "git *": "deny" }, read: "deny" },
          },
        },
      }),
    );
    expect(values.agentBuildExtras).toEqual({
      ...nullAgentExtras(),
      prompt: "p",
      top_p: 0.5,
      "permission.edit": "allow",
      // A pattern object under permission.bash is legal schema content the enum
      // field cannot express — it reads as null, never crashes.
      "permission.bash": null,
    });
    // Absent leaf inside an existing permission container.
    expect(readOpencodeSettingValues('{"agent":{"build":{"permission":{"task":"ask"}}}}').agentBuildExtras).toEqual({
      ...nullAgentExtras(),
      "permission.task": "ask",
    });
    // Missing / wrong-shaped permission container reads as absent for every dotted leaf.
    expect(readOpencodeSettingValues('{"agent":{"build":{}}}').agentBuildExtras).toEqual(nullAgentExtras());
    expect(readOpencodeSettingValues('{"agent":{"build":{"permission":"ask"}}}').agentBuildExtras).toEqual(
      nullAgentExtras(),
    );
  });

  it("validator accepts flat dotted keys with enum values (and still rejects unknown keys / bad actions)", () => {
    expect(isValidOpencodeSettingValue(buildExtras, { "permission.edit": "allow" })).toBe(true);
    expect(isValidOpencodeSettingValue(buildExtras, { "permission.bash": "ask" })).toBe(true);
    expect(isValidOpencodeSettingValue(buildExtras, { "permission.doom_loop": "deny" })).toBe(true);
    expect(isValidOpencodeSettingValue(buildExtras, { "permission.edit": null })).toBe(true);
    expect(isValidOpencodeSettingValue(buildExtras, { "permission.edit": "sometimes" })).toBe(false);
    expect(isValidOpencodeSettingValue(buildExtras, { "permission.read": "allow" })).toBe(false);
    expect(isValidOpencodeSettingValue(buildExtras, { made_up: true })).toBe(false);
  });

  it("edits emit set/remove at agent.build.permission.edit; siblings and hand-written leaves survive", () => {
    expect(opencodeSettingEdits(buildExtras, { "permission.edit": "allow" })).toEqual([
      { path: ["agent", "build", "permission", "edit"], value: "allow", op: "set" },
    ]);
    expect(opencodeSettingEdits(buildExtras, { "permission.edit": null })).toEqual([
      { path: ["agent", "build", "permission", "edit"], value: undefined, op: "remove" },
    ]);

    // A per-leaf edit of permission.edit leaves the sibling permission.bash value,
    // a hand-written pattern object under permission.bash, and the non-descriptor
    // permission.read completely untouched.
    const seeded = JSON.stringify({
      agent: {
        build: {
          permission: {
            edit: "ask",
            bash: "deny",
            read: "deny",
          },
        },
      },
    });
    const next = applyEdits(seeded, opencodeSettingEdits(buildExtras, { "permission.edit": "allow" }));
    expect(getValue(next, ["agent", "build", "permission"])).toEqual({
      edit: "allow",
      bash: "deny",
      read: "deny",
    });

    const patternSeeded = JSON.stringify({
      agent: { build: { permission: { bash: { "git *": "allow" }, read: { "**": "deny" } } } },
    });
    const patternNext = applyEdits(patternSeeded, opencodeSettingEdits(buildExtras, { "permission.edit": "deny" }));
    expect(getValue(patternNext, ["agent", "build", "permission"])).toEqual({
      edit: "deny",
      bash: { "git *": "allow" },
      read: { "**": "deny" },
    });
  });

  it("all-null map on a shared parent stays per-leaf: agent.build siblings (descriptor + unknown) survive", () => {
    const seeded =
      '{\n  "agent": {\n    // hand-tuned\n    "build": {\n      "model": "a/b",\n      "temperature": 0.7,\n      "steps": 40,\n      "prompt": "old",\n      "custom": "keep me",\n    },\n  },\n}\n';
    const next = applyEdits(seeded, opencodeSettingEdits(buildExtras, nullAgentExtras()));
    expect(getValue(next, ["agent", "build"])).toEqual({
      model: "a/b",
      temperature: 0.7,
      steps: 40,
      custom: "keep me",
    });
    expect(next).toContain("// hand-tuned");
  });

  it("null value on a shared parent produces no edits (never removes agent.build)", () => {
    expect(opencodeSettingEdits(buildExtras, null)).toEqual([]);
  });

  it("single-owner shallowObjects keep the 恢复默认 collapse (all-null map removes the whole key)", () => {
    expect(opencodeSettingEdits(setting("compaction"), { auto: null, prune: null })).toEqual([
      { path: ["compaction"], value: undefined, op: "remove" },
    ]);
    expect(opencodeSettingEdits(setting("serverConfig"), {})).toEqual([
      { path: ["server"], value: undefined, op: "remove" },
    ]);
  });
});

describe("shallowObject multiline leaf (agent prompt)", () => {
  const multilineField: OpencodeSettingField = { key: "prompt", kind: "multiline", label: "系统提示词" };

  it("validator: trimmed non-empty within maxLen ?? 8000", () => {
    expect(isValidShallowObjectLeaf(multilineField, "hello")).toBe(true);
    expect(isValidShallowObjectLeaf(multilineField, " line1\nline2 ")).toBe(true);
    expect(isValidShallowObjectLeaf(multilineField, "")).toBe(false);
    expect(isValidShallowObjectLeaf(multilineField, "   \n  ")).toBe(false);
    expect(isValidShallowObjectLeaf(multilineField, "x".repeat(8000))).toBe(true);
    expect(isValidShallowObjectLeaf(multilineField, "x".repeat(8001))).toBe(false);
    const bounded: OpencodeSettingField = { ...multilineField, maxLen: 8 };
    expect(isValidShallowObjectLeaf(bounded, "12345678")).toBe(true);
    expect(isValidShallowObjectLeaf(bounded, "123456789")).toBe(false);
  });

  it("read degrades empty/over-long prompts to null; a partial commit round-trips prompt/hidden/color/top_p", () => {
    const values = readOpencodeSettingValues(
      JSON.stringify({
        agent: { plan: { prompt: "  \n ", hidden: true, color: "#3fb950", top_p: 0.9, bogus: 1 } },
      }),
    );
    expect(values.agentPlanExtras).toEqual({ ...nullAgentExtras(), hidden: true, color: "#3fb950", top_p: 0.9 });

    const planExtras = setting("agentPlanExtras");
    const written = applyEdits(
      "{}",
      opencodeSettingEdits(planExtras, {
        prompt: "You are plan.\nBe careful.",
        hidden: false,
        color: "primary",
        top_p: 0.95,
        "permission.task": "ask",
      }),
    );
    expect(getValue(written, ["agent", "plan"])).toEqual({
      prompt: "You are plan.\nBe careful.",
      hidden: false,
      color: "primary",
      top_p: 0.95,
      permission: { task: "ask" },
    });
    expect(readOpencodeSettingValues(written).agentPlanExtras).toEqual({
      ...nullAgentExtras(),
      prompt: "You are plan.\nBe careful.",
      hidden: false,
      color: "primary",
      top_p: 0.95,
      "permission.task": "ask",
    });
  });
});

describe("batch-8 providerEntries recordEditor (自定义供应商)", () => {
  const descriptor = setting("providerEntries");
  it("descriptor pins the provider field vocabulary and the unexposed leaves", () => {
    expect(descriptor.kind).toBe("recordEditor");
    expect(descriptor.path).toEqual(["provider"]);
    expect(descriptor.group).toBe("供应商");
    expect(descriptor.label).toBe("自定义供应商");
    expect(descriptor.hint).toContain("models");
    expect(descriptor.record?.fields.map((field) => [field.key, field.kind])).toEqual([
      ["name", "text"],
      ["npm", "text"],
      ["options.apiKey", "text"],
      ["options.baseURL", "text"],
      ["whitelist", "stringList"],
      ["blacklist", "stringList"],
    ]);
    // env / options.timeout / models.<id> deliberately unexposed (models is a deep
    // ModelConfig map; env is a rare hand-tuned array) — hand-edit the file instead.
    const keys = (descriptor.record?.fields ?? []).map((field) => field.key).join("|");
    expect(keys).not.toContain("env");
    expect(keys).not.toContain("timeout");
    expect(keys).not.toContain("models");
  });

  it("round-trip: write a provider entry, read it back through the provider record slot", () => {
    const entry = {
      name: "My Gateway",
      "options.apiKey": "{env:MYGW_KEY}",
      "options.baseURL": "https://gw.example.internal/v1",
      whitelist: ["gw/pro", "gw/flash"],
    };
    const written = applyEdits("{}", opencodeSettingEdits(descriptor, { mygw: { ...entry } }));
    expect(getValue(written, ["provider", "mygw"])).toEqual({
      name: "My Gateway",
      options: { apiKey: "{env:MYGW_KEY}", baseURL: "https://gw.example.internal/v1" },
      whitelist: ["gw/pro", "gw/flash"],
    });
    const states = readRecordStates(written);
    expect(states.provider).toEqual({ mode: "entries", booleanValue: null, entries: { mygw: entry } });
  });

  it("hand-written models blocks and options.timeout survive UI edits of a touched provider entry", () => {
    const seeded =
      '{\n  "provider": {\n    // tuned by hand\n    "mygw": {\n      "name": "Old",\n      "options": { "apiKey": "old", "timeout": 30 },\n      "models": { "pro": { "name": "GW Pro", "tool_call": true } },\n    },\n  },\n}\n';
    const modelsSnippet = /"models"\s*:\s*\{[\s\S]*?\n[\s\S]*?\},/.exec(seeded)?.[0] ?? "";
    expect(modelsSnippet.length).toBeGreaterThan(0);
    const next = applyEdits(
      seeded,
      opencodeSettingEdits(descriptor, { mygw: { name: "New", "options.apiKey": "new" } }),
    );
    expect(next).toContain(modelsSnippet);
    expect(getValue(next, ["provider", "mygw", "options", "timeout"])).toBe(30);
    expect(getValue(next, ["provider", "mygw", "name"])).toBe("New");
    expect(getValue(next, ["provider", "mygw", "options", "apiKey"])).toBe("new");
    expect(next).toContain("// tuned by hand");
  });

  it("delete via a null entry removes the whole name (the only name-removal path)", () => {
    const seeded = JSON.stringify({ provider: { mygw: { name: "GW" }, other: { name: "Other" } } });
    const next = applyEdits(seeded, opencodeSettingEdits(descriptor, { mygw: null }));
    expect(getValue(next, ["provider"])).toEqual({ other: { name: "Other" } });
  });

  it("providerEntries values never enter the scalar values map (rides payload.records.provider)", () => {
    const values = readOpencodeSettingValues(JSON.stringify({ provider: { mygw: { name: "GW" } } }));
    expect(Object.hasOwn(values, "providerEntries")).toBe(false);
  });
});

describe("batch-6 pluginList (插件列表)", () => {
  const descriptor = setting("pluginEntries");

  it("descriptor pins the plugin row vocabulary", () => {
    expect(descriptor.kind).toBe("pluginList");
    expect(descriptor.path).toEqual(["plugin"]);
    expect(descriptor.group).toBe("插件");
    expect(descriptor.label).toBe("插件列表");
    expect(descriptor.hint).toContain("@版本");
    expect(descriptor.hint).toContain("元组");
  });

  it("read surfaces an all-strings array as-is — scoped names, @version suffixes, local paths, order kept", () => {
    const plugin = [
      "@opencontext/amplify",
      "my-plugin@2.1.0",
      "@scoped/pkg@1.2.3",
      "./local/plugin.js",
      "~/plugins/x",
      "file://srv/plugin.js",
    ];
    expect(readOpencodeSettingValues(JSON.stringify({ plugin })).pluginEntries).toEqual(plugin);
  });

  it("read: empty array surfaces as [], absent and non-array values degrade to null", () => {
    expect(readOpencodeSettingValues(JSON.stringify({ plugin: [] })).pluginEntries).toEqual([]);
    expect(readOpencodeSettingValues("{}").pluginEntries).toBeNull();
    expect(readOpencodeSettingValues("").pluginEntries).toBeNull();
    expect(readOpencodeSettingValues(JSON.stringify({ plugin: "my-plugin" })).pluginEntries).toBeNull();
    expect(readOpencodeSettingValues(JSON.stringify({ plugin: { name: "x" } })).pluginEntries).toBeNull();
  });

  it("read: ONE non-string (tuple) entry degrades the value to null and raises the protected flag", () => {
    const text = JSON.stringify({ plugin: ["my-plugin", ["@scoped/pkg", { memory: true }]] });
    expect(readOpencodeSettingValues(text).pluginEntries).toBeNull();
    expect(readPluginProtected(text)).toBe(true);
    // All-strings / empty / absent / wrong-shape files never raise the flag.
    expect(readPluginProtected(JSON.stringify({ plugin: ["my-plugin"] }))).toBe(false);
    expect(readPluginProtected(JSON.stringify({ plugin: [] }))).toBe(false);
    expect(readPluginProtected("{}")).toBe(false);
    expect(readPluginProtected(JSON.stringify({ plugin: "my-plugin" }))).toBe(false);
  });

  it("read: a sanity-failing string entry (129 chars / blank) degrades to null AND raises the protected flag", () => {
    expect(readOpencodeSettingValues(JSON.stringify({ plugin: ["ok", "x".repeat(129)] })).pluginEntries).toBeNull();
    expect(readPluginProtected(JSON.stringify({ plugin: ["ok", "x".repeat(129)] }))).toBe(true);
    expect(readOpencodeSettingValues(JSON.stringify({ plugin: ["ok", "   "] })).pluginEntries).toBeNull();
    expect(readPluginProtected(JSON.stringify({ plugin: ["ok", "   "] }))).toBe(true);
    // Over-length REALISTIC case: a long file:// path must also read-protect.
    expect(readPluginProtected(JSON.stringify({ plugin: [`file:///srv/${"x".repeat(130)}/plugin.js`] }))).toBe(true);
  });

  it("validator: 1–32 unique trimmed non-empty ≤128-char npm-ish entries (@scoped/pkg@1.2.3 accepted)", () => {
    expect(isValidOpencodeSettingValue(descriptor, ["my-plugin"])).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, ["@scoped/pkg@1.2.3"])).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, ["./local/plugin", "/abs/plugin"])).toBe(true);
    // Path prefixes pluginResolver treats as first-class all pass the charset
    // (~, file://); Windows drive-letter paths stay out (note only — `\` is
    // never a legal plugin-array separator per repo pathSafety conventions).
    expect(isValidOpencodeSettingValue(descriptor, ["~/plugins/x"])).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, ["file://srv/plugin"])).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, ["C:\\plugins\\x"])).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, null)).toBe(true); // remove op
    expect(isValidOpencodeSettingValue(descriptor, [])).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, ["a", ""])).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, ["a", "   "])).toBe(false); // whitespace-only entry
    expect(isValidOpencodeSettingValue(descriptor, ["x".repeat(128)])).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, ["x".repeat(129)])).toBe(false);
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `plugin-${i}`);
    expect(isValidOpencodeSettingValue(descriptor, ids(32))).toBe(true);
    expect(isValidOpencodeSettingValue(descriptor, ids(33))).toBe(false); // the 33rd entry
  });

  it("validator: dupes rejected after trim (case-sensitive); bad charset and non-arrays rejected", () => {
    expect(isValidOpencodeSettingValue(descriptor, ["a", "a"])).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, ["a", " a "])).toBe(false); // same entry after trim
    expect(isValidOpencodeSettingValue(descriptor, ["a", "A"])).toBe(true); // case stays significant
    expect(isValidOpencodeSettingValue(descriptor, ["bad name!"])).toBe(false); // charset outside npm-ish
    expect(isValidOpencodeSettingValue(descriptor, "my-plugin")).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, ["ok", 3])).toBe(false);
    expect(isValidOpencodeSettingValue(descriptor, [["pkg", {}]])).toBe(false); // tuple form never writable
  });

  it('edits: whole-array set at ["plugin"], null removes the key, per-entry order preserved', () => {
    expect(opencodeSettingEdits(descriptor, ["b", "a"])).toEqual([{ path: ["plugin"], value: ["b", "a"], op: "set" }]);
    expect(opencodeSettingEdits(descriptor, null)).toEqual([{ path: ["plugin"], value: undefined, op: "remove" }]);
    const written = applyEdits("{}", opencodeSettingEdits(descriptor, ["b", "a"]));
    expect(getValue(written, ["plugin"])).toEqual(["b", "a"]);
    const removed = applyEdits(written, opencodeSettingEdits(descriptor, null));
    expect(getValue(removed, ["plugin"])).toBeUndefined();
  });

  it("pluginEntries values ride the scalar map (no dedicated payload slot for the VALUE — only the flag)", () => {
    expect(Object.hasOwn(readOpencodeSettingValues(JSON.stringify({ plugin: ["x"] })), "pluginEntries")).toBe(true);
  });
});
