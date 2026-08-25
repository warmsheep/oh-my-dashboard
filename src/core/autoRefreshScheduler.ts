import type { AutoRefreshCategory, AutoRefreshSettings } from "../shared/protocol";
import { AUTO_REFRESH_CATEGORIES } from "../shared/protocol";
import type { ClearTimeoutFn, SetTimeoutFn } from "./watchManager";

export interface AutoRefreshSchedulerOptions {
  /** Live settings read — re-read at every arm so config changes land on the next tick. */
  getSettings(): AutoRefreshSettings;
  /** Invoked when a category's polling interval elapses. */
  onRefresh(category: AutoRefreshCategory): void;
  setTimeout?: SetTimeoutFn;
  clearTimeout?: ClearTimeoutFn;
}

/**
 * Per-category timed auto-refresh polling for the tree sections (pure Node,
 * vscode-free). Each enabled category runs its own self-scheduling setTimeout
 * chain — NOT setInterval — so ticks never overlap and interval changes apply
 * on the next arm. Filesystem watching (WatchManager) is a separate, always-on
 * mechanism; this scheduler only adds the opt-in polling fallback.
 */
export class AutoRefreshScheduler {
  private readonly getSettingsFn: () => AutoRefreshSettings;
  private readonly onRefreshFn: (category: AutoRefreshCategory) => void;
  private readonly scheduleTimeout: SetTimeoutFn;
  private readonly cancelTimeout: ClearTimeoutFn;
  private readonly timers = new Map<AutoRefreshCategory, unknown>();
  private disposed = false;

  constructor(options: AutoRefreshSchedulerOptions) {
    this.getSettingsFn = options.getSettings;
    this.onRefreshFn = options.onRefresh;
    this.scheduleTimeout = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.cancelTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /**
   * (Re-)arm every enabled category and clear disabled ones. Idempotent; call
   * after settings changes — a pending tick is replaced, so new intervals start
   * immediately instead of waiting out the old delay.
   */
  reconfigure(): void {
    if (this.disposed) {
      return;
    }
    const settings = this.getSettingsFn();
    for (const category of AUTO_REFRESH_CATEGORIES) {
      this.clearTimer(category);
      const { enabled, intervalSeconds } = settings.categories[category];
      if (enabled) {
        this.arm(category, intervalSeconds);
      }
    }
  }

  /** Number of armed category timers (tests assert arming without real time). */
  timerCount(): number {
    return this.timers.size;
  }

  dispose(): void {
    for (const category of [...this.timers.keys()]) {
      this.clearTimer(category);
    }
    this.disposed = true;
  }

  private arm(category: AutoRefreshCategory, intervalSeconds: number): void {
    this.timers.set(
      category,
      this.scheduleTimeout(() => {
        this.timers.delete(category);
        if (this.disposed) {
          return;
        }
        this.onRefreshFn(category);
        // Re-read live settings: a disable or interval change applies right here,
        // even if the extension-side config listener missed the change.
        const current = this.getSettingsFn().categories[category];
        if (current.enabled) {
          this.arm(category, current.intervalSeconds);
        }
      }, intervalSeconds * 1000),
    );
  }

  private clearTimer(category: AutoRefreshCategory): void {
    const handle = this.timers.get(category);
    if (handle !== undefined) {
      this.cancelTimeout(handle);
      this.timers.delete(category);
    }
  }
}
