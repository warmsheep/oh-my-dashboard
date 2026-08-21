import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../../src/core/configStore";

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
  it("prefers $XDG_CONFIG_HOME/opencode when XDG_CONFIG_HOME is set", () => {
    expect(ConfigStore.resolveConfigDir({ XDG_CONFIG_HOME: "/tmp/xdg-root" }, "/home/tester")).toBe(
      path.join("/tmp/xdg-root", "opencode"),
    );
  });

  it("defaults to ~/.config/opencode on linux", () => {
    expect(ConfigStore.resolveConfigDir({}, "/home/tester", "linux")).toBe(
      path.join("/home/tester", ".config", "opencode"),
    );
  });

  it("uses ~/Library/Application Support/opencode on darwin", () => {
    expect(ConfigStore.resolveConfigDir({}, "/Users/tester", "darwin")).toBe(
      path.join("/Users/tester", "Library", "Application Support", "opencode"),
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
    writeFileSync(path.join(configDir, "AGENTS.md"), "# agents");

    const wsWithAgentsMd = sandbox();
    writeFileSync(path.join(wsWithAgentsMd, "AGENTS.md"), "# project agents");
    const wsWithoutAgentsMd = sandbox();

    const store = new ConfigStore({ configDirOverride: configDir });
    const d = store.discover([wsWithAgentsMd, wsWithoutAgentsMd]);

    expect(d.configDir).toBe(configDir);
    expect(d.opencodeJson).toBe(path.join(configDir, "opencode.json"));
    expect(d.ohMyOpencodeJson).toBe(path.join(configDir, "oh-my-opencode.json"));
    expect(d.commandDir).toBe(path.join(configDir, "command"));
    expect(d.skillsDir).toBe(path.join(configDir, "skills"));
    expect(d.presetsDir).toBe(path.join(configDir, "presets"));
    expect(d.backupsDir).toBe(path.join(configDir, "backups"));
    expect(d.commandFiles).toEqual(["x.md"]);
    expect(d.skillNames).toEqual(["one", "two"]);
    expect(d.agentsMd).toEqual([
      { scope: "global", path: path.join(configDir, "AGENTS.md"), exists: true },
      { scope: "project", path: path.join(wsWithAgentsMd, "AGENTS.md"), exists: true },
      { scope: "project", path: path.join(wsWithoutAgentsMd, "AGENTS.md"), exists: false },
    ]);
  });

  it("does not throw on an empty config dir; paths still present, arrays empty", () => {
    const dir = sandbox();
    const store = new ConfigStore({ configDirOverride: dir });
    const d = store.discover();
    expect(d.opencodeJson).toBe(path.join(dir, "opencode.json"));
    expect(d.commandFiles).toEqual([]);
    expect(d.skillNames).toEqual([]);
    expect(d.agentsMd).toEqual([{ scope: "global", path: path.join(dir, "AGENTS.md"), exists: false }]);
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

describe("ConfigStore.listModels", () => {
  it("returns exactly 24 options sorted by id from the fixture, with name/label fallback", () => {
    const dir = seedConfigDir({ opencode: true });
    const models = new ConfigStore({ configDirOverride: dir }).listModels();

    expect(models).toHaveLength(24);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("WindsurfAI/claude-opus-4.6");
    expect(ids).toContain("zhipuai-coding-plan/glm-5");
    expect(ids).toEqual([...ids].sort());

    const named = models.find((m) => m.id === "WindsurfAI/claude-opus-4.6");
    expect(named?.label).toBe("Claude Opus 4.6 By WindsurfAI");

    // zhipuai fixture models carry no "name" field, so label must fall back to the model key
    const unnamed = models.find((m) => m.id === "zhipuai-coding-plan/glm-5");
    expect(unnamed?.label).toBe("glm-5");
    expect(unnamed?.provider).toBe("zhipuai-coding-plan");
    expect(unnamed?.model).toBe("glm-5");
  });

  it("returns [] when opencode.json is missing", () => {
    const dir = sandbox();
    expect(new ConfigStore({ configDirOverride: dir }).listModels()).toEqual([]);
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
    const { agents, categories } = new ConfigStore({ configDirOverride: dir }).ohMyAssignments();
    expect(agents.oracle?.model).toBe("zhipuai-coding-plan/glm-5.2");
    expect(agents.oracle?.variant).toBe("high");
    expect(Object.keys(agents)).toHaveLength(10);
    expect(Object.keys(categories)).toHaveLength(13);
  });

  it("returns empty records when the file is missing", () => {
    const dir = sandbox();
    expect(new ConfigStore({ configDirOverride: dir }).ohMyAssignments()).toEqual({
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
