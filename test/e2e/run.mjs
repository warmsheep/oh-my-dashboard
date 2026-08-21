#!/usr/bin/env node
/**
 * e2e runner: launches VSCode (via @vscode/test-electron) against the extension
 * under development and runs the smoke suite from dist/test-e2e/index.js.
 *
 * Isolation contract (CRITICAL):
 * - The extension must NEVER see the real ~/.config/opencode. We set
 *   XDG_CONFIG_HOME to a freshly seeded temp dir; ConfigStore.resolveConfigDir
 *   prioritizes $XDG_CONFIG_HOME/opencode. `extensionTestsEnv` is merged into
 *   the whole spawned VSCode process env by @vscode/test-electron, so the
 *   extension host inherits it.
 * - HOME is likewise replaced with a fresh temp dir, because the omo config
 *   (~/.omo/omo.jsonc) derives from os.homedir(), not XDG_CONFIG_HOME.
 * - As a belt-and-braces guard we fingerprint the real ~/.config/opencode and
 *   ~/.omo before/after the run and fail if either changed.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

function fail(message) {
  console.error(`[e2e:runner] ${message}`);
  process.exit(1);
}

/** Ensure dist-webview/ holds the built webview assets (presetEditorHost reads
 *  <extensionRoot>/dist-webview/index.html and rewrites ./index.js + ./main.css). */
function prepareWebviewAssets() {
  const buildDir = path.join(repoRoot, "webview-ui", "build");
  if (!fs.existsSync(path.join(buildDir, "index.html"))) {
    console.log("[e2e:runner] webview-ui/build missing — running npm run build:webview");
    const result = spawnSync("npm", ["run", "build:webview"], {
      cwd: repoRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.status !== 0) {
      fail("npm run build:webview failed");
    }
  }
  const distWebview = path.join(repoRoot, "dist-webview");
  fs.rmSync(distWebview, { recursive: true, force: true });
  fs.mkdirSync(distWebview, { recursive: true });
  for (const file of ["index.html", "index.js", "main.css"]) {
    const src = path.join(buildDir, file);
    if (!fs.existsSync(src)) {
      fail(`webview asset missing: ${src}`);
    }
    fs.copyFileSync(src, path.join(distWebview, file));
  }
  console.log(`[e2e:runner] dist-webview seeded from webview-ui/build (${distWebview})`);
}

/** Seed <tmp>/ocm-e2e-XXXX/opencode with fixture configs; return the seed dir
 *  (to be used as XDG_CONFIG_HOME). */
function seedConfigHome() {
  const seedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ocm-e2e-"));
  const opencodeDir = path.join(seedRoot, "opencode");
  fs.mkdirSync(opencodeDir, { recursive: true });

  const fixtureOpencode = path.join(repoRoot, "test", "fixtures", "opencode.jsonc");
  const fixtureOhMy = path.join(repoRoot, "test", "fixtures", "oh-my-opencode.json");
  fs.copyFileSync(fixtureOpencode, path.join(opencodeDir, "opencode.json"));
  fs.copyFileSync(fixtureOhMy, path.join(opencodeDir, "oh-my-opencode.json"));

  fs.mkdirSync(path.join(opencodeDir, "command"), { recursive: true });
  fs.writeFileSync(path.join(opencodeDir, "command", "e2e.md"), "# e2e command stub\n");
  fs.mkdirSync(path.join(opencodeDir, "skills", "e2e-skill"), { recursive: true });
  fs.writeFileSync(path.join(opencodeDir, "skills", "e2e-skill", "SKILL.md"), "# e2e skill stub\n");

  console.log(`[e2e:runner] seeded XDG_CONFIG_HOME=${seedRoot}`);
  return seedRoot;
}

/** Recursive fingerprint (relpath/mtime/size) to detect any accidental write
 *  to the real user config dir. */
function fingerprint(dir) {
  if (!fs.existsSync(dir)) {
    return "<missing>";
  }
  const lines = [];
  const walk = (current, rel) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        lines.push(`d ${relPath}`);
        walk(path.join(current, entry.name), relPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(path.join(current, entry.name));
        lines.push(`f ${relPath} ${stat.mtimeMs} ${stat.size}`);
      }
    }
  };
  walk(dir, "");
  return lines.join("\n");
}

/** Content+mtime stamp of one file ("<missing>" when absent) for the safety guard. */
function fileStamp(file) {
  if (!fs.existsSync(file)) {
    return "<missing>";
  }
  const stat = fs.statSync(file);
  return `${stat.mtimeMs} ${stat.size}`;
}

function removeWithRetries(target, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (i === attempts - 1) {
        console.warn(`[e2e:runner] could not remove ${target}: ${error}`);
        return;
      }
      spawnSync("sleep", ["1"]);
    }
  }
}

async function main() {
  const suitePath = path.join(repoRoot, "dist", "test-e2e", "index.js");
  if (!fs.existsSync(suitePath)) {
    fail(`test suite bundle not found: ${suitePath} — run "node esbuild.mjs --tests" first`);
  }

  prepareWebviewAssets();
  const seedRoot = seedConfigHome();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocm-e2e-home-"));

  const realConfigDir = path.join(os.homedir(), ".config", "opencode");
  const realOmoFiles = ["omo.jsonc", "omo.json"].map((name) => path.join(os.homedir(), ".omo", name));
  const beforeConfig = fingerprint(realConfigDir);
  const beforeOmo = realOmoFiles.map(fileStamp);

  let failed = false;
  try {
    await runTests({
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: suitePath,
      launchArgs: ["--disable-gpu", "--disable-extensions"],
      extensionTestsEnv: {
        XDG_CONFIG_HOME: seedRoot,
        HOME: fakeHome,
      },
    });
  } catch (error) {
    console.error(`[e2e:runner] VSCode test run failed: ${error}`);
    failed = true;
  }

  const afterConfig = fingerprint(realConfigDir);
  if (beforeConfig !== afterConfig) {
    console.error("[e2e:runner] SAFETY VIOLATION: real ~/.config/opencode changed during the run!");
    failed = true;
  } else {
    console.log("[e2e:runner] real ~/.config/opencode untouched ✔");
  }
  const afterOmo = realOmoFiles.map(fileStamp);
  if (beforeOmo.join("|") !== afterOmo.join("|")) {
    console.error("[e2e:runner] SAFETY VIOLATION: real ~/.omo/omo.json[c] changed during the run!");
    failed = true;
  } else {
    console.log("[e2e:runner] real ~/.omo/omo.json[c] untouched ✔");
  }

  if (failed) {
    console.error(`[e2e:runner] FAILED — keeping seed dir for inspection: ${seedRoot}`);
    process.exit(1);
  }

  removeWithRetries(seedRoot);
  removeWithRetries(fakeHome);
  console.log("[e2e:runner] PASSED");
}

main().catch((error) => {
  console.error(`[e2e:runner] unexpected failure: ${error}`);
  process.exit(1);
});
