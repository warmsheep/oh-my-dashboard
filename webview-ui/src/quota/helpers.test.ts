import type { ProviderQuota, QuotaWindow } from "@shared/protocol";
import { describe, expect, it } from "vitest";

import {
  balanceText,
  balanceTone,
  cookiePlaceholder,
  formatFetchedAt,
  formatTokenCount,
  orderedWindows,
  progressPercent,
  windowRemaining,
} from "./helpers";

function window(partial: Partial<QuotaWindow>): QuotaWindow {
  return {
    kind: "weekly",
    usedPercent: null,
    remainingPercent: null,
    used: null,
    limit: null,
    remaining: null,
    resetAt: null,
    ...partial,
  };
}

describe("orderedWindows", () => {
  it("sorts windows into the 5h → weekly → monthly display order", () => {
    const sorted = orderedWindows([window({ kind: "monthly" }), window({ kind: "weekly" }), window({ kind: "5h" })]);
    expect(sorted.map((w) => w.kind)).toEqual(["5h", "weekly", "monthly"]);
  });
});

describe("progressPercent", () => {
  it("prefers usedPercent for the bar fill", () => {
    expect(progressPercent(window({ usedPercent: 28, remainingPercent: 72 }))).toBe(28);
  });

  it("derives from remainingPercent when usedPercent is null", () => {
    expect(progressPercent(window({ remainingPercent: 72 }))).toBe(28);
  });

  it("returns null when both are unknown (no fabricated bar)", () => {
    expect(progressPercent(window({}))).toBeNull();
  });
});

describe("formatTokenCount", () => {
  it("renders small counts as-is", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(9999)).toBe("9999");
  });

  it("compresses into 万 with one decimal", () => {
    expect(formatTokenCount(10_000)).toBe("1万");
    expect(formatTokenCount(123_456)).toBe("12.3万");
  });

  it("compresses into 亿 with one decimal", () => {
    expect(formatTokenCount(1_200_000_000)).toBe("1.2亿");
    expect(formatTokenCount(1_234_567_890)).toBe("1.2亿");
    expect(formatTokenCount(12_300_000_000)).toBe("12.3亿");
  });
});

describe("windowRemaining", () => {
  it("maps remaining percent to the shared color bands", () => {
    expect(windowRemaining(window({ remainingPercent: 70 }))).toEqual({ percent: 70, colorClass: "tone-green" });
    expect(windowRemaining(window({ usedPercent: 70 }))).toEqual({ percent: 30, colorClass: "tone-yellow" });
    expect(windowRemaining(window({ remainingPercent: 10 }))).toEqual({ percent: 10, colorClass: "tone-red" });
  });

  it("returns null when no percent is known", () => {
    expect(windowRemaining(window({}))).toBeNull();
  });
});

describe("balanceText / balanceTone", () => {
  it("renders a currency-prefixed amount with two decimals", () => {
    expect(balanceText({ total: 12.345, currency: "CNY" })).toBe("¥12.35");
    expect(balanceText({ total: 5, currency: "USD" })).toBe("$5.00");
    expect(balanceText({ total: 5, currency: "EUR" })).toBe("EUR 5.00");
  });

  it("returns null without a usable total/currency pair", () => {
    expect(balanceText({ total: null, currency: "CNY" })).toBeNull();
    expect(balanceText({ total: 5, currency: null })).toBeNull();
    expect(balanceText(null)).toBeNull();
  });

  it("maps balances to the absolute-amount color bands", () => {
    expect(balanceTone(150)).toBe("tone-green");
    expect(balanceTone(50)).toBe("tone-yellow");
    expect(balanceTone(10)).toBe("tone-red");
  });
});

describe("cookiePlaceholder", () => {
  it("keeps the field empty-safe when a cookie is already stored", () => {
    expect(cookiePlaceholder(true)).toBe("已配置 — 留空保持不变");
  });

  it("shows the expected cookie shape when unconfigured", () => {
    expect(cookiePlaceholder(false)).toContain("api-platform_serviceToken");
  });
});

describe("formatFetchedAt", () => {
  it("prefixes the localized timestamp", () => {
    const text = formatFetchedAt("2026-08-25T10:00:00Z");
    expect(text.startsWith("更新于 ")).toBe(true);
    expect(text.length).toBeGreaterThan("更新于 ".length);
  });
});

describe("provider grouping fallback", () => {
  it("reuses the provider type without losing shape (type-level smoke)", () => {
    const provider: ProviderQuota = {
      providerId: "kimi",
      label: "Kimi",
      plan: null,
      windows: [],
      balances: null,
      configured: false,
      error: null,
    };
    expect(provider.providerId).toBe("kimi");
  });
});
