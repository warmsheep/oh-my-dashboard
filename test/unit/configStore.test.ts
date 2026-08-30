import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigStore, writeFileAtomic } from "../../src/core/configStore";
import { getValue, JsoncSyntaxError, parseSafe, validate } from "../../src/core/jsoncEditor";

// Transparent readFileSync counter for the memoization tests: the wrapper only logs
// string paths while enabled and always delegates to the real implementation.
// failOnce makes the NEXT read of a path throw EACCES (stat still succeeds).
const fsReadSpy = vi.hoisted(() => ({ reads: [] as string[], on: false, failOnce: new Set<string>() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realReadFileSync = actual.readFileSync;
  return {
    ...actual,
    readFileSync: ((p: unknown, ...rest: unknown[]) => {
      if (typeof p === "string" && fsReadSpy.failOnce.has(p)) {
        fsReadSpy.failOnce.delete(p);
        throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: "EACCES" });
      }
      if (fsReadSpy.on && typeof p === "string") {
        fsReadSpy.reads.push(p);
      }
      return (realReadFileSync as unknown as (path: unknown, ...args: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.readFileSync,
  };
});

const FIXTURES_DIR = path.resolve(process.cwd(), "test/fixtures");

const sandboxes: string[] = [];

/** Isolated under os.tmpdir() so tests can never touch the real ~/.config/opencode. */
function sandbox(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ocm-"));
  sandboxes.push(dir);
  return dir;
}

function seedConfigDir(files: { opencode?: boolean; ohMy?: boolean } = { opencode: true, ohMy: true }): string {
  const dir = sandbox();
  if (files.opencode) {
    copyFileSync(path.join(FIXTURES_DIR, "opencode.jsonc"), path.join(dir, "opencode.json"));
  }
  if (files.ohMy) {
    copyFileSync(path.join(FIXTURES_DIR, "oh-my-opencode.json"), path.join(dir, "oh-my-opencode.json"));
  }
  return dir;
}

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ConfigStore.resolveConfigDir", () => {
  it("prefers $OPENCODE_CONFIG_DIR over everything else", () => {
    expect(
      ConfigStore.resolveConfigDir(
        { OPENCODE_CONFIG_DIR: "/custom/dir", XDG_CONFIG_HOME: "/tmp/xdg-root" },
        "/home/tester",
      ),
    ).toBe("/custom/dir");
  });

  it("prefers $XDG_CONFIG_HOME/opencode when XDG_CONFIG_HOME is set", () => {
    expect(ConfigStore.resolveConfigDir({ XDG_CONFIG_HOME: "/tmp/xdg-root" }, "/home/tester")).toBe(
      path.join("/tmp/xdg-root", "opencode"),
    );
  });

  it("defaults to ~/.config/opencode (opencode's xdg-basedir has no platform branches: same on linux/macOS/win32)", () => {
    expect(ConfigStore.resolveConfigDir({}, "/home/tester")).toBe(path.join("/home/tester", ".config", "opencode"));
    expect(ConfigStore.resolveConfigDir({}, "/Users/tester")).toBe(path.join("/Users/tester", ".config", "opencode"));
    expect(ConfigStore.resolveConfigDir({}, "C:\\Users\\tester")).toBe(
      path.join("C:\\Users\\tester", ".config", "opencode"),
    );
  });

  it("configDirOverride wins over environment for instance.configDir", () => {
    const store = new ConfigStore({
      configDirOverride: "/tmp/override-dir",
      env: { XDG_CONFIG_HOME: "/tmp/xdg-root" },
      homeDir: "/home/tester",
    });
    expect(store.configDir).toBe("/tmp/override-dir");
  });
});

describe("ConfigStore.discover", () => {
  it("reports all fields exactly on a seeded tree", () => {
    const configDir = seedConfigDir();
    mkdirSync(path.join(configDir, "command"));
    writeFileSync(path.join(configDir, "command", "x.md"), "# x");
    writeFileSync(path.join(configDir, "command", "notes.txt"), "not a command");
    mkdirSync(path.join(configDir, "skills", "one"), { recursive: true });
    mkdirSync(path.join(configDir, "skills", "two"), { recursive: true });
    writeFileSync(path.join(configDir, "skills", "one", "SKILL.md"), "# one");
    writeFileSync(path.join(configDir, "skills", "two", "SKILL.md"), "# two");
    writeFileSync(path.join(configDir, "AGENTS.md"), "# agents");

    const wsWithAgentsMd = sandbox();
    writeFileSync(path.join(wsWithAgentsMd, "AGENTS.md"), "# project agents");
    const wsWithoutAgentsMd = sandbox();

    const home = sandbox();
    const store = new ConfigStore({ configDirOverride: configDir, homeDir: home });
    const d = store.discover([wsWithAgentsMd, wsWithoutAgentsMd]);

    expect(d.configDir).toBe(configDir);
    expect(d.opencodeJson).toBe(path.join(configDir, "opencode.json"));
    expect(d.agentConfig.path).toBe(path.join(configDir, "oh-my-opencode.json"));
    expect(d.commandDir).toBe(path.join(configDir, "command"));
    expect(d.presetsDir).toBe(path.join(configDir, "presets"));
    expect(d.backupsDir).toBe(path.join(configDir, "backups"));
    expect(d.commandFiles).toEqual(["x.md"]);
    // Only skills dirs that exist on disk are reported; home-level candidates all carry the global scope.
    expect(
      d.skillLocations.map((l) => ({ scope: l.scope, label: l.label, dir: l.dir, skillNames: l.skillNames })),
    ).toEqual([
      {
        scope: "global",
        label: configDir + path.sep + "skills",
        dir: path.join(configDir, "skills"),
        skillNames: ["one", "two"],
      },
    ]);
    expect(d.agentsMd).toEqual([
      { scope: "global", path: path.join(configDir, "AGENTS.md"), exists: true },
      { scope: "project", path: path.join(wsWithAgentsMd, "AGENTS.md"), exists: true },
      { scope: "project", path: path.join(wsWithoutAgentsMd, "AGENTS.md"), exists: false },
    ]);
  });

  it("does not throw on an empty config dir; no skill rows when no candidate dir exists", () => {
    const dir = sandbox();
    const home = sandbox();
    const store = new ConfigStore({ configDirOverride: dir, homeDir: home });
    const d = store.discover();
    expect(d.opencodeJson).toBe(path.join(dir, "opencode.json"));
    expect(d.commandFiles).toEqual([]);
    expect(d.skillLocations).toEqual([]);
    expect(d.agentsMd).toEqual([{ scope: "global", path: path.join(dir, "AGENTS.md"), exists: false }]);
  });

  it("discovers ~/.agents/skills as 全局 with a dir tree, ignoring non-skill entries and the opencode cache", () => {
    const configDir = seedConfigDir();
    const home = sandbox();
    mkdirSync(path.join(home, ".agents", "skills", "pdf"), { recursive: true });
    mkdirSync(path.join(home, ".agents", "skills", "xlsx"), { recursive: true });
    writeFileSync(path.join(home, ".agents", "skills", "pdf", "SKILL.md"), "# pdf");
    writeFileSync(path.join(home, ".agents", "skills", "xlsx", "SKILL.md"), "# xlsx");
    writeFileSync(path.join(home, ".agents", "skills", "README.md"), "not a skill");
    mkdirSync(path.join(home, ".agents", "skills", "not-a-skill"), { recursive: true });
    // opencode-managed plugin cache must never show up as a managed location
    mkdirSync(path.join(home, ".cache", "opencode", "skills", "cached-skill"), { recursive: true });

    const d = new ConfigStore({ configDirOverride: configDir, homeDir: home }).discover();

    expect(d.skillLocations).toHaveLength(1);
    const row = d.skillLocations[0];
    expect(row.scope).toBe("global");
    expect(row.label).toBe("~/.agents/skills");
    expect(row.dir).toBe(path.join(home, ".agents", "skills"));
    expect(row.skillNames).toEqual(["pdf", "xlsx"]);
    const pdf = row.tree.find((e) => e.name === "pdf");
    expect(pdf?.isDir).toBe(true);
    expect(pdf?.children?.map((c) => c.name)).toEqual(["SKILL.md"]);
    expect(row.tree.some((e) => e.name === "cached-skill")).toBe(false);
  });

  it("reports every common home-level skills dir as 全局 in canonical order with tilde labels", () => {
    const configDir = seedConfigDir();
    const home = sandbox();
    for (const rel of [
      ".agents/skills/a",
      ".claude/skills/b",
      ".codex/skills/c",
      ".copilot/skills/d",
      ".gemini/skills/e",
      ".cursor/skills/f",
      ".codeium/windsurf/skills/g",
      ".config/agents/skills/h",
      ".config/amp/skills/i",
    ]) {
      mkdirSync(path.join(home, rel), { recursive: true });
      const skill = rel.split("/").pop()!;
      writeFileSync(path.join(home, rel, "SKILL.md"), `# ${skill}`);
    }
    mkdirSync(path.join(configDir, "skills", "j"), { recursive: true });
    writeFileSync(path.join(configDir, "skills", "j", "SKILL.md"), "# j");

    const d = new ConfigStore({ configDirOverride: configDir, homeDir: home }).discover();

    expect(d.skillLocations.map((l) => l.scope)).toEqual(d.skillLocations.map(() => "global"));
    expect(d.skillLocations.map((l) => l.label)).toEqual([
      "~/.agents/skills",
      "~/.claude/skills",
      configDir + path.sep + "skills",
      "~/.config/agents/skills",
      "~/.config/amp/skills",
      "~/.copilot/skills",
      "~/.gemini/skills",
      "~/.cursor/skills",
      "~/.codeium/windsurf/skills",
      "~/.codex/skills",
    ]);
    expect(d.skillLocations.map((l) => l.skillNames.flat())).toEqual(
      [["a"], ["b"], ["j"], ["h"], ["i"], ["d"], ["e"], ["f"], ["g"], ["c"]].map((n) => n),
    );
  });

  it("honors XDG_CONFIG_HOME for the XDG-style global skills candidates", () => {
    const configDir = seedConfigDir();
    const home = sandbox();
    const xdg = sandbox();
    mkdirSync(path.join(xdg, "agents", "skills", "amp-skill"), { recursive: true });
    writeFileSync(path.join(xdg, "agents", "skills", "amp-skill", "SKILL.md"), "# amp");

    const d = new ConfigStore({
      configDirOverride: configDir,
      homeDir: home,
      env: { XDG_CONFIG_HOME: xdg },
    }).discover();

    const amp = d.skillLocations.find((l) => l.dir === path.join(xdg, "agents", "skills"));
    expect(amp?.scope).toBe("global");
    expect(amp?.skillNames).toEqual(["amp-skill"]);
  });

  it("counts symlinked skill dirs (e.g. ~/.claude/skills → ~/.agents/skills entries)", () => {
    const configDir = seedConfigDir();
    const home = sandbox();
    mkdirSync(path.join(home, ".agents", "skills", "pdf"), { recursive: true });
    writeFileSync(path.join(home, ".agents", "skills", "pdf", "SKILL.md"), "# pdf");
    mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    // Junctions need no privilege on Windows (unlike "dir" symlinks) and satisfy statSync follow.
    symlinkSync(
      path.join(home, ".agents", "skills", "pdf"),
      path.join(home, ".claude", "skills", "pdf"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const d = new ConfigStore({ configDirOverride: configDir, homeDir: home }).discover();

    const claude = d.skillLocations.find((l) => l.dir === path.join(home, ".claude", "skills"));
    expect(claude?.skillNames).toEqual(["pdf"]);
    const linked = claude?.tree.find((e) => e.name === "pdf");
    expect(linked?.isDir).toBe(true);
  });

  it("dedupes when configDir itself is one of the home-level candidates", () => {
    const home = sandbox();
    const claudeConfig = path.join(home, ".claude");
    mkdirSync(path.join(claudeConfig, "skills", "s"), { recursive: true });
    writeFileSync(path.join(claudeConfig, "skills", "s", "SKILL.md"), "# s");

    const d = new ConfigStore({ configDirOverride: claudeConfig, homeDir: home }).discover();

    expect(d.skillLocations).toHaveLength(1);
    expect(d.skillLocations[0].dir).toBe(path.join(claudeConfig, "skills"));
    expect(d.skillLocations[0].label).toBe("~/.claude/skills");
  });

  it("a SKILL.md that is a DIRECTORY does not count as a skill", () => {
    const configDir = seedConfigDir();
    const home = sandbox();
    mkdirSync(path.join(configDir, "skills", "fake", "SKILL.md"), { recursive: true }); // SKILL.md as a dir
    mkdirSync(path.join(configDir, "skills", "real"), { recursive: true });
    writeFileSync(path.join(configDir, "skills", "real", "SKILL.md"), "# real");

    const d = new ConfigStore({ configDirOverride: configDir, homeDir: home }).discover();

    const row = d.skillLocations[0];
    expect(row.skillNames).toEqual(["real"]);
    // the fake entry still shows in the file tree (it IS a directory), it just is not a skill
    expect(row.tree.some((e) => e.name === "fake")).toBe(true);
  });

  it("a skills candidate path that is a FILE is not listed as a skill location", () => {
    const configDir = seedConfigDir();
    const home = sandbox();
    mkdirSync(path.join(home, ".agents"));
    writeFileSync(path.join(home, ".agents", "skills"), "not a dir"); // file shadowing the candidate
    mkdirSync(path.join(home, ".claude", "skills", "s"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "skills", "s", "SKILL.md"), "# s");

    const d = new ConfigStore({ configDirOverride: configDir, homeDir: home }).discover();

    expect(d.skillLocations.map((l) => l.dir)).toEqual([path.join(home, ".claude", "skills")]);
  });

  it("a candidate dir that is a symlink to a real skills dir still counts (stat follows links)", () => {
    const configDir = seedConfigDir();
    const home = sandbox();
    mkdirSync(path.join(home, ".agents", "skills", "pdf"), { recursive: true });
    writeFileSync(path.join(home, ".agents", "skills", "pdf", "SKILL.md"), "# pdf");
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    symlinkSync(
      path.join(home, ".agents", "skills"),
      path.join(home, ".claude", "skills"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const d = new ConfigStore({ configDirOverride: configDir, homeDir: home }).discover();

    expect(d.skillLocations.map((l) => l.dir)).toEqual([
      path.join(home, ".agents", "skills"),
      path.join(home, ".claude", "skills"),
    ]);
    expect(d.skillLocations[1].skillNames).toEqual(["pdf"]);
  });

  it("discovers project skills from every common project dir in candidate order", () => {
    const configDir = seedConfigDir();
    const home = sandbox();
    const ws = sandbox();
    for (const rel of [
      ".agents/skills",
      ".claude/skills",
      ".opencode/skills",
      ".github/skills",
      ".gemini/skills",
      ".cursor/skills",
      ".windsurf/skills",
    ]) {
      const skillDir = path.join(ws, rel, "demo");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, "SKILL.md"), "# demo");
    }
    const wsOnlyNative = sandbox();
    mkdirSync(path.join(wsOnlyNative, ".opencode", "skills", "only-opencode"), { recursive: true });
    writeFileSync(path.join(wsOnlyNative, ".opencode", "skills", "only-opencode", "SKILL.md"), "# x");
    const wsWithout = sandbox();

    const d = new ConfigStore({ configDirOverride: configDir, homeDir: home }).discover([ws, wsOnlyNative, wsWithout]);

    const projects = d.skillLocations.filter((l) => l.scope === "project");
    expect(projects.map((l) => `${l.label} @ ${l.dir}`)).toEqual([
      `.agents/skills @ ${path.join(ws, ".agents", "skills")}`,
      `.claude/skills @ ${path.join(ws, ".claude", "skills")}`,
      `.opencode/skills @ ${path.join(ws, ".opencode", "skills")}`,
      `.github/skills @ ${path.join(ws, ".github", "skills")}`,
      `.gemini/skills @ ${path.join(ws, ".gemini", "skills")}`,
      `.cursor/skills @ ${path.join(ws, ".cursor", "skills")}`,
      `.windsurf/skills @ ${path.join(ws, ".windsurf", "skills")}`,
      `.opencode/skills @ ${path.join(wsOnlyNative, ".opencode", "skills")}`,
    ]);
    expect(projects.every((l) => l.skillNames.length === 1)).toBe(true);
  });
});

describe("ConfigStore.discoverPaths", () => {
  it("returns the path-level fields: dirs, existence flags, agent target, agentsMd — without trees", () => {
    const configDir = seedConfigDir();
    const home = sandbox();
    mkdirSync(path.join(configDir, "command"));
    writeFileSync(path.join(configDir, "command", "x.md"), "# x");
    mkdirSync(path.join(configDir, "skills", "one"), { recursive: true });
    writeFileSync(path.join(configDir, "skills", "one", "SKILL.md"), "# one");
    writeFileSync(path.join(configDir, "AGENTS.md"), "# agents");
    const ws = sandbox();
    writeFileSync(path.join(ws, "AGENTS.md"), "# project agents");

    const d = new ConfigStore({ configDirOverride: configDir, homeDir: home }).discoverPaths([ws]);

    expect(d.configDir).toBe(configDir);
    expect(d.opencodeJson).toBe(path.join(configDir, "opencode.json"));
    expect(d.agentConfig).toEqual({
      kind: "legacy",
      path: path.join(configDir, "oh-my-opencode.json"),
      sectionPath: [],
      reasoningKey: "variant",
      exists: true,
    });
    expect(d.commandDir).toBe(path.join(configDir, "command"));
    expect(d.skillsDir).toBe(path.join(configDir, "skills"));
    expect(d.presetsDir).toBe(path.join(configDir, "presets"));
    expect(d.backupsDir).toBe(path.join(configDir, "backups"));
    expect(d.agentsMd).toEqual([
      { scope: "global", path: path.join(configDir, "AGENTS.md"), exists: true },
      { scope: "project", path: path.join(ws, "AGENTS.md"), exists: true },
    ]);
    expect(d.skillLocations).toEqual([
      { scope: "global", label: configDir + path.sep + "skills", dir: path.join(configDir, "skills") },
    ]);
  });

  it("reports no skill rows on an empty config dir and a non-existent agent target", () => {
    const dir = sandbox();
    const home = sandbox();
    const d = new ConfigStore({ configDirOverride: dir, homeDir: home }).discoverPaths();
    expect(d.skillLocations).toEqual([]);
    expect(d.agentConfig.exists).toBe(false);
  });

  it("agrees with discover() on the candidate dir set (same helper, minus trees/names)", () => {
    const configDir = seedConfigDir();
    const home = sandbox();
    mkdirSync(path.join(home, ".agents", "skills", "pdf"), { recursive: true });
    writeFileSync(path.join(home, ".agents", "skills", "pdf", "SKILL.md"), "# pdf");
    const store = new ConfigStore({ configDirOverride: configDir, homeDir: home });

    const paths = store.discoverPaths();
    const full = store.discover();
    expect(paths.skillLocations.map((l) => ({ scope: l.scope, label: l.label, dir: l.dir }))).toEqual(
      full.skillLocations.map((l) => ({ scope: l.scope, label: l.label, dir: l.dir })),
    );
    expect(paths.agentConfig).toEqual(full.agentConfig);
  });
});

describe("ConfigStore internal read memoization", () => {
  it("reads opencode.json once across repeated listModels/listPlugins/defaultModel in one refresh", () => {
    const dir = seedConfigDir({ opencode: true });
    const store = new ConfigStore({ configDirOverride: dir });
    const opencode = path.join(dir, "opencode.json");

    fsReadSpy.reads.length = 0;
    fsReadSpy.on = true;
    try {
      store.listModels();
      store.listModels();
      store.listPlugins();
      expect(store.defaultModel()).toBeNull();
      expect(fsReadSpy.reads.filter((p) => p === opencode)).toHaveLength(1);
    } finally {
      fsReadSpy.on = false;
    }
  });

  it("writeAtomic busts the memo: the next read is fresh", () => {
    const dir = seedConfigDir({ opencode: true });
    const store = new ConfigStore({ configDirOverride: dir });
    expect(store.defaultModel()).toBeNull(); // populate the memo

    store.writeAtomic(path.join(dir, "opencode.json"), JSON.stringify({ model: "x/y" }));

    expect(store.defaultModel()).toBe("x/y");
  });

  it("an external write (mtime bump) busts the memo without writeAtomic", () => {
    const dir = seedConfigDir({ opencode: true });
    const store = new ConfigStore({ configDirOverride: dir });
    expect(store.defaultModel()).toBeNull(); // populate the memo

    writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ model: "ext/z" }));

    expect(store.defaultModel()).toBe("ext/z");
  });

  it("opencodeModels shares the memoized parse (provider models update after an external edit)", () => {
    const dir = seedConfigDir({ opencode: true });
    const store = new ConfigStore({ configDirOverride: dir });
    expect(store.listModels().some((m) => m.id === "ext/brand-new")).toBe(false);

    writeFileSync(
      path.join(dir, "opencode.json"),
      JSON.stringify({ provider: { ext: { models: { "brand-new": {} } } } }),
    );

    expect(store.listModels().some((m) => m.id === "ext/brand-new")).toBe(true);
  });

  it('a stat-ok but failing read (EACCES) is NOT cached as "" — permission recovery self-heals', () => {
    const dir = seedConfigDir({ opencode: true });
    const store = new ConfigStore({ configDirOverride: dir });
    const opencode = path.join(dir, "opencode.json");
    writeFileSync(opencode, JSON.stringify({ model: "a/b" }));

    fsReadSpy.failOnce.add(opencode);
    expect(store.defaultModel()).toBeNull(); // degraded to empty per readTextOrEmpty semantics

    // No write, no mtime change — the next read must retry the real file instead of
    // replaying the cached "" under the still-valid stat key.
    expect(store.defaultModel()).toBe("a/b");
  });
});

describe("ConfigStore.writeAtomic", () => {
  it("writes exact content and leaves no .tmp-* residue in the directory", () => {
    const dir = sandbox();
    const target = path.join(dir, "opencode.json");
    new ConfigStore({ configDirOverride: dir }).writeAtomic(target, "hello world");
    expect(readFileSync(target, "utf8")).toBe("hello world");
    expect(readdirSync(dir).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  it("fully replaces existing file content", () => {
    const dir = sandbox();
    const target = path.join(dir, "opencode.json");
    const store = new ConfigStore({ configDirOverride: dir });
    store.writeAtomic(target, "old content that is much longer");
    store.writeAtomic(target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
  });
});

describe("ConfigStore.pluginCacheDir", () => {
  it("prefers $XDG_CACHE_HOME/opencode on every platform", () => {
    const store = new ConfigStore({ homeDir: "/home/t", env: { XDG_CACHE_HOME: "/xdg-cache" }, platform: "darwin" });
    expect(store.pluginCacheDir).toBe(path.join("/xdg-cache", "opencode"));
  });

  it("uses ~/.cache/opencode on linux, macOS and win32 alike (xdg-basedir has no platform branches)", () => {
    expect(new ConfigStore({ homeDir: "/home/t", env: {}, platform: "linux" }).pluginCacheDir).toBe(
      path.join("/home/t", ".cache", "opencode"),
    );
    expect(new ConfigStore({ homeDir: "/Users/t", env: {}, platform: "darwin" }).pluginCacheDir).toBe(
      path.join("/Users/t", ".cache", "opencode"),
    );
    expect(new ConfigStore({ homeDir: "C:\\Users\\t", env: {}, platform: "win32" }).pluginCacheDir).toBe(
      path.join("C:\\Users\\t", ".cache", "opencode"),
    );
  });
});

describe("writeFileAtomic", () => {
  type FakeFs = Pick<
    typeof import("node:fs"),
    "openSync" | "writeFileSync" | "fsyncSync" | "closeSync" | "renameSync" | "rmSync"
  >;
  const fakeFs = (renameImpl: (tmp: string, target: string) => void): { fs: FakeFs; calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      fs: {
        openSync: () => 3,
        writeFileSync: () => undefined,
        fsyncSync: () => undefined,
        closeSync: () => undefined,
        renameSync: (tmp: unknown, target: unknown) => {
          calls.push("rename");
          renameImpl(String(tmp), String(target));
        },
        rmSync: () => {
          calls.push("rm");
        },
      } as unknown as FakeFs,
    };
  };

  it("retries transient Windows lock errors (EPERM/EACCES/EBUSY) then succeeds", () => {
    let failures = 2;
    const { fs, calls } = fakeFs(() => {
      if (failures > 0) {
        failures -= 1;
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
    });
    writeFileAtomic(path.join(sandbox(), "out.json"), "x", fs);
    expect(calls).toEqual(["rename", "rename", "rename"]);
  });

  it("does not retry non-lock errors and cleans up the tmp file", () => {
    const { fs, calls } = fakeFs(() => {
      const err = new Error("no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    expect(() => writeFileAtomic(path.join(sandbox(), "out.json"), "x", fs)).toThrow("no such file");
    expect(calls).toEqual(["rename", "rm"]);
  });

  it("gives up after 5 attempts on persistent EPERM and cleans up", () => {
    const { fs, calls } = fakeFs(() => {
      const err = new Error("operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    expect(() => writeFileAtomic(path.join(sandbox(), "out.json"), "x", fs)).toThrow("operation not permitted");
    expect(calls.filter((c) => c === "rename")).toHaveLength(5);
    expect(calls[calls.length - 1]).toBe("rm");
  });

  it("cleans up the tmp file when the write itself fails (e.g. ENOSPC)", () => {
    const calls: string[] = [];
    const failingFs = {
      openSync: () => 3,
      writeFileSync: () => {
        const err = new Error("no space left on device") as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      },
      fsyncSync: () => undefined,
      closeSync: () => undefined,
      renameSync: () => {
        calls.push("rename");
      },
      rmSync: () => {
        calls.push("rm");
      },
    } as unknown as Parameters<typeof writeFileAtomic>[2];
    expect(() => writeFileAtomic(path.join(sandbox(), "out.json"), "x", failingFs)).toThrow("no space left");
    expect(calls).toEqual(["rm"]); // tmp removed, rename never attempted
  });
});

describe("ConfigStore.listModels", () => {
  it("returns exactly the opencode.json providers when models.json is absent (no implicit seeding)", () => {
    const dir = seedConfigDir({ opencode: true });
    const models = new ConfigStore({ configDirOverride: dir }).listModels();

    // Dynamic: a hard-coded length breaks on every fixture change (review P2-13).
    const fixture = parseSafe<{ provider?: Record<string, { models?: Record<string, unknown> }> }>(
      readFileSync(path.join(FIXTURES_DIR, "opencode.jsonc"), "utf8"),
    );
    const fixtureIds = Object.entries(fixture.value?.provider ?? {}).flatMap(([provider, cfg]) =>
      Object.keys((cfg as { models?: Record<string, unknown> }).models ?? {}).map((model) => `${provider}/${model}`),
    );
    const expectedIds = [...new Set(fixtureIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(models.map((m) => m.id)).toEqual(expectedIds);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("WindsurfAI/claude-opus-4.6");
    expect(ids).toContain("zhipuai-coding-plan/glm-5");
    expect(new Set(ids).size).toBe(ids.length);

    const named = models.find((m) => m.id === "WindsurfAI/claude-opus-4.6");
    expect(named?.label).toBe("Claude Opus 4.6 By WindsurfAI");

    // zhipuai fixture models carry no "name" field, so label must fall back to the model key
    const unnamed = models.find((m) => m.id === "zhipuai-coding-plan/glm-5");
    expect(unnamed?.label).toBe("glm-5");
    expect(unnamed?.provider).toBe("zhipuai-coding-plan");

    // listModels is a pure read now — the network is the catalog's source of truth.
    expect(existsSync(path.join(dir, "models.json"))).toBe(false);
  });

  it("returns an empty list when both opencode.json and models.json are missing", () => {
    const dir = sandbox();
    const models = new ConfigStore({ configDirOverride: dir }).listModels();
    expect(models).toEqual([]);
    expect(existsSync(path.join(dir, "models.json"))).toBe(false);
  });
});

describe("ConfigStore.listModelEntries", () => {
  it("labels each merged entry with its source: opencode-only, local-only, or both", () => {
    const dir = seedConfigDir({ opencode: false, ohMy: false });
    writeFileSync(
      path.join(dir, "opencode.json"),
      JSON.stringify({ provider: { provA: { models: { onlyA: {}, shared: {} } } } }),
    );
    writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        models: [
          { provider: "provA", model: "shared", label: "shared" },
          { provider: "provC", model: "onlyC" },
        ],
      }),
    );

    const entries = new ConfigStore({ configDirOverride: dir }).listModelEntries();
    expect(entries.map((e) => [e.option.id, e.source])).toEqual([
      ["provA/onlyA", "opencode"],
      ["provA/shared", "both"],
      ["provC/onlyC", "local"],
    ]);
  });
});

describe("ConfigStore.defaultModel", () => {
  it("returns null when absent, then the model string after write", () => {
    const dir = seedConfigDir({ opencode: true });
    const store = new ConfigStore({ configDirOverride: dir });
    expect(store.defaultModel()).toBeNull();
    store.writeAtomic(path.join(dir, "opencode.json"), JSON.stringify({ model: "x/y" }));
    expect(store.defaultModel()).toBe("x/y");
  });
});

describe("ConfigStore.ohMyAssignments", () => {
  it("reads agents and categories from the seeded fixture", () => {
    const dir = seedConfigDir({ ohMy: true });
    const { agents, categories } = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() }).ohMyAssignments();
    expect(agents.oracle?.model).toBe("zhipuai-coding-plan/glm-5.2");
    expect(agents.oracle?.variant).toBe("high");
    expect(Object.keys(agents)).toHaveLength(10);
    expect(Object.keys(categories)).toHaveLength(13);
  });

  it("returns empty records when the file is missing", () => {
    const dir = sandbox();
    expect(new ConfigStore({ configDirOverride: dir, homeDir: sandbox() }).ohMyAssignments()).toEqual({
      agents: {},
      categories: {},
    });
  });
});

describe("ConfigStore.readTextOrEmpty", () => {
  it("returns '' for a missing file", () => {
    const dir = sandbox();
    expect(new ConfigStore({ configDirOverride: dir }).readTextOrEmpty(path.join(dir, "nope.json"))).toBe("");
  });
});

describe("ConfigStore.resolveOpencodeConfigPath", () => {
  it("prefers opencode.json, falls back to opencode.jsonc, defaults to opencode.json", () => {
    const dir = sandbox();
    const store = new ConfigStore({ configDirOverride: dir });
    expect(store.resolveOpencodeConfigPath()).toBe(path.join(dir, "opencode.json"));

    writeFileSync(path.join(dir, "opencode.jsonc"), "{}");
    expect(store.resolveOpencodeConfigPath()).toBe(path.join(dir, "opencode.jsonc"));

    writeFileSync(path.join(dir, "opencode.json"), "{}");
    expect(store.resolveOpencodeConfigPath()).toBe(path.join(dir, "opencode.json"));
  });
});

describe("ConfigStore.resolveAgentConfig", () => {
  it("prefers ~/.omo/omo.jsonc over everything else", () => {
    const configDir = seedConfigDir();
    const home = sandbox();
    mkdirSync(path.join(home, ".omo"), { recursive: true });
    writeFileSync(path.join(home, ".omo", "omo.jsonc"), "{}");

    const target = new ConfigStore({ configDirOverride: configDir, homeDir: home }).resolveAgentConfig();
    expect(target).toEqual({
      kind: "omo",
      path: path.join(home, ".omo", "omo.jsonc"),
      sectionPath: ["[opencode]"],
      reasoningKey: "reasoning",
      exists: true,
    });
  });

  it("accepts ~/.omo/omo.json as fallback basename", () => {
    const configDir = seedConfigDir();
    const home = sandbox();
    mkdirSync(path.join(home, ".omo"), { recursive: true });
    writeFileSync(path.join(home, ".omo", "omo.json"), "{}");

    const target = new ConfigStore({ configDirOverride: configDir, homeDir: home }).resolveAgentConfig();
    expect(target.kind).toBe("omo");
    expect(target.path).toBe(path.join(home, ".omo", "omo.json"));
    expect(target.exists).toBe(true);
  });

  it("matches runtime legacy order: oh-my-opencode.jsonc > oh-my-opencode.json > oh-my-openagent.jsonc > oh-my-openagent.json", () => {
    const dir = sandbox();
    const home = sandbox();
    const store = new ConfigStore({ configDirOverride: dir, homeDir: home });

    writeFileSync(path.join(dir, "oh-my-openagent.json"), "{}");
    expect(store.resolveAgentConfig().path).toBe(path.join(dir, "oh-my-openagent.json"));

    writeFileSync(path.join(dir, "oh-my-openagent.jsonc"), "{}");
    expect(store.resolveAgentConfig().path).toBe(path.join(dir, "oh-my-openagent.jsonc"));

    writeFileSync(path.join(dir, "oh-my-opencode.json"), "{}");
    expect(store.resolveAgentConfig().path).toBe(path.join(dir, "oh-my-opencode.json"));

    writeFileSync(path.join(dir, "oh-my-opencode.jsonc"), "{}");
    const target = store.resolveAgentConfig();
    expect(target).toEqual({
      kind: "legacy",
      path: path.join(dir, "oh-my-opencode.jsonc"),
      sectionPath: [],
      reasoningKey: "variant",
      exists: true,
    });
  });

  it("creates omo.jsonc when nothing exists but ~/.omo is present", () => {
    const dir = seedConfigDir({ opencode: true, ohMy: false });
    const home = sandbox();
    mkdirSync(path.join(home, ".omo"), { recursive: true });

    const target = new ConfigStore({ configDirOverride: dir, homeDir: home }).resolveAgentConfig();
    expect(target.kind).toBe("omo");
    expect(target.path).toBe(path.join(home, ".omo", "omo.jsonc"));
    expect(target.exists).toBe(false);
  });

  it("creates omo.jsonc when opencode.json registers the oh-my-openagent plugin", () => {
    const dir = sandbox();
    const home = sandbox();
    writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ plugin: ["oh-my-openagent@latest"] }));

    const target = new ConfigStore({ configDirOverride: dir, homeDir: home }).resolveAgentConfig();
    expect(target.kind).toBe("omo");
    expect(target.exists).toBe(false);
  });

  it("falls back to legacy oh-my-opencode.json when nothing hints at omo", () => {
    const dir = sandbox();
    const home = sandbox();
    writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ plugin: ["oh-my-opencode"] }));

    const target = new ConfigStore({ configDirOverride: dir, homeDir: home }).resolveAgentConfig();
    expect(target).toEqual({
      kind: "legacy",
      path: path.join(dir, "oh-my-opencode.json"),
      sectionPath: [],
      reasoningKey: "variant",
      exists: false,
    });
  });
});

describe("ConfigStore.ohMyAssignments (omo target)", () => {
  function seedOmo(text: string): { configDir: string; home: string } {
    const configDir = seedConfigDir({ opencode: true, ohMy: false });
    const home = sandbox();
    mkdirSync(path.join(home, ".omo"), { recursive: true });
    writeFileSync(path.join(home, ".omo", "omo.jsonc"), text);
    return { configDir, home };
  }

  it("reads [opencode] agents/categories, maps reasoning→variant, follows models[0] chains, skips model-less entries", () => {
    const { configDir, home } = seedOmo(`{
      "[opencode]": {
        "agents": {
          "oracle": { "model": "openai/gpt-5.6-sol", "reasoning": "high" },
          "explore": { "model": "github-copilot/grok-code-fast-1" },
          "prometheus": { "prompt_append": "no model here" },
          "chained": { "models": [{ "model": "a/b", "reasoning": "max" }, { "model": "c/d" }] }
        },
        "categories": {
          "quick": { "model": "x/y", "reasoning": "off" }
        }
      }
    }`);

    const { agents, categories } = new ConfigStore({ configDirOverride: configDir, homeDir: home }).ohMyAssignments();
    expect(agents).toEqual({
      oracle: { model: "openai/gpt-5.6-sol", variant: "high" },
      explore: { model: "github-copilot/grok-code-fast-1" },
      chained: { model: "a/b", variant: "max" },
    });
    expect(categories).toEqual({ quick: { model: "x/y", variant: "off" } });
  });

  it("falls back to shared-base agents/categories when the [opencode] block lacks them", () => {
    const { configDir, home } = seedOmo(`{
      "agents": { "oracle": { "model": "a/b", "reasoning": "low" } },
      "[opencode]": { "tmux": { "enabled": false } }
    }`);

    const { agents } = new ConfigStore({ configDirOverride: configDir, homeDir: home }).ohMyAssignments();
    expect(agents).toEqual({ oracle: { model: "a/b", variant: "low" } });
  });

  it("accepts the deprecated variant key on omo targets", () => {
    const { configDir, home } = seedOmo(`{
      "[opencode]": { "agents": { "oracle": { "model": "a/b", "variant": "xhigh" } } }
    }`);

    const { agents } = new ConfigStore({ configDirOverride: configDir, homeDir: home }).ohMyAssignments();
    expect(agents).toEqual({ oracle: { model: "a/b", variant: "xhigh" } });
  });
});

describe("ConfigStore hostile-environment tolerance", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "readTextOrEmpty returns '' for an unreadable (chmod 000) file",
    () => {
      const dir = sandbox();
      const file = path.join(dir, "opencode.json");
      writeFileSync(file, "{}");
      chmodSync(file, 0o000);
      try {
        expect(new ConfigStore({ configDirOverride: dir }).readTextOrEmpty(file)).toBe("");
      } finally {
        chmodSync(file, 0o644);
      }
    },
  );

  it("readDirTree terminates on an ancestor symlink without duplicating nodes", () => {
    const dir = seedConfigDir();
    const commandDir = path.join(dir, "command");
    mkdirSync(path.join(commandDir, "real"), { recursive: true });
    writeFileSync(path.join(commandDir, "real", "a.md"), "a");
    symlinkSync(commandDir, path.join(commandDir, "self"), process.platform === "win32" ? "junction" : "dir");

    const tree = new ConfigStore({ configDirOverride: dir }).discover().commandTree;
    expect(tree.map((e) => e.name)).toEqual(["real", "self"]);
    const self = tree.find((e) => e.name === "self");
    expect(self?.isDir).toBe(true);
    expect(self?.children).toBeUndefined(); // already visited via the real path
  });

  it("a single unreadable subdir degrades to empty instead of breaking discover()", () => {
    const dir = seedConfigDir();
    mkdirSync(path.join(dir, "command"), { recursive: true });
    writeFileSync(path.join(dir, "command", "a.md"), "a");
    const asRoot = process.getuid?.() === 0;
    if (process.platform !== "win32" && !asRoot) {
      chmodSync(path.join(dir, "command"), 0o000);
    }
    try {
      const d = new ConfigStore({ configDirOverride: dir }).discover();
      expect(Array.isArray(d.commandFiles)).toBe(true);
      if (process.platform !== "win32" && !asRoot) {
        expect(d.commandFiles).toEqual([]); // unreadable dir degrades to empty, not a crash
      } else {
        expect(d.commandFiles).toEqual(["a.md"]);
      }
      expect(d.commandDir).toBe(path.join(dir, "command"));
    } finally {
      if (process.platform !== "win32" && !asRoot) {
        chmodSync(path.join(dir, "command"), 0o755);
      }
    }
  });
});

describe("ConfigStore.setAgentModel", () => {
  it("legacy target: sets model+variant, clears the sibling reasoning key and any models chain", () => {
    const dir = seedConfigDir({ opencode: true, ohMy: true });
    const home = sandbox();
    const store = new ConfigStore({ configDirOverride: dir, homeDir: home });
    const target = path.join(dir, "oh-my-opencode.json");

    store.setAgentModel("agents", "oracle", "x/y", "high");

    const text = readFileSync(target, "utf8");
    expect(validate(text)).toEqual([]);
    expect(getValue(text, ["agents", "oracle", "model"])).toBe("x/y");
    expect(getValue(text, ["agents", "oracle", "variant"])).toBe("high");
    expect(getValue(text, ["agents", "oracle", "reasoning"])).toBeUndefined();
    expect(getValue(text, ["agents", "oracle", "models"])).toBeUndefined();
    // entries not addressed stay untouched
    expect(getValue(text, ["agents", "librarian", "model"])).toBeDefined();
  });

  it("null variant removes the reasoning key entirely on the legacy target", () => {
    const dir = seedConfigDir({ opencode: true, ohMy: true });
    const store = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() });
    const target = path.join(dir, "oh-my-opencode.json");

    store.setAgentModel("agents", "oracle", "x/y", null);

    const text = readFileSync(target, "utf8");
    expect(getValue(text, ["agents", "oracle", "model"])).toBe("x/y");
    expect(getValue(text, ["agents", "oracle", "variant"])).toBeUndefined();
  });

  it("omo target: writes reasoning inside [opencode], clears variant/models chains, keeps comments", () => {
    const dir = seedConfigDir({ opencode: true, ohMy: false });
    const home = sandbox();
    mkdirSync(path.join(home, ".omo"), { recursive: true });
    const omoPath = path.join(home, ".omo", "omo.jsonc");
    writeFileSync(
      omoPath,
      '// unified\n{\n  "[opencode]": {\n    "agents": {\n      "oracle": { "model": "old/old", "variant": "low", "models": [{ "model": "a/b" }] },\n    },\n  },\n}\n',
    );
    const store = new ConfigStore({ configDirOverride: dir, homeDir: home });

    store.setAgentModel("agents", "oracle", "x/y", "max");

    const text = readFileSync(omoPath, "utf8");
    expect(validate(text)).toEqual([]);
    expect(text).toContain("// unified");
    expect(getValue(text, ["[opencode]", "agents", "oracle"])).toEqual({ model: "x/y", reasoning: "max" });
    expect(getValue(text, ["[opencode]", "agents", "oracle", "variant"])).toBeUndefined();
    expect(getValue(text, ["[opencode]", "agents", "oracle", "models"])).toBeUndefined();
  });

  it("creates the agent config from a missing file (fresh omo machine)", () => {
    const dir = seedConfigDir({ opencode: true, ohMy: false });
    const home = sandbox();
    mkdirSync(path.join(home, ".omo"), { recursive: true });
    const store = new ConfigStore({ configDirOverride: dir, homeDir: home });

    store.setAgentModel("categories", "quick", "a/b", "low");

    const created = path.join(home, ".omo", "omo.jsonc");
    const text = readFileSync(created, "utf8");
    expect(validate(text)).toEqual([]);
    expect(getValue(text, ["[opencode]", "categories", "quick"])).toEqual({ model: "a/b", reasoning: "low" });
  });

  it("aborts with JsoncSyntaxError on a broken agent config and writes nothing", () => {
    const dir = seedConfigDir({ opencode: true, ohMy: true });
    const store = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() });
    const target = path.join(dir, "oh-my-opencode.json");
    writeFileSync(target, "{ broken");
    const before = readFileSync(target);

    expect(() => store.setAgentModel("agents", "oracle", "x/y", null)).toThrow(JsoncSyntaxError);
    expect(readFileSync(target)).toEqual(before);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "aborts with CONFIG_UNREADABLE when the agent config exists but cannot be read",
    () => {
      const dir = seedConfigDir({ opencode: true, ohMy: true });
      const store = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() });
      const target = path.join(dir, "oh-my-opencode.json");
      const before = readFileSync(target);
      chmodSync(target, 0o000);
      try {
        expect(() => store.setAgentModel("agents", "oracle", "x/y", null)).toThrow("CONFIG_UNREADABLE");
      } finally {
        chmodSync(target, 0o644);
      }
      expect(readFileSync(target)).toEqual(before);
    },
  );
});

describe("ConfigStore.setOpencodeSetting / opencodeSettingValues", () => {
  it("round-trips a value into opencode.json preserving comments, trailing commas and $schema", () => {
    const dir = sandbox();
    writeFileSync(
      path.join(dir, "opencode.json"),
      '// header\n{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "old/old",\n  "provider": {\n    "zhipuai": { "models": { "glm-5": {} }, },\n  },\n}\n',
    );
    const store = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() });

    store.setOpencodeSetting("model", "zhipuai/glm-5");

    const text = readFileSync(path.join(dir, "opencode.json"), "utf8");
    expect(validate(text)).toEqual([]);
    expect(text).toContain("// header");
    expect(text).toContain('"https://opencode.ai/config.json"');
    expect(getValue(text, ["model"])).toBe("zhipuai/glm-5");
    expect(getValue(text, ["provider", "zhipuai"])).toBeDefined();
    expect(store.opencodeSettingValues()["model"]).toBe("zhipuai/glm-5");
  });

  it("writes nested agent.build.model and reads it back", () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, "opencode.json"), "{}\n");
    const store = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() });

    store.setOpencodeSetting("agentBuildModel", "kimi/k2");

    const text = readFileSync(path.join(dir, "opencode.json"), "utf8");
    expect(getValue(text, ["agent", "build", "model"])).toBe("kimi/k2");
    expect(store.opencodeSettingValues().agentBuildModel).toBe("kimi/k2");
  });

  it("null removes the key (「未设置」)", () => {
    const dir = sandbox();
    writeFileSync(path.join(dir, "opencode.json"), '{ "model": "a/b" }\n');
    const store = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() });

    store.setOpencodeSetting("model", null);

    const text = readFileSync(path.join(dir, "opencode.json"), "utf8");
    expect(getValue(text, ["model"])).toBeUndefined();
    expect(store.opencodeSettingValues()["model"]).toBeNull();
  });

  it("creates opencode.json when the config dir has none", () => {
    const dir = sandbox();
    const store = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() });

    store.setOpencodeSetting("share", "auto");

    const created = path.join(dir, "opencode.json");
    expect(validate(readFileSync(created, "utf8"))).toEqual([]);
    expect(getValue(readFileSync(created, "utf8"), ["share"])).toBe("auto");
  });

  it("opencodeSettingValues returns all-null for a missing config (display-tolerant)", () => {
    const dir = sandbox();
    const store = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() });
    const values = store.opencodeSettingValues();
    expect(Object.values(values).every((value) => value === null)).toBe(true);
    expect(Object.keys(values).length).toBeGreaterThan(0);
  });

  it("aborts with JsoncSyntaxError on a broken opencode config and writes nothing", () => {
    const dir = sandbox();
    const target = path.join(dir, "opencode.json");
    writeFileSync(target, "{ broken");
    const store = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() });
    const before = readFileSync(target);

    expect(() => store.setOpencodeSetting("model", "a/b")).toThrow(JsoncSyntaxError);
    expect(readFileSync(target)).toEqual(before);
  });

  it("throws OPENCODE_SETTING_INVALID on an unknown key", () => {
    const dir = sandbox();
    const store = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() });
    expect(() => store.setOpencodeSetting("bogus", true)).toThrow("OPENCODE_SETTING_INVALID");
  });

  it("throws OPENCODE_SETTING_INVALID on a value failing the descriptor validation", () => {
    const dir = sandbox();
    const store = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() });
    expect(() => store.setOpencodeSetting("share", "nope")).toThrow("OPENCODE_SETTING_INVALID");
    expect(() => store.setOpencodeSetting("model", "not-a-model-id")).toThrow("OPENCODE_SETTING_INVALID");
  });
});

describe("ConfigStore.setOmoMiscSetting / omoMiscValues", () => {
  it("writes [opencode].team_mode.enabled into ~/.omo/omo.jsonc and reads it back", () => {
    const dir = sandbox();
    const home = sandbox();
    mkdirSync(path.join(home, ".omo"), { recursive: true });
    writeFileSync(path.join(home, ".omo", "omo.jsonc"), '{\n  "[opencode]": {\n    "agents": {},\n  },\n}\n');
    const store = new ConfigStore({ configDirOverride: dir, homeDir: home });

    store.setOmoMiscSetting("teamMode", true);

    const text = readFileSync(path.join(home, ".omo", "omo.jsonc"), "utf8");
    expect(validate(text)).toEqual([]);
    expect(getValue(text, ["[opencode]", "team_mode", "enabled"])).toBe(true);
    // section-scoped read: the sibling [opencode].agents block survives untouched
    expect(getValue(text, ["[opencode]", "agents"])).toEqual({});
    expect(store.omoMiscValues()).toMatchObject({ teamMode: true, telemetry: null });
  });

  it("writes the legacy top-level path on a legacy target", () => {
    const dir = seedConfigDir({ opencode: true, ohMy: true });
    const store = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() });

    store.setOmoMiscSetting("runtimeFallback", true);

    const text = readFileSync(path.join(dir, "oh-my-opencode.json"), "utf8");
    expect(getValue(text, ["runtime_fallback", "enabled"])).toBe(true);
    expect(getValue(text, ["[opencode]"])).toBeUndefined();
    expect(store.omoMiscValues()).toMatchObject({ runtimeFallback: true });
  });

  it("creates the omo target file when missing (fresh omo machine)", () => {
    const dir = sandbox();
    const home = sandbox();
    mkdirSync(path.join(home, ".omo"), { recursive: true });
    const store = new ConfigStore({ configDirOverride: dir, homeDir: home });

    store.setOmoMiscSetting("backgroundConcurrency", 0);

    const created = path.join(home, ".omo", "omo.jsonc");
    expect(validate(readFileSync(created, "utf8"))).toEqual([]);
    expect(getValue(readFileSync(created, "utf8"), ["[opencode]", "background_task", "defaultConcurrency"])).toBe(0);
  });

  it("null removes the leaf key on the omo target", () => {
    const dir = sandbox();
    const home = sandbox();
    mkdirSync(path.join(home, ".omo"), { recursive: true });
    writeFileSync(path.join(home, ".omo", "omo.jsonc"), '{ "[opencode]": { "telemetry": false } }\n');
    const store = new ConfigStore({ configDirOverride: dir, homeDir: home });

    store.setOmoMiscSetting("telemetry", null);

    const text = readFileSync(path.join(home, ".omo", "omo.jsonc"), "utf8");
    expect(getValue(text, ["[opencode]", "telemetry"])).toBeUndefined();
    expect(store.omoMiscValues().telemetry).toBeNull();
  });

  it("throws OMO_SETTING_INVALID on an unknown key or out-of-bounds value", () => {
    const dir = sandbox();
    const store = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() });
    expect(() => store.setOmoMiscSetting("bogus", true)).toThrow("OMO_SETTING_INVALID");
    expect(() => store.setOmoMiscSetting("backgroundConcurrency", 3.5)).toThrow("OMO_SETTING_INVALID");
    expect(() => store.setOmoMiscSetting("backgroundConcurrency", -1)).toThrow("OMO_SETTING_INVALID");
  });
});

describe("ConfigStore.readTextForEdit", () => {
  it("returns '' for a genuinely absent file", () => {
    const dir = sandbox();
    expect(new ConfigStore({ configDirOverride: dir }).readTextForEdit(path.join(dir, "nope.json"))).toBe("");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "throws CONFIG_UNREADABLE for an existing but unreadable file",
    () => {
      const dir = sandbox();
      const file = path.join(dir, "opencode.json");
      writeFileSync(file, "{}");
      chmodSync(file, 0o000);
      try {
        expect(() => new ConfigStore({ configDirOverride: dir }).readTextForEdit(file)).toThrow("CONFIG_UNREADABLE");
      } finally {
        chmodSync(file, 0o644);
      }
    },
  );
});
