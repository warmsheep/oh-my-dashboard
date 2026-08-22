import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

function pluginCacheModules(home: string): string {
  return path.join(home, ".cache", "opencode", "node_modules");
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
      `{"plugin":[${JSON.stringify(
        "a",
      )},42,null,{},{"package":"b","options":{}},{"options":{}},"  "]}`,
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

describe("ConfigStore.listPlugins — npm entries", () => {
  it("splits scoped/versioned specifiers down to the package name and reports them uninstalled", () => {
    const { store, home } = makeCtx(
      `{"plugin":["@scope/name@latest","@scope2/plain","pkg@1.2.3","bare"]}`,
    );
    const list = store.listPlugins();
    expect(list.map((p) => p.name)).toEqual(["@scope/name", "@scope2/plain", "pkg", "bare"]);
    expect(list.every((p) => p.kind === "npm")).toBe(true);
    expect(list.every((p) => p.installed)).toBe(false);
    expect(list.every((p) => p.tree)).toEqual(true); // all empty arrays
    expect(list.every((p) => p.resolvedPath === path.join(pluginCacheModules(home), p.name))).toBe(true);
  });

  it("resolves an install in the runtime cache dir and reads its version + file tree", () => {
    const { store, home } = makeCtx(`{"plugin":["@scope/name@latest"]}`);
    seedNpmPlugin(pluginCacheModules(home), "@scope/name", { "dist/index.js": "export {}" });
    const [entry] = store.listPlugins();
    expect(entry.installed).toBe(true);
    expect(entry.version).toBe("1.2.3");
    expect(entry.resolvedPath).toBe(path.join(pluginCacheModules(home), "@scope/name"));
    const names = entry.tree.map((e) => e.name);
    expect(names).toEqual(["dist", "package.json"]); // dirs first, files after, alphabetical
    const dist = entry.tree.find((e) => e.name === "dist")!;
    expect(dist.isDir).toBe(true);
    expect(dist.children?.map((c) => c.name)).toEqual(["index.js"]);
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
    seedNpmPlugin(pluginCacheModules(home), "dual", {}, `{"name":"dual","version":"9.9.9"}`);
    seedNpmPlugin(path.join(configDir, "node_modules"), "dual");
    const [entry] = store.listPlugins();
    expect(entry.resolvedPath).toBe(path.join(pluginCacheModules(home), "dual"));
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
});
