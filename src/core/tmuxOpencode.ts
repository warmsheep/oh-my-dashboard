import * as defaultNet from "node:net";
import * as path from "node:path";

/**
 * Pure launch planning for the "Open Tmux Opencode" command: session naming, free-port
 * probing, and tmux command-line construction. The ui layer performs the actual probes
 * (tmux availability / session listing) and terminal creation; everything decided
 * here is deterministic and unit-tested.
 *
 * Why the opencode TUI must be launched with an explicit `--port` (researched from the
 * opencode + oh-my-openagent sources, see the "Open Tmux Opencode" CHANGELOG entry):
 * without any of --port/--hostname/--mdns the TUI runs entirely in-process (no TCP
 * listener) and plugins see a dead fallback `ctx.serverUrl` of http://localhost:4096 —
 * oh-my-openagent's team mode then silently skips its tmux member layout
 * ("isServerRunning" gate). With `--port` the TUI starts a real server and ctx.serverUrl
 * carries the bound port, which team mode uses to `opencode attach` member panes.
 * OPENCODE_PORT is exported purely as belt-and-braces: opencode itself ignores it, but
 * oh-my-openagent reads it as the fallback when ctx.serverUrl is missing/port 0
 * (older opencode builds).
 */

/** Session name when no workspace folder is open. */
const DEFAULT_SESSION_NAME = "opencode";

/** Longest session-name suffix we keep from a workspace folder name. */
const SESSION_NAME_MAX_SUFFIX = 32;

/**
 * Derive the tmux session name from the workspace folder name: lowercase ASCII
 * alphanumerics only, runs of everything else collapse to "-", edges trimmed, capped.
 * Session names cannot contain ":" or "." (tmux target syntax); stripping everything
 * non-alphanumeric keeps our names safely addressable by exact name
 * (`tmux list-sessions` compare / `attach-session -t <name>`).
 */
export function tmuxSessionNameFor(folderName: string | undefined): string {
  const suffix = (folderName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SESSION_NAME_MAX_SUFFIX)
    .replace(/-+$/g, "");
  return suffix ? `${DEFAULT_SESSION_NAME}-${suffix}` : DEFAULT_SESSION_NAME;
}

/**
 * Injectable subset of node:net that {@link pickFreePort} needs (fsMod-style DI for
 * unit tests; the real module satisfies this structurally).
 */
export interface FreePortNet {
  createServer(): {
    unref(): void;
    once(event: "error", listener: (error: Error) => void): unknown;
    listen(port: number, host: string, callback: () => void): unknown;
    close(callback: () => void): unknown;
    address(): { port: number } | string | null;
  };
}

/**
 * Ask the OS for a free TCP port on the loopback interface: bind port 0, read the
 * assigned port, release the socket. A tiny TOCTOU window is inherent (another process
 * may grab the port before opencode binds it) — acceptable for a launcher; opencode's
 * own listen failure is visible in the terminal. Rejects with FREE_PORT_UNAVAILABLE
 * (mapped in errors.ts) when the socket layer cannot answer.
 */
export function pickFreePort(netMod: FreePortNet = defaultNet): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = netMod.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close(() => {
        if (port === null || !Number.isInteger(port) || port <= 0) {
          reject(new Error("FREE_PORT_UNAVAILABLE"));
        } else {
          resolve(port);
        }
      });
    });
  });
}

/**
 * POSIX single-quote a value for safe interpolation into a shell command line. The
 * outer line is typed into the user's default terminal shell (bash/zsh/fish all accept
 * this idiom, including the `'\''` escape; PowerShell does not, but tmux usage
 * effectively implies a POSIX shell profile). The tmux pane command is executed by the
 * tmux server's `default-shell -c` (typically $SHELL: bash/zsh/fish — csh/tcsh would
 * choke on `&&`, with the failure visible in the pane).
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Parsed `tmux -V` version (major.minor). */
export interface TmuxVersion {
  major: number;
  minor: number;
}

/**
 * Parse `tmux -V` stdout ("tmux 1.8", "tmux 3.3a", "tmux next-3.4") into major/minor;
 * null for anything unparseable. Used only to branch color handling — never security
 * sensitive.
 */
export function parseTmuxVersion(raw: string | null): TmuxVersion | null {
  if (raw === null) {
    return null;
  }
  const match = /(\d+)\.(\d+)/.exec(raw);
  if (match === null) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    return null;
  }
  return { major, minor };
}

/**
 * Color-environment inputs gathered by the ui layer; both null-able (probe may fail or
 * the tmux server may not exist yet).
 */
export interface TmuxColorEnv {
  /** Effective `default-terminal` tmux option value; null = unknown (assume colorless default). */
  defaultTerminal: string | null;
  /** Raw `tmux -V` stdout; null = unknown (assume legacy behavior). */
  version: string | null;
}

/** Derived color fixes for one launch (see tmuxColorPlan for the rationale). */
export interface TmuxColorPlan {
  /** TERM to export inside the lead pane (null = default-terminal already color-capable). */
  paneTerm: string | null;
  /** Remove COLORTERM inside panes (legacy tmux cannot honor it and TUIs misrender). */
  scrubColorterm: boolean;
  /** default-terminal value to set session-wide so FUTURE panes (team members) inherit it. */
  sessionTerminal: string | null;
}

/**
 * Decide the color fixes a launch needs. Empirically verified (tmux 1.8 + opencode TUI):
 * a fresh tmux pane advertises TERM=screen (tmux's default-terminal) while the server
 * env leaks COLORTERM=truecolor from the VSCode terminal — contradictory signals that
 * make the opencode TUI render uncolored (all-black) text or nothing at all. Fixes:
 * - TERM upgraded to screen-256color (pane env export + session default-terminal so
 *   oh-my-openagent team-mode member panes split later inherit it too) whenever the
 *   effective default-terminal lacks 256color/direct/truecolor.
 * - COLORTERM scrubbed on tmux < 3.2 (it cannot translate truecolor escapes — they
 *   mangle into black; 3.2+ manages COLORTERM itself, so we leave it alone).
 * Unknown probes (null) take the conservative branch: assume the colorless default.
 */
export function tmuxColorPlan(env: TmuxColorEnv): TmuxColorPlan {
  const colorCapable = /(?:256color|direct|truecolor)/.test(env.defaultTerminal ?? "");
  const version = parseTmuxVersion(env.version);
  return {
    paneTerm: colorCapable ? null : "screen-256color",
    scrubColorterm: version === null || version.major < 3 || (version.major === 3 && version.minor < 2),
    sessionTerminal: colorCapable ? null : "screen-256color",
  };
}

/** VSCode color-theme direction the launched TUI should mirror. */
export type TmuxUiTheme = "light" | "dark";

/**
 * kv.json content seeding the per-launch TUI state dir. Source-verified mechanism
 * (opencode tui context/theme.tsx): the theme MODE resolves as kv "theme_mode_lock"
 * ?? terminal-OSC detection ?? "dark" — under tmux the OSC handshake never answers,
 * so the TUI always falls back to dark; no env/config key overrides the mode. Verified
 * on the real binary: {"theme_mode_lock":"light"} flips the whole UI to the opencode
 * theme's light palette ("dark" keeps the dark one).
 */
export function tuiThemeKvSeed(uiTheme: TmuxUiTheme): string {
  return `{"theme_mode_lock":"${uiTheme}"}`;
}

/**
 * Where the TUI reads its kv store INSIDE a state dir: "$XDG_STATE_HOME/opencode/kv.json"
 * (opencode appends its own "opencode" segment). Seeding any other path silently no-ops
 * — the theme lock stops applying — so the contract lives here, tested.
 */
export function tuiThemeKvPath(stateDir: string): string {
  return path.join(stateDir, "opencode", "kv.json");
}

/** What the command should do after the ui-layer probes ran. */
export type TmuxLaunchPlan =
  | { kind: "attach"; sessionName: string; command: string }
  | { kind: "create"; sessionName: string; port: number; command: string };

export interface TmuxLaunchInput {
  /** True when the exact session name is listed by the ui-layer probe (attach instead of spawning). */
  sessionExists: boolean;
  sessionName: string;
  /** Free port from {@link pickFreePort}; only read on the create path. */
  port: number;
  /** Working directory for the new session (usually the workspace root); null = tmux default. */
  cwd: string | null;
  /** Probed tmux color environment (see {@link tmuxColorPlan}); only read on the create path. */
  color: TmuxColorEnv;
  /**
   * Per-launch TUI state dir the ui layer created and seeded (see
   * {@link tuiThemeKvSeed}); exported in the lead pane AND stored as session env so
   * oh-my-openagent team-member panes (tmux split-window inherits the session env)
   * read the same theme lock. Null = launch unpinned (state-dir creation failed);
   * only read on the create path.
   */
  themeStateDir: string | null;
}

/**
 * Decide the exact shell line to run: attach to an existing session (idempotent second
 * invocation keeps the original port), or create one running the opencode TUI with a
 * pinned random port plus the color fixes from {@link tmuxColorPlan}.
 *
 * Create path runs DETACHED first, configures the session (default-terminal so future
 * team-member panes inherit a color-capable TERM; session-scoped COLORTERM scrub),
 * then attaches — the options must be in place before oh-my-openagent splits member
 * panes, and a lead pane created with `new-session -A …` would already be running
 * with the unconfigured environment. The `;` chain keeps the sequence resilient: if
 * the session appeared between the probe and here (race), creation fails, the two
 * config commands still apply to the existing session, and the attach succeeds.
 */
export function resolveTmuxLaunchPlan(input: TmuxLaunchInput): TmuxLaunchPlan {
  if (input.sessionExists) {
    return {
      kind: "attach",
      sessionName: input.sessionName,
      command: `tmux attach-session -t ${shellSingleQuote(input.sessionName)}`,
    };
  }
  // Pane process: `exec` so opencode IS the pane (the pane dies with the TUI, no orphan
  // shell); `opencode` resolves via the tmux server's environment (default-shell -c).
  // The working directory is set by `cd` inside the pane (not `new-session -c`, which
  // only exists since tmux 1.9 — CentOS 7 ships 1.8). A failed `cd` aborts the pane
  // instead of silently launching opencode elsewhere.
  const color = tmuxColorPlan(input.color);
  const termExport = color.paneTerm !== null ? `export TERM=${color.paneTerm}; ` : "";
  // Empty-string assignment (not `unset`): falsy for every TUI color detector, works in
  // fish (which has no unset builtin), and mirrors the session-level scrub semantics.
  const colortermScrub = color.scrubColorterm ? `export COLORTERM=; ` : "";
  const themeLock =
    input.themeStateDir !== null ? `export XDG_STATE_HOME=${shellSingleQuote(input.themeStateDir)}; ` : "";
  const cd = input.cwd !== null && input.cwd.length > 0 ? `cd ${shellSingleQuote(input.cwd)} && ` : "";
  const paneCommand = `${themeLock}${termExport}${colortermScrub}export OPENCODE_PORT=${input.port}; ${cd}exec opencode --port ${input.port}`;
  const name = shellSingleQuote(input.sessionName);
  const parts = [`tmux new-session -d -s ${name} ${shellSingleQuote(paneCommand)}`];
  if (color.sessionTerminal !== null) {
    parts.push(`tmux set-option -t ${name} default-terminal ${shellSingleQuote(color.sessionTerminal)}`);
  }
  if (color.scrubColorterm) {
    parts.push(`tmux set-environment -t ${name} COLORTERM ''`);
  }
  if (input.themeStateDir !== null) {
    parts.push(`tmux set-environment -t ${name} XDG_STATE_HOME ${shellSingleQuote(input.themeStateDir)}`);
  }
  parts.push(`tmux attach-session -t ${name}`);
  return {
    kind: "create",
    sessionName: input.sessionName,
    port: input.port,
    command: parts.join(" ; "),
  };
}
