import { describe, expect, it } from "vitest";

import { normalizeManagerTab } from "./helpers";

describe("normalizeManagerTab", () => {
  it("passes through the known literal tabs", () => {
    expect(normalizeManagerTab("settings")).toBe("settings");
    expect(normalizeManagerTab("preset")).toBe("preset");
    expect(normalizeManagerTab("quota")).toBe("quota");
  });

  it("degrades garbage persisted state to the quota tab", () => {
    expect(normalizeManagerTab(undefined)).toBe("quota");
    expect(normalizeManagerTab(null)).toBe("quota");
    expect(normalizeManagerTab(42)).toBe("quota");
    expect(normalizeManagerTab({ tab: "settings" })).toBe("quota");
    expect(normalizeManagerTab("Settings")).toBe("quota");
    expect(normalizeManagerTab("preset ")).toBe("quota");
  });
});
