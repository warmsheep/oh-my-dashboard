import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WatchManager } from "../../src/core/watchManager";
import type { WatchFactory, WatchTarget } from "../../src/core/watchManager";

/**
 * Fake FSWatcher: records error listeners, tracks close() calls. Cast to fs.FSWatcher
 * at the factory boundary (the manager only uses on()/close()).
 */
class FakeWatcher {
  closed = false;
  closeCalls = 0;
  private readonly errorListeners: ((error: Error) => void)[] = [];

  on(event: string, listener: (...args: never[]) => void): this {
    if (event === "error") {
      this.errorListeners.push(listener as (error: Error) => void);
    }
    return this;
  }

  close(): void {
    this.closeCalls += 1;
    this.closed = true;
  }

  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) {
      listener(error);
    }
  }
}

interface Armed {
  dir: string;
  recursive: boolean;
  listener: (event: string, filename: string | Buffer | null) => void;
  watcher: FakeWatcher;
}

/** Manual timer + clock control: the debounce callback is captured, never auto-run. */
class ManualTimers {
  now = 10_000;
  private handle = 0;
  private timer: { id: number; handler: () => void } | null = null;

  setTimeout = (handler: () => void, _ms: number): unknown => {
    this.handle += 1;
    this.timer = { id: this.handle, handler };
    return this.handle;
  };

  clearTimeout = (handle: unknown): void => {
    if (this.timer !== null && this.timer.id === handle) {
      this.timer = null;
    }
  };

  /** True when a debounce timer is pending. */
  get armed(): boolean {
    return this.timer !== null;
  }

  fire(): void {
    const current = this.timer;
    this.timer = null;
    current?.handler();
  }
}

describe("WatchManager", () => {
  let sandbox: string;
  let timers: ManualTimers;
  let armed: Armed[];
  let watchersByDir: Map<string, FakeWatcher>;
  let watchFactory: WatchFactory;
  let refreshes: string[];
  let logs: string[];
  let manager: WatchManager | null;

  const configDir = (): string => path.join(sandbox, "opencode");
  const managedFile = (): string => path.join(configDir(), "opencode.json");
  const presetsDir = (): string => path.join(configDir(), "presets");

  const makeManager = (targets: readonly WatchTarget[]): WatchManager => {
    const m = new WatchManager({
      targets,
      onRefresh: () => refreshes.push(`t${timers.now}`),
      log: (message: string) => logs.push(message),
      watch: watchFactory,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      now: () => timers.now,
    });
    m.arm();
    return m;
  };

  const emit = (dir: string, event: string, filename: string | Buffer | null): void => {
    const entry = armed.find((a) => a.dir === dir);
    if (entry === undefined) {
      throw new Error(`no watcher armed for ${dir}`);
    }
    entry.listener(event, filename);
  };

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "watchmanager-"));
    fs.mkdirSync(path.join(sandbox, "opencode"), { recursive: true });
    fs.writeFileSync(managedFile(), "{}");
    fs.mkdirSync(presetsDir(), { recursive: true });
    timers = new ManualTimers();
    armed = [];
    watchersByDir = new Map();
    watchFactory = ((
      dir: string,
      options: fs.WatchOptions,
      listener: (event: string, filename: string | Buffer | null) => void,
    ) => {
      const watcher = new FakeWatcher();
      const entry: Armed = { dir, recursive: options.recursive === true, listener, watcher };
      armed.push(entry);
      watchersByDir.set(dir, watcher);
      return watcher as unknown as fs.FSWatcher;
    }) as WatchFactory;
    refreshes = [];
    logs = [];
    manager = null;
  });

  afterEach(() => {
    manager?.dispose();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const targets = (): WatchTarget[] => [
    { dir: configDir(), recursive: false, allowedBasenames: new Set(["opencode.json", "models.json"]) },
    { dir: presetsDir(), recursive: true },
  ];

  it("arms one watcher per existing target dir and never duplicates on re-arm", () => {
    manager = makeManager(targets());
    expect(manager.watcherCount()).toBe(2);
    manager.arm();
    manager.arm();
    expect(manager.watcherCount()).toBe(2);
    expect(armed.filter((a) => a.dir === configDir()).length).toBe(1);
    expect(armed.find((a) => a.dir === presetsDir())?.recursive).toBe(true);
    expect(armed.find((a) => a.dir === configDir())?.recursive).toBe(false);
  });

  it("skips missing dirs at arm time and arms them once they appear", () => {
    fs.rmSync(presetsDir(), { recursive: true });
    manager = makeManager(targets());
    expect(manager.watcherCount()).toBe(1);

    fs.mkdirSync(presetsDir());
    manager.arm(); // what scheduleRefresh does on every event burst
    expect(manager.watcherCount()).toBe(2);
  });

  it("a watch-factory throw is logged, not propagated, and excluded from the count", () => {
    const failing: WatchFactory = ((dir: string) => {
      if (dir === presetsDir()) {
        throw new Error("EMFILE: too many open files");
      }
      return watchFactory(dir, { recursive: false }, () => undefined);
    }) as WatchFactory;
    manager = new WatchManager({
      targets: targets(),
      onRefresh: () => refreshes.push("r"),
      log: (message: string) => logs.push(message),
      watch: failing,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      now: () => timers.now,
    });
    expect(() => manager!.arm()).not.toThrow();
    expect(manager!.watcherCount()).toBe(1);
    expect(logs.some((l) => l.includes("fs.watch") && l.includes("EMFILE"))).toBe(true);
  });

  it("debounce coalesces an event burst into one refresh", () => {
    manager = makeManager(targets());
    emit(configDir(), "change", "opencode.json");
    fs.writeFileSync(managedFile(), '{"a":1}');
    timers.now += 100;
    emit(configDir(), "change", "opencode.json");
    expect(timers.armed).toBe(true);

    timers.now += 300;
    timers.fire();
    expect(refreshes).toHaveLength(1);

    // no further timer pending
    expect(timers.armed).toBe(false);
  });

  it("tracked file: same content as last seen → no refresh; changed content → refresh", () => {
    manager = makeManager(targets());

    // First sighting of the file: refresh (original semantics — activation-time state unknown).
    emit(configDir(), "change", "opencode.json");
    timers.now += 300;
    timers.fire();
    expect(refreshes).toHaveLength(1);

    // Rewrite identical bytes: the watcher fires but content dedupe swallows it.
    fs.writeFileSync(managedFile(), fs.readFileSync(managedFile(), "utf8"));
    emit(configDir(), "change", "opencode.json");
    timers.now += 300;
    timers.fire();
    expect(refreshes).toHaveLength(1);

    // Actually changed content: refresh.
    fs.writeFileSync(managedFile(), '{"model":"x"}');
    emit(configDir(), "change", "opencode.json");
    timers.now += 300;
    timers.fire();
    expect(refreshes).toHaveLength(2);

    // Vanished file: refresh (deletion is a real change).
    fs.rmSync(managedFile());
    emit(configDir(), "change", "opencode.json");
    timers.now += 300;
    timers.fire();
    expect(refreshes).toHaveLength(3);
  });

  it("flat watchers filter by basename: unrelated churn and null filenames never refresh", () => {
    manager = makeManager(targets());
    emit(configDir(), "change", "omo-runtime-state.json");
    emit(configDir(), "change", null);
    expect(timers.armed).toBe(false);
    emit(configDir(), "change", "models.json");
    expect(timers.armed).toBe(true);
  });

  it("recursive (no-identity) events force a refresh even when tracked files are unchanged", () => {
    manager = makeManager(targets());
    // Baseline: a tracked event marks opencode.json's content as seen and refreshes.
    emit(configDir(), "change", "opencode.json");
    timers.now += 300;
    timers.fire();
    expect(refreshes).toHaveLength(1);

    // A recursive-subdir event carries no file identity: force the next refresh even
    // though every tracked file's content is unchanged since.
    emit(presetsDir(), "change", "some-preset.json");
    timers.now += 300;
    timers.fire();
    expect(refreshes).toHaveLength(2);
  });

  it("watcher error: logs, closes the handle, un-registers the dir, and re-arms once per burst (at fire)", () => {
    manager = makeManager(targets());
    const watcher = watchersByDir.get(presetsDir());
    expect(watcher).toBeDefined();

    expect(() => watcher!.emitError(Object.assign(new Error("EPERM: watch"), { code: "EPERM" }))).not.toThrow();
    expect(watcher!.closed).toBe(true);
    expect(manager.watcherCount()).toBe(1);
    expect(logs.some((l) => l.includes("fs.watch") && l.includes("EPERM"))).toBe(true);

    // Re-arming happens at debounce fire (once per burst), NOT at event scheduling:
    emit(configDir(), "change", "opencode.json");
    expect(armed.filter((a) => a.dir === presetsDir()).length).toBe(1);
    timers.now += 300;
    timers.fire();
    expect(armed.filter((a) => a.dir === presetsDir()).length).toBe(2);
    expect(manager.watcherCount()).toBe(2);
  });

  it("a persistently failing watch target logs its failure once until a real event proves recovery", () => {
    let failPresets = true;
    const flaky: WatchFactory = ((dir: string, options: fs.WatchOptions, listener) => {
      if (dir === presetsDir() && failPresets) {
        throw new Error("EMFILE: too many open files");
      }
      return watchFactory(dir, options, listener);
    }) as WatchFactory;
    manager = new WatchManager({
      targets: targets(),
      onRefresh: () => refreshes.push("r"),
      log: (message) => logs.push(message),
      watch: flaky,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      now: () => timers.now,
    });
    manager.arm();
    manager.arm();
    manager.arm();
    expect(logs.filter((l) => l.includes("EMFILE"))).toHaveLength(1); // first failure only

    // The dir starts watching again; merely arming does NOT reset the memo — a
    // recurring EMFILE must stay quiet until a real event proves the watch works.
    failPresets = false;
    manager.arm();
    expect(manager.watcherCount()).toBe(2);
    failPresets = true;
    manager.arm();
    expect(logs.filter((l) => l.includes("EMFILE"))).toHaveLength(1);

    // A delivered event is the proof of recovery: the next failure logs again.
    failPresets = false;
    manager.arm();
    emit(presetsDir(), "change", "p.json");
    failPresets = true;
    const healthy = watchersByDir.get(presetsDir());
    healthy?.emitError(new Error("EMFILE: too many open files"));
    expect(logs.filter((l) => l.includes("EMFILE"))).toHaveLength(2);
  });

  it("dispose closes every watcher and cancels the pending debounce timer", () => {
    manager = makeManager(targets());
    emit(configDir(), "change", "opencode.json");
    expect(timers.armed).toBe(true);
    manager.dispose();
    expect(timers.armed).toBe(false);
    for (const watcher of watchersByDir.values()) {
      expect(watcher.closed).toBe(true);
    }
    // Firing after dispose must be a no-op (the timer callback was cancelled).
    expect(() => timers.fire()).not.toThrow();
  });

  describe("noteExternalRefresh (explicit-refresh echo suppression)", () => {
    it("marks tracked contents as seen: own-write echo events dedupe to no refresh", () => {
      manager = makeManager(targets());
      // The command wrote new content, then refreshed explicitly:
      fs.writeFileSync(managedFile(), '{"v":2}');
      manager.noteExternalRefresh();

      // fs.watch echoes the extension's own write ~300ms later — content unchanged since.
      emit(configDir(), "change", "opencode.json");
      timers.now += 300;
      timers.fire();
      expect(refreshes).toHaveLength(0);
    });

    it("an external change after the marker still refreshes", () => {
      manager = makeManager(targets());
      manager.noteExternalRefresh();
      fs.writeFileSync(managedFile(), '{"v":3}');
      emit(configDir(), "change", "opencode.json");
      timers.now += 300;
      timers.fire();
      expect(refreshes).toHaveLength(1);
    });

    it("creation of a previously-missing tracked file still refreshes", () => {
      const modelsFile = path.join(configDir(), "models.json");
      manager = makeManager(targets());
      manager.noteExternalRefresh(); // models.json marked as known-missing
      fs.writeFileSync(modelsFile, "{}");
      emit(configDir(), "change", "models.json");
      timers.now += 300;
      timers.fire();
      expect(refreshes).toHaveLength(1);
    });

    it("forced events inside the cooldown window are dropped (own writes to recursive dirs)", () => {
      manager = makeManager(targets());
      fs.writeFileSync(path.join(presetsDir(), "p.json"), "{}");
      manager.noteExternalRefresh(); // command end: opens the forced cooldown

      emit(presetsDir(), "change", "p.json"); // echo of the extension's own write
      timers.now += 300;
      timers.fire();
      expect(refreshes).toHaveLength(0);
    });

    it("forced events after the cooldown window refresh again", () => {
      manager = makeManager(targets());
      manager.noteExternalRefresh();
      emit(presetsDir(), "change", "p.json");
      timers.now += 600; // beyond the 500ms cooldown
      timers.fire();
      expect(refreshes).toHaveLength(1);
    });

    it("a forced event does not swallow tracked-file triggers in the same burst", () => {
      manager = makeManager(targets());
      manager.noteExternalRefresh();
      // Forced (recursive) + genuinely changed tracked file in one burst → must refresh.
      fs.writeFileSync(managedFile(), '{"v":4}');
      emit(presetsDir(), "change", "p.json");
      emit(configDir(), "change", "opencode.json");
      timers.now += 300;
      timers.fire();
      expect(refreshes).toHaveLength(1);
    });
  });
});
