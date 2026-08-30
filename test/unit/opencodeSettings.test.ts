import { describe, expect, it } from "vitest";

import { applyEdits } from "../../src/core/jsoncEditor";
import {
  isValidOpencodeSettingValue,
  opencodeSettingEdits,
  readOpencodeSettingValues,
} from "../../src/core/opencodeSettings";
import { OPENCODE_SETTINGS } from "../../src/shared/protocol";
import type { OpencodeSetting } from "../../src/shared/protocol";

/** Descriptor lookup by key; throws on typos so a bad test key fails loudly. */
function setting(key: string): OpencodeSetting {
  const found = OPENCODE_SETTINGS.find((entry) => entry.key === key);
  if (found === undefined) {
    throw new Error(`unknown test key: ${key}`);
  }
  return found;
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
      agent: { build: { model: "a/b" }, plan: { model: "c/d" } },
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
    });
  });

  it("returns null for absent keys and covers every descriptor on empty text", () => {
    const values = readOpencodeSettingValues("{}");
    for (const entry of OPENCODE_SETTINGS) {
      expect(values[entry.key]).toBeNull();
    }
    const empty = readOpencodeSettingValues("");
    expect(Object.keys(empty).length).toBe(OPENCODE_SETTINGS.length);
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
      }),
    );
    expect(values.model).toBeNull();
    expect(values.share).toBeNull();
    expect(values.autoupdate).toBeNull();
    expect(values.snapshot).toBeNull();
    expect(values.username).toBeNull();
    expect(values.disabledProviders).toBeNull();
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
});
