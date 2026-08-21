import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { BUILTIN_MODELS } from "../../src/core/builtinModels";
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

    const store = new ConfigStore({ configDirOverride: configDir, homeDir: sandbox() });
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
    const store = new ConfigStore({ configDirOverride: dir, homeDir: sandbox() });
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
