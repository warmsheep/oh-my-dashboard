import { describe, expect, it } from "vitest";

import { normalizeManagerTab } from "./helpers";

describe("normalizeManagerTab", () => {
  it('returns "settings" only for the literal settings tab', () => {
    expect(normalizeManagerTab("settings")).toBe("settings");
  });

  it("degrades garbage persisted state to the quota tab", () => {
    expect(normalizeManagerTab("quota")).toBe("quota");
    expect(normalizeManagerTab(undefined)).toBe("quota");
    expect(normalizeManagerTab(null)).toBe("quota");
    expect(normalizeManagerTab(42)).toBe("quota");
    expect(normalizeManagerTab({ tab: "settings" })).toBe("quota");
    expect(normalizeManagerTab("Settings")).toBe("quota");
  });
});
