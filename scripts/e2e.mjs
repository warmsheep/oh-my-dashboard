#!/usr/bin/env node
/**
 * Cross-platform e2e entry point.
 *
 * - Windows / macOS (and Linux with a display): run `npm run test:e2e` directly.
 * - Headless Linux (no DISPLAY): wrap in xvfb-run, which provides the virtual display
 *   VSCode's Electron needs. Install it via `apt install xvfb` when missing.
 */
import { spawnSync } from "node:child_process";

const isWin = process.platform === "win32";
const needsXvfb = process.platform === "linux" && !process.env.DISPLAY;

const command = needsXvfb ? "xvfb-run" : "npm";
const args = needsXvfb ? ["-a", "npm", "run", "test:e2e"] : ["run", "test:e2e"];

const result = spawnSync(command, args, { stdio: "inherit", shell: isWin });
if (result.error) {
  console.error(
    needsXvfb
      ? `[e2e] 无法启动 xvfb-run（${result.error.message}）。请先安装：apt install xvfb`
      : `[e2e] 无法启动 npm（${result.error.message}）`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
