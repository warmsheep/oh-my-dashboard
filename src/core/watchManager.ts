import * as defaultFs from "node:fs";
import * as path from "node:path";

import { errorDetail } from "./errors";

/** Injectable stand-in for fs.watch(target, options, listener). */
export type WatchFactory = (
  target: string,
  options: defaultFs.WatchOptions,
  listener: (event: string, filename: string | Buffer | null) => void,
) => defaultFs.FSWatcher;

/** Injectable timer pair so tests control the debounce without real time passing. */
export type SetTimeoutFn = (handler: () => void, timeoutMs: number) => unknown;
export type ClearTimeoutFn = (handle: unknown) => void;

/**
 * One watched directory.
 *
 * - `allowedBasenames` present → flat filtered watch: only events whose filename basename
 *   is in the set schedule a tracked-file refresh (subject to content dedupe). Used for
 *   churn-heavy dirs (configDir, ~/.omo, plugin cache) that host unrelated runtime files.
 * - `allowedBasenames` absent → identity-less watch: any event FORCES the next refresh
 *   (recursive watchers cannot attribute events to files, so dedupe must not apply).
 *
 * Targets pointing at non-existent dirs are skipped at arm time and retried on every
 * event burst, so dirs created after activation (presets/, <cache>/packages/…) get armed.
 */
export interface WatchTarget {
  dir: string;
  recursive: boolean;
  allowedBasenames?: ReadonlySet<string>;
}

export interface WatchManagerOptions {
  targets: readonly WatchTarget[];
  /** Invoked after debounce + dedupe decided a real refresh is needed. */
  onRefresh(): void;
  log(message: string): void;
  watch?: WatchFactory;
  setTimeout?: SetTimeoutFn;
  clearTimeout?: ClearTimeoutFn;
  now?(): number;
  debounceMs?: number;
  /** How long after noteExternalRefresh() forced (identity-less) events are dropped. */
  forcedCooldownMs?: number;
  /** Min gap between refreshes (default 1000ms): watcher churn must not turn into a refresh pump. */
  minIntervalMs?: number;
  /** Max time a pending burst may be postponed by further events (default 2000ms) — trailing-debounce starvation guard. */
  maxWaitMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_FORCED_COOLDOWN_MS = 500;
const DEFAULT_MIN_INTERVAL_MS = 1_000;
const DEFAULT_MAX_WAIT_MS = 2_000;
/** Re-arm backoff for a failing watch target: 1s doubling, capped at 30s. */
const ARM_BACKOFF_BASE_MS = 1_000;
const ARM_BACKOFF_CAP_MS = 30_000;

/**
 * Debounced filesystem-watch orchestrator for the managed config dirs (pure Node,
 * vscode-free). Owns what extension.ts previously inlined:
 *
 * 1. Watcher arming — one watcher per existing target dir, never duplicated; watcher
 *    errors (EMFILE/EPERM, watched dir deleted) degrade to a log line, the handle is
 *    closed and un-registered so the next burst can re-arm it — one bad dir must never
 *    crash the extension host.
 * 2. Refresh scheduling — debounceMs coalescing of event bursts, content-level dedupe
 *    for tracked files (identical bytes → no refresh), forced path for identity-less
 *    watchers.
 * 3. Explicit-refresh echo suppression — after a command-driven refreshAll,
 *    noteExternalRefresh() marks tracked files' current contents as seen (own-write
 *    echoes dedupe naturally) and opens a short cooldown for forced events, so the
 *    extension's own writes don't pay a second full refresh ~300ms later.
 */
export class WatchManager {
  private readonly targets: readonly WatchTarget[];
  private readonly onRefreshCallback: () => void;
  private readonly log: (message: string) => void;
  private readonly watchFn: WatchFactory;
  private readonly scheduleTimeout: SetTimeoutFn;
  private readonly cancelTimeout: ClearTimeoutFn;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly forcedCooldownMs: number;
  private readonly minIntervalMs: number;
  private readonly maxWaitMs: number;

  private readonly watchers = new Map<string, defaultFs.FSWatcher>();
  /** Tracked-file contents last deemed current; null = known-missing at mark time. */
  private readonly lastFileContents = new Map<string, string | null>();
  private readonly pendingTriggers = new Set<string>();
  /** Dirs whose watch failure is already logged this streak — quiet until a real event proves recovery. */
  private readonly loggedWatchFailures = new Set<string>();
  /** Per-dir re-arm backoff: earliest retry time (epoch ms) after a failed arm attempt. */
  private readonly armRetryAfter = new Map<string, number>();
  private readonly armFailures = new Map<string, number>();
  private timer: unknown;
  /** When the current pending burst started (epoch ms) — the maxWaitMs starvation guard. */
  private pendingSince: number | undefined;
  /** Earliest allowed next refresh (epoch ms) — the minIntervalMs pump guard. */
  private nextRefreshAt = 0;
  private forceNext = false;
  private suppressForcedUntil = 0;
  private disposed = false;

  constructor(options: WatchManagerOptions) {
    this.targets = options.targets;
    this.onRefreshCallback = options.onRefresh;
    this.log = options.log;
    this.watchFn = options.watch ?? ((target, opts, listener) => defaultFs.watch(target, opts, listener));
    this.scheduleTimeout = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
    this.cancelTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.now = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.forcedCooldownMs = options.forcedCooldownMs ?? DEFAULT_FORCED_COOLDOWN_MS;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  /** (Re-)arm watchers for every existing target dir. Idempotent; safe to call per burst. */
  arm(): void {
    for (const target of this.targets) {
      if (this.watchers.has(target.dir) || !defaultFs.existsSync(target.dir)) {
        continue;
      }
      const retryAt = this.armRetryAfter.get(target.dir);
      if (retryAt !== undefined && this.now() < retryAt) {
        continue;
      }
      try {
        const watcher = this.watchFn(target.dir, { recursive: target.recursive }, this.handlerFor(target));
        // An async error (EMFILE/EPERM/deleted dir) with no listener would take down the
        // extension host: drop the handle so re-arming can retry instead.
        watcher.on("error", (error: Error) => this.handleWatcherError(target.dir, watcher, error));
        this.watchers.set(target.dir, watcher);
        this.armRetryAfter.delete(target.dir);
        this.armFailures.delete(target.dir);
      } catch (error) {
        // Log once per failure streak: a persistently failing target re-tried every
        // burst must not flood the output channel. A delivered event clears the memo.
        if (!this.loggedWatchFailures.has(target.dir)) {
          this.loggedWatchFailures.add(target.dir);
          this.log(`watchManager: fs.watch(${target.dir}) 失败: ${errorDetail(error)}`);
        }
        // Exponential retry backoff: re-arming a big recursive tree costs O(subtree)
        // syscalls — a per-burst retry of a doomed target is its own storm.
        const failures = Math.min((this.armFailures.get(target.dir) ?? 0) + 1, 5);
        this.armFailures.set(target.dir, failures);
        this.armRetryAfter.set(
          target.dir,
          this.now() + Math.min(ARM_BACKOFF_BASE_MS * 2 ** (failures - 1), ARM_BACKOFF_CAP_MS),
        );
      }
    }
  }

  /**
   * Watcher event entry point. A tracked-file path schedules a deduped refresh; no
   * argument (identity-less watcher) forces the next refresh past the content dedupe.
   */
  scheduleRefresh(trigger?: string): void {
    if (this.disposed) {
      return;
    }
    if (trigger === undefined) {
      this.forceNext = true;
    } else {
      this.pendingTriggers.add(trigger);
    }
    if (this.timer !== undefined) {
      // Trailing debounce, bounded by maxWait: further events keep postponing the fire
      // ONLY while the burst is younger than maxWaitMs — older bursts must fire even
      // under continuous churn (starvation otherwise never refreshes NOR re-arms).
      const waited = this.now() - (this.pendingSince ?? this.now());
      if (waited < this.maxWaitMs) {
        this.cancelTimeout(this.timer);
        this.timer = this.scheduleTimeout(() => this.fire(), this.debounceMs);
      }
    } else {
      this.pendingSince = this.now();
      this.timer = this.scheduleTimeout(() => this.fire(), this.debounceMs);
    }
  }

  /**
   * Call right after an explicit (command-driven) refresh completed: the extension's
   * own writes echo back through fs.watch ~debounceMs later. Marks every tracked
   * candidate file's current content as seen (unchanged echoes dedupe; real later
   * changes and creations still refresh) and opens the forced-event cooldown (the only
   * suppression available for recursive watchers, which carry no file identity).
   */
  noteExternalRefresh(): void {
    const until = this.now() + this.forcedCooldownMs;
    if (until > this.suppressForcedUntil) {
      this.suppressForcedUntil = until;
    }
    for (const target of this.targets) {
      if (target.allowedBasenames === undefined) {
        continue;
      }
      for (const base of target.allowedBasenames) {
        const file = path.join(target.dir, base);
        try {
          this.lastFileContents.set(file, defaultFs.readFileSync(file, "utf8"));
        } catch {
          this.lastFileContents.set(file, null); // known-missing: a later creation is still a change
        }
      }
    }
  }

  watcherCount(): number {
    return this.watchers.size;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      this.cancelTimeout(this.timer);
      this.timer = undefined;
    }
    for (const watcher of this.watchers.values()) {
      closeWatcherQuietly(watcher);
    }
    this.watchers.clear();
    this.pendingTriggers.clear();
  }

  private fire(): void {
    // Min-interval throttle: defer (not drop) a too-soon refresh; the pending
    // triggers stay queued for the rescheduled fire.
    const nowAtFire = this.now();
    if (nowAtFire < this.nextRefreshAt) {
      this.timer = this.scheduleTimeout(() => this.fire(), Math.max(1, this.nextRefreshAt - nowAtFire));
      return;
    }
    this.timer = undefined;
    this.pendingSince = undefined;
    this.nextRefreshAt = nowAtFire + this.minIntervalMs;
    // Re-arm once per (debounced) burst, not per event — an event storm pays one
    // existsSync pass and one retry for dropped watchers instead of one per event.
    this.arm();
    const forced = this.forceNext;
    this.forceNext = false;
    const triggers = [...this.pendingTriggers];
    this.pendingTriggers.clear();

    if (forced) {
      if (this.now() >= this.suppressForcedUntil) {
        this.onRefreshCallback();
        return;
      }
      // Cooldown: the forced trigger is the echo of our own explicit refresh — drop it,
      // but still honor tracked files in the same burst whose content genuinely changed.
      const changed = triggers.filter((file) => this.fileChanged(file));
      if (changed.length > 0) {
        this.onRefreshCallback();
      }
      return;
    }
    const changed = triggers.filter((file) => this.fileChanged(file));
    if (changed.length > 0) {
      this.onRefreshCallback();
    }
  }

  /** True when the file's bytes differ from the last state we acted on (null = missing). */
  private fileChanged(file: string): boolean {
    let current: string | null;
    try {
      current = defaultFs.readFileSync(file, "utf8");
    } catch {
      current = null; // vanished or never existed
    }
    const seen = this.lastFileContents.get(file);
    if (seen !== undefined && seen === current) {
      return false; // identical bytes (or still missing after a known-missing mark)
    }
    this.lastFileContents.set(file, current);
    return true;
  }

  private handlerFor(target: WatchTarget): (event: string, filename: string | Buffer | null) => void {
    // A delivered event proves the watch works — reset the failure-log memo for this dir.
    const noteHealthy = (): void => {
      this.loggedWatchFailures.delete(target.dir);
    };
    if (target.allowedBasenames === undefined) {
      return () => {
        noteHealthy();
        this.scheduleRefresh();
      };
    }
    return (_event: string, filename: string | Buffer | null): void => {
      noteHealthy();
      const base = filename === null ? "" : path.basename(filename.toString());
      if (target.allowedBasenames !== undefined && target.allowedBasenames.has(base)) {
        this.scheduleRefresh(path.join(target.dir, base));
      }
    };
  }

  private handleWatcherError(dir: string, watcher: defaultFs.FSWatcher, error: Error): void {
    if (!this.loggedWatchFailures.has(dir)) {
      this.loggedWatchFailures.add(dir);
      this.log(`watchManager: fs.watch(${dir}) 错误: ${errorDetail(error)}`);
    }
    if (this.watchers.get(dir) === watcher) {
      this.watchers.delete(dir);
      // The handle died — the next re-arm pays O(subtree) again, so back it off too.
      const failures = Math.min((this.armFailures.get(dir) ?? 0) + 1, 5);
      this.armFailures.set(dir, failures);
      this.armRetryAfter.set(dir, this.now() + Math.min(ARM_BACKOFF_BASE_MS * 2 ** (failures - 1), ARM_BACKOFF_CAP_MS));
    }
    closeWatcherQuietly(watcher);
  }
}

/** close() may throw synchronously (already closed) or return a rejected Promise. */
function closeWatcherQuietly(watcher: defaultFs.FSWatcher): void {
  try {
    const closing = watcher.close() as void | Promise<void>;
    if (closing instanceof Promise) {
      closing.catch(() => undefined);
    }
  } catch {
    // Already closed — the error event fired on a dying handle.
  }
}
