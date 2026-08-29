import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseTmuxVersion,
  pickFreePort,
  resolveTmuxLaunchPlan,
  shellSingleQuote,
  tmuxColorPlan,
  tmuxSessionNameFor,
  tuiThemeKvPath,
  tuiThemeKvSeed,
  type FreePortNet,
  type TmuxColorEnv,
} from "../../src/core/tmuxOpencode";

const STATE_DIR = "/tmp/opencode-tui-state-abc123";
/** The dir quoted as it appears INSIDE the single-quoted pane command (extra escape layer). */
const ESCAPED_STATE_DIR = shellSingleQuote(STATE_DIR).replaceAll("'", "'\\''");

describe("tmuxSessionNameFor", () => {
  it("sanitizes workspace folder names into opencode-<slug>", () => {
    expect(tmuxSessionNameFor("My Project_2")).toBe("opencode-my-project-2");
    expect(tmuxSessionNameFor("oh-my-dashboard")).toBe("opencode-oh-my-dashboard");
  });

  it('strips tmux-reserved characters (":" and ".") and unicode, collapses separators', () => {
    expect(tmuxSessionNameFor("a:b.c d")).toBe("opencode-a-b-c-d");
    expect(tmuxSessionNameFor("项目 workspace")).toBe("opencode-workspace");
  });

  it("falls back to the default name for empty/separator-only/undefined input", () => {
    expect(tmuxSessionNameFor(undefined)).toBe("opencode");
    expect(tmuxSessionNameFor("")).toBe("opencode");
    expect(tmuxSessionNameFor("---")).toBe("opencode");
  });

  it("caps the slug length at 32 characters and trims the trailing separator", () => {
    expect(tmuxSessionNameFor("a".repeat(64))).toBe(`opencode-${"a".repeat(32)}`);
    expect(tmuxSessionNameFor(`${"a".repeat(31)}-${"b".repeat(31)}`)).toBe(`opencode-${"a".repeat(31)}`);
  });
});

describe("pickFreePort", () => {
  it("resolves a positive integer port the OS considered free", async () => {
    const port = await pickFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it("rejects with FREE_PORT_UNAVAILABLE when the socket layer cannot report a port", async () => {
    const fakeNet: FreePortNet = {
      createServer: () => ({
        unref: () => undefined,
        once: () => undefined,
        listen: (_port: number, _host: string, callback: () => void) => {
          callback();
        },
        close: (callback: () => void) => {
          callback();
        },
        address: () => null,
      }),
    };
    await expect(pickFreePort(fakeNet)).rejects.toThrow("FREE_PORT_UNAVAILABLE");
  });
});

describe("shellSingleQuote", () => {
  it("quotes plain values", () => {
    expect(shellSingleQuote("opencode")).toBe("'opencode'");
    expect(shellSingleQuote("/path with spaces/oc")).toBe("'/path with spaces/oc'");
  });

  it("escapes embedded single quotes the POSIX way", () => {
    expect(shellSingleQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("parseTmuxVersion", () => {
  it("parses stable, suffixed, next-prefixed, and multi-digit-minor versions", () => {
    expect(parseTmuxVersion("tmux 1.8")).toEqual({ major: 1, minor: 8 });
    expect(parseTmuxVersion("tmux 3.3a\n")).toEqual({ major: 3, minor: 3 });
    expect(parseTmuxVersion("tmux next-3.4")).toEqual({ major: 3, minor: 4 });
    // Numeric compare territory: 3.10 must outrank 3.2, not sort before it as a string.
    expect(parseTmuxVersion("tmux 3.10")).toEqual({ major: 3, minor: 10 });
  });

  it("returns null for null input or unparseable output", () => {
    expect(parseTmuxVersion(null)).toBeNull();
    expect(parseTmuxVersion("open terminal failed: not a terminal")).toBeNull();
    expect(parseTmuxVersion("tmux")).toBeNull();
  });
});

describe("tmuxColorPlan", () => {
  it("legacy tmux with the colorless screen default applies every fix", () => {
    const env: TmuxColorEnv = { defaultTerminal: "screen", version: "tmux 1.8" };
    expect(tmuxColorPlan(env)).toEqual({
      paneTerm: "screen-256color",
      scrubColorterm: true,
      sessionTerminal: "screen-256color",
    });
  });

  it("modern tmux already advertising a color-capable default-terminal needs nothing", () => {
    const env: TmuxColorEnv = { defaultTerminal: "tmux-256color", version: "tmux 3.3a" };
    expect(tmuxColorPlan(env)).toEqual({ paneTerm: null, scrubColorterm: false, sessionTerminal: null });
  });

  it("scrubs COLORTERM below 3.2 even when default-terminal is color-capable", () => {
    const env: TmuxColorEnv = { defaultTerminal: "tmux-256color", version: "tmux 3.1" };
    expect(tmuxColorPlan(env).scrubColorterm).toBe(true);
    expect(tmuxColorPlan({ defaultTerminal: "tmux-256color", version: "tmux 3.2" }).scrubColorterm).toBe(false);
  });

  it("unknown probes take the conservative branch (full fix)", () => {
    expect(tmuxColorPlan({ defaultTerminal: null, version: null })).toEqual({
      paneTerm: "screen-256color",
      scrubColorterm: true,
      sessionTerminal: "screen-256color",
    });
  });

  it("a failed default-terminal probe on modern tmux upgrades TERM but keeps COLORTERM", () => {
    expect(tmuxColorPlan({ defaultTerminal: null, version: "tmux 3.3a" })).toEqual({
      paneTerm: "screen-256color",
      scrubColorterm: false,
      sessionTerminal: "screen-256color",
    });
  });
});

describe("tuiThemeKvSeed", () => {
  it("locks the TUI theme mode for either direction", () => {
    expect(tuiThemeKvSeed("light")).toBe('{"theme_mode_lock":"light"}');
    expect(tuiThemeKvSeed("dark")).toBe('{"theme_mode_lock":"dark"}');
  });

  it("places the kv under the opencode segment inside the state dir (silent no-op otherwise)", () => {
    expect(tuiThemeKvPath("/tmp/opencode-tui-state-x")).toBe(
      "/tmp/opencode-tui-state-x/opencode/kv.json".replaceAll("/", path.sep),
    );
  });
});

describe("resolveTmuxLaunchPlan", () => {
  const legacyColor: TmuxColorEnv = { defaultTerminal: "screen", version: "tmux 1.8" };

  it("attaches to an existing session without a port, color fixes, or theme lock", () => {
    const plan = resolveTmuxLaunchPlan({
      sessionExists: true,
      sessionName: "opencode-demo",
      port: 0,
      cwd: "/ws/demo",
      color: legacyColor,
      themeStateDir: STATE_DIR,
    });
    expect(plan).toEqual({
      kind: "attach",
      sessionName: "opencode-demo",
      command: "tmux attach-session -t 'opencode-demo'",
    });
  });

  it("creates detached, applies the theme lock and color fixes, then attaches (legacy tmux)", () => {
    const plan = resolveTmuxLaunchPlan({
      sessionExists: false,
      sessionName: "opencode-demo",
      port: 15432,
      cwd: "/ws/demo",
      color: legacyColor,
      themeStateDir: STATE_DIR,
    });
    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") {
      throw new Error("unreachable");
    }
    expect(plan.port).toBe(15432);
    expect(plan.command).toBe(
      "tmux new-session -d -s 'opencode-demo' " +
        `'export XDG_STATE_HOME=${ESCAPED_STATE_DIR}; export TERM=screen-256color; export COLORTERM=; export OPENCODE_PORT=15432; cd '\\''/ws/demo'\\'' && exec opencode --port 15432'` +
        " ; tmux set-option -t 'opencode-demo' default-terminal 'screen-256color'" +
        " ; tmux set-environment -t 'opencode-demo' COLORTERM ''" +
        ` ; tmux set-environment -t 'opencode-demo' XDG_STATE_HOME ${shellSingleQuote(STATE_DIR)}` +
        " ; tmux attach-session -t 'opencode-demo'",
    );
  });

  it("scrubs only COLORTERM when default-terminal is already color-capable on legacy tmux", () => {
    const plan = resolveTmuxLaunchPlan({
      sessionExists: false,
      sessionName: "opencode",
      port: 21000,
      cwd: null,
      color: { defaultTerminal: "tmux-256color", version: "tmux 3.1" },
      themeStateDir: STATE_DIR,
    });
    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") {
      throw new Error("unreachable");
    }
    expect(plan.command).toBe(
      "tmux new-session -d -s 'opencode' " +
        `'export XDG_STATE_HOME=${ESCAPED_STATE_DIR}; export COLORTERM=; export OPENCODE_PORT=21000; exec opencode --port 21000'` +
        " ; tmux set-environment -t 'opencode' COLORTERM ''" +
        ` ; tmux set-environment -t 'opencode' XDG_STATE_HOME ${shellSingleQuote(STATE_DIR)}` +
        " ; tmux attach-session -t 'opencode'",
    );
  });

  it("launches unpinned (no theme dir exports) when themeStateDir is null", () => {
    const plan = resolveTmuxLaunchPlan({
      sessionExists: false,
      sessionName: "opencode",
      port: 22000,
      cwd: null,
      color: legacyColor,
      themeStateDir: null,
    });
    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") {
      throw new Error("unreachable");
    }
    expect(plan.command).toBe(
      "tmux new-session -d -s 'opencode' " +
        `'export TERM=screen-256color; export COLORTERM=; export OPENCODE_PORT=22000; exec opencode --port 22000'` +
        " ; tmux set-option -t 'opencode' default-terminal 'screen-256color'" +
        " ; tmux set-environment -t 'opencode' COLORTERM ''" +
        " ; tmux attach-session -t 'opencode'",
    );
  });

  it("omits the color commands when modern tmux already advertises color support", () => {
    const plan = resolveTmuxLaunchPlan({
      sessionExists: false,
      sessionName: "opencode",
      port: 20000,
      cwd: null,
      color: { defaultTerminal: "tmux-256color", version: "tmux 3.3a" },
      themeStateDir: STATE_DIR,
    });
    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") {
      throw new Error("unreachable");
    }
    expect(plan.command).toBe(
      "tmux new-session -d -s 'opencode' " +
        `'export XDG_STATE_HOME=${ESCAPED_STATE_DIR}; export OPENCODE_PORT=20000; exec opencode --port 20000'` +
        ` ; tmux set-environment -t 'opencode' XDG_STATE_HOME ${shellSingleQuote(STATE_DIR)}` +
        " ; tmux attach-session -t 'opencode'",
    );
  });

  it("omits the cd for null and empty cwd", () => {
    for (const cwd of [null, ""] as const) {
      const plan = resolveTmuxLaunchPlan({
        sessionExists: false,
        sessionName: "opencode",
        port: 20000,
        cwd,
        color: { defaultTerminal: null, version: null },
        themeStateDir: STATE_DIR,
      });
      expect(plan.kind).toBe("create");
      if (plan.kind !== "create") {
        throw new Error("unreachable");
      }
      expect(plan.command).toContain(
        `'export XDG_STATE_HOME=${ESCAPED_STATE_DIR}; export TERM=screen-256color; export COLORTERM=; export OPENCODE_PORT=20000; exec opencode --port 20000`,
      );
    }
  });
});
