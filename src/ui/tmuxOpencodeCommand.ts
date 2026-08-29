import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import * as vscode from "vscode";

import {
  pickFreePort,
  resolveTmuxLaunchPlan,
  tmuxSessionNameFor,
  tuiThemeKvPath,
  tuiThemeKvSeed,
  type TmuxColorEnv,
  type TmuxUiTheme,
} from "../core/tmuxOpencode";

const execFileAsync = promisify(execFile);

/**
 * tmux probe timeout — a wedged `tmux -V` (stale NFS mount, broken PATH entry) must not
 * hang the command forever; treat it the same as "not installed".
 */
const PROBE_TIMEOUT_MS = 5_000;

export interface TmuxOpencodeDeps {
  log(message: string): void;
  /**
   * False under ExtensionMode.Test: probes and terminal creation are skipped so the e2e
   * sandbox stays hermetic (no real tmux/opencode processes) — same policy as model
   * catalog seeding. The plan builder itself stays unit-tested in core.
   */
  launchEnabled: boolean;
}

/** `tmux -V` stdout when the binary executes (ENOENT/timeout/non-zero → null). */
async function tmuxVersionOutput(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tmux", ["-V"], { timeout: PROBE_TIMEOUT_MS });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Trimmed stdout of a read-only tmux probe, or null when it fails (mirrors the other
 * probes' any-failure → null semantics).
 */
async function tmuxProbeStdout(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tmux", args, { timeout: PROBE_TIMEOUT_MS });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Effective `default-terminal` option value; null when the query fails (e.g. no tmux
 * server running yet — the option is server-global state).
 */
async function tmuxDefaultTerminal(): Promise<string | null> {
  return tmuxProbeStdout(["show-options", "-gv", "default-terminal"]);
}

/**
 * Create the per-launch TUI state dir seeded with the theme-mode lock (see core
 * tuiThemeKvSeed/tuiThemeKvPath for the mechanism and the exact kv location). The dir
 * is passed into the pane command AND stored as session env, so oh-my-openagent
 * team-member panes (tmux split-window inherits the session env) read the same theme
 * lock. Any failure returns null → the launch proceeds unpinned (natural dark fallback).
 */
async function createThemeStateDir(uiTheme: TmuxUiTheme): Promise<string | null> {
  try {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opencode-tui-state-"));
    await fsp.mkdir(path.join(dir, "opencode"), { recursive: true });
    await fsp.writeFile(tuiThemeKvPath(dir), tuiThemeKvSeed(uiTheme), "utf8");
    return dir;
  } catch {
    return null;
  }
}

/**
 * Exact session names currently known to the tmux server. Uses `list-sessions` + a
 * code-side exact compare instead of `has-session -t <name>` (or the `=<name>`
 * exact-match prefix, unavailable before modern tmux): old tmux resolves `-t` targets
 * by UNIQUE PREFIX when no exact match exists, so `-t opencode` would match a live
 * `opencode-<other-workspace>` session (verified on tmux 1.8). Any failure — including
 * "no server running" — yields an empty set (nothing to attach to).
 */
async function listTmuxSessions(): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      timeout: PROBE_TIMEOUT_MS,
    });
    return new Set(
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * "Open Tmux Opencode" command body: open a terminal page in the EDITOR area that runs
 * `tmux` hosting the opencode TUI on a pinned random port (see core/tmuxOpencode.ts for
 * why the port is mandatory for oh-my-openagent team mode). Idempotent: when the
 * per-workspace session already exists it simply attaches (keeping the original port).
 * Throws TMUX_NOT_FOUND (TMUX_NOT_FOUND_WINDOWS on a local-Windows host, with WSL
 * guidance) for the run() wrapper to surface as a Chinese notification.
 */
export async function openTmuxOpencode(deps: TmuxOpencodeDeps): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const sessionName = tmuxSessionNameFor(folder?.name);
  if (!deps.launchEnabled) {
    deps.log(`tmux-opencode: Test 模式跳过实际启动（目标会话 ${sessionName}）`);
    return;
  }
  const version = await tmuxVersionOutput();
  if (version === null) {
    // Windows has no native tmux and this command is tmux-centric end to end (the
    // oh-my-openagent team visualization it enables requires POSIX tmux anyway), so a
    // local-Windows host degrades here with WSL guidance instead of the apt/brew hint.
    throw new Error(process.platform === "win32" ? "TMUX_NOT_FOUND_WINDOWS" : "TMUX_NOT_FOUND");
  }
  // Exact-match attach is guaranteed by the accurate list-sessions probe; tmux always
  // prefers an exact session-name match over its unique-prefix fallback.
  const sessionExists = (await listTmuxSessions()).has(sessionName);
  // Port, color, and theme inputs only matter on the create path; resolveTmuxLaunchPlan
  // reads none of them when attaching.
  const port = sessionExists ? 0 : await pickFreePort();
  const color: TmuxColorEnv = sessionExists
    ? { defaultTerminal: null, version: null }
    : { defaultTerminal: await tmuxDefaultTerminal(), version };
  const themeKind = vscode.window.activeColorTheme.kind;
  const uiTheme: TmuxUiTheme =
    themeKind === vscode.ColorThemeKind.Light || themeKind === vscode.ColorThemeKind.HighContrastLight
      ? "light"
      : "dark";
  const themeStateDir = sessionExists ? null : await createThemeStateDir(uiTheme);
  if (!sessionExists && themeStateDir === null) {
    deps.log(`tmux-opencode: 主题状态目录创建失败，本次启动不锁定主题（自然回退）`);
  }
  const plan = resolveTmuxLaunchPlan({
    sessionExists,
    sessionName,
    port,
    cwd: folder?.uri.fsPath ?? null,
    color,
    themeStateDir,
  });
  deps.log(
    `tmux-opencode: ${plan.kind} 会话 ${sessionName}` +
      `${plan.kind === "create" ? `（端口 ${plan.port}，主题 ${uiTheme}）` : ""}`,
  );
  const terminal = vscode.window.createTerminal({
    name: `OpenCode (tmux: ${sessionName})`,
    location: vscode.TerminalLocation.Editor,
    cwd: folder?.uri.fsPath,
  });
  terminal.sendText(plan.command, true);
  terminal.show();
  if (plan.kind === "create") {
    void vscode.window.showInformationMessage(
      `OpenCode 已在 tmux 会话「${sessionName}」启动，服务端口 ${plan.port}（随机端口，兼容 oh-my-openagent team 模式）`,
    );
  }
}
