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

/** Ensure dist-webview/ holds the built webview assets (panel hosts read
 * <extensionRoot>/dist-webview/*.html and rewrite every local asset reference). */
function prepareWebviewAssets() {
  const buildDir = path.join(repoRoot, "webview-ui", "build");
  // Check the page entry — a partial build (missing manager.html) must trigger a
  // rebuild, not fail later with a missing-asset error.
  if (!["manager.html"].every((page) => fs.existsSync(path.join(buildDir, page)))) {
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
  // Multi-entry builds carry shared chunks (vendor.js, vscode.js/css) next to the
  // per-page files — copy the whole build dir instead of a hardcoded asset list.
  for (const entry of fs.readdirSync(buildDir)) {
    fs.copyFileSync(path.join(buildDir, entry), path.join(distWebview, entry));
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
  // The config-tab e2e asserts this skill's frontmatter description rides the boot configInit.
  fs.mkdirSync(path.join(opencodeDir, "skills", "e2e-skill"), { recursive: true });
  fs.writeFileSync(
    path.join(opencodeDir, "skills", "e2e-skill", "SKILL.md"),
    "---\nname: e2e-skill\ndescription: e2e 技能（配置页展示用）\n---\n\n# e2e skill stub\n",
  );

  // The fixture opencode.jsonc declares "@happycastle/opencode-openmemory@latest" in its
  // plugin array — seed it in the modern arborist layout under an isolated XDG_CACHE_HOME:
  // <XDG_CACHE_HOME>/opencode/packages/<spec>/node_modules/<name>.
  const cacheHome = path.join(seedRoot, ".cache");
  const pluginDir = path.join(
    cacheHome,
    "opencode",
    "packages",
    "@happycastle",
    "opencode-openmemory@latest",
    "node_modules",
    "@happycastle",
    "opencode-openmemory",
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({ name: "@happycastle/opencode-openmemory", version: "0.0.3" }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(pluginDir, "index.js"), "// e2e plugin stub\n");

  console.log(`[e2e:runner] seeded XDG_CONFIG_HOME=${seedRoot}`);
  return { seedRoot, cacheHome };
}

/** Recursive fingerprint (relpath/mtime/size) to detect any accidental write
 *  to the real user config dir. Returns "<missing>" for absent paths. */
function fingerprint(dir) {
  if (!fs.existsSync(dir)) {
    return "<missing>";
  }
  const lines = [];
  const walk = (current, rel) => {
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

/** Portable synchronous sleep — `sleep` does not exist on Windows. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, ms);
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
      sleepSync(1_000);
    }
  }
}

/**
 * Directories the safety guard fingerprints before/after the run: the runner's own
 * OPENCODE_CONFIG_DIR / XDG_CONFIG_HOME/opencode plus the default ~/.config/opencode.
 * Mirrors ConfigStore.resolveConfigDir — opencode uses xdg-basedir, which has no
 * platform branches (same ~/.config fallback on Linux, macOS and Windows).
 */
function realConfigDirCandidates() {
  const dirs = [];
  const explicit = process.env.OPENCODE_CONFIG_DIR;
  if (typeof explicit === "string" && explicit.trim() !== "") {
    dirs.push(explicit.trim());
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (typeof xdg === "string" && xdg.trim() !== "") {
    dirs.push(path.join(xdg, "opencode"));
  }
  dirs.push(path.join(os.homedir(), ".config", "opencode"));
  return [...new Set(dirs)];
}

async function main() {
  const suitePath = path.join(repoRoot, "dist", "test-e2e", "index.js");
  if (!fs.existsSync(suitePath)) {
    fail(`test suite bundle not found: ${suitePath} — run "node esbuild.mjs --tests" first`);
  }

  prepareWebviewAssets();
  const { seedRoot, cacheHome } = seedConfigHome();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocm-e2e-home-"));

  const guardDirs = realConfigDirCandidates();
  // Fingerprint the WHOLE ~/.omo dir (not just the two known filenames) — the omo
  // runtime may add other files, and future config names deserve the same guard.
  const realOmoDir = path.join(os.homedir(), ".omo");
  const beforeConfig = guardDirs.map(fingerprint);
  const beforeOmo = fingerprint(realOmoDir);

  let failed = false;
  try {
    await runTests({
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: suitePath,
      launchArgs: ["--disable-gpu", "--disable-extensions"],
      extensionTestsEnv: {
        XDG_CONFIG_HOME: seedRoot,
        XDG_CACHE_HOME: cacheHome,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        XDG_DATA_HOME: path.join(fakeHome, ".local", "share"),
        // resolveConfigDir gives OPENCODE_CONFIG_DIR top precedence — an inherited real
        // value would redirect the extension to the real config dir despite the XDG seed.
        // resolveConfigDir treats empty as unset, so this masks any inherited value.
        OPENCODE_CONFIG_DIR: "",
      },
    });
  } catch (error) {
    console.error(`[e2e:runner] VSCode test run failed: ${error}`);
    failed = true;
  }

  const afterConfig = guardDirs.map(fingerprint);
  if (beforeConfig.join("|") !== afterConfig.join("|")) {
    console.error(`[e2e:runner] SAFETY VIOLATION: real config dir changed during the run (${guardDirs.join(", ")})!`);
    failed = true;
  } else {
    console.log(`[e2e:runner] real config dirs untouched ✔ (${guardDirs.join(", ")})`);
  }
  const afterOmo = fingerprint(realOmoDir);
  if (beforeOmo !== afterOmo) {
    console.error("[e2e:runner] SAFETY VIOLATION: real ~/.omo dir changed during the run!");
    failed = true;
  } else {
    console.log("[e2e:runner] real ~/.omo dir untouched ✔");
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
