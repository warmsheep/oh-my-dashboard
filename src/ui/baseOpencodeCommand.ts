import * as vscode from "vscode";

import { pickFreePort } from "../core/tmuxOpencode";

export interface BaseOpencodeDeps {
  log(message: string): void;
  /**
   * False under ExtensionMode.Test: port probing and terminal creation are skipped so
   * the e2e sandbox stays hermetic — same policy as the tmux command and model catalog
   * seeding.
   */
  launchEnabled: boolean;
}

/**
 * "Open Base Opencode" command body: a plain editor-area terminal running the opencode
 * TUI directly — no tmux and none of tmux's color/theme environment fixes. In a direct
 * VSCode terminal the TUI gets TERM/COLORTERM from VSCode (truecolor) and follows
 * light/dark via the OSC background handshake, so natural behavior is already correct
 * on every platform. A random free port IS pinned (`opencode --port <P>`) so the
 * session exposes its real HTTP server — other terminals can `opencode attach
 * http://127.0.0.1:<P>` and tooling can talk to it; OPENCODE_PORT rides the terminal's
 * env option (merged, not strict) as the oh-my-openagent fallback for older opencode
 * builds, mirroring the tmux launch. The only text sent is `opencode --port <P>` — a
 * numeric flag stays shell-agnostic across bash/zsh/fish/PowerShell/cmd; the terminal's
 * cwd option (not a `cd` command) places it in the workspace, avoiding path and
 * quoting differences entirely. `opencode` resolves via the TERMINAL's PATH on
 * purpose: probing the extension-host PATH would false-negative on nvm/Homebrew setups
 * where the two differ, so a missing binary surfaces as the shell's own error message
 * in the terminal.
 */
export async function openBaseOpencode(deps: BaseOpencodeDeps): Promise<void> {
  if (!deps.launchEnabled) {
    deps.log("base-opencode: Test 模式跳过实际启动");
    return;
  }
  // Rejects with FREE_PORT_UNAVAILABLE (mapped in errors.ts) for the run() wrapper.
  const port = await pickFreePort();
  const folder = vscode.workspace.workspaceFolders?.[0];
  const terminal = vscode.window.createTerminal({
    name: "OpenCode",
    location: vscode.TerminalLocation.Editor,
    cwd: folder?.uri.fsPath,
    env: { OPENCODE_PORT: String(port) },
  });
  terminal.sendText(`opencode --port ${port}`, true);
  terminal.show();
  deps.log(`base-opencode: 编辑器区终端启动 opencode --port ${port}${folder ? `（${folder.uri.fsPath}）` : ""}`);
  void vscode.window.showInformationMessage(
    `OpenCode 已在终端启动，服务端口 ${port}（随机端口，可供 opencode attach / 工具直连）`,
  );
}
