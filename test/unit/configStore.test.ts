import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { BUILTIN_MODELS } from "../../src/core/builtinModels";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore, writeFileAtomic } from "../../src/core/configStore";

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
    expect(ConfigStore.resolveConfigDir({}, "/home/tester")).toBe(
      path.join("/home/tester", ".config", "opencode"),
    );
    expect(ConfigStore.resolveConfigDir({}, "/Users/tester")).toBe(
      path.join("/Users/tester", ".config", "opencode"),
    );
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
    expect(d.ohMyOpencodeJson).toBe(path.join(configDir, "oh-my-opencode.json"));
    expect(d.commandDir).toBe(path.join(configDir, "command"));
    expect(d.presetsDir).toBe(path.join(configDir, "presets"));
    expect(d.backupsDir).toBe(path.join(configDir, "backups"));
    expect(d.commandFiles).toEqual(["x.md"]);
    // Only skills dirs that exist on disk are reported; home-level candidates all carry the global scope.
    expect(
      d.skillLocations.map((l) => ({ scope: l.scope, label: l.label, dir: l.dir, skillNames: l.skillNames })),
    ).toEqual([
      { scope: "global", label: configDir + path.sep + "skills", dir: path.join(configDir, "skills"), skillNames: ["one", "two"] },
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
    expect(d.skillLocations.map((l) => l.skillNames.flat())).toEqual([["a"], ["b"], ["j"], ["h"], ["i"], ["d"], ["e"], ["f"], ["g"], ["c"]].map((n) => n));
  });

  it("honors XDG_CONFIG_HOME for the XDG-style global skills candidates", () => {
    const configDir = seedConfigDir();
    const home = sandbox();
    const xdg = sandbox();
    mkdirSync(path.join(xdg, "agents", "skills", "amp-skill"), { recursive: true });
    writeFileSync(path.join(xdg, "agents", "skills", "amp-skill", "SKILL.md"), "# amp");

    const d = new ConfigStore({ configDirOverride: configDir, homeDir: home, env: { XDG_CONFIG_HOME: xdg } }).discover();

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

  it("discovers project skills from every common project dir in candidate order", () => {
    const configDir = seedConfigDir();
    const home = sandbox();
    const ws = sandbox();
    for (const rel of [".agents/skills", ".claude/skills", ".opencode/skills", ".github/skills", ".gemini/skills", ".cursor/skills", ".windsurf/skills"]) {
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
  it("merges opencode.json providers with the local builtin catalog, deduplicated by id", () => {
    const dir = seedConfigDir({ opencode: true });
    const models = new ConfigStore({ configDirOverride: dir }).listModels();

    expect(models).toHaveLength(74);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("WindsurfAI/claude-opus-4.6");
    expect(ids).toContain("zhipuai-coding-plan/glm-5");
    expect(ids).toContain("xai/grok-4.6");
    expect(ids).toContain("google/gemini-3.7-flash");
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);

    const named = models.find((m) => m.id === "WindsurfAI/claude-opus-4.6");
    expect(named?.label).toBe("Claude Opus 4.6 By WindsurfAI");

    // zhipuai fixture models carry no "name" field, so label must fall back to the model key
    const unnamed = models.find((m) => m.id === "zhipuai-coding-plan/glm-5");
    expect(unnamed?.label).toBe("glm-5");
    expect(unnamed?.provider).toBe("zhipuai-coding-plan");

    expect(existsSync(path.join(dir, "models.json"))).toBe(true);
  });

  it("falls back to the builtin catalog (via models.json) when opencode.json is missing", () => {
    const dir = sandbox();
    const models = new ConfigStore({ configDirOverride: dir }).listModels();
    expect(models.length).toBe(BUILTIN_MODELS.length);
    expect(models.map((m) => m.id)).toContain("anthropic/claude-opus-5");
    expect(existsSync(path.join(dir, "models.json"))).toBe(true);
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

describe("ConfigStore.readText / readTextOrEmpty", () => {
  it("readText throws on missing file; readTextOrEmpty returns ''", () => {
    const dir = sandbox();
    const store = new ConfigStore({ configDirOverride: dir });
    const missing = path.join(dir, "nope.json");
    expect(() => store.readText(missing)).toThrow();
    expect(store.readTextOrEmpty(missing)).toBe("");
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
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("readTextOrEmpty returns '' for an unreadable (chmod 000) file", () => {
    const dir = sandbox();
    const file = path.join(dir, "opencode.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o000);
    try {
      expect(new ConfigStore({ configDirOverride: dir }).readTextOrEmpty(file)).toBe("");
    } finally {
      chmodSync(file, 0o644);
    }
  });

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
