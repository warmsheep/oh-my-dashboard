import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  balanceColor as CORE_BALANCE_COLOR,
  deriveRemainingPercent as CORE_DERIVE_REMAINING,
  remainingColor as CORE_REMAINING_COLOR,
} from "../../src/core/quotaService";
import {
  KNOWN_AGENTS as CORE_KNOWN_AGENTS,
  KNOWN_CATEGORIES as CORE_KNOWN_CATEGORIES,
  VARIANT_ORDER as CORE_VARIANT_ORDER,
  VARIANTS as CORE_VARIANTS,
} from "../../src/core/types";
import type { ModelOption as CoreModelOption } from "../../src/core/types";
import {
  AUTO_REFRESH_CATEGORIES,
  AUTO_REFRESH_DEFAULT_INTERVAL_SECONDS,
  AUTO_REFRESH_MAX_INTERVAL_SECONDS,
  AUTO_REFRESH_MIN_INTERVAL_SECONDS,
  autoRefreshCategoryLabel,
  balanceColor,
  defaultQuotaVisibility,
  deriveRemainingPercent,
  filterQuotaSnapshotByVisibility,
  formatQuotaResetTime,
  KNOWN_AGENTS,
  KNOWN_CATEGORIES,
  normalizeAutoRefreshSettings,
  QUOTA_PROVIDER_IDS,
  QUOTA_REFRESH_DEFAULT_SECONDS,
  QUOTA_WINDOW_ORDER,
  quotaCurrencySymbol,
  quotaWindowLabel,
  remainingColor,
  VARIANT_ORDER,
  VARIANTS,
} from "../../src/shared/protocol";
import type { AutoRefreshSettings, ModelOption, QuotaSnapshot, QuotaWindow, Variant } from "../../src/shared/protocol";

const PROTOCOL_SRC = path.resolve(process.cwd(), "src/shared/protocol.ts");

describe("shared/protocol dependency guard", () => {
  it("protocol.ts declares no imports other than type-only from ./ (stays vscode-free and dependency-free)", () => {
    const source = readFileSync(PROTOCOL_SRC, "utf8");
    const importLines = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("import"));
    // Currently zero imports; if one is ever needed it must be type-only, same-dir.
    for (const line of importLines) {
      expect(line).toMatch(/^import type \{[^}]*\} from "\.\/[^"]+";$/);
    }
    expect(source).not.toMatch(/["']vscode["']/);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it("evaluates standalone (no transitive runtime dependencies leaked through imports)", async () => {
    const mod = await import("../../src/shared/protocol");
    expect(mod.KNOWN_AGENTS.length).toBeGreaterThan(0);
  });
});

describe("shared/protocol canonical lists", () => {
  it("KNOWN_AGENTS / KNOWN_CATEGORIES are non-empty and duplicate-free", () => {
    for (const list of [KNOWN_AGENTS, KNOWN_CATEGORIES]) {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("VARIANT_ORDER is a permutation of VARIANTS (same five entries)", () => {
    expect([...VARIANT_ORDER].sort()).toEqual([...VARIANTS].sort());
    expect(new Set(VARIANT_ORDER).size).toBe(VARIANTS.length);
  });
});

describe("core/types re-exports the protocol canonicals (single source of truth)", () => {
  it("KNOWN_AGENTS / KNOWN_CATEGORIES / VARIANTS / VARIANT_ORDER are the same objects via both paths", () => {
    expect(CORE_KNOWN_AGENTS).toBe(KNOWN_AGENTS);
    expect(CORE_KNOWN_CATEGORIES).toBe(KNOWN_CATEGORIES);
    expect(CORE_VARIANTS).toBe(VARIANTS);
    expect(CORE_VARIANT_ORDER).toBe(VARIANT_ORDER);
  });

  it("ModelOption type is shared structurally (assignment compiles)", () => {
    const option: ModelOption = { id: "p/m", provider: "p", model: "m", label: "M" };
    const coreOption: CoreModelOption = option;
    expect(coreOption.id).toBe("p/m");
  });

  it("Variant values remain the classic five", () => {
    const variants: readonly Variant[] = ["low", "medium", "high", "xhigh", "max"];
    expect([...VARIANTS]).toEqual(variants);
  });
});

describe("shared/protocol quota canon (single source of truth)", () => {
  it("QUOTA_PROVIDER_IDS is the canonical four-provider order, duplicate-free", () => {
    expect([...QUOTA_PROVIDER_IDS]).toEqual(["kimi", "glm", "mimo", "deepseek"]);
    expect(new Set(QUOTA_PROVIDER_IDS).size).toBe(QUOTA_PROVIDER_IDS.length);
  });

  it("QUOTA_WINDOW_ORDER is the canonical 5h → weekly → monthly display order", () => {
    expect([...QUOTA_WINDOW_ORDER]).toEqual(["5h", "weekly", "monthly"]);
    expect(new Set(QUOTA_WINDOW_ORDER).size).toBe(QUOTA_WINDOW_ORDER.length);
  });

  it("quota display helpers re-exported from core are the same objects via both paths", () => {
    expect(CORE_DERIVE_REMAINING).toBe(deriveRemainingPercent);
    expect(CORE_REMAINING_COLOR).toBe(remainingColor);
    expect(CORE_BALANCE_COLOR).toBe(balanceColor);
  });

  it("quotaWindowLabel maps the three window kinds to Chinese labels", () => {
    expect(quotaWindowLabel("5h")).toBe("5小时额度");
    expect(quotaWindowLabel("weekly")).toBe("周额度");
    expect(quotaWindowLabel("monthly")).toBe("月额度");
  });

  it("quotaCurrencySymbol knows CNY/USD and prefixes unknown codes", () => {
    expect(quotaCurrencySymbol("CNY")).toBe("¥");
    expect(quotaCurrencySymbol("USD")).toBe("$");
    expect(quotaCurrencySymbol("EUR")).toBe("EUR ");
  });

  it("formatQuotaResetTime renders a known timestamp and degrades for garbage", () => {
    expect(formatQuotaResetTime("2026-08-25T10:00:00Z")).toMatch(/^重置于 \d{4}\/\d{1,2}\/\d{1,2}/);
    expect(formatQuotaResetTime(null)).toBe("重置时间未知");
    expect(formatQuotaResetTime("not-a-date")).toBe("重置时间未知");
  });

  it("remaining/balance color bands match the status-bar rules", () => {
    expect(remainingColor(60)).toBe("green");
    expect(remainingColor(59.9)).toBe("yellow");
    expect(remainingColor(20)).toBe("yellow");
    expect(remainingColor(19.9)).toBe("red");
    expect(balanceColor(100)).toBe("yellow");
    expect(balanceColor(100.01)).toBe("green");
    expect(balanceColor(19.9)).toBe("red");
  });

  it("deriveRemainingPercent prefers remainingPercent and derives from usedPercent", () => {
    const w = (partial: Partial<QuotaWindow>): QuotaWindow => ({
      kind: "weekly",
      usedPercent: null,
      remainingPercent: null,
      used: null,
      limit: null,
      remaining: null,
      resetAt: null,
      ...partial,
    });
    expect(deriveRemainingPercent(w({ remainingPercent: 72, usedPercent: 28 }))).toBe(72);
    expect(deriveRemainingPercent(w({ usedPercent: 33.3 }))).toBe(66.7);
    expect(deriveRemainingPercent(w({}))).toBeNull();
  });
});

describe("shared/protocol settings canon (auto-refresh contract)", () => {
  it("AUTO_REFRESH_CATEGORIES is the canonical five-section order, duplicate-free", () => {
    expect([...AUTO_REFRESH_CATEGORIES]).toEqual(["config", "presets", "backups", "models", "plugins"]);
    expect(new Set(AUTO_REFRESH_CATEGORIES).size).toBe(AUTO_REFRESH_CATEGORIES.length);
  });

  it("autoRefreshCategoryLabel maps the five categories to Chinese section names", () => {
    expect(autoRefreshCategoryLabel("config")).toBe("配置");
    expect(autoRefreshCategoryLabel("presets")).toBe("模板");
    expect(autoRefreshCategoryLabel("backups")).toBe("备份");
    expect(autoRefreshCategoryLabel("models")).toBe("模型");
    expect(autoRefreshCategoryLabel("plugins")).toBe("插件");
  });

  it("normalizeAutoRefreshSettings fills every default for empty/absent input", () => {
    for (const source of [undefined, null, {}]) {
      const settings = normalizeAutoRefreshSettings(source);
      for (const category of AUTO_REFRESH_CATEGORIES) {
        expect(settings.categories[category]).toEqual({
          enabled: false,
          intervalSeconds: AUTO_REFRESH_DEFAULT_INTERVAL_SECONDS,
        });
      }
      expect(settings.quotaRefreshSeconds).toBe(QUOTA_REFRESH_DEFAULT_SECONDS);
    }
  });

  it("normalizeAutoRefreshSettings keeps valid values and preserves disabled intervals", () => {
    const settings = normalizeAutoRefreshSettings({
      categories: { presets: { enabled: true, intervalSeconds: 45 }, backups: { enabled: false, intervalSeconds: 90 } },
      quotaRefreshSeconds: 0,
    });
    expect(settings.categories.presets).toEqual({ enabled: true, intervalSeconds: 45 });
    expect(settings.categories.backups).toEqual({ enabled: false, intervalSeconds: 90 });
    expect(settings.quotaRefreshSeconds).toBe(0);
  });

  it("normalizeAutoRefreshSettings clamps out-of-range intervals and rounds fractions", () => {
    const settings = normalizeAutoRefreshSettings({
      categories: {
        config: { enabled: true, intervalSeconds: 0 },
        models: { enabled: true, intervalSeconds: 99_999 },
        plugins: { enabled: true, intervalSeconds: 29.6 },
      },
      quotaRefreshSeconds: -5,
    });
    expect(settings.categories.config.intervalSeconds).toBe(AUTO_REFRESH_MIN_INTERVAL_SECONDS);
    expect(settings.categories.models.intervalSeconds).toBe(AUTO_REFRESH_MAX_INTERVAL_SECONDS);
    expect(settings.categories.plugins.intervalSeconds).toBe(30);
    expect(settings.quotaRefreshSeconds).toBe(0);
  });

  it("normalizeAutoRefreshSettings degrades garbage input to defaults and strict-boolean enabled", () => {
    const settings = normalizeAutoRefreshSettings({
      categories: {
        config: { enabled: "yes" as unknown, intervalSeconds: "fast" as unknown },
        presets: { enabled: 1 as unknown, intervalSeconds: Number.NaN },
      },
      quotaRefreshSeconds: "off" as unknown,
    });
    expect(settings.categories.config).toEqual({
      enabled: false,
      intervalSeconds: AUTO_REFRESH_DEFAULT_INTERVAL_SECONDS,
    });
    expect(settings.categories.presets).toEqual({
      enabled: false,
      intervalSeconds: AUTO_REFRESH_DEFAULT_INTERVAL_SECONDS,
    });
    expect(settings.quotaRefreshSeconds).toBe(QUOTA_REFRESH_DEFAULT_SECONDS);
  });

  it("normalizeAutoRefreshSettings output is assignable to the AutoRefreshSettings contract", () => {
    const settings: AutoRefreshSettings = normalizeAutoRefreshSettings({
      categories: { plugins: { enabled: true, intervalSeconds: 60 } },
      quotaRefreshSeconds: 120,
    });
    expect(settings.categories.plugins.enabled).toBe(true);
    expect(settings.quotaRefreshSeconds).toBe(120);
  });
});

describe("quota visibility helpers", () => {
  const snapshot: QuotaSnapshot = {
    fetchedAt: "t",
    providers: [
      { providerId: "kimi", label: "Kimi", plan: null, windows: [], balances: null, configured: true, error: null },
      { providerId: "glm", label: "GLM", plan: null, windows: [], balances: null, configured: true, error: "x" },
      { providerId: "mimo", label: "MiMo", plan: null, windows: [], balances: null, configured: false, error: null },
      {
        providerId: "deepseek",
        label: "DeepSeek",
        plan: null,
        windows: [],
        balances: null,
        configured: true,
        error: null,
      },
    ],
  };

  it("defaultQuotaVisibility marks every provider visible", () => {
    expect(defaultQuotaVisibility()).toEqual({
      kimi: true,
      glm: true,
      mimo: true,
      deepseek: true,
    });
  });

  it("filterQuotaSnapshotByVisibility keeps visible providers and preserves fetchedAt", () => {
    const filtered = filterQuotaSnapshotByVisibility(snapshot, { kimi: true, glm: false, mimo: false, deepseek: true });
    expect(filtered.providers.map((provider) => provider.providerId)).toEqual(["kimi", "deepseek"]);
    expect(filtered.fetchedAt).toBe("t");
  });

  it("filterQuotaSnapshotByVisibility with everything visible is an identity pass-through", () => {
    const filtered = filterQuotaSnapshotByVisibility(snapshot, defaultQuotaVisibility());
    expect(filtered.providers).toHaveLength(4);
  });
});
