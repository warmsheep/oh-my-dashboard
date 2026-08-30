import { describe, expect, it } from "vitest";

import { applyEdits, getValue } from "../../src/core/jsoncEditor";
import { isValidOmoMiscValue, omoMiscEdits, readOmoMiscValues } from "../../src/core/omoSettings";
import { KNOWN_AGENTS, OMO_MISC_SETTINGS, OMO_REASONING_LEVELS } from "../../src/shared/protocol";
import type { ModelCatalogValue, OmoMiscSetting, OmoSettingValue } from "../../src/shared/protocol";

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

describe("scope: shared keys live at the TOP LEVEL for BOTH targets", () => {
  it("read takes the top-level models on the omo target and ignores the [opencode].models decoy", () => {
    const text = JSON.stringify({
      "[opencode]": {
        models: { decoy: { model: "evil/decoy" } },
        disabled_agents: ["oracle"],
      },
      models: { "kimi-max": { model: "moonshotai/kimi-k2" } },
    });
    const values = readOmoMiscValues(text, ["[opencode]"]);
    expect(values.omoModels).toEqual({ "kimi-max": { model: "moonshotai/kimi-k2", reasoning: null } });
    // Plugin-scope Wave-2 keys still read under [opencode] in the same file.
    expect(values.disabledAgents).toEqual(["oracle"]);
  });

  it("plugin-scope Wave-2 booleans read under [opencode] and ignore the top-level decoy", () => {
    const text = JSON.stringify({
      "[opencode]": { experimental: { disable_omo_env: true } },
      experimental: { disable_omo_env: false },
    });
    expect(readOmoMiscValues(text, ["[opencode]"]).disableOmoEnv).toBe(true);
  });

  it("shared-scope keys read top-level on the legacy target too (no sectionPath either way)", () => {
    const values = readOmoMiscValues(JSON.stringify({ models: { "glm-flash": { model: "zhipuai/glm-flash" } } }), []);
    expect(values.omoModels).toEqual({ "glm-flash": { model: "zhipuai/glm-flash", reasoning: null } });
  });

  it("writes land top-level for shared scope on the omo target and never create [opencode].models", () => {
    const seeded = JSON.stringify({ "[opencode]": { telemetry: false }, models: { keep: { model: "a/b" } } });
    const text = applyEdits(
      seeded,
      omoMiscEdits(["[opencode]"], setting("omoModels"), {
        "kimi-max": { model: "moonshotai/kimi-k2", reasoning: "high" },
      }),
    );
    expect(getValue(text, ["models", "kimi-max"])).toEqual({ model: "moonshotai/kimi-k2", reasoning: "high" });
    expect(getValue(text, ["models", "keep"])).toEqual({ model: "a/b" });
    expect(getValue(text, ["[opencode]", "telemetry"])).toBe(false);
    expect(getValue(text, ["[opencode]", "models"])).toBeUndefined();
  });
});

describe("modelCatalog kind", () => {
  it("read skips broken entries and never produces null entries (null only marks UI deletion intent)", () => {
    const text = JSON.stringify({
      models: {
        good: { model: "a/b", reasoning: "high" },
        noReasoning: { model: "c/d" },
        notObject: "junk",
        nullish: null,
        noModel: { reasoning: "low" },
        badModel: { model: "not-a-model-id" },
        badReasoning: { model: "a/b", reasoning: "ultra" },
      },
    });
    expect(readOmoMiscValues(text, []).omoModels).toEqual({
      good: { model: "a/b", reasoning: "high" },
      noReasoning: { model: "c/d", reasoning: null },
    });
  });

  it("read degrades a non-object models key (or an absent one) to null", () => {
    expect(readOmoMiscValues(JSON.stringify({ models: ["a/b"] }), []).omoModels).toBeNull();
    expect(readOmoMiscValues(JSON.stringify({ models: "junk" }), []).omoModels).toBeNull();
    expect(readOmoMiscValues("{}", []).omoModels).toBeNull();
  });

  it("edits set {model} / {model, reasoning} per alias, remove an alias via a null entry, and remove the whole key via null", () => {
    const seeded = JSON.stringify({ models: { old: { model: "x/y", extra: 1 }, gone: { model: "a/b" } } });
    const value: ModelCatalogValue = {
      "kimi-max": { model: "moonshotai/kimi-k2", reasoning: "high" },
      "glm-flash": { model: "zhipuai/glm-flash", reasoning: null },
      gone: null,
    };
    const text = applyEdits(seeded, omoMiscEdits([], setting("omoModels"), value));
    expect(getValue(text, ["models", "kimi-max"])).toEqual({ model: "moonshotai/kimi-k2", reasoning: "high" });
    expect(getValue(text, ["models", "glm-flash"])).toEqual({ model: "zhipuai/glm-flash" });
    expect(getValue(text, ["models", "gone"])).toBeUndefined();
    // Unmentioned aliases (including hand-written extra keys) stay untouched.
    expect(getValue(text, ["models", "old"])).toEqual({ model: "x/y", extra: 1 });
    const wiped = applyEdits(text, omoMiscEdits([], setting("omoModels"), null));
    expect(getValue(wiped, ["models"])).toBeUndefined();
  });

  it("validator: alias charset/length, ≤32 aliases, model pattern, reasoning enum, null delete markers", () => {
    const descriptor = setting("omoModels");
    expect(isValidOmoMiscValue(descriptor, { "kimi-max": { model: "moonshotai/kimi-k2", reasoning: "off" } })).toBe(
      true,
    );
    expect(isValidOmoMiscValue(descriptor, { alias: null })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { alias: { model: "a/b", reasoning: null } })).toBe(true);
    // Absent reasoning key is accepted as the null form ({ model } object literals).
    expect(isValidOmoMiscValue(descriptor, { alias: { model: "a/b" } })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { "bad alias!": { model: "a/b", reasoning: null } })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { ["x".repeat(33)]: { model: "a/b", reasoning: null } })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { a: { model: "missing-slash", reasoning: null } })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { a: { model: "a/b", reasoning: "ultra" } })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { a: "not-an-entry" })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, ["a/b"])).toBe(false);
    expect(isValidOmoMiscValue(descriptor, null)).toBe(true);
    const entry = (id: number): [string, { model: string; reasoning: string | null }] => [
      `alias-${id}`,
      { model: "a/b", reasoning: null },
    ];
    expect(isValidOmoMiscValue(descriptor, Object.fromEntries(Array.from({ length: 32 }, (_, i) => entry(i))))).toBe(
      true,
    );
    expect(isValidOmoMiscValue(descriptor, Object.fromEntries(Array.from({ length: 33 }, (_, i) => entry(i))))).toBe(
      false,
    );
  });

  it("reasoning levels come from the protocol constant OMO_REASONING_LEVELS", () => {
    expect(OMO_REASONING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]);
    const descriptor = setting("omoModels");
    for (const level of OMO_REASONING_LEVELS) {
      expect(isValidOmoMiscValue(descriptor, { a: { model: "a/b", reasoning: level } })).toBe(true);
    }
  });
});

describe("enumChips kind (disabledAgents)", () => {
  it("descriptor options reuse the KNOWN_AGENTS protocol constant", () => {
    expect(setting("disabledAgents").options).toEqual([...KNOWN_AGENTS]);
  });

  it("reads the string array at the plugin path; non-string arrays degrade to null; [] stays []", () => {
    const text = JSON.stringify({ "[opencode]": { disabled_agents: ["oracle", "momus"] } });
    expect(readOmoMiscValues(text, ["[opencode]"]).disabledAgents).toEqual(["oracle", "momus"]);
    expect(readOmoMiscValues(JSON.stringify({ disabled_agents: ["oracle", 5] }), []).disabledAgents).toBeNull();
    expect(readOmoMiscValues(JSON.stringify({ disabled_agents: "oracle" }), []).disabledAgents).toBeNull();
    expect(readOmoMiscValues(JSON.stringify({ disabled_agents: [] }), []).disabledAgents).toEqual([]);
  });

  it("validator: unique entries ∈ descriptor options, ≤32 entries, null ok", () => {
    const descriptor = setting("disabledAgents");
    expect(isValidOmoMiscValue(descriptor, [])).toBe(true);
    expect(isValidOmoMiscValue(descriptor, ["oracle", "momus"])).toBe(true);
    expect(isValidOmoMiscValue(descriptor, ["oracle", "oracle"])).toBe(false);
    expect(isValidOmoMiscValue(descriptor, ["oracle", "made-up-agent"])).toBe(false);
    expect(isValidOmoMiscValue(descriptor, [1])).toBe(false);
    expect(isValidOmoMiscValue(descriptor, "oracle")).toBe(false);
    expect(isValidOmoMiscValue(descriptor, null)).toBe(true);
    // The ≤32 cap is unreachable via KNOWN_AGENTS (11 unique names) — probe it with a wide custom descriptor.
    const wide: OmoMiscSetting = {
      ...descriptor,
      options: Array.from({ length: 33 }, (_, i) => `agent-${i}`),
    };
    expect(
      isValidOmoMiscValue(
        wide,
        Array.from({ length: 32 }, (_, i) => `agent-${i}`),
      ),
    ).toBe(true);
    expect(
      isValidOmoMiscValue(
        wide,
        Array.from({ length: 33 }, (_, i) => `agent-${i}`),
      ),
    ).toBe(false);
  });

  it("edits set/remove the whole array at the effective path", () => {
    const seeded = JSON.stringify({ "[opencode]": { disabled_agents: ["oracle"] } });
    const updated = applyEdits(seeded, omoMiscEdits(["[opencode]"], setting("disabledAgents"), ["momus", "atlas"]));
    expect(getValue(updated, ["[opencode]", "disabled_agents"])).toEqual(["momus", "atlas"]);
    const removed = applyEdits(updated, omoMiscEdits(["[opencode]"], setting("disabledAgents"), null));
    expect(getValue(removed, ["[opencode]", "disabled_agents"])).toBeUndefined();
  });

  it("an options-less enumChips descriptor rejects every entry (options ?? [] fallback)", () => {
    const bare: OmoMiscSetting = { ...setting("disabledAgents"), options: undefined };
    expect(isValidOmoMiscValue(bare, ["oracle"])).toBe(false);
  });

  it("stringList kind edits like enumChips and validates with the shared entry rules", () => {
    // Kind-level probe with a synthetic descriptor — the shipped stringList descriptors
    // (disabled_skills etc., batch-1) get end-to-end coverage in their own block
    // below; this keeps the kind coverage descriptor-independent.
    const descriptor: OmoMiscSetting = {
      key: "customList",
      path: ["some_list"],
      kind: "stringList",
      label: "列表",
      group: "g",
    };
    expect(applyEdits("{}", omoMiscEdits([], descriptor, ["a"]))).toContain('"some_list"');
    expect(omoMiscEdits([], descriptor, null)).toEqual([{ path: ["some_list"], value: undefined, op: "remove" }]);
    expect(isValidOmoMiscValue(descriptor, ["a", "b"])).toBe(true);
    expect(isValidOmoMiscValue(descriptor, [])).toBe(false); // shared rules: 1–16 entries
    expect(isValidOmoMiscValue(descriptor, ["a", "a"])).toBe(false);
    expect(isValidOmoMiscValue(descriptor, null)).toBe(true);
  });
});

describe("shallowObject kind (runtimeFallbackParams / defaultMode)", () => {
  it("reads per-field; invalid leaves degrade to null per field; unknown file keys are not surfaced", () => {
    const text = JSON.stringify({
      runtime_fallback: {
        max_fallback_attempts: 5,
        cooldown_seconds: 10.5,
        timeout_seconds: 0,
        notify_on_fallback: true,
        surprise: "hi",
      },
    });
    expect(readOmoMiscValues(text, []).runtimeFallbackParams).toEqual({
      max_fallback_attempts: 5,
      cooldown_seconds: null, // decimal on an integer field
      timeout_seconds: null, // below min 1
      notify_on_fallback: true,
      restore_primary_after_cooldown: null,
    });
    expect(readOmoMiscValues(JSON.stringify({ runtime_fallback: "nope" }), []).runtimeFallbackParams).toBeNull();
    expect(readOmoMiscValues("{}", []).defaultMode).toBeNull();
  });

  it("validator: per-field bounds, integer flag, null leaf = unset, unknown field key rejected", () => {
    const descriptor = setting("runtimeFallbackParams");
    expect(isValidOmoMiscValue(descriptor, { max_fallback_attempts: 20 })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { max_fallback_attempts: 1 })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { max_fallback_attempts: 0 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { max_fallback_attempts: 21 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { cooldown_seconds: 3600 })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { cooldown_seconds: 3601 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { timeout_seconds: 600 })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { timeout_seconds: 601 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { cooldown_seconds: 1.5 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { notify_on_fallback: "yes" })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { made_up: 1 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { timeout_seconds: null })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, null)).toBe(true);
    expect(isValidOmoMiscValue(descriptor, 5)).toBe(false);
    // defaultMode: boolean fields only.
    expect(isValidOmoMiscValue(setting("defaultMode"), { ultrawork: true, goal: false })).toBe(true);
    expect(isValidOmoMiscValue(setting("defaultMode"), { ultrawork: 1 })).toBe(false);
  });

  it("edits: per-leaf writes keep sibling keys and comments; an all-null map removes the key", () => {
    const seeded = '{\n  "runtime_fallback": {\n    // user note\n    "enabled": true,\n  },\n}\n';
    const partial = applyEdits(
      seeded,
      omoMiscEdits([], setting("runtimeFallbackParams"), { cooldown_seconds: 90, max_fallback_attempts: null }),
    );
    // `enabled` is written by the batch-1 runtimeFallback descriptor sharing the parent
    // object — a per-leaf write must NOT wipe it, and the comment must survive.
    expect(getValue(partial, ["runtime_fallback"])).toEqual({ enabled: true, cooldown_seconds: 90 });
    expect(partial).toContain("// user note");
    const emptied = applyEdits(
      partial,
      omoMiscEdits([], setting("runtimeFallbackParams"), { cooldown_seconds: null, max_fallback_attempts: null }),
    );
    expect(getValue(emptied, ["runtime_fallback"])).toBeUndefined();
    const wholeNull = applyEdits(seeded, omoMiscEdits([], setting("runtimeFallbackParams"), null));
    expect(getValue(wholeNull, ["runtime_fallback"])).toBeUndefined();
  });

  it("edits: per-leaf paths respect the effective scope routing", () => {
    expect(omoMiscEdits(["[opencode]"], setting("defaultMode"), { ultrawork: true, goal: null })).toEqual([
      { path: ["[opencode]", "default_mode", "ultrawork"], value: true, op: "set" },
      { path: ["[opencode]", "default_mode", "goal"], value: undefined, op: "remove" },
    ]);
  });

  it("edits ignore a non-record value instead of corrupting the file (callers validate first)", () => {
    const bad = 42 as unknown as OmoSettingValue;
    expect(omoMiscEdits([], setting("runtimeFallbackParams"), bad)).toEqual([]);
    expect(omoMiscEdits([], setting("omoModels"), bad)).toEqual([]);
  });
});

describe("batch-3 descriptors (OMO tab)", () => {
  it("disabledMcps (enumChips): unique entries ∈ options", () => {
    const mcps = setting("disabledMcps");
    expect(isValidOmoMiscValue(mcps, [])).toBe(true);
    expect(isValidOmoMiscValue(mcps, ["websearch", "codegraph"])).toBe(true);
    expect(isValidOmoMiscValue(mcps, ["websearch", "websearch"])).toBe(false);
    expect(isValidOmoMiscValue(mcps, ["made-up-mcp"])).toBe(false);
    expect(isValidOmoMiscValue(mcps, [1])).toBe(false);
    expect(isValidOmoMiscValue(mcps, null)).toBe(true);
  });

  it("disabledCommands (enumChips): schema-strict enum options", () => {
    const commands = setting("disabledCommands");
    expect(isValidOmoMiscValue(commands, ["goal", "hyperplan"])).toBe(true);
    expect(isValidOmoMiscValue(commands, ["Goal"])).toBe(false); // case-sensitive
    expect(isValidOmoMiscValue(commands, ["bogus"])).toBe(false);
  });

  it("browserAutomation (enum): listed provider ids only; read passes strings, degrades others", () => {
    const engine = setting("browserAutomation");
    expect(isValidOmoMiscValue(engine, "playwright")).toBe(true);
    expect(isValidOmoMiscValue(engine, "dev-browser")).toBe(true);
    expect(isValidOmoMiscValue(engine, "chrome")).toBe(false);
    expect(isValidOmoMiscValue(engine, null)).toBe(true);
    const values = readOmoMiscValues(
      JSON.stringify({ "[opencode]": { browser_automation_engine: { provider: "agent-browser" } } }),
      ["[opencode]"],
    );
    expect(values.browserAutomation).toBe("agent-browser");
    expect(
      readOmoMiscValues(JSON.stringify({ browser_automation_engine: { provider: 7 } }), []).browserAutomation,
    ).toBeNull();
  });

  it("websearchProvider (enum): exa/tavily only", () => {
    const websearch = setting("websearchProvider");
    expect(isValidOmoMiscValue(websearch, "exa")).toBe(true);
    expect(isValidOmoMiscValue(websearch, "tavily")).toBe(true);
    expect(isValidOmoMiscValue(websearch, "brave")).toBe(false);
    expect(isValidOmoMiscValue(websearch, 42)).toBe(false);
  });

  it("enum edits land at the nested path with the section prefix and remove on null", () => {
    const edits = omoMiscEdits(["[opencode]"], setting("browserAutomation"), "agent-browser");
    expect(edits).toEqual([
      { path: ["[opencode]", "browser_automation_engine", "provider"], value: "agent-browser", op: "set" },
    ]);
    const text = applyEdits("{}", edits);
    expect(getValue(text, ["[opencode]", "browser_automation_engine", "provider"])).toBe("agent-browser");
    const removed = applyEdits(text, omoMiscEdits(["[opencode]"], setting("browserAutomation"), null));
    expect(getValue(removed, ["[opencode]", "browser_automation_engine", "provider"])).toBeUndefined();
  });

  it("gitMaster (shallowObject): boolean leaves only", () => {
    const git = setting("gitMaster");
    expect(isValidOmoMiscValue(git, { commit_footer: false, include_co_authored_by: null })).toBe(true);
    expect(isValidOmoMiscValue(git, { commit_footer: "yes" })).toBe(false);
    expect(isValidOmoMiscValue(git, { made_up: true })).toBe(false);
    expect(isValidOmoMiscValue(git, null)).toBe(true);
  });

  it("tmuxParams (shallowObject with enum leaves): layout/isolation ∈ options, main_pane_size int 20–80", () => {
    const tmux = setting("tmuxParams");
    expect(isValidOmoMiscValue(tmux, { layout: "tiled", main_pane_size: 60, isolation: "window" })).toBe(true);
    expect(isValidOmoMiscValue(tmux, { layout: "bogus" })).toBe(false);
    expect(isValidOmoMiscValue(tmux, { isolation: "matrix" })).toBe(false);
    expect(isValidOmoMiscValue(tmux, { layout: 42 })).toBe(false);
    expect(isValidOmoMiscValue(tmux, { main_pane_size: 19 })).toBe(false);
    expect(isValidOmoMiscValue(tmux, { main_pane_size: 81 })).toBe(false);
    expect(isValidOmoMiscValue(tmux, { main_pane_size: 60.5 })).toBe(false);
    expect(isValidOmoMiscValue(tmux, { layout: null })).toBe(true); // null leaf = unset
  });

  it("tmuxParams read: valid enum leaves pass through, invalid ones degrade to null; unknown file keys not surfaced", () => {
    const values = readOmoMiscValues(
      JSON.stringify({ tmux: { layout: "tiled", isolation: "bogus", main_pane_size: 50, surprise: 1 } }),
      [],
    );
    expect(values.tmuxParams).toEqual({ layout: "tiled", main_pane_size: 50, isolation: null });
  });

  it("tmuxParams edits: enum leaf set + null-leaf remove preserve a sibling comment and custom key", () => {
    const seeded = '{\n  "tmux": {\n    // user note\n    "custom": "keep",\n    "enabled": true,\n  },\n}\n';
    const next = applyEdits(seeded, omoMiscEdits([], setting("tmuxParams"), { layout: "tiled", isolation: null }));
    // `enabled` belongs to the batch-1 tmuxEnabled descriptor sharing the parent — per-leaf writes keep it.
    expect(getValue(next, ["tmux"])).toEqual({ custom: "keep", enabled: true, layout: "tiled" });
    expect(next).toContain("// user note");
  });

  it("teamModeLimits (shallowObject): integer bounds per field", () => {
    const limits = setting("teamModeLimits");
    expect(
      isValidOmoMiscValue(limits, {
        max_parallel_members: 4,
        max_members: 8,
        max_wall_clock_minutes: 120,
        max_member_turns: 500,
      }),
    ).toBe(true);
    expect(isValidOmoMiscValue(limits, { max_parallel_members: 0 })).toBe(false);
    expect(isValidOmoMiscValue(limits, { max_parallel_members: 9 })).toBe(false);
    expect(isValidOmoMiscValue(limits, { max_members: 9 })).toBe(false);
    expect(isValidOmoMiscValue(limits, { max_wall_clock_minutes: 1440 })).toBe(true);
    expect(isValidOmoMiscValue(limits, { max_wall_clock_minutes: 1441 })).toBe(false);
    expect(isValidOmoMiscValue(limits, { max_member_turns: 10000 })).toBe(true);
    expect(isValidOmoMiscValue(limits, { max_member_turns: 10001 })).toBe(false);
  });

  it("agentOrder (orderedList): 1–64 unique trimmed non-empty ≤64-char entries", () => {
    const order = setting("agentOrder");
    expect(isValidOmoMiscValue(order, ["atlas", "oracle"])).toBe(true);
    expect(isValidOmoMiscValue(order, ["atlas", "atlas"])).toBe(false);
    expect(isValidOmoMiscValue(order, ["ok", ""])).toBe(false);
    expect(isValidOmoMiscValue(order, ["x".repeat(64)])).toBe(true);
    expect(isValidOmoMiscValue(order, ["x".repeat(65)])).toBe(false);
    expect(isValidOmoMiscValue(order, null)).toBe(true);
    const names = (count: number) => Array.from({ length: count }, (_, i) => `agent-${i}`);
    expect(isValidOmoMiscValue(order, names(64))).toBe(true);
    expect(isValidOmoMiscValue(order, names(65))).toBe(false);
  });

  it("agentOrder read keeps the string array as-is; mixed/non-array values degrade to null", () => {
    expect(readOmoMiscValues(JSON.stringify({ agent_order: ["atlas", "hephaestus"] }), []).agentOrder).toEqual([
      "atlas",
      "hephaestus",
    ]);
    expect(readOmoMiscValues(JSON.stringify({ agent_order: ["atlas", 3] }), []).agentOrder).toBeNull();
    expect(readOmoMiscValues(JSON.stringify({ agent_order: "atlas" }), []).agentOrder).toBeNull();
  });

  it("agentOrder read is display-tolerant: oversized and duplicate hand-written arrays pass through AS-IS", () => {
    // Reads never cap or dedupe (commits are validator-bounded — the orderedList matrix
    // above already covers >64/dupes rejection), so hand-written entries stay visible.
    const oversized = Array.from({ length: 65 }, (_, i) => `agent-${i}`);
    expect(readOmoMiscValues(JSON.stringify({ agent_order: oversized }), []).agentOrder).toEqual(oversized);
    const duplicated = ["atlas", "oracle", "atlas"];
    expect(readOmoMiscValues(JSON.stringify({ agent_order: duplicated }), []).agentOrder).toEqual(duplicated);
  });

  it("agentOrder edits set/remove the whole key at the effective path", () => {
    const seeded = JSON.stringify({ "[opencode]": { agent_order: ["oracle"] } });
    const updated = applyEdits(seeded, omoMiscEdits(["[opencode]"], setting("agentOrder"), ["atlas", "oracle"]));
    expect(getValue(updated, ["[opencode]", "agent_order"])).toEqual(["atlas", "oracle"]);
    const removed = applyEdits(updated, omoMiscEdits(["[opencode]"], setting("agentOrder"), null));
    expect(getValue(removed, ["[opencode]", "agent_order"])).toBeUndefined();
  });

  it("gitMaster round-trip: per-leaf write on the legacy target", () => {
    const text = applyEdits("{}", omoMiscEdits([], setting("gitMaster"), { commit_footer: false }));
    expect(getValue(text, ["git_master"])).toEqual({ commit_footer: false });
  });
});

describe("batch-5 agentPairMap kind (agentUltrawork / agentCompaction)", () => {
  it("descriptor metadata: options reuse KNOWN_AGENTS and agents.leafKey names the per-agent sub-key", () => {
    const ultrawork = setting("agentUltrawork");
    expect(ultrawork.kind).toBe("agentPairMap");
    expect(ultrawork.path).toEqual(["agents"]);
    expect(ultrawork.options).toEqual([...KNOWN_AGENTS]);
    expect(ultrawork.agents).toEqual({ leafKey: "ultrawork" });
    expect(setting("agentCompaction").agents).toEqual({ leafKey: "compaction" });
  });

  it("read extracts per-agent agents.<name>.<leafKey>; broken entries are omitted, invalid reasoning degrades to null", () => {
    const text = JSON.stringify({
      agents: {
        oracle: { model: "zhipuai/glm-5", reasoning: "high", ultrawork: { model: "kimi/k2", reasoning: "max" } },
        atlas: { model: "zhipuai/glm-5", ultrawork: { model: "moonshotai/kimi-k2" } },
        sisyphus: { model: "zhipuai/glm-5", ultrawork: { model: "bad-id" } },
        hephaestus: { model: "zhipuai/glm-5", ultrawork: { model: "kimi/k2", reasoning: "ultra" } },
        metis: { model: "zhipuai/glm-5", ultrawork: "not an object" },
        momus: { model: "zhipuai/glm-5" },
        "made-up-agent": { ultrawork: { model: "kimi/k2" } },
      },
    });
    expect(readOmoMiscValues(text, []).agentUltrawork).toEqual({
      oracle: { model: "kimi/k2", reasoning: "max" },
      atlas: { model: "moonshotai/kimi-k2", reasoning: null },
      // invalid reasoning string degrades to null inside the entry (display-safe, pinned)
      hephaestus: { model: "kimi/k2", reasoning: null },
    });
  });

  it("read prefixes the omo sectionPath and degrades an absent/non-object agents block to null", () => {
    const text = JSON.stringify({
      "[opencode]": { agents: { oracle: { compaction: { model: "kimi/k2", reasoning: "off" } } } },
      agents: { oracle: { compaction: { model: "evil/decoy" } } },
    });
    expect(readOmoMiscValues(text, ["[opencode]"]).agentCompaction).toEqual({
      oracle: { model: "kimi/k2", reasoning: "off" },
    });
    expect(readOmoMiscValues("{}", []).agentUltrawork).toBeNull();
    expect(readOmoMiscValues(JSON.stringify({ agents: "nope" }), []).agentUltrawork).toBeNull();
  });

  it("edits: per-agent set writes {model} / {model, reasoning} at agents.<name>.<leafKey>; null entry removes the leafKey", () => {
    const value = {
      oracle: { model: "kimi/k2", reasoning: "high" },
      atlas: { model: "moonshotai/kimi-k2", reasoning: null },
      metis: null,
    };
    const text = applyEdits("{}", omoMiscEdits(["[opencode]"], setting("agentUltrawork"), value));
    expect(getValue(text, ["[opencode]", "agents", "oracle", "ultrawork"])).toEqual({
      model: "kimi/k2",
      reasoning: "high",
    });
    expect(getValue(text, ["[opencode]", "agents", "atlas", "ultrawork"])).toEqual({ model: "moonshotai/kimi-k2" });
    expect(getValue(text, ["[opencode]", "agents", "metis"])).toBeUndefined();

    const seeded = JSON.stringify({ agents: { oracle: { ultrawork: { model: "kimi/k2" } } } });
    const removed = applyEdits(seeded, omoMiscEdits([], setting("agentUltrawork"), { oracle: null }));
    expect(getValue(removed, ["agents", "oracle", "ultrawork"])).toBeUndefined();
    expect(getValue(removed, ["agents", "oracle"])).toEqual({});
  });

  it("edits: a whole null value produces NO edits (never touches the agents block)", () => {
    const seeded = JSON.stringify({ agents: { oracle: { model: "zhipuai/glm-5" } } });
    expect(omoMiscEdits(["[opencode]"], setting("agentUltrawork"), null)).toEqual([]);
    const untouched = applyEdits(seeded, omoMiscEdits([], setting("agentCompaction"), null));
    expect(untouched).toBe(seeded);
  });

  it("edits never disturb the sibling model/reasoning keys owned by the 模型配置 section (byte-identical)", () => {
    const seeded =
      '{\n  "agents": {\n    // 模型配置 owns these\n    "oracle": { "model": "zhipuai/glm-5", "reasoning": "high" },\n  },\n}\n';
    const next = applyEdits(
      seeded,
      omoMiscEdits([], setting("agentUltrawork"), { oracle: { model: "kimi/k2", reasoning: "low" } }),
    );
    // The ultrawork leaf lands NEXT TO the sibling keys without rewriting them.
    expect(getValue(next, ["agents", "oracle"])).toEqual({
      model: "zhipuai/glm-5",
      reasoning: "high",
      ultrawork: { model: "kimi/k2", reasoning: "low" },
    });
    expect(next).toContain("// 模型配置 owns these");
    const afterRemove = applyEdits(next, omoMiscEdits([], setting("agentUltrawork"), { oracle: null }));
    expect(getValue(afterRemove, ["agents", "oracle"])).toEqual({ model: "zhipuai/glm-5", reasoning: "high" });
  });

  it("read omits a reasoning-only leaf (no model); a commit for another agent leaves the hand-written leaf untouched", () => {
    const seeded = JSON.stringify({ agents: { hephaestus: { ultrawork: { reasoning: "high" } } } });
    // No model ⇒ not a valid override: the read skips the entry instead of wiping it.
    expect(readOmoMiscValues(seeded, []).agentUltrawork).toEqual({});
    const next = applyEdits(
      seeded,
      omoMiscEdits([], setting("agentUltrawork"), { oracle: { model: "kimi/k2", reasoning: "low" } }),
    );
    expect(getValue(next, ["agents", "hephaestus", "ultrawork"])).toEqual({ reasoning: "high" });
    expect(getValue(next, ["agents", "oracle", "ultrawork"])).toEqual({ model: "kimi/k2", reasoning: "low" });
  });

  it("validator: keys ⊆ options, MODEL_ID_PATTERN, reasoning ∈ OMO_REASONING_LEVELS or null, null entries ok", () => {
    const descriptor = setting("agentUltrawork");
    expect(isValidOmoMiscValue(descriptor, { oracle: { model: "kimi/k2", reasoning: "high" } })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { oracle: { model: "kimi/k2", reasoning: null } })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { oracle: { model: "kimi/k2" } })).toBe(true); // absent reasoning
    expect(isValidOmoMiscValue(descriptor, { oracle: null })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, {})).toBe(true);
    expect(isValidOmoMiscValue(descriptor, null)).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { "made-up-agent": { model: "kimi/k2", reasoning: null } })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { oracle: { model: "no-slash", reasoning: null } })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { oracle: { model: "kimi/k2", reasoning: "ultra" } })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { oracle: "not-an-entry" })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, [{ model: "kimi/k2" }])).toBe(false);
    expect(isValidOmoMiscValue(descriptor, "nope")).toBe(false);
  });
});

describe("batch-5 agentTextMap kind (agentPrompt / agentPromptAppend)", () => {
  it("descriptor metadata: KNOWN_AGENTS options + per-agent leafKey prompt / prompt_append", () => {
    expect(setting("agentPrompt").agents).toEqual({ leafKey: "prompt" });
    expect(setting("agentPromptAppend").agents).toEqual({ leafKey: "prompt_append" });
    expect(setting("agentPrompt").options).toEqual([...KNOWN_AGENTS]);
  });

  it("read keeps string leaves per agent and omits non-strings, empty-after-trim and over-8000 ones", () => {
    const text = JSON.stringify({
      agents: {
        oracle: { prompt: "你是审计员。", prompt_append: "追加一段。" },
        atlas: { prompt: "   " },
        metis: { prompt: 42 },
        momus: { prompt: "x".repeat(8001) },
        sisyphus: { prompt: "x".repeat(8000) },
        hephaestus: {},
        "made-up-agent": { prompt: "invisible" },
      },
    });
    const values = readOmoMiscValues(text, []);
    expect(values.agentPrompt).toEqual({ oracle: "你是审计员。", sisyphus: "x".repeat(8000) });
    expect(values.agentPromptAppend).toEqual({ oracle: "追加一段。" });
  });

  it("read degrades an absent agents block to null and prefixes the omo sectionPath", () => {
    expect(readOmoMiscValues("{}", []).agentPrompt).toBeNull();
    const text = JSON.stringify({ "[opencode]": { agents: { oracle: { prompt: "p" } } } });
    expect(readOmoMiscValues(text, ["[opencode]"]).agentPrompt).toEqual({ oracle: "p" });
    // The omo read only looks under [opencode].agents — a top-level agents decoy is
    // invisible, so an empty [opencode] block reads the same as an absent one (null).
    const decoy = JSON.stringify({ "[opencode]": {}, agents: { oracle: { prompt: "decoy" } } });
    expect(readOmoMiscValues(decoy, ["[opencode]"]).agentPrompt).toBeNull();
  });

  it("edits: per-agent set/remove at agents.<name>.<leafKey>; whole null produces no edits", () => {
    const seeded = JSON.stringify({ agents: { oracle: { prompt: "old" } } });
    const next = applyEdits(
      seeded,
      omoMiscEdits(["[opencode]"], setting("agentPromptAppend"), { oracle: "追加", atlas: null }),
    );
    expect(getValue(next, ["[opencode]", "agents", "oracle", "prompt_append"])).toBe("追加");
    expect(getValue(next, ["[opencode]", "agents", "atlas"])).toBeUndefined();
    expect(omoMiscEdits([], setting("agentPrompt"), null)).toEqual([]);
    expect(applyEdits(seeded, omoMiscEdits([], setting("agentPrompt"), null))).toBe(seeded);
  });

  it("edits touching only oracle leave a hand-written over-long momus prompt byte-identical (combined trace)", () => {
    // 8001 chars exceeds the read/validator bound, so the read omits it — the pin:
    // per-agent writes must never rewrite untouched leaves, whatever they contain.
    const longPrompt = "提".repeat(8001);
    const seeded = JSON.stringify({ agents: { momus: { prompt: longPrompt }, oracle: { prompt: "old" } } });
    const next = applyEdits(seeded, omoMiscEdits([], setting("agentPrompt"), { oracle: "new" }));
    expect(getValue(next, ["agents", "oracle", "prompt"])).toBe("new");
    expect(getValue(next, ["agents", "momus", "prompt"])).toBe(longPrompt);
    expect(next).toContain(longPrompt);
  });

  it("validator: keys ⊆ options, trimmed non-empty ≤8000 or null", () => {
    const descriptor = setting("agentPrompt");
    expect(isValidOmoMiscValue(descriptor, { oracle: "text", atlas: null })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, {})).toBe(true);
    expect(isValidOmoMiscValue(descriptor, null)).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { "made-up-agent": "text" })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { oracle: "   " })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { oracle: "x".repeat(8000) })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { oracle: "x".repeat(8001) })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { oracle: 42 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, ["text"])).toBe(false);
  });
});

describe("batch-5 scalar/shallow descriptors (claude_code / keyword / goal / codegraph / monitor / notification / i18n)", () => {
  it("claudeCode (shallowObject): six boolean leaves default true", () => {
    const descriptor = setting("claudeCode");
    expect(descriptor.path).toEqual(["claude_code"]);
    expect(descriptor.fields?.map((field) => [field.key, field.default])).toEqual([
      ["mcp", true],
      ["commands", true],
      ["skills", true],
      ["agents", true],
      ["hooks", true],
      ["plugins", true],
    ]);
    expect(isValidOmoMiscValue(descriptor, { mcp: false, hooks: null })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { mcp: "yes" })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { made_up: true })).toBe(false);
  });

  it("keywordExpansions (enumChips): unique entries ∈ the four expansion keywords", () => {
    const descriptor = setting("keywordExpansions");
    expect(descriptor.path).toEqual(["keyword_detector", "enabled_expansions"]);
    expect(descriptor.options).toEqual(["ultrawork", "team", "hyperplan", "hyperplan-ultrawork"]);
    expect(isValidOmoMiscValue(descriptor, [])).toBe(true);
    expect(isValidOmoMiscValue(descriptor, ["ultrawork", "hyperplan-ultrawork"])).toBe(true);
    expect(isValidOmoMiscValue(descriptor, ["team", "team"])).toBe(false);
    expect(isValidOmoMiscValue(descriptor, ["ulw"])).toBe(false);
  });

  it("goalParams (shallowObject): enabled/auto_start booleans + default_max_iterations int 1–1000", () => {
    const descriptor = setting("goalParams");
    expect(isValidOmoMiscValue(descriptor, { enabled: true, auto_start: false, default_max_iterations: 100 })).toBe(
      true,
    );
    expect(isValidOmoMiscValue(descriptor, { default_max_iterations: 1 })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { default_max_iterations: 1000 })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { default_max_iterations: 0 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { default_max_iterations: 1001 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { default_max_iterations: 1.5 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { auto_start: "yes" })).toBe(false);
  });

  it("codegraph / monitorParams (shallowObject): leaves with their defaults", () => {
    const codegraph = setting("codegraph");
    expect(codegraph.fields?.every((field) => field.kind === "boolean" && field.default === true)).toBe(true);
    expect(isValidOmoMiscValue(codegraph, { daemon: false })).toBe(true);
    expect(isValidOmoMiscValue(codegraph, { daemon: 1 })).toBe(false);

    const monitor = setting("monitorParams");
    expect(monitor.fields?.map((field) => [field.key, field.default])).toEqual([
      ["enabled", false],
      ["live_mode_enabled", false],
      ["max_monitors_per_session", 3],
      ["max_runtime_ms", 1800000],
      ["allowed_commands", undefined],
    ]);
    expect(isValidOmoMiscValue(monitor, { enabled: true, live_mode_enabled: null })).toBe(true);
    expect(isValidOmoMiscValue(monitor, { enabled: 1 })).toBe(false);
  });

  it("notificationForce (boolean) / i18nLocale (string ≤16) validators", () => {
    const notification = setting("notificationForce");
    expect(notification.path).toEqual(["notification", "force_enable"]);
    expect(notification.default).toBe(false);
    expect(isValidOmoMiscValue(notification, true)).toBe(true);
    expect(isValidOmoMiscValue(notification, 1)).toBe(false);

    const locale = setting("i18nLocale");
    expect(locale.path).toEqual(["i18n", "locale"]);
    expect(locale.maxLen).toBe(16);
    expect(isValidOmoMiscValue(locale, "zh")).toBe(true);
    expect(isValidOmoMiscValue(locale, "en")).toBe(true);
    expect(isValidOmoMiscValue(locale, "x".repeat(16))).toBe(true);
    expect(isValidOmoMiscValue(locale, "x".repeat(17))).toBe(false);
    expect(isValidOmoMiscValue(locale, "   ")).toBe(false);
    expect(isValidOmoMiscValue(locale, 42)).toBe(false);
    expect(isValidOmoMiscValue(locale, null)).toBe(true);
  });

  it("string kind reads pass strings through and degrade others to null; edits set/remove the nested leaf", () => {
    expect(readOmoMiscValues(JSON.stringify({ i18n: { locale: "zh" } }), []).i18nLocale).toBe("zh");
    expect(readOmoMiscValues(JSON.stringify({ i18n: { locale: 7 } }), []).i18nLocale).toBeNull();
    const edits = omoMiscEdits(["[opencode]"], setting("i18nLocale"), "en");
    expect(edits).toEqual([{ path: ["[opencode]", "i18n", "locale"], value: "en", op: "set" }]);
    const removed = applyEdits('{"i18n":{"locale":"en"}}', omoMiscEdits([], setting("i18nLocale"), null));
    expect(getValue(removed, ["i18n", "locale"])).toBeUndefined();
  });

  it("batch-5 group order is stable on first appearance (覆写矩阵 → 提示词 → 兼容层 → 关键词 → 目标循环 → 工具链 → 通知)", () => {
    const groups: string[] = [];
    for (const entry of OMO_MISC_SETTINGS) {
      if (!groups.includes(entry.group)) {
        groups.push(entry.group);
      }
    }
    const batch5 = ["覆写矩阵", "提示词", "兼容层", "关键词", "目标循环", "工具链", "通知"];
    expect(groups.slice(-batch5.length)).toEqual(batch5);
  });
});

describe("new-plan batch-1 scalars (稳定性 / 编排 / 实验特性 / Git)", () => {
  it("autoUpdate / modelFallback (boolean): read present/absent/wrong-shape; edits set/remove at the plugin path", () => {
    const values = readOmoMiscValues(JSON.stringify({ "[opencode]": { auto_update: false, model_fallback: true } }), [
      "[opencode]",
    ]);
    expect(values.autoUpdate).toBe(false);
    expect(values.modelFallback).toBe(true);
    const bad = readOmoMiscValues(JSON.stringify({ auto_update: "yes", model_fallback: 0 }), []);
    expect(bad.autoUpdate).toBeNull();
    expect(bad.modelFallback).toBeNull();
    expect(readOmoMiscValues("{}", []).autoUpdate).toBeNull();

    for (const key of ["autoUpdate", "modelFallback"]) {
      expect(isValidOmoMiscValue(setting(key), true)).toBe(true);
      expect(isValidOmoMiscValue(setting(key), 1)).toBe(false);
      expect(isValidOmoMiscValue(setting(key), "true")).toBe(false);
      expect(isValidOmoMiscValue(setting(key), null)).toBe(true);
    }

    const edits = omoMiscEdits(["[opencode]"], setting("autoUpdate"), false);
    expect(edits).toEqual([{ path: ["[opencode]", "auto_update"], value: false, op: "set" }]);
    const text = applyEdits("{}", edits);
    expect(getValue(text, ["[opencode]", "auto_update"])).toBe(false);
    const removed = applyEdits(text, omoMiscEdits(["[opencode]"], setting("autoUpdate"), null));
    expect(getValue(removed, ["[opencode]", "auto_update"])).toBeUndefined();
  });

  it("defaultRunAgent (string ≤64): validator trims and bounds; read passthrough/degrade; edits set/remove", () => {
    const descriptor = setting("defaultRunAgent");
    expect(descriptor.path).toEqual(["default_run_agent"]);
    expect(descriptor.maxLen).toBe(64);
    expect(isValidOmoMiscValue(descriptor, "general-purpose")).toBe(true);
    expect(isValidOmoMiscValue(descriptor, "x".repeat(64))).toBe(true);
    expect(isValidOmoMiscValue(descriptor, "x".repeat(65))).toBe(false);
    expect(isValidOmoMiscValue(descriptor, "   ")).toBe(false);
    expect(isValidOmoMiscValue(descriptor, 42)).toBe(false);
    expect(isValidOmoMiscValue(descriptor, null)).toBe(true);

    expect(readOmoMiscValues(JSON.stringify({ default_run_agent: "plan" }), []).defaultRunAgent).toBe("plan");
    expect(readOmoMiscValues(JSON.stringify({ default_run_agent: 7 }), []).defaultRunAgent).toBeNull();

    const text = applyEdits("{}", omoMiscEdits(["[opencode]"], setting("defaultRunAgent"), "sisyphus"));
    expect(getValue(text, ["[opencode]", "default_run_agent"])).toBe("sisyphus");
    const removed = applyEdits(text, omoMiscEdits(["[opencode]"], setting("defaultRunAgent"), null));
    expect(getValue(removed, ["[opencode]", "default_run_agent"])).toBeUndefined();
  });

  it("newTaskSystem reads new_task_system_enabled, independent from experimental.task_system", () => {
    const descriptor = setting("newTaskSystem");
    expect(descriptor.path).toEqual(["new_task_system_enabled"]);
    const values = readOmoMiscValues(
      JSON.stringify({ new_task_system_enabled: false, experimental: { task_system: true } }),
      [],
    );
    expect(values.newTaskSystem).toBe(false);
    expect(values.taskSystem).toBe(true);
    expect(readOmoMiscValues(JSON.stringify({ new_task_system_enabled: 1 }), []).newTaskSystem).toBeNull();
    expect(isValidOmoMiscValue(descriptor, true)).toBe(true);
    expect(isValidOmoMiscValue(descriptor, "on")).toBe(false);

    const text = applyEdits("{}", omoMiscEdits(["[opencode]"], setting("newTaskSystem"), true));
    expect(getValue(text, ["[opencode]", "new_task_system_enabled"])).toBe(true);
    const removed = applyEdits(text, omoMiscEdits(["[opencode]"], setting("newTaskSystem"), null));
    expect(getValue(removed, ["[opencode]", "new_task_system_enabled"])).toBeUndefined();
  });

  it("preemptiveCompaction: 2-segment experimental path; null removes the leaf and keeps the container", () => {
    const descriptor = setting("preemptiveCompaction");
    expect(descriptor.path).toEqual(["experimental", "preemptive_compaction"]);
    const values = readOmoMiscValues(
      JSON.stringify({ experimental: { preemptive_compaction: true, task_system: true } }),
      [],
    );
    expect(values.preemptiveCompaction).toBe(true);
    expect(
      readOmoMiscValues(JSON.stringify({ experimental: { preemptive_compaction: 1 } }), []).preemptiveCompaction,
    ).toBeNull();
    expect(readOmoMiscValues("{}", []).preemptiveCompaction).toBeNull();
    expect(isValidOmoMiscValue(descriptor, false)).toBe(true);
    expect(isValidOmoMiscValue(descriptor, 0)).toBe(false);

    const seeded = applyEdits("{}", omoMiscEdits(["[opencode]"], setting("preemptiveCompaction"), true));
    expect(getValue(seeded, ["[opencode]", "experimental", "preemptive_compaction"])).toBe(true);
    const removed = applyEdits(seeded, omoMiscEdits(["[opencode]"], setting("preemptiveCompaction"), null));
    expect(getValue(removed, ["[opencode]", "experimental", "preemptive_compaction"])).toBeUndefined();
    expect(getValue(removed, ["[opencode]", "experimental"])).toEqual({});
  });

  it("dynamicContextPruning (shallowObject): nested turn_protection/protected_tools/strategies are NOT surfaced", () => {
    const descriptor = setting("dynamicContextPruning");
    expect(descriptor.path).toEqual(["experimental", "dynamic_context_pruning"]);
    expect(descriptor.fields?.map((field) => [field.key, field.kind, field.default])).toEqual([
      ["enabled", "boolean", false],
      ["notification", "enum", "detailed"],
    ]);
    const values = readOmoMiscValues(
      JSON.stringify({
        experimental: {
          dynamic_context_pruning: {
            enabled: true,
            notification: "minimal",
            turn_protection: { enabled: true, turns: 3 },
            protected_tools: ["task"],
            strategies: { deduplication: { enabled: true } },
          },
        },
      }),
      [],
    );
    expect(values.dynamicContextPruning).toEqual({ enabled: true, notification: "minimal" });
    const degraded = readOmoMiscValues(
      JSON.stringify({ experimental: { dynamic_context_pruning: { enabled: true, notification: "loud" } } }),
      [],
    );
    expect(degraded.dynamicContextPruning).toEqual({ enabled: true, notification: null });
    expect(
      readOmoMiscValues(JSON.stringify({ experimental: { dynamic_context_pruning: "off" } }), []).dynamicContextPruning,
    ).toBeNull();
    expect(readOmoMiscValues("{}", []).dynamicContextPruning).toBeNull();
  });

  it("dynamicContextPruning validator: notification ∈ off|minimal|detailed; unknown fields rejected", () => {
    const descriptor = setting("dynamicContextPruning");
    expect(isValidOmoMiscValue(descriptor, { enabled: false, notification: "off" })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { notification: null })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { notification: "loud" })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { enabled: 1 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { made_up: true })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, null)).toBe(true);
  });

  it("dynamicContextPruning edits: per-leaf writes; an all-null map removes the key; experimental siblings survive", () => {
    const seeded = JSON.stringify({ "[opencode]": { experimental: { task_system: true } } });
    const next = applyEdits(
      seeded,
      omoMiscEdits(["[opencode]"], setting("dynamicContextPruning"), { enabled: true, notification: "off" }),
    );
    expect(getValue(next, ["[opencode]", "experimental", "dynamic_context_pruning"])).toEqual({
      enabled: true,
      notification: "off",
    });
    expect(getValue(next, ["[opencode]", "experimental", "task_system"])).toBe(true);
    const emptied = applyEdits(
      next,
      omoMiscEdits(["[opencode]"], setting("dynamicContextPruning"), { enabled: null, notification: null }),
    );
    expect(getValue(emptied, ["[opencode]", "experimental", "dynamic_context_pruning"])).toBeUndefined();
    expect(getValue(emptied, ["[opencode]", "experimental", "task_system"])).toBe(true);
  });

  it("ulwAutoCommit / startWorkAutoCommit: nested containers created on set; null removes the leaf", () => {
    for (const [key, parent] of [
      ["ulwAutoCommit", "ulw_execute"],
      ["startWorkAutoCommit", "start_work"],
    ] as const) {
      const descriptor = setting(key);
      expect(descriptor.path).toEqual([parent, "auto_commit"]);
      expect(descriptor.kind).toBe("boolean");
      expect(descriptor.default).toBe(true);
      const values = readOmoMiscValues(JSON.stringify({ [parent]: { auto_commit: false } }), []);
      expect(values[key]).toBe(false);
      expect(readOmoMiscValues(JSON.stringify({ [parent]: { auto_commit: "no" } }), [])[key]).toBeNull();
      expect(readOmoMiscValues("{}", [])[key]).toBeNull();
      expect(isValidOmoMiscValue(descriptor, false)).toBe(true);
      expect(isValidOmoMiscValue(descriptor, 0)).toBe(false);

      const seeded = applyEdits("{}", omoMiscEdits(["[opencode]"], descriptor, false));
      expect(getValue(seeded, ["[opencode]", parent, "auto_commit"])).toBe(false);
      const removed = applyEdits(seeded, omoMiscEdits(["[opencode]"], descriptor, null));
      expect(getValue(removed, ["[opencode]", parent, "auto_commit"])).toBeUndefined();
      expect(getValue(removed, ["[opencode]", parent])).toEqual({});
    }
  });
});

describe("new-plan batch-1 memory (shared scope — top level for BOTH targets)", () => {
  it("read takes the TOP-LEVEL memory on the omo target and ignores the [opencode].memory decoy", () => {
    const text = JSON.stringify({
      "[opencode]": { memory: { enabled: false, tool_exposure: "search" } },
      memory: { enabled: true, tool_exposure: "direct", reflection: { enabled: false } },
    });
    const values = readOmoMiscValues(text, ["[opencode]"]);
    expect(values.memory).toEqual({ enabled: true, tool_exposure: "direct" });
    const legacy = readOmoMiscValues(JSON.stringify({ memory: { enabled: false } }), []);
    expect(legacy.memory).toEqual({ enabled: false, tool_exposure: null });
  });

  it("read degrades a non-object memory and invalid enum leaves per field; absent → null", () => {
    expect(readOmoMiscValues(JSON.stringify({ memory: "off" }), []).memory).toBeNull();
    expect(readOmoMiscValues("{}", []).memory).toBeNull();
    const badEnum = readOmoMiscValues(JSON.stringify({ memory: { enabled: true, tool_exposure: "both" } }), []);
    expect(badEnum.memory).toEqual({ enabled: true, tool_exposure: null });
  });

  it("validator: enabled boolean, tool_exposure ∈ direct|search, null leaf/whole ok, unknown fields rejected", () => {
    const descriptor = setting("memory");
    expect(descriptor.scope).toBe("shared");
    expect(descriptor.fields?.map((field) => [field.key, field.default])).toEqual([
      ["enabled", true],
      ["tool_exposure", "direct"],
    ]);
    expect(isValidOmoMiscValue(descriptor, { enabled: false, tool_exposure: "search" })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { tool_exposure: null })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { tool_exposure: "both" })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { enabled: 1 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { made_up: true })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, null)).toBe(true);
  });

  it("edits land TOP-LEVEL on the omo target (never under [opencode]); an all-null map removes the key", () => {
    const seeded = JSON.stringify({ "[opencode]": { telemetry: true } });
    const next = applyEdits(
      seeded,
      omoMiscEdits(["[opencode]"], setting("memory"), { enabled: false, tool_exposure: "search" }),
    );
    expect(getValue(next, ["memory"])).toEqual({ enabled: false, tool_exposure: "search" });
    expect(getValue(next, ["[opencode]", "memory"])).toBeUndefined();
    expect(getValue(next, ["[opencode]", "telemetry"])).toBe(true);
    const emptied = applyEdits(
      next,
      omoMiscEdits(["[opencode]"], setting("memory"), { enabled: null, tool_exposure: null }),
    );
    expect(getValue(emptied, ["memory"])).toBeUndefined();
  });
});

describe("new-plan batch-1 stringList descriptors (disabled_* / mcp_env_allowlist)", () => {
  it("metadata: five stringList descriptors at their plugin paths", () => {
    const expected = [
      ["omoDisabledProviders", ["disabled_providers"], "模型目录"],
      ["disabledSkills", ["disabled_skills"], "MCP 与命令"],
      ["disabledHooks", ["disabled_hooks"], "MCP 与命令"],
      ["disabledTools", ["disabled_tools"], "MCP 与命令"],
      ["mcpEnvAllowlist", ["mcp_env_allowlist"], "MCP 与命令"],
    ] as const;
    for (const [key, path, group] of expected) {
      const descriptor = setting(key);
      expect(descriptor.kind).toBe("stringList");
      expect(descriptor.path).toEqual([...path]);
      expect(descriptor.group).toBe(group);
    }
  });

  it("read: string arrays pass through ([] stays []); mixed/non-array values degrade to null", () => {
    const values = readOmoMiscValues(
      JSON.stringify({
        disabled_providers: ["waves"],
        disabled_skills: ["pdf", "docx"],
        disabled_hooks: ["comment-checker"],
        disabled_tools: [],
        mcp_env_allowlist: ["HOME", "PATH"],
      }),
      [],
    );
    expect(values.omoDisabledProviders).toEqual(["waves"]);
    expect(values.disabledSkills).toEqual(["pdf", "docx"]);
    expect(values.disabledHooks).toEqual(["comment-checker"]);
    expect(values.disabledTools).toEqual([]);
    expect(values.mcpEnvAllowlist).toEqual(["HOME", "PATH"]);
    expect(readOmoMiscValues(JSON.stringify({ disabled_skills: ["pdf", 5] }), []).disabledSkills).toBeNull();
    expect(readOmoMiscValues(JSON.stringify({ mcp_env_allowlist: "HOME" }), []).mcpEnvAllowlist).toBeNull();
  });

  it("validator: shared entry rules — unique trimmed non-empty ≤256 chars, 1–16 entries, null ok", () => {
    const descriptor = setting("disabledHooks");
    expect(isValidOmoMiscValue(descriptor, ["comment-checker", "auto-update-checker"])).toBe(true);
    expect(isValidOmoMiscValue(descriptor, [])).toBe(false);
    expect(isValidOmoMiscValue(descriptor, ["a", "a"])).toBe(false);
    expect(isValidOmoMiscValue(descriptor, ["x".repeat(256)])).toBe(true);
    expect(isValidOmoMiscValue(descriptor, ["x".repeat(257)])).toBe(false);
    expect(isValidOmoMiscValue(descriptor, [1])).toBe(false);
    expect(isValidOmoMiscValue(descriptor, "comment-checker")).toBe(false);
    expect(isValidOmoMiscValue(descriptor, null)).toBe(true);
    expect(
      isValidOmoMiscValue(
        descriptor,
        Array.from({ length: 16 }, (_, i) => `hook-${i}`),
      ),
    ).toBe(true);
    expect(
      isValidOmoMiscValue(
        descriptor,
        Array.from({ length: 17 }, (_, i) => `hook-${i}`),
      ),
    ).toBe(false);
  });

  it("edits set/remove the whole array at the section-prefixed path", () => {
    const edits = omoMiscEdits(["[opencode]"], setting("disabledSkills"), ["pdf", "docx"]);
    expect(edits).toEqual([{ path: ["[opencode]", "disabled_skills"], value: ["pdf", "docx"], op: "set" }]);
    const text = applyEdits("{}", edits);
    expect(getValue(text, ["[opencode]", "disabled_skills"])).toEqual(["pdf", "docx"]);
    const removed = applyEdits(text, omoMiscEdits(["[opencode]"], setting("disabledSkills"), null));
    expect(getValue(removed, ["[opencode]", "disabled_skills"])).toBeUndefined();
    const legacy = applyEdits("{}", omoMiscEdits([], setting("mcpEnvAllowlist"), ["HOME"]));
    expect(getValue(legacy, ["mcp_env_allowlist"])).toEqual(["HOME"]);
  });
});

describe("new-plan batch-2a (模型能力缓存 / 保姆超时 / OpenClaw / monitor+team_mode 扩展)", () => {
  it("modelCapabilities metadata: plugin path, flat leaves, runtime-derived boolean defaults, source_url unexposed", () => {
    const descriptor = setting("modelCapabilities");
    expect(descriptor.path).toEqual(["model_capabilities"]);
    expect(descriptor.kind).toBe("shallowObject");
    expect(descriptor.group).toBe("模型目录");
    expect(descriptor.scope).toBeUndefined();
    // Boolean defaults mirror the runtime gates (model-capabilities-status.ts):
    // both features only stop on an explicit `=== false`, so absence = active.
    expect(descriptor.fields?.map((field) => [field.key, field.kind, field.default ?? null])).toEqual([
      ["enabled", "boolean", true],
      ["auto_refresh_on_start", "boolean", true],
      ["refresh_timeout_ms", "number", 5000],
    ]);
  });

  it("modelCapabilities read: leaves surface per field, source_url/unknown keys never do; wrong shapes degrade", () => {
    const values = readOmoMiscValues(
      JSON.stringify({
        "[opencode]": {
          model_capabilities: {
            enabled: false,
            auto_refresh_on_start: true,
            refresh_timeout_ms: 5000,
            source_url: "https://models.dev/api.json",
          },
        },
        model_capabilities: { enabled: true },
      }),
      ["[opencode]"],
    );
    expect(values.modelCapabilities).toEqual({
      enabled: false,
      auto_refresh_on_start: true,
      refresh_timeout_ms: 5000,
    });
    const bad = readOmoMiscValues(
      JSON.stringify({ model_capabilities: { enabled: "yes", refresh_timeout_ms: 250.5 } }),
      [],
    );
    expect(bad.modelCapabilities).toEqual({ enabled: null, auto_refresh_on_start: null, refresh_timeout_ms: null });
    expect(readOmoMiscValues(JSON.stringify({ model_capabilities: "off" }), []).modelCapabilities).toBeNull();
    expect(readOmoMiscValues("{}", []).modelCapabilities).toBeNull();
  });

  it("modelCapabilities validator: boolean leaves, refresh_timeout_ms integer ≥1000, unknown field rejected", () => {
    const descriptor = setting("modelCapabilities");
    expect(
      isValidOmoMiscValue(descriptor, { enabled: false, auto_refresh_on_start: null, refresh_timeout_ms: 1000 }),
    ).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { refresh_timeout_ms: 999 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { refresh_timeout_ms: 5000 })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { refresh_timeout_ms: 250.5 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { enabled: 1 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { auto_refresh_on_start: "true" })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { source_url: "https://models.dev" })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, null)).toBe(true);
  });

  it("modelCapabilities edits: per-leaf write keeps a hand-written source_url; an all-null map removes the key", () => {
    const seeded = JSON.stringify({
      "[opencode]": { model_capabilities: { enabled: true, source_url: "https://models.dev/api.json" } },
    });
    const next = applyEdits(
      seeded,
      omoMiscEdits(["[opencode]"], setting("modelCapabilities"), { refresh_timeout_ms: 8000 }),
    );
    expect(getValue(next, ["[opencode]", "model_capabilities"])).toEqual({
      enabled: true,
      source_url: "https://models.dev/api.json",
      refresh_timeout_ms: 8000,
    });
    const emptied = applyEdits(
      next,
      omoMiscEdits(["[opencode]"], setting("modelCapabilities"), {
        enabled: null,
        auto_refresh_on_start: null,
        refresh_timeout_ms: null,
      }),
    );
    expect(getValue(emptied, ["[opencode]", "model_capabilities"])).toBeUndefined();
  });

  it("babysittingTimeout metadata: nested plugin path, schema default 120000, explicit ms bounds", () => {
    const descriptor = setting("babysittingTimeout");
    expect(descriptor.path).toEqual(["babysitting", "timeout_ms"]);
    expect(descriptor.kind).toBe("number");
    expect(descriptor.group).toBe("编排");
    expect(descriptor.default).toBe(120000);
    expect(descriptor.min).toBe(1000);
    expect(descriptor.max).toBe(3600000);
  });

  it("babysittingTimeout read: passthrough / wrong shape → null / absent → null", () => {
    expect(readOmoMiscValues(JSON.stringify({ babysitting: { timeout_ms: 180000 } }), []).babysittingTimeout).toBe(
      180000,
    );
    expect(
      readOmoMiscValues(JSON.stringify({ babysitting: { timeout_ms: "120000" } }), []).babysittingTimeout,
    ).toBeNull();
    expect(readOmoMiscValues("{}", []).babysittingTimeout).toBeNull();
  });

  it("babysittingTimeout validator: integer 1000–3600000 only (bounds include the schema default)", () => {
    const descriptor = setting("babysittingTimeout");
    expect(isValidOmoMiscValue(descriptor, 120000)).toBe(true);
    expect(isValidOmoMiscValue(descriptor, 1000)).toBe(true);
    expect(isValidOmoMiscValue(descriptor, 3600000)).toBe(true);
    expect(isValidOmoMiscValue(descriptor, 999)).toBe(false);
    expect(isValidOmoMiscValue(descriptor, 3600001)).toBe(false);
    expect(isValidOmoMiscValue(descriptor, 1200.5)).toBe(false);
    expect(isValidOmoMiscValue(descriptor, "120000")).toBe(false);
    expect(isValidOmoMiscValue(descriptor, null)).toBe(true);
  });

  it("babysittingTimeout edits: set creates the nested container; null removes the leaf and keeps it", () => {
    const seeded = applyEdits("{}", omoMiscEdits(["[opencode]"], setting("babysittingTimeout"), 300000));
    expect(getValue(seeded, ["[opencode]", "babysitting", "timeout_ms"])).toBe(300000);
    const removed = applyEdits(seeded, omoMiscEdits(["[opencode]"], setting("babysittingTimeout"), null));
    expect(getValue(removed, ["[opencode]", "babysitting", "timeout_ms"])).toBeUndefined();
    expect(getValue(removed, ["[opencode]", "babysitting"])).toEqual({});
  });

  it("openclawEnabled metadata/read/validator: nested boolean with schema default false", () => {
    const descriptor = setting("openclawEnabled");
    expect(descriptor.path).toEqual(["openclaw", "enabled"]);
    expect(descriptor.kind).toBe("boolean");
    expect(descriptor.group).toBe("工具链");
    expect(descriptor.default).toBe(false);
    expect(readOmoMiscValues(JSON.stringify({ openclaw: { enabled: true } }), []).openclawEnabled).toBe(true);
    expect(readOmoMiscValues(JSON.stringify({ openclaw: { enabled: 1 } }), []).openclawEnabled).toBeNull();
    expect(readOmoMiscValues("{}", []).openclawEnabled).toBeNull();
    expect(isValidOmoMiscValue(descriptor, true)).toBe(true);
    expect(isValidOmoMiscValue(descriptor, 1)).toBe(false);
    expect(isValidOmoMiscValue(descriptor, "true")).toBe(false);
    expect(isValidOmoMiscValue(descriptor, null)).toBe(true);
  });

  it("openclawEnabled edits: set/remove touch only the leaf; a hand-written gateways block survives both", () => {
    const gateways = { primary: { type: "http", method: "POST", url: "https://example.com/hook" } };
    const seeded = JSON.stringify({ "[opencode]": { openclaw: { enabled: false, gateways } } });
    const next = applyEdits(seeded, omoMiscEdits(["[opencode]"], setting("openclawEnabled"), true));
    expect(getValue(next, ["[opencode]", "openclaw", "enabled"])).toBe(true);
    expect(getValue(next, ["[opencode]", "openclaw", "gateways"])).toEqual(gateways);
    const removed = applyEdits(next, omoMiscEdits(["[opencode]"], setting("openclawEnabled"), null));
    expect(getValue(removed, ["[opencode]", "openclaw", "enabled"])).toBeUndefined();
    expect(getValue(removed, ["[opencode]", "openclaw", "gateways"])).toEqual(gateways);
  });

  it("monitorParams extension: new caps validate within schema bounds; allowed_commands surfaces as a stringList leaf", () => {
    const monitor = setting("monitorParams");
    expect(isValidOmoMiscValue(monitor, { max_monitors_per_session: 3, max_runtime_ms: 1800000 })).toBe(true);
    expect(isValidOmoMiscValue(monitor, { max_monitors_per_session: 1 })).toBe(true);
    expect(isValidOmoMiscValue(monitor, { max_monitors_per_session: 0 })).toBe(false);
    expect(isValidOmoMiscValue(monitor, { max_monitors_per_session: 16 })).toBe(true);
    expect(isValidOmoMiscValue(monitor, { max_monitors_per_session: 17 })).toBe(false);
    expect(isValidOmoMiscValue(monitor, { max_runtime_ms: 1000 })).toBe(true);
    expect(isValidOmoMiscValue(monitor, { max_runtime_ms: 999 })).toBe(false);
    expect(isValidOmoMiscValue(monitor, { max_runtime_ms: 1800.5 })).toBe(false);
    const values = readOmoMiscValues(
      JSON.stringify({
        monitor: { enabled: true, max_monitors_per_session: 5, allowed_commands: ["git"], batch_max_lines: 10 },
      }),
      [],
    );
    expect(values.monitorParams).toEqual({
      enabled: true,
      live_mode_enabled: null,
      max_monitors_per_session: 5,
      max_runtime_ms: null,
      allowed_commands: ["git"],
    });
  });

  it("monitorParams edits: per-leaf write keeps allowed_commands and a user comment (existing per-leaf behavior intact)", () => {
    const seeded =
      '{\n  "monitor": {\n    // user note\n    "allowed_commands": ["git"],\n    "enabled": true,\n  },\n}\n';
    const next = applyEdits(seeded, omoMiscEdits([], setting("monitorParams"), { max_monitors_per_session: 8 }));
    expect(getValue(next, ["monitor"])).toEqual({
      allowed_commands: ["git"],
      enabled: true,
      max_monitors_per_session: 8,
    });
    expect(next).toContain("// user note");
  });

  it("teamModeLimits extension: message/mailbox caps validate within schema bounds; defaults metadata", () => {
    const limits = setting("teamModeLimits");
    const appended = limits.fields?.filter(
      (field) => field.key === "max_messages_per_run" || field.key === "mailbox_poll_interval_ms",
    );
    expect(appended?.map((field) => [field.key, field.default])).toEqual([
      ["max_messages_per_run", 10000],
      ["mailbox_poll_interval_ms", 3000],
    ]);
    expect(isValidOmoMiscValue(limits, { max_messages_per_run: 10000, mailbox_poll_interval_ms: 3000 })).toBe(true);
    expect(isValidOmoMiscValue(limits, { max_messages_per_run: 1 })).toBe(true);
    expect(isValidOmoMiscValue(limits, { max_messages_per_run: 0 })).toBe(false);
    expect(isValidOmoMiscValue(limits, { mailbox_poll_interval_ms: 500 })).toBe(true);
    expect(isValidOmoMiscValue(limits, { mailbox_poll_interval_ms: 499 })).toBe(false);
    expect(isValidOmoMiscValue(limits, { mailbox_poll_interval_ms: 3000.5 })).toBe(false);
    // The pre-existing four-cap subset maps keep validating (extension adds, never narrows).
    expect(isValidOmoMiscValue(limits, { max_parallel_members: 4, max_members: 8 })).toBe(true);
  });

  it("teamModeLimits extension: new leaves surface on read; per-leaf writes keep shared-parent siblings", () => {
    const values = readOmoMiscValues(
      JSON.stringify({ team_mode: { enabled: true, max_members: 6, mailbox_poll_interval_ms: 2000 } }),
      [],
    );
    expect(values.teamModeLimits).toEqual({
      max_parallel_members: null,
      max_members: 6,
      max_wall_clock_minutes: null,
      max_member_turns: null,
      max_messages_per_run: null,
      mailbox_poll_interval_ms: 2000,
    });
    const seeded = JSON.stringify({ team_mode: { enabled: true, max_members: 8 } });
    const next = applyEdits(seeded, omoMiscEdits([], setting("teamModeLimits"), { max_messages_per_run: 500 }));
    expect(getValue(next, ["team_mode"])).toEqual({ enabled: true, max_members: 8, max_messages_per_run: 500 });
  });
});

describe("batch-2b numberMap kind (并发上限 / 温度覆写)", () => {
  it("descriptor metadata: flat concurrency maps, nested temperature maps, bounds and agents leafKeys", () => {
    const provider = setting("providerConcurrency");
    expect(provider.path).toEqual(["background_task", "providerConcurrency"]);
    expect(provider.kind).toBe("numberMap");
    expect(provider.min).toBe(0);
    expect(provider.max).toBeUndefined();
    expect(provider.agents).toBeUndefined();
    expect(provider.group).toBe("编排");
    expect(provider.label).toBe("供应商并发上限");

    const model = setting("modelConcurrency");
    expect(model.path).toEqual(["background_task", "modelConcurrency"]);
    expect(model.kind).toBe("numberMap");
    expect(model.min).toBe(0);
    expect(model.group).toBe("编排");

    const agentTemp = setting("agentTemperature");
    expect(agentTemp.path).toEqual(["agents"]);
    expect(agentTemp.kind).toBe("numberMap");
    expect(agentTemp.agents).toEqual({ leafKey: "temperature" });
    expect(agentTemp.options).toEqual([...KNOWN_AGENTS]);
    expect(agentTemp.min).toBe(0);
    expect(agentTemp.max).toBe(2);
    expect(agentTemp.group).toBe("覆写矩阵");

    const categoryTemp = setting("categoryTemperature");
    expect(categoryTemp.path).toEqual(["categories"]);
    expect(categoryTemp.kind).toBe("numberMap");
    expect(categoryTemp.agents).toEqual({ leafKey: "temperature" });
    expect(categoryTemp.options).toBeUndefined();
    expect(categoryTemp.min).toBe(0);
    expect(categoryTemp.max).toBe(2);
    expect(categoryTemp.group).toBe("覆写矩阵");
  });

  it("flat read: finite in-range numbers surface (decimals ok); non-numeric and out-of-range entries are skipped", () => {
    const text = JSON.stringify({
      background_task: {
        defaultConcurrency: 5,
        providerConcurrency: { zhipuai: 4, moonshotai: 2.5, kimi: 0, bad: "4", off: -1, nil: null, flag: true },
      },
    });
    expect(readOmoMiscValues(text, []).providerConcurrency).toEqual({ zhipuai: 4, moonshotai: 2.5, kimi: 0 });
    // The shared background_task parent still feeds the batch-1 scalar descriptor.
    expect(readOmoMiscValues(text, []).backgroundConcurrency).toBe(5);
  });

  it("flat read degrades wrong shapes (non-object / absent) to null", () => {
    expect(
      readOmoMiscValues(JSON.stringify({ background_task: { providerConcurrency: "nope" } }), []).providerConcurrency,
    ).toBeNull();
    expect(
      readOmoMiscValues(JSON.stringify({ background_task: { providerConcurrency: ["a"] } }), []).providerConcurrency,
    ).toBeNull();
    expect(readOmoMiscValues("{}", []).providerConcurrency).toBeNull();
  });

  it("nested read with options: agents.<name>.temperature surfaces only for options agents; broken entries are skipped", () => {
    const text = JSON.stringify({
      agents: {
        oracle: { temperature: 0.5 },
        atlas: { temperature: 1.75 },
        metis: { temperature: 3 },
        momus: { temperature: "0.5" },
        sisyphus: { prompt: "no leaf" },
        "made-up-agent": { temperature: 1 },
      },
    });
    expect(readOmoMiscValues(text, []).agentTemperature).toEqual({ oracle: 0.5, atlas: 1.75 });
    expect(readOmoMiscValues("{}", []).agentTemperature).toBeNull();
    expect(readOmoMiscValues(JSON.stringify({ agents: "nope" }), []).agentTemperature).toBeNull();
  });

  it("nested free-key read: every category key surfaces; broken entries are skipped", () => {
    const text = JSON.stringify({
      categories: {
        backend: { temperature: 0.7 },
        "my-custom": { temperature: 1.75 },
        visual: { temperature: 5 },
        quick: { temperature: false },
        broken: "not an object",
      },
    });
    expect(readOmoMiscValues(text, []).categoryTemperature).toEqual({ backend: 0.7, "my-custom": 1.75 });
  });

  it("read prefixes the omo sectionPath for both variants (top-level decoys ignored)", () => {
    const text = JSON.stringify({
      "[opencode]": {
        background_task: { providerConcurrency: { zhipuai: 3 } },
        categories: { backend: { temperature: 0.4 } },
      },
      background_task: { providerConcurrency: { evil: 9 } },
      categories: { backend: { temperature: 2 } },
    });
    const values = readOmoMiscValues(text, ["[opencode]"]);
    expect(values.providerConcurrency).toEqual({ zhipuai: 3 });
    expect(values.categoryTemperature).toEqual({ backend: 0.4 });
  });

  it("validator: free keys reuse the modelCatalog alias charset; options restrict keys; per-entry bounds accept decimals", () => {
    const provider = setting("providerConcurrency");
    expect(isValidOmoMiscValue(provider, { zhipuai: 4 })).toBe(true);
    expect(isValidOmoMiscValue(provider, { zhipuai: 0 })).toBe(true);
    expect(isValidOmoMiscValue(provider, { zhipuai: 2.5 })).toBe(true); // schema minimum 0, decimals legal
    expect(isValidOmoMiscValue(provider, { zhipuai: 100000 })).toBe(true); // no descriptor max → unbounded above
    expect(isValidOmoMiscValue(provider, { zhipuai: -1 })).toBe(false);
    expect(isValidOmoMiscValue(provider, { zhipuai: Number.NaN })).toBe(false);
    expect(isValidOmoMiscValue(provider, { zhipuai: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isValidOmoMiscValue(provider, { zhipuai: "4" })).toBe(false);
    expect(isValidOmoMiscValue(provider, { zhipuai: null })).toBe(true);
    expect(isValidOmoMiscValue(provider, {})).toBe(true);
    expect(isValidOmoMiscValue(provider, null)).toBe(true);
    expect(isValidOmoMiscValue(provider, 4)).toBe(false);
    expect(isValidOmoMiscValue(provider, ["zhipuai"])).toBe(false);
    // Free-key charset: the modelCatalog alias rules (identifier chars, ≤32 chars).
    expect(isValidOmoMiscValue(provider, { "a.b-c_d": 1 })).toBe(true);
    expect(isValidOmoMiscValue(provider, { "bad key!": 1 })).toBe(false);
    expect(isValidOmoMiscValue(provider, { 分类: 1 })).toBe(false);
    expect(isValidOmoMiscValue(provider, { ["x".repeat(33)]: 1 })).toBe(false);

    const agentTemp = setting("agentTemperature");
    expect(isValidOmoMiscValue(agentTemp, { oracle: 0.5, atlas: 1.75 })).toBe(true);
    expect(isValidOmoMiscValue(agentTemp, { oracle: 2 })).toBe(true);
    expect(isValidOmoMiscValue(agentTemp, { oracle: 2.1 })).toBe(false);
    expect(isValidOmoMiscValue(agentTemp, { oracle: -0.1 })).toBe(false);
    expect(isValidOmoMiscValue(agentTemp, { "made-up-agent": 1 })).toBe(false);
  });

  it("validator: entry count capped at 32 (mirror of the modelCatalog bound)", () => {
    const provider = setting("providerConcurrency");
    const entries = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`p-${i}`, i]));
    expect(isValidOmoMiscValue(provider, entries(32))).toBe(true);
    expect(isValidOmoMiscValue(provider, entries(33))).toBe(false);
  });

  it("flat edits: per-entry set/remove at <path>.<key>; null whole-value removes the key itself and keeps siblings", () => {
    const seeded = JSON.stringify({
      "[opencode]": {
        background_task: { defaultConcurrency: 5, providerConcurrency: { kimi: 2, keep: 1 } },
      },
      background_task: { defaultConcurrency: 5, providerConcurrency: { kimi: 2, keep: 1 } },
    });
    const next = applyEdits(
      seeded,
      omoMiscEdits(["[opencode]"], setting("providerConcurrency"), { zhipuai: 4, kimi: null }),
    );
    expect(getValue(next, ["[opencode]", "background_task", "providerConcurrency"])).toEqual({
      keep: 1,
      zhipuai: 4,
    });
    expect(getValue(next, ["[opencode]", "background_task", "defaultConcurrency"])).toBe(5);
    // A sibling numberMap sharing the parent object leaves it untouched too.
    const modelNext = applyEdits(seeded, omoMiscEdits([], setting("modelConcurrency"), { "zhipuai/glm-5": 3 }));
    expect(getValue(modelNext, ["background_task", "providerConcurrency"])).toEqual({ kimi: 2, keep: 1 });
    expect(getValue(modelNext, ["background_task", "modelConcurrency"])).toEqual({ "zhipuai/glm-5": 3 });
    // Flat maps MAY collapse: a null whole-value removes just the providerConcurrency leaf.
    const removed = applyEdits(next, omoMiscEdits(["[opencode]"], setting("providerConcurrency"), null));
    expect(getValue(removed, ["[opencode]", "background_task", "providerConcurrency"])).toBeUndefined();
    expect(getValue(removed, ["[opencode]", "background_task", "defaultConcurrency"])).toBe(5);
  });

  it("nested edits: per-entry set/remove at <path>.<name>.<leafKey>; null whole-value produces NO edits", () => {
    const text = applyEdits(
      "{}",
      omoMiscEdits(["[opencode]"], setting("agentTemperature"), { oracle: 0.5, atlas: null }),
    );
    expect(getValue(text, ["[opencode]", "agents", "oracle", "temperature"])).toBe(0.5);

    const categoryText = applyEdits(
      "{}",
      omoMiscEdits([], setting("categoryTemperature"), { backend: 0.7, "my-custom": 1.75 }),
    );
    expect(getValue(categoryText, ["categories", "backend", "temperature"])).toBe(0.7);
    expect(getValue(categoryText, ["categories", "my-custom", "temperature"])).toBe(1.75);

    const seeded = JSON.stringify({ agents: { atlas: { temperature: 1, model: "x/y" } } });
    const removed = applyEdits(seeded, omoMiscEdits([], setting("agentTemperature"), { atlas: null }));
    expect(getValue(removed, ["agents", "atlas", "temperature"])).toBeUndefined();
    expect(getValue(removed, ["agents", "atlas", "model"])).toBe("x/y");
    // Nested leaf maps NEVER wipe: a null whole-value is 无编辑 (shared agents/categories block).
    expect(omoMiscEdits([], setting("agentTemperature"), null)).toEqual([]);
    expect(applyEdits(seeded, omoMiscEdits([], setting("agentTemperature"), null))).toBe(seeded);
    expect(applyEdits(seeded, omoMiscEdits([], setting("categoryTemperature"), null))).toBe(seeded);
  });

  it("agentTemperature writes never disturb a hand-written agents.build.prompt (sibling survival)", () => {
    const seeded =
      '{\n  "agents": {\n    // 手写提示词\n    "build": { "prompt": "file://prompts/build.md" },\n  },\n}\n';
    const next = applyEdits(seeded, omoMiscEdits([], setting("agentTemperature"), { build: 0.9 }));
    expect(getValue(next, ["agents", "build"])).toEqual({ prompt: "file://prompts/build.md", temperature: 0.9 });
    expect(next).toContain("// 手写提示词");
    const removed = applyEdits(next, omoMiscEdits([], setting("agentTemperature"), { build: null }));
    expect(getValue(removed, ["agents", "build"])).toEqual({ prompt: "file://prompts/build.md" });
  });

  it("edits ignore a non-record value instead of corrupting the file (callers validate first)", () => {
    const bad = 42 as unknown as OmoSettingValue;
    expect(omoMiscEdits([], setting("providerConcurrency"), bad)).toEqual([]);
    expect(omoMiscEdits([], setting("agentTemperature"), bad)).toEqual([]);
  });
});

describe("batch-2b categoryPromptAppend (free-key agentTextMap)", () => {
  it("descriptor metadata: categories target, prompt_append leaf, free keys, ≤8000 hint bound", () => {
    const descriptor = setting("categoryPromptAppend");
    expect(descriptor.kind).toBe("agentTextMap");
    expect(descriptor.path).toEqual(["categories"]);
    expect(descriptor.agents).toEqual({ leafKey: "prompt_append" });
    expect(descriptor.options).toBeUndefined();
    expect(descriptor.group).toBe("提示词");
    expect(descriptor.label).toBe("分类提示词追加");
  });

  it("read: free category keys surface at categories.<name>.prompt_append; broken values are skipped", () => {
    const text = JSON.stringify({
      categories: {
        backend: { prompt_append: "注意事务。", temperature: 0.3 },
        quick: { prompt_append: "   " },
        deep: { prompt_append: 42 },
        writing: { prompt_append: "x".repeat(8000) },
        broken: "not an object",
      },
    });
    expect(readOmoMiscValues(text, []).categoryPromptAppend).toEqual({
      backend: "注意事务。",
      writing: "x".repeat(8000),
    });
    expect(readOmoMiscValues("{}", []).categoryPromptAppend).toBeNull();
    expect(readOmoMiscValues(JSON.stringify({ categories: "nope" }), []).categoryPromptAppend).toBeNull();
  });

  it("validator: free keys pass the identifier charset; trimmed non-empty ≤8000 (AGENT_TEXT_MAX_LENGTH reuse) or null", () => {
    const descriptor = setting("categoryPromptAppend");
    expect(isValidOmoMiscValue(descriptor, { backend: "追加", "my-custom": null })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, {})).toBe(true);
    expect(isValidOmoMiscValue(descriptor, null)).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { "bad key!": "text" })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { ["x".repeat(33)]: "text" })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { backend: "   " })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { backend: "x".repeat(8000) })).toBe(true);
    expect(isValidOmoMiscValue(descriptor, { backend: "x".repeat(8001) })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, { backend: 42 })).toBe(false);
    expect(isValidOmoMiscValue(descriptor, ["text"])).toBe(false);
  });

  it("edits: per-category set/remove keep siblings; whole null produces no edits", () => {
    const seeded = JSON.stringify({
      categories: { backend: { temperature: 0.7, prompt_append: "旧" }, quick: { prompt_append: "删" } },
    });
    const next = applyEdits(
      seeded,
      omoMiscEdits([], setting("categoryPromptAppend"), { backend: "新文本", quick: null }),
    );
    expect(getValue(next, ["categories", "backend"])).toEqual({ temperature: 0.7, prompt_append: "新文本" });
    expect(getValue(next, ["categories", "quick"])).toEqual({});
    expect(applyEdits(seeded, omoMiscEdits([], setting("categoryPromptAppend"), null))).toBe(seeded);
  });
});

describe("batch-7 monitor.allowed_commands (shallowObject stringList leaf)", () => {
  const unsetLeaves = {
    enabled: null,
    live_mode_enabled: null,
    max_monitors_per_session: null,
    max_runtime_ms: null,
  };

  it("descriptor: kind stringList with the whitelist label; schema leaves stay unexposed", () => {
    const field = setting("monitorParams").fields?.find((entry) => entry.key === "allowed_commands");
    expect(field?.kind).toBe("stringList");
    expect(field?.label).toBe("允许的命令");
    expect(setting("monitorParams").fields?.some((entry) => entry.key === "batch_max_lines")).toBe(false);
  });

  it("read: a valid list surfaces; wrong shapes degrade to a null leaf", () => {
    const values = readOmoMiscValues(
      JSON.stringify({ monitor: { allowed_commands: ["git", "rg"], enabled: true } }),
      [],
    );
    expect(values.monitorParams).toEqual({ ...unsetLeaves, enabled: true, allowed_commands: ["git", "rg"] });
    const degraded = readOmoMiscValues(JSON.stringify({ monitor: { allowed_commands: "git" } }), []);
    expect(degraded.monitorParams).toEqual({ ...unsetLeaves, allowed_commands: null });
    const dupes = readOmoMiscValues(JSON.stringify({ monitor: { allowed_commands: ["git", "git"] } }), []);
    expect(dupes.monitorParams).toEqual({ ...unsetLeaves, allowed_commands: null });
  });

  it("validator: the shared stringList rules (1–16 unique trimmed non-empty ≤256)", () => {
    const monitor = setting("monitorParams");
    expect(isValidOmoMiscValue(monitor, { allowed_commands: ["git"] })).toBe(true);
    expect(isValidOmoMiscValue(monitor, { allowed_commands: [] })).toBe(false);
    expect(isValidOmoMiscValue(monitor, { allowed_commands: ["git", "git"] })).toBe(false);
    expect(isValidOmoMiscValue(monitor, { allowed_commands: [""] })).toBe(false);
    expect(isValidOmoMiscValue(monitor, { allowed_commands: "git" })).toBe(false);
    expect(isValidOmoMiscValue(monitor, { allowed_commands: null })).toBe(true); // null leaf = unset
  });

  it("edits: a full-map write sets the leaf, keeps siblings and JSONC comments; a null leaf removes it", () => {
    const seeded = '{\n  "monitor": {\n    // user note\n    "enabled": true,\n    "batch_max_lines": 10,\n  },\n}\n';
    const next = applyEdits(
      seeded,
      omoMiscEdits([], setting("monitorParams"), { ...unsetLeaves, enabled: true, allowed_commands: ["git", "rg"] }),
    );
    expect(getValue(next, ["monitor"])).toEqual({
      enabled: true,
      batch_max_lines: 10,
      allowed_commands: ["git", "rg"],
    });
    expect(next).toContain("// user note");

    const cleared = applyEdits(
      next,
      omoMiscEdits([], setting("monitorParams"), { ...unsetLeaves, enabled: true, allowed_commands: null }),
    );
    expect(getValue(cleared, ["monitor", "allowed_commands"])).toBeUndefined();
    expect(getValue(cleared, ["monitor", "enabled"])).toBe(true);
    expect(getValue(cleared, ["monitor", "batch_max_lines"])).toBe(10);
  });
});
