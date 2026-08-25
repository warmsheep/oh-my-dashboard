import type { AutoRefreshCategory, AutoRefreshSettings } from "@shared/protocol";
import { AUTO_REFRESH_CATEGORIES } from "@shared/protocol";
import { describe, expect, it } from "vitest";

import {
  buildSettings,
  clampIntervalInput,
  clampQuotaInput,
  isSettingsDirty,
  mergeIncomingDrafts,
  mergeIncomingSettings,
} from "./helpers";

/** Uniform settings fixture: every category shares enabled/interval to keep the merge assertions readable. */
function makeSettings(enabled: boolean, intervalSeconds: number, quotaRefreshSeconds: number): AutoRefreshSettings {
  const categories = {} as Record<AutoRefreshCategory, { enabled: boolean; intervalSeconds: number }>;
  for (const category of AUTO_REFRESH_CATEGORIES) {
    categories[category] = { enabled, intervalSeconds };
  }
  return buildSettings(categories, quotaRefreshSeconds);
}

/** Fixture with per-category overrides on top of the uniform defaults. */
function makeSettingsWith(
  overrides: Partial<Record<AutoRefreshCategory, { enabled: boolean; intervalSeconds: number }>>,
  quotaRefreshSeconds = 30,
): AutoRefreshSettings {
  const categories = {} as Record<AutoRefreshCategory, { enabled: boolean; intervalSeconds: number }>;
  for (const category of AUTO_REFRESH_CATEGORIES) {
    categories[category] = overrides[category] ?? { enabled: false, intervalSeconds: 30 };
  }
  return buildSettings(categories, quotaRefreshSeconds);
}

describe("clampIntervalInput", () => {
  it("parses plain integers", () => {
    expect(clampIntervalInput("45")).toBe(45);
  });

  it("trims surrounding whitespace and rounds fractions", () => {
    expect(clampIntervalInput("  30  ")).toBe(30);
    expect(clampIntervalInput("45.7")).toBe(46);
  });

  it("returns null for empty or non-numeric text", () => {
    expect(clampIntervalInput("")).toBeNull();
    expect(clampIntervalInput("   ")).toBeNull();
    expect(clampIntervalInput("abc")).toBeNull();
  });

  it("clamps below the minimum and above the maximum", () => {
    expect(clampIntervalInput("0")).toBe(1);
    expect(clampIntervalInput("-20")).toBe(1);
    expect(clampIntervalInput("3601")).toBe(3600);
    expect(clampIntervalInput("999999")).toBe(3600);
  });

  it("keeps the exact bounds", () => {
    expect(clampIntervalInput("1")).toBe(1);
    expect(clampIntervalInput("3600")).toBe(3600);
  });
});

describe("clampQuotaInput", () => {
  it("allows 0 (disabled cycle) and the upper bound", () => {
    expect(clampQuotaInput("0")).toBe(0);
    expect(clampQuotaInput("3600")).toBe(3600);
  });

  it("clamps out-of-range values into 0-3600", () => {
    expect(clampQuotaInput("-5")).toBe(0);
    expect(clampQuotaInput("7200")).toBe(3600);
  });

  it("rounds fractional input", () => {
    expect(clampQuotaInput("29.4")).toBe(29);
  });

  it("returns null for empty or non-numeric text", () => {
    expect(clampQuotaInput("")).toBeNull();
    expect(clampQuotaInput("x1")).toBeNull();
  });
});

describe("buildSettings", () => {
  it("passes through well-formed form values", () => {
    const result = makeSettings(true, 120, 60);
    expect(result.categories.config).toEqual({ enabled: true, intervalSeconds: 120 });
    expect(result.quotaRefreshSeconds).toBe(60);
  });

  it("normalizes out-of-range values through the shared clamps", () => {
    const result = makeSettings(false, 0, 99999);
    for (const category of AUTO_REFRESH_CATEGORIES) {
      expect(result.categories[category]).toEqual({ enabled: false, intervalSeconds: 1 });
    }
    expect(result.quotaRefreshSeconds).toBe(3600);
  });
});

describe("isSettingsDirty", () => {
  it("is clean when form equals saved", () => {
    const settings = makeSettingsWith({ presets: { enabled: true, intervalSeconds: 45 } }, 60);
    expect(isSettingsDirty(settings, settings)).toBe(false);
  });

  it("detects toggle, interval and quota differences", () => {
    const saved = makeSettings(false, 30, 30);
    expect(isSettingsDirty(makeSettingsWith({ models: { enabled: true, intervalSeconds: 30 } }), saved)).toBe(true);
    expect(isSettingsDirty(makeSettingsWith({ models: { enabled: false, intervalSeconds: 45 } }), saved)).toBe(true);
    expect(isSettingsDirty(makeSettingsWith({}, 10), saved)).toBe(true);
  });
});

describe("mergeIncomingSettings", () => {
  it("adopts the incoming object wholesale into both states when nothing is dirty", () => {
    const saved = makeSettings(false, 30, 30);
    const incoming = makeSettings(true, 600, 0);
    const merged = mergeIncomingSettings(incoming, saved, saved);
    expect(merged.saved).toBe(incoming);
    expect(merged.form).toEqual(incoming);
  });

  it("preserves dirty fields in the form while saved adopts the push", () => {
    const saved = makeSettings(false, 30, 30);
    const form = makeSettingsWith({ backups: { enabled: true, intervalSeconds: 45 } }, 120);
    const incoming = makeSettingsWith({ presets: { enabled: true, intervalSeconds: 300 } }, 0);
    const merged = mergeIncomingSettings(incoming, saved, form);
    // Persisted truth always wins for `saved`.
    expect(merged.saved).toBe(incoming);
    // Form keeps the edited backups + quota, adopts the untouched presets push.
    expect(merged.form.categories.backups).toEqual({ enabled: true, intervalSeconds: 45 });
    expect(merged.form.quotaRefreshSeconds).toBe(120);
    expect(merged.form.categories.presets).toEqual({ enabled: true, intervalSeconds: 300 });
  });

  it("adopts the incoming value for a category whose toggle is clean but interval dirty", () => {
    const saved = makeSettings(false, 30, 30);
    const form = makeSettingsWith({ config: { enabled: false, intervalSeconds: 90 } });
    const incoming = makeSettings(true, 600, 0);
    const merged = mergeIncomingSettings(incoming, saved, form);
    // Interval is dirty → the whole category keeps the user's values.
    expect(merged.form.categories.config).toEqual({ enabled: false, intervalSeconds: 90 });
  });
});

describe("mergeIncomingDrafts", () => {
  it("clears drafts when nothing is focused", () => {
    expect(mergeIncomingDrafts({ config: "12", quota: "0" }, null)).toEqual({});
  });

  it("drops stale drafts of non-focused fields", () => {
    expect(mergeIncomingDrafts({ config: "12", quota: "0" }, "quota")).toEqual({ quota: "0" });
  });

  it("returns empty when the focused field has no draft", () => {
    expect(mergeIncomingDrafts({ config: "12" }, "presets")).toEqual({});
  });
});
