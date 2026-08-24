import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../../src/core/configStore";
import type { DirEntry } from "../../src/core/types";

const sandboxes: string[] = [];

/** Isolated under os.tmpdir() so tests can never touch the real ~/.config/opencode. */
function sandbox(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ocm-plugins-"));
  sandboxes.push(dir);
  return dir;
}

interface Ctx {
  home: string;
  configDir: string;
  store: ConfigStore;
}

/** homeDir + configDir both inside the sandbox; empty env keeps XDG vars out of resolution. */
function makeCtx(opencodeJson?: string): Ctx {
  const home = sandbox();
  const configDir = path.join(home, ".config", "opencode");
  mkdirSync(configDir, { recursive: true });
  if (opencodeJson !== undefined) {
    writeFileSync(path.join(configDir, "opencode.json"), opencodeJson);
  }
  return { home, configDir, store: new ConfigStore({ configDirOverride: configDir, homeDir: home, env: {} }) };
}

/** bun-era flat layout: <cache>/node_modules/<name>. */
function pluginCacheModules(home: string): string {
  return path.join(home, ".cache", "opencode", "node_modules");
}

/** Modern arborist layout: <cache>/packages/<dirKey>/node_modules/<name>. */
function pluginPackagesDir(home: string, dirKey: string, name: string): string {
  return path.join(home, ".cache", "opencode", "packages", dirKey, "node_modules", ...name.split("/"));
}

function seedNpmPlugin(
  root: string,
  name: string,
  files: Record<string, string> = {},
  pkgJson = `{"name":"${name}","version":"1.2.3"}`,
): string {
  const dir = path.join(root, ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), pkgJson);
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ConfigStore.listPlugins — config reading", () => {
  it("returns [] when opencode.json is missing", () => {
    const { store } = makeCtx();
    expect(store.listPlugins()).toEqual([]);
  });

  it("returns [] when no plugin key exists", () => {
    const { store } = makeCtx(`{"provider":{}}`);
    expect(store.listPlugins()).toEqual([]);
  });

  it("returns [] when plugin is not an array", () => {
    const { store } = makeCtx(`{"plugin":"oh-my-openagent"}`);
    expect(store.listPlugins()).toEqual([]);
  });

  it("skips non-string, blank and object entries without a package field; keeps object entries with one", () => {
    const { store } = makeCtx(
      `{"plugin":[${JSON.stringify("a")},42,null,{},{"package":"b","options":{}},{"options":{}},"  "]}`,
    );
    const names = store.listPlugins().map((p) => p.name);
    expect(names).toEqual(["a", "b"]);
  });

  it("reads the plugins (plural) key as fallback when plugin is absent", () => {
    const { store } = makeCtx(`{"plugins":["pkg-a"]}`);
    const list = store.listPlugins();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("pkg-a");
  });

  it("tolerates JSONC comments and trailing commas inside the plugin array", () => {
    const { store } = makeCtx(`{
      // enabled plugins
      "plugin": [
        "one", // first
        "two",
      ],
    }`);
    expect(store.listPlugins().map((p) => p.name)).toEqual(["one", "two"]);
  });

  it("preserves declaration order", () => {
    const { store } = makeCtx(`{"plugin":["zeta","alpha","mid"]}`);
    expect(store.listPlugins().map((p) => p.name)).toEqual(["zeta", "alpha", "mid"]);
  });
});

describe("plugin declaration reading — V1/V2 normalized (declaredPluginSpecifiers)", () => {
  it("resolveAgentConfig detects the omo target via V2 plugins {package} entries", () => {
    const { store } = makeCtx(`{"plugins":[{"package":"oh-my-openagent@latest"}]}`);
    const target = store.resolveAgentConfig();
    expect(target.kind).toBe("omo");
    expect(target.exists).toBe(false);
  });

  it("listPlugins and resolveAgentConfig read the SAME declaration list (no drift)", () => {
    const { store } = makeCtx(`{"plugins":[{"package":"oh-my-openagent"}]}`);
    expect(store.listPlugins().map((p) => p.specifier)).toEqual(["oh-my-openagent"]);
    expect(store.resolveAgentConfig().kind).toBe("omo");
  });

  it("mixed shape: a present V1 plugin array wins; the V2 plugins key is not consulted", () => {
    const { store } = makeCtx(`{"plugin":["something-else"],"plugins":[{"package":"oh-my-openagent"}]}`);
    expect(store.listPlugins().map((p) => p.specifier)).toEqual(["something-else"]);
    expect(store.resolveAgentConfig().kind).toBe("legacy");
  });

  it("V2 object entries without a package field are ignored by both consumers", () => {
    const { store } = makeCtx(`{"plugins":[{"options":{}},"plain"]}`);
    expect(store.listPlugins().map((p) => p.specifier)).toEqual(["plain"]);
    expect(store.resolveAgentConfig().kind).toBe("legacy");
  });
});

describe("ConfigStore.listPlugins — npm entries", () => {
  it("splits scoped/versioned specifiers down to the package name and reports them uninstalled", () => {
    const { store, home } = makeCtx(`{"plugin":["@scope/name@latest","@scope2/plain","pkg@1.2.3","bare"]}`);
    const list = store.listPlugins();
    expect(list.map((p) => p.name)).toEqual(["@scope/name", "@scope2/plain", "pkg", "bare"]);
    expect(list.every((p) => p.kind === "npm")).toBe(true);
    expect(list.every((p) => p.installed)).toBe(false);
    expect(list.every((p) => p.tree)).toEqual(true); // all empty arrays
    // Uninstalled entries report the modern expected location: packages/<spec>/node_modules/<name>
    // (bare names get the "@latest" dir key, matching opencode's resolvePluginTarget).
    expect(list.map((p) => p.resolvedPath)).toEqual([
      pluginPackagesDir(home, "@scope/name@latest", "@scope/name"),
      pluginPackagesDir(home, "@scope2/plain@latest", "@scope2/plain"),
      pluginPackagesDir(home, "pkg@1.2.3", "pkg"),
      pluginPackagesDir(home, "bare@latest", "bare"),
    ]);
  });

  it("resolves an install in the runtime cache packages/ layout and reads its version + file tree", () => {
    const { store, home } = makeCtx(`{"plugin":["@scope/name@latest"]}`);
    const dir = pluginPackagesDir(home, "@scope/name@latest", "@scope/name");
    const nodeModules = dir.slice(0, dir.indexOf("node_modules") + "node_modules".length);
    seedNpmPlugin(nodeModules, "@scope/name", { "dist/index.js": "export {}" });
    const [entry] = store.listPlugins();
    expect(entry.installed).toBe(true);
    expect(entry.version).toBe("1.2.3");
    expect(entry.resolvedPath).toBe(dir);
    const names = entry.tree.map((e) => e.name);
    expect(names).toEqual(["dist", "package.json"]); // dirs first, files after, alphabetical
    const dist = entry.tree.find((e) => e.name === "dist")!;
    expect(dist.isDir).toBe(true);
    expect(dist.children?.map((c) => c.name)).toEqual(["index.js"]);
  });

  it("resolves installs from the legacy bun-era flat cache layout", () => {
    const { store, home } = makeCtx(`{"plugin":["legacy-pkg"]}`);
    seedNpmPlugin(pluginCacheModules(home), "legacy-pkg", { "index.js": "" });
    const [entry] = store.listPlugins();
    expect(entry.installed).toBe(true);
    expect(entry.resolvedPath).toBe(path.join(pluginCacheModules(home), "legacy-pkg"));
    expect(entry.version).toBe("1.2.3");
  });

  it("finds installs under packages/ via scan when the dir key drifts from our reconstruction", () => {
    const { store, home } = makeCtx(`{"plugin":["drifty"]}`);
    // opencode normalized the spec differently (e.g. npa lowercasing) — the scan still finds it.
    const dir = pluginPackagesDir(home, "drifty@^2.0.0", "drifty");
    seedNpmPlugin(path.dirname(dir), "drifty"); // unscoped: dirname(node_modules/drifty) = node_modules
    const [entry] = store.listPlugins();
    expect(entry.installed).toBe(true);
    expect(entry.resolvedPath).toBe(dir);
  });

  it("falls back to configDir/node_modules when the cache dir has no install", () => {
    const { store, configDir } = makeCtx(`{"plugin":["oh-my-openagent"]}`);
    seedNpmPlugin(path.join(configDir, "node_modules"), "oh-my-openagent", { "index.js": "" });
    const [entry] = store.listPlugins();
    expect(entry.installed).toBe(true);
    expect(entry.resolvedPath).toBe(path.join(configDir, "node_modules", "oh-my-openagent"));
    expect(entry.version).toBe("1.2.3");
  });

  it("prefers the runtime cache install when both locations exist", () => {
    const { store, home, configDir } = makeCtx(`{"plugin":["dual"]}`);
    const dir = pluginPackagesDir(home, "dual@latest", "dual");
    seedNpmPlugin(path.dirname(dir), "dual", {}, `{"name":"dual","version":"9.9.9"}`);
    seedNpmPlugin(path.join(configDir, "node_modules"), "dual");
    const [entry] = store.listPlugins();
    expect(entry.resolvedPath).toBe(dir);
    expect(entry.version).toBe("9.9.9");
  });

  it("treats an installed package without package.json as installed with no version", () => {
    const { store, home } = makeCtx(`{"plugin":["raw"]}`);
    const dir = path.join(pluginCacheModules(home), "raw");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "mod.js"), "");
    const [entry] = store.listPlugins();
    expect(entry.installed).toBe(true);
    expect(entry.version).toBeUndefined();
  });

  it("ignores a non-string version field in the installed package.json", () => {
    const { store, home } = makeCtx(`{"plugin":["weird"]}`);
    seedNpmPlugin(pluginCacheModules(home), "weird", {}, `{"name":"weird","version":42}`);
    const [entry] = store.listPlugins();
    expect(entry.installed).toBe(true);
    expect(entry.version).toBeUndefined();
  });

  it("excludes nested node_modules and .git from the file tree at every depth", () => {
    const { store, home } = makeCtx(`{"plugin":["big"]}`);
    seedNpmPlugin(pluginCacheModules(home), "big", {
      "dist/ok.js": "",
      "node_modules/dep/x.js": "",
      ".git/config": "",
      "sub/node_modules/deep/y.js": "",
      "sub/keep.js": "",
    });
    const [entry] = store.listPlugins();
    const walk = (nodes: DirEntry[], acc: string[] = []): string[] => {
      for (const n of nodes) {
        acc.push(n.name);
        if (n.children) walk(n.children, acc);
      }
      return acc;
    };
    const names = walk(entry.tree);
    expect(names.some((n) => n === "node_modules" || n === ".git")).toBe(false);
    expect(names).toContain("dist");
    expect(names).toContain("sub");
    expect(names).toContain("keep.js");
  });

  it.skipIf(process.platform === "win32")(
    "win32: sanitizes illegal chars in the packages dir key to '_' (upstream npm.ts sanitize)",
    () => {
      const home = sandbox();
      const configDir = path.join(home, ".config", "opencode");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(path.join(configDir, "opencode.json"), `{"plugin":["a<b"]}`);
      const store = new ConfigStore({ configDirOverride: configDir, homeDir: home, env: {}, platform: "win32" });

      // opencode writes the install under packages/a_b@latest/ (illegal chars replaced),
      // while the package directory itself keeps the raw name.
      const nodeModules = path.dirname(pluginPackagesDir(home, "a_b@latest", "a<b"));
      seedNpmPlugin(nodeModules, "a<b", { "index.js": "" });

      const [entry] = store.listPlugins();
      expect(entry.name).toBe("a<b");
      expect(entry.installed).toBe(true);
      expect(entry.resolvedPath).toBe(pluginPackagesDir(home, "a_b@latest", "a<b"));
      expect(entry.version).toBe("1.2.3");
    },
  );
});

describe("ConfigStore.listPlugins — path entries", () => {
  it("expands ~/ file paths against homeDir and yields a single-file tree", () => {
    const { store, home } = makeCtx(`{"plugin":["~/my-plugin.ts"]}`);
    writeFileSync(path.join(home, "my-plugin.ts"), "export {}");
    const [entry] = store.listPlugins();
    expect(entry.kind).toBe("path");
    expect(entry.name).toBe("my-plugin.ts");
    expect(entry.installed).toBe(true);
    expect(entry.resolvedPath).toBe(path.join(home, "my-plugin.ts"));
    expect(entry.tree).toEqual([{ name: "my-plugin.ts", path: path.join(home, "my-plugin.ts"), isDir: false }]);
    expect(entry.version).toBeUndefined();
  });

  it("marks a missing ~/ path uninstalled with an empty tree", () => {
    const { store } = makeCtx(`{"plugin":["~/nope.ts"]}`);
    const [entry] = store.listPlugins();
    expect(entry.installed).toBe(false);
    expect(entry.tree).toEqual([]);
  });

  it("resolves ./ relative paths against the config dir and renders directory trees", () => {
    const { store, configDir } = makeCtx(`{"plugin":["./plugins/local"]}`);
    const dir = path.join(configDir, "plugins", "local");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "a.ts"), "");
    writeFileSync(path.join(dir, "b.ts"), "");
    const [entry] = store.listPlugins();
    expect(entry.kind).toBe("path");
    expect(entry.name).toBe("local");
    expect(entry.resolvedPath).toBe(dir);
    expect(entry.installed).toBe(true);
    expect(entry.tree.map((e) => e.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("passes absolute paths through unchanged", () => {
    const { store } = makeCtx(`{"plugin":["/opt/plugins/abs.js"]}`);
    const [entry] = store.listPlugins();
    expect(entry.resolvedPath).toBe("/opt/plugins/abs.js");
    expect(entry.installed).toBe(false);
  });

  it("strips the file:// prefix from path specifiers", () => {
    const { store, configDir } = makeCtx(`{"plugin":["file://./p.js"]}`);
    writeFileSync(path.join(configDir, "p.js"), "");
    const [entry] = store.listPlugins();
    expect(entry.kind).toBe("path");
    expect(entry.resolvedPath).toBe(path.join(configDir, "p.js"));
    expect(entry.installed).toBe(true);
  });

  it("resolves Windows drive-letter URLs (file:///C:/…) through fileURLToPath on every platform", () => {
    // Asserting against fileURLToPath itself is the point: the slice fallback would
    // yield the RELATIVE "C:/x…" and resolve it against configDir instead.
    const { store } = makeCtx(`{"plugin":["file:///C:/x/plugin.js"]}`);
    const [entry] = store.listPlugins();
    expect(entry.kind).toBe("path");
    expect(entry.resolvedPath).toBe(path.resolve(fileURLToPath("file:///C:/x/plugin.js")));
  });
});
