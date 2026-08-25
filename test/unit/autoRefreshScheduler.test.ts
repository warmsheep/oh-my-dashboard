import { describe, expect, it } from "vitest";

import { AutoRefreshScheduler } from "../../src/core/autoRefreshScheduler";
import type { AutoRefreshCategory, AutoRefreshSettings } from "../../src/shared/protocol";
import { AUTO_REFRESH_CATEGORIES, normalizeAutoRefreshSettings } from "../../src/shared/protocol";

/**
 * Manual timer registry with category tagging. The scheduler arms timers in two
 * deterministic spots — reconfigure() walks AUTO_REFRESH_CATEGORIES order, and a
 * fired handler re-arms its own category synchronously — so the test declares the
 * expected arm sequence up front (expectArms) and each setTimeout call consumes
 * the next tag. Handlers never auto-run; tests fire them explicitly.
 */
class FakeTimers {
  private handle = 0;
  private queue: AutoRefreshCategory[] = [];
  private readonly timers = new Map<number, { handler: () => void; ms: number }>();
  private readonly tags = new Map<number, AutoRefreshCategory>();

  setTimeout = (handler: () => void, ms: number): unknown => {
    this.handle += 1;
    this.timers.set(this.handle, { handler, ms });
    const tag = this.queue.shift();
    if (tag !== undefined) {
      this.tags.set(this.handle, tag);
    }
    return this.handle;
  };

  clearTimeout = (handle: unknown): void => {
    const id = handle as number;
    this.timers.delete(id);
    this.tags.delete(id);
  };

  /** Declare the categories whose timers the next scheduler action will arm. */
  expectArms(categories: AutoRefreshCategory[]): void {
    this.queue = [...categories];
  }

  /** Run one full reconfigure pass with the expected arm sequence. */
  reconfigure(scheduler: AutoRefreshScheduler, arms: AutoRefreshCategory[]): void {
    this.expectArms(arms);
    scheduler.reconfigure();
    this.queue = [];
  }

  /** Fire the pending timer of one category; throws when it has none armed. */
  fire(category: AutoRefreshCategory, rearm: boolean): void {
    for (const [id, timer] of [...this.timers.entries()]) {
      if (this.tags.get(id) === category) {
        this.timers.delete(id);
        this.tags.delete(id);
        if (rearm) {
          this.expectArms([category]);
        }
        timer.handler();
        this.queue = [];
        return;
      }
    }
    throw new Error(`no pending timer for ${category}`);
  }

  pending(category: AutoRefreshCategory): number | undefined {
    for (const [id, timer] of this.timers.entries()) {
      if (this.tags.get(id) === category) {
        return timer.ms;
      }
    }
    return undefined;
  }

  pendingCount(): number {
    return this.timers.size;
  }
}

describe("AutoRefreshScheduler", () => {
  const settingsOf = (
    categories: Partial<Record<AutoRefreshCategory, { enabled: boolean; intervalSeconds: number }>>,
  ): AutoRefreshSettings =>
    normalizeAutoRefreshSettings({
      categories: Object.fromEntries(
        AUTO_REFRESH_CATEGORIES.map((category) => [
          category,
          categories[category] ?? { enabled: false, intervalSeconds: 30 },
        ]),
      ),
      quotaRefreshSeconds: 30,
    });

  const makeScheduler = (
    getSettings: () => AutoRefreshSettings,
    onRefresh: (category: AutoRefreshCategory) => void,
  ): { scheduler: AutoRefreshScheduler; timers: FakeTimers } => {
    const timers = new FakeTimers();
    const scheduler = new AutoRefreshScheduler({
      getSettings,
      onRefresh,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    return { scheduler, timers };
  };

  it("arms nothing when every category is disabled", () => {
    const { scheduler, timers } = makeScheduler(
      () => settingsOf({}),
      () => undefined,
    );
    timers.reconfigure(scheduler, []);
    expect(scheduler.timerCount()).toBe(0);
    expect(timers.pendingCount()).toBe(0);
  });

  it("arms one timer per enabled category with the configured interval", () => {
    const settings = settingsOf({
      config: { enabled: true, intervalSeconds: 30 },
      backups: { enabled: true, intervalSeconds: 60 },
    });
    const { scheduler, timers } = makeScheduler(
      () => settings,
      () => undefined,
    );
    timers.reconfigure(scheduler, ["config", "backups"]);
    expect(scheduler.timerCount()).toBe(2);
    expect(timers.pending("config")).toBe(30_000);
    expect(timers.pending("backups")).toBe(60_000);
  });

  it("fires onRefresh per tick and re-arms with the interval re-read live", () => {
    let settings = settingsOf({ presets: { enabled: true, intervalSeconds: 30 } });
    const refreshed: AutoRefreshCategory[] = [];
    const { scheduler, timers } = makeScheduler(
      () => settings,
      (category) => refreshed.push(category),
    );
    timers.reconfigure(scheduler, ["presets"]);
    timers.fire("presets", true);
    expect(refreshed).toEqual(["presets"]);
    expect(timers.pending("presets")).toBe(30_000);
    // Interval change lands on the next tick without an explicit reconfigure.
    settings = settingsOf({ presets: { enabled: true, intervalSeconds: 45 } });
    timers.fire("presets", true);
    expect(refreshed).toEqual(["presets", "presets"]);
    expect(timers.pending("presets")).toBe(45_000);
  });

  it("stops the chain when the category is disabled between ticks", () => {
    let settings = settingsOf({ models: { enabled: true, intervalSeconds: 30 } });
    const { scheduler, timers } = makeScheduler(
      () => settings,
      () => undefined,
    );
    timers.reconfigure(scheduler, ["models"]);
    settings = settingsOf({});
    timers.fire("models", false);
    expect(timers.pending("models")).toBeUndefined();
    expect(scheduler.timerCount()).toBe(0);
  });

  it("reconfigure replaces a pending timer (new interval applies immediately) and clears disabled ones", () => {
    let settings = settingsOf({ plugins: { enabled: true, intervalSeconds: 30 } });
    const { scheduler, timers } = makeScheduler(
      () => settings,
      () => undefined,
    );
    timers.reconfigure(scheduler, ["plugins"]);
    expect(timers.pending("plugins")).toBe(30_000);
    settings = settingsOf({ plugins: { enabled: true, intervalSeconds: 120 } });
    timers.reconfigure(scheduler, ["plugins"]);
    expect(timers.pendingCount()).toBe(1);
    expect(timers.pending("plugins")).toBe(120_000);
    settings = settingsOf({});
    timers.reconfigure(scheduler, []);
    expect(timers.pendingCount()).toBe(0);
    expect(scheduler.timerCount()).toBe(0);
  });

  it("reconfigure is idempotent for unchanged settings", () => {
    const settings = settingsOf({ config: { enabled: true, intervalSeconds: 30 } });
    const { scheduler, timers } = makeScheduler(
      () => settings,
      () => undefined,
    );
    timers.reconfigure(scheduler, ["config"]);
    timers.reconfigure(scheduler, ["config"]);
    expect(timers.pendingCount()).toBe(1);
  });

  it("re-reads settings on every reconfigure call", () => {
    // getSettings must be consulted per call, not cached at construction — the
    // extension reconfigures only on config-change events.
    let settings = settingsOf({});
    const { scheduler, timers } = makeScheduler(
      () => settings,
      () => undefined,
    );
    timers.reconfigure(scheduler, []);
    expect(timers.pendingCount()).toBe(0);
    settings = settingsOf({ backups: { enabled: true, intervalSeconds: 15 } });
    timers.reconfigure(scheduler, ["backups"]);
    expect(timers.pending("backups")).toBe(15_000);
  });

  it("dispose cancels every pending timer and freezes the scheduler", () => {
    const settings = settingsOf({ config: { enabled: true, intervalSeconds: 30 } });
    const { scheduler, timers } = makeScheduler(
      () => settings,
      () => undefined,
    );
    timers.reconfigure(scheduler, ["config"]);
    scheduler.dispose();
    expect(timers.pendingCount()).toBe(0);
    expect(scheduler.timerCount()).toBe(0);
    timers.reconfigure(scheduler, ["config"]);
    expect(timers.pendingCount()).toBe(0);
  });
});
