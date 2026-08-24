import { describe, expect, it, vi } from "vitest";

import type { BackupEntry, DiscoveredConfig, JsoncError, ModelEntry, PluginEntry, Preset } from "../../src/core/types";
import { buildConfigTree, CURRENT_PRESET_BADGE } from "../../src/tree/nodes";
import type { BaseNode } from "../../src/tree/nodes";
import { ConfigTreeDataProvider } from "../../src/tree/provider";
import type { TreeDataSnapshot } from "../../src/tree/provider";

// VSCode is not available under vitest — mock exactly the surface the provider uses.
vi.mock("vscode", () => ({
  TreeItem: class {
    constructor(
      public label?: string | { label: string },
      public collapsibleState?: number,
    ) {}
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(public id?: string) {}
  },
  EventEmitter: class {
    event = () => () => {};
    fire() {}
  },
}));

// ---------------------------------------------------------------------------
// Fixtures (inline, no fs)
// ---------------------------------------------------------------------------

function makeDiscovered(overrides: Partial<DiscoveredConfig> = {}): DiscoveredConfig {
  return {
    configDir: "/cfg",
    opencodeJson: "/cfg/opencode.json",
    agentConfig: {
      kind: "legacy",
      path: "/cfg/oh-my-opencode.json",
      sectionPath: [],
      reasoningKey: "variant",
      exists: true,
    },
    agentsMd: [
      { scope: "global", path: "/cfg/AGENTS.md", exists: true },
      { scope: "project", path: "/work/proj-a/AGENTS.md", exists: false },
    ],
    commandDir: "/cfg/command",
    commandFiles: ["deploy.md", "git.md"],
    skillLocations: [
      {
        scope: "global",
        label: "~/.agents/skills",
        dir: "/home/t/.agents/skills",
        skillNames: ["agentmail", "browser"],
        tree: [],
      },
      {
        scope: "global",
        label: "/cfg/skills",
        dir: "/cfg/skills",
        skillNames: ["pdf", "xlsx"],
        tree: [
          {
            name: "pdf",
            path: "/cfg/skills/pdf",
            isDir: true,
            children: [{ name: "SKILL.md", path: "/cfg/skills/pdf/SKILL.md", isDir: false }],
          },
        ],
      },
    ],
    commandTree: [
      { name: "deploy.md", path: "/cfg/command/deploy.md", isDir: false },
      { name: "git.md", path: "/cfg/command/git.md", isDir: false },
      {
        name: "sub",
        path: "/cfg/command/sub",
        isDir: true,
        children: [{ name: "nested.md", path: "/cfg/command/sub/nested.md", isDir: false }],
      },
    ],
    presetsDir: "/cfg/presets",
    backupsDir: "/cfg/backups",
    ...overrides,
  };
}

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    name: "balanced",
    createdAt: "2026-08-01T00:00:00.000Z",
    appliedAt: "2026-07-15T12:00:00.000Z",
    defaults: { model: null },
    agents: {},
    categories: {},
    ...overrides,
  };
}

function makeBackup(manifest: Partial<BackupEntry["manifest"]> = {}, rest: Partial<BackupEntry> = {}): BackupEntry {
  return {
    dirName: "20260819-090000-manual",
    dir: "/cfg/backups/20260819-090000-manual",
    manifest: {
      version: 1,
      reason: "manual",
      createdAt: "2026-08-19T09:00:00.000Z",
      fileCount: 3,
      machine: "devbox",
      ...manifest,
    },
    ...rest,
  };
}

const PRESETS: Preset[] = [
  makePreset({ name: "deep-work", appliedAt: "2026-08-20T08:30:00.000Z", defaults: { model: "glm-4.7" } }),
  makePreset({ name: "balanced" }),
];

const BACKUPS: BackupEntry[] = [
  // Deliberately unsorted input: newest must come first in the tree.
  makeBackup(),
  makeBackup(
    {
      reason: "pre-apply",
      preset: "deep-work",
      createdAt: "2026-08-21T10:00:00.000Z",
      fileCount: 2,
    },
    {
      dirName: "20260821-100000-pre-apply",
      dir: "/cfg/backups/20260821-100000-pre-apply",
    },
  ),
];

const ASSIGNMENTS: NonNullable<TreeDataSnapshot["assignments"]> = {
  // Insertion order intentionally scrambled; output must follow KNOWN_AGENTS first.
  agents: {
    oracle: { model: "glm-4.7", variant: "high" },
    hephaestus: { model: "claude-opus", variant: "medium" },
    zeus: { model: "glm-4.7" },
  },
  categories: {
    frontend: { model: "glm-4.7" },
    "visual-engineering": { model: "claude-opus", variant: "xhigh" },
  },
};

const MODEL_ENTRIES: ModelEntry[] = [
  {
    option: { id: "zhipuai-coding-plan/glm-5", provider: "zhipuai-coding-plan", model: "glm-5", label: "GLM-5" },
    source: "opencode",
  },
  {
    option: { id: "zhipuai-coding-plan/glm-5.3", provider: "zhipuai-coding-plan", model: "glm-5.3", label: "GLM-5.3" },
    source: "local",
  },
  {
    option: {
      id: "deepseek/deepseek-v4-flash",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
    },
    source: "both",
  },
];

const PLUGINS: PluginEntry[] = [
  {
    name: "@scope/installed",
    specifier: "@scope/installed@latest",
    kind: "npm",
    resolvedPath: "/home/t/.cache/opencode/node_modules/@scope/installed",
    version: "0.0.3",
    installed: true,
    tree: [
      {
        name: "package.json",
        path: "/home/t/.cache/opencode/node_modules/@scope/installed/package.json",
        isDir: false,
      },
      {
        name: "src",
        path: "/home/t/.cache/opencode/node_modules/@scope/installed/src",
        isDir: true,
        children: [
          {
            name: "index.ts",
            path: "/home/t/.cache/opencode/node_modules/@scope/installed/src/index.ts",
            isDir: false,
          },
        ],
      },
    ],
  },
  {
    name: "missing-pkg",
    specifier: "missing-pkg",
    kind: "npm",
    resolvedPath: "/home/t/.cache/opencode/node_modules/missing-pkg",
    installed: false,
    tree: [],
  },
  {
    name: "local.ts",
    specifier: "~/local.ts",
    kind: "path",
    resolvedPath: "/home/t/local.ts",
    installed: true,
    tree: [{ name: "local.ts", path: "/home/t/local.ts", isDir: false }],
  },
  {
    name: "gone-dir",
    specifier: "./gone-dir",
    kind: "path",
    resolvedPath: "/cfg/gone-dir",
    installed: false,
    tree: [],
  },
];

function makeSnapshot(overrides: Partial<TreeDataSnapshot> = {}): TreeDataSnapshot {
  return {
    discovered: makeDiscovered(),
    presets: PRESETS,
    currentPreset: "deep-work",
    backups: BACKUPS,
    parseErrors: new Map<string, JsoncError[]>(),
    assignments: ASSIGNMENTS,
    ...overrides,
  };
}

function find(nodes: BaseNode[], id: string): BaseNode {
  const hit = nodes.find((n) => n.id === id);
  if (!hit) throw new Error(`node not found: ${id}`);
  return hit;
}

function collectIds(nodes: BaseNode[], acc: string[] = []): string[] {
  for (const n of nodes) {
    acc.push(n.id);
    if (n.children) collectIds(n.children, acc);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// a. Full shape
// ---------------------------------------------------------------------------

describe("buildConfigTree — full shape", () => {
  const roots = buildConfigTree(
    makeSnapshot().discovered,
    PRESETS,
    "deep-work",
    BACKUPS,
    new Map<string, JsoncError[]>(),
    ASSIGNMENTS,
    MODEL_ENTRIES,
  );

  it("returns exactly five roots in order 配置 / 模板 / 备份 / 模型 / 插件, all expanded", () => {
    expect(roots.map((r) => r.label)).toEqual(["配置", "模板", "备份", "模型", "插件"]);
    expect(roots.map((r) => r.kind)).toEqual(["configRoot", "presetRoot", "backupRoot", "modelRoot", "pluginRoot"]);
    expect(roots.every((r) => r.collapsibleState === "expanded")).toBe(true);
  });

  it("model section: add action first, then providers with model children and source labels", () => {
    const kids = roots[3].children!;
    expect(kids[0].kind).toBe("modelAddAction");
    expect(kids[0].command).toBe("opencode.addModel");
    const providers = kids.slice(1);
    expect(providers.every((p) => p.kind === "modelProvider")).toBe(true);
    const zhipu = providers.find((p) => p.label === "zhipuai-coding-plan");
    expect(zhipu).toBeDefined();
    expect(zhipu!.children!.every((m) => m.kind === "model")).toBe(true);
    const fromOpencode = zhipu!.children!.find((m) => m.id === "model:zhipuai-coding-plan/glm-5");
    expect(fromOpencode?.description).toBe("opencode.json");
    expect(fromOpencode?.contextValue).toBe("modelOpencode");
    const localOnly = zhipu!.children!.find((m) => m.description === "models.json");
    expect(localOnly?.contextValue).toBe("modelLocal");
  });

  it("config section: two config files, agentsMd rows, dir summaries — in order", () => {
    const kids = roots[0].children!;
    expect(kids.map((k) => k.kind)).toEqual([
      "configFile",
      "configFile",
      "agentsMd",
      "agentsMd",
      "dirSummary",
      "dirSummary",
      "dirSummary",
    ]);
  });

  it("opencode.json node: label/tooltip/contextValue/command/filePath, leaf", () => {
    const n = find(roots[0].children!, "config:opencode.json");
    expect(n.label).toBe("opencode.json");
    expect(n.description).toBeUndefined();
    expect(n.tooltip).toBe("/cfg/opencode.json");
    expect(n.contextValue).toBe("configFile");
    expect(n.command).toBe("opencode.openConfigFile");
    expect(n.filePath).toBe("/cfg/opencode.json");
    expect(n.collapsibleState).toBe("none");
    expect(n.children).toBeUndefined();
  });

  it("agent config node shows the detected file's basename (omo.jsonc on omo machines)", () => {
    const omoRoots = buildConfigTree(
      makeDiscovered({
        agentConfig: {
          kind: "omo",
          path: "/home/t/.omo/omo.jsonc",
          sectionPath: ["[opencode]"],
          reasoningKey: "reasoning",
          exists: true,
        },
      }),
      [],
      null,
      [],
      new Map<string, JsoncError[]>(),
      ASSIGNMENTS,
    );
    const n = find(omoRoots[0].children!, "config:agentConfig");
    expect(n.label).toBe("omo.jsonc");
    expect(n.tooltip).toBe("/home/t/.omo/omo.jsonc");
    expect(n.filePath).toBe("/home/t/.omo/omo.jsonc");
  });

  it("oh-my-opencode.json node: collapsed with agent+category children, KNOWN order first", () => {
    const n = find(roots[0].children!, "config:agentConfig");
    expect(n.label).toBe("oh-my-opencode.json");
    expect(n.collapsibleState).toBe("collapsed");

    const kids = n.children!;
    expect(kids.map((k) => k.contextValue)).toEqual(["agent", "agent", "agent", "category", "category"]);
    // hephaestus & oracle are KNOWN (in that order); zeus is an extra, sorted after.
    expect(kids.map((k) => k.id)).toEqual([
      "agent:hephaestus",
      "agent:oracle",
      "agent:zeus",
      "category:visual-engineering",
      "category:frontend",
    ]);

    expect(kids[0].label).toBe("🤖 hephaestus");
    expect(kids[0].description).toBe("claude-opus · medium");
    expect(kids[1].label).toBe("🤖 oracle");
    expect(kids[1].description).toBe("glm-4.7 · high");
    expect(kids[2].description).toBe("glm-4.7");
    expect(kids[3].label).toBe("📦 visual-engineering");
    expect(kids[3].description).toBe("claude-opus · xhigh");
    expect(kids[4].label).toBe("📦 frontend");
    expect(kids.every((k) => k.collapsibleState === "none")).toBe(true);
  });

  it("agentsMd rows: global first, project with folder basename, （不存在） when missing", () => {
    const kids = roots[0].children!;
    const global = find(kids, "agentsMd:global");
    expect(global.label).toBe("AGENTS.md（全局）");
    expect(global.description).toBeUndefined();
    expect(global.contextValue).toBe("agentsMd");
    expect(global.command).toBe("opencode.openConfigFile");

    const project = kids.find((k) => k.id === "agentsMd:/work/proj-a/AGENTS.md")!;
    expect(project.label).toBe("AGENTS.md（proj-a）");
    expect(project.description).toBe("（不存在）");
  });

  it("dirSummary rows: one skills node per location — path label + 全局/项目 count description", () => {
    const kids = roots[0].children!;
    const command = find(kids, "dir:command");
    expect(command).toMatchObject({
      label: "command/ (2)",
      tooltip: "/cfg/command",
      contextValue: "dirSummary",
      collapsibleState: "collapsed",
      command: "opencode.openConfigFile",
      filePath: "/cfg/command",
    });
    const sub = find(command.children!, "dir:/cfg/command/sub");
    expect(sub.kind).toBe("dirEntry");
    expect(sub.collapsibleState).toBe("collapsed");
    const nested = find(sub.children!, "file:/cfg/command/sub/nested.md");
    expect(nested.kind).toBe("fileEntry");
    expect(nested.command).toBe("opencode.openConfigFile");
    expect(nested.filePath).toBe("/cfg/command/sub/nested.md");

    const agents = find(kids, "dir:skills:/home/t/.agents/skills");
    expect(agents).toMatchObject({
      label: "~/.agents/skills",
      description: "全局 2",
      tooltip: "/home/t/.agents/skills",
      contextValue: "dirSummary",
      collapsibleState: "none",
      command: "opencode.openConfigFile",
      filePath: "/home/t/.agents/skills",
    });

    const global = find(kids, "dir:skills:/cfg/skills");
    expect(global).toMatchObject({
      label: "/cfg/skills",
      description: "全局 2",
      tooltip: "/cfg/skills",
      collapsibleState: "collapsed",
      command: "opencode.openConfigFile",
      filePath: "/cfg/skills",
    });
    const skillFile = find(find(global.children!, "dir:/cfg/skills/pdf").children!, "file:/cfg/skills/pdf/SKILL.md");
    expect(skillFile.command).toBe("opencode.openConfigFile");
  });

  it("dirSummary rows: project skills locations get a per-folder stable id", () => {
    const projectRoots = buildConfigTree(
      makeDiscovered({
        skillLocations: [
          { scope: "global", label: "~/.agents/skills", dir: "/home/t/.agents/skills", skillNames: [], tree: [] },
          { scope: "global", label: "/cfg/skills", dir: "/cfg/skills", skillNames: [], tree: [] },
          {
            scope: "project",
            label: ".opencode/skills",
            dir: "/work/proj-a/.opencode/skills",
            skillNames: ["local-skill"],
            tree: [
              {
                name: "local-skill",
                path: "/work/proj-a/.opencode/skills/local-skill",
                isDir: true,
                children: [
                  { name: "SKILL.md", path: "/work/proj-a/.opencode/skills/local-skill/SKILL.md", isDir: false },
                ],
              },
            ],
          },
        ],
      }),
      [],
      null,
      [],
      new Map<string, JsoncError[]>(),
    );
    const kids = projectRoots[0].children!;
    const project = find(kids, "dir:skills:/work/proj-a/.opencode/skills");
    expect(project.label).toBe(".opencode/skills");
    expect(project.description).toBe("项目 1");
    expect(project.tooltip).toBe("/work/proj-a/.opencode/skills");
    expect(project.command).toBe("opencode.openConfigFile");
    expect(project.filePath).toBe("/work/proj-a/.opencode/skills");
    expect(project.collapsibleState).toBe("collapsed");
  });

  it("preset section: captureAction first, then presets sorted by name", () => {
    const kids = roots[1].children!;
    expect(kids.map((k) => k.kind)).toEqual(["captureAction", "preset", "preset"]);
    expect(kids[0]).toMatchObject({
      label: "➕ 从当前配置捕获…",
      contextValue: "captureAction",
      command: "opencode.capturePreset",
      collapsibleState: "none",
    });
    expect(kids.map((k) => k.id)).toEqual(["action:capturePreset", "preset:balanced", "preset:deep-work"]);
  });

  it("backup section: sorted newest first, label stamp + reason, preset description, dir tooltip", () => {
    const kids = roots[2].children!;
    expect(kids.map((k) => k.id)).toEqual(["backup:20260821-100000-pre-apply", "backup:20260819-090000-manual"]);
    expect(kids[0].label).toBe("2026-08-21 10:00 应用前");
    expect(kids[0].description).toBe("模板 deep-work");
    expect(kids[0].contextValue).toBe("backup");
    expect(kids[0].tooltip).toContain("/cfg/backups/20260821-100000-pre-apply");
    expect(kids[0].tooltip).toContain("2");
    expect(kids[1].label).toBe("2026-08-19 09:00 手动");
    expect(kids[1].description).toBeUndefined();
  });

  it("without assignments, oh-my-opencode.json node is a childless leaf", () => {
    const roots2 = buildConfigTree(makeSnapshot().discovered, PRESETS, null, BACKUPS, new Map());
    const n = find(roots2[0].children!, "config:agentConfig");
    expect(n.children).toBeUndefined();
    expect(n.collapsibleState).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// b. Both configs missing → guide node
// ---------------------------------------------------------------------------

describe("buildConfigTree — missing configs guide", () => {
  const roots = buildConfigTree(
    makeDiscovered({
      opencodeJson: "",
      agentConfig: { kind: "legacy", path: "", sectionPath: [], reasoningKey: "variant", exists: false },
    }),
    [],
    null,
    [],
    new Map<string, JsoncError[]>(),
  );

  it("prepends a guide node offering template creation, keeps config rows", () => {
    const kids = roots[0].children!;
    expect(kids[0]).toMatchObject({
      kind: "guide",
      label: "配置不存在，点击从模板创建",
      contextValue: "guide",
      command: "opencode.createConfig",
      collapsibleState: "none",
    });
    expect(kids.slice(1).map((k) => k.kind)).toEqual([
      "configFile",
      "configFile",
      "agentsMd",
      "agentsMd",
      "dirSummary",
      "dirSummary",
      "dirSummary",
    ]);
  });
});

// ---------------------------------------------------------------------------
// c. Parse errors → ⚠️ suffix + parseError child
// ---------------------------------------------------------------------------

describe("buildConfigTree — parse errors", () => {
  const parseErrors = new Map<string, JsoncError[]>([
    [
      "/cfg/opencode.json",
      [
        { offset: 42, length: 3, message: "Expected ':'" },
        { offset: 99, length: 1, message: "Trailing comma" },
      ],
    ],
  ]);
  const roots = buildConfigTree(makeDiscovered(), [], null, [], parseErrors);

  it("suffixes label with ⚠️, becomes collapsed, gains parseError child with errorOffsets", () => {
    const n = find(roots[0].children!, "config:opencode.json");
    expect(n.label).toBe("opencode.json ⚠️");
    expect(n.collapsibleState).toBe("collapsed");

    const pe = n.children![0];
    expect(pe.kind).toBe("parseError");
    expect(pe.contextValue).toBe("parseError");
    expect(pe.label).toContain("42");
    expect(pe.label).toContain("Expected ':'");
    expect(pe.errorOffsets).toHaveLength(2);
    expect(pe.errorOffsets![0].offset).toBe(42);
  });

  it("leaves the healthy file untouched", () => {
    const other = find(roots[0].children!, "config:agentConfig");
    expect(other.label).toBe("oh-my-opencode.json");
    expect((other.children ?? []).some((c) => c.kind === "parseError")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// d. Current preset marker + backup preset description
// ---------------------------------------------------------------------------

describe("buildConfigTree — current preset marker", () => {
  const roots = buildConfigTree(makeDiscovered(), PRESETS, "deep-work", BACKUPS, new Map());

  it("marks only the current preset with （当前）", () => {
    const kids = roots[1].children!.filter((k) => k.kind === "preset");
    const deep = find(kids, "preset:deep-work");
    const balanced = find(kids, "preset:balanced");
    expect(deep.description).toBe(CURRENT_PRESET_BADGE);
    expect(balanced.description).not.toContain("当前");
    expect(balanced.description).toBe("应用于 07-15");
    // Preset rows open the preset editor on click (safe); apply stays on menus.
    expect(deep.command).toBe("opencode.editPreset");
    expect(balanced.command).toBe("opencode.editPreset");
    expect(deep.tooltip).toContain(CURRENT_PRESET_BADGE);
    expect(deep.tooltip).toContain("2026-08-20T08:30:00.000Z");
  });

  it("named backups show `名称 · 时间`; the timestamp is display-only from createdAt", () => {
    const snap = makeSnapshot({
      backups: [
        makeBackup(
          { name: "升级前", createdAt: "2026-08-21T10:00:00.000Z", reason: "manual" },
          { dirName: "2026-08-21T10-00-00-000Z-manual", dir: "/cfg/backups/2026-08-21T10-00-00-000Z-manual" },
        ),
      ],
    });
    const kids = buildConfigTree(snap.discovered, snap.presets, snap.currentPreset, snap.backups, snap.parseErrors)[2]
      .children!;
    expect(kids[0].label).toBe("升级前 · 2026-08-21 10:00");
    expect(kids[0].id).toBe("backup:2026-08-21T10-00-00-000Z-manual");
  });

  it("backup description carries manifest.preset name", () => {
    const newest = roots[2].children![0];
    expect(newest.description).toBe("模板 deep-work");
  });
});

// ---------------------------------------------------------------------------
// e. Empty backups guide + captureAction always first
// ---------------------------------------------------------------------------

describe("buildConfigTree — empty sections", () => {
  const roots = buildConfigTree(makeDiscovered(), [], null, [], new Map());

  it("shows 「暂无备份」 guide (no command) when no backups", () => {
    const kids = roots[2].children!;
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({
      kind: "guide",
      label: "暂无备份",
      contextValue: "guide",
      collapsibleState: "none",
    });
    expect(kids[0].command).toBeUndefined();
  });

  it("keeps captureAction first even with zero presets", () => {
    const kids = roots[1].children!;
    expect(kids).toHaveLength(1);
    expect(kids[0].kind).toBe("captureAction");
  });
});

describe("buildConfigTree — hostile manifest data fallbacks", () => {
  it("backup with an invalid createdAt shows the raw ISO and sorts as the oldest (no NaN crash)", () => {
    const garbage = makeBackup(
      { createdAt: "not-a-date" },
      { dirName: "garbage-stamp", dir: "/cfg/backups/garbage-stamp" },
    );
    const fresh = makeBackup(
      { createdAt: "2026-08-21T10:00:00.000Z" },
      { dirName: "fresh-stamp", dir: "/cfg/backups/fresh-stamp" },
    );
    const tree = buildConfigTree(makeDiscovered(), [], null, [garbage, fresh], new Map());
    const kids = tree[2].children!;
    expect(kids.map((k) => k.id)).toEqual(["backup:fresh-stamp", "backup:garbage-stamp"]);
    expect(kids[1].label).toBe("not-a-date 手动"); // raw ISO passthrough, no NaN
  });

  it("backup with an unknown reason falls back to the raw reason text", () => {
    const weird = makeBackup(
      { reason: "pre-migrate" as BackupEntry["manifest"]["reason"], createdAt: "2026-08-20T10:00:00.000Z" },
      { dirName: "weird-reason", dir: "/cfg/backups/weird-reason" },
    );
    const tree = buildConfigTree(makeDiscovered(), [], null, [weird], new Map());
    expect(tree[2].children![0].label).toBe("2026-08-20 10:00 pre-migrate");
  });

  it("model section with empty or missing models contains only the add action", () => {
    for (const models of [[] as ModelEntry[], undefined]) {
      const tree = buildConfigTree(makeDiscovered(), [], null, [], new Map(), undefined, models);
      const kids = tree[3].children!;
      expect(kids).toHaveLength(1);
      expect(kids[0]).toMatchObject({ kind: "modelAddAction", label: "➕ 添加模型…", command: "opencode.addModel" });
    }
  });
});

// ---------------------------------------------------------------------------
// e2. Plugin section
// ---------------------------------------------------------------------------

describe("buildConfigTree — plugin section", () => {
  const roots = buildConfigTree(
    makeDiscovered(),
    [],
    null,
    [],
    new Map<string, JsoncError[]>(),
    undefined,
    [],
    PLUGINS,
  );

  it("pluginRoot: 插件 header clicking opens the opencode config", () => {
    const root = roots[4];
    expect(root).toMatchObject({
      kind: "pluginRoot",
      id: "root:plugins",
      label: "插件",
      tooltip: "/cfg/opencode.json",
      contextValue: "pluginRoot",
      collapsibleState: "expanded",
      command: "opencode.openConfigFile",
      filePath: "/cfg/opencode.json",
    });
  });

  it("plugin nodes: name labels, state descriptions, click does not navigate", () => {
    const kids = roots[4].children!;
    expect(kids.map((k) => k.kind)).toEqual(["plugin", "plugin", "plugin", "plugin"]);
    expect(kids.map((k) => k.label)).toEqual(["@scope/installed", "missing-pkg", "local.ts", "gone-dir"]);
    expect(kids.map((k) => k.description)).toEqual(["0.0.3", "未安装", "本地路径", "缺失"]);
    for (const kid of kids) {
      expect(kid.command).toBeUndefined();
      expect(kid.filePath).toBeUndefined();
      expect(kid.tooltip).toContain(kid.label);
      expect(kid.tooltip).toContain("\n");
    }
  });

  it("plugin nodes with trees are collapsed and expose dirEntry/fileEntry grandchildren", () => {
    const kids = roots[4].children!;
    expect(kids.map((k) => k.collapsibleState)).toEqual(["collapsed", "none", "none", "none"]);
    const installed = kids[0].children!;
    expect(installed.map((c) => c.kind)).toEqual(["fileEntry", "dirEntry"]);
    const src = installed[1];
    expect(src.command).toBeUndefined(); // dirs expand, they don't navigate
    expect(src.children![0]).toMatchObject({
      kind: "fileEntry",
      command: "opencode.openConfigFile",
      filePath: "/home/t/.cache/opencode/node_modules/@scope/installed/src/index.ts",
    });
    expect(kids[2].children).toBeUndefined(); // single-file path plugin: plain leaf row
  });

  it("shows a single guide row when no plugins are declared (also when param omitted)", () => {
    const empty = buildConfigTree(makeDiscovered(), [], null, [], new Map(), undefined, [], [])[4].children!;
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({
      kind: "guide",
      id: "guide:noPlugins",
      label: "opencode.json 中未声明插件",
      collapsibleState: "none",
    });
    expect(empty[0].command).toBeUndefined();

    const omitted = buildConfigTree(makeDiscovered(), [], null, [], new Map())[4].children!;
    expect(omitted[0].id).toBe("guide:noPlugins");
  });
});

// ---------------------------------------------------------------------------
// f. Unique stable ids across the whole tree
// ---------------------------------------------------------------------------

describe("buildConfigTree — id uniqueness", () => {
  it("has no duplicate ids anywhere (recursive)", () => {
    const roots = buildConfigTree(
      makeDiscovered({
        opencodeJson: "",
        agentConfig: { kind: "legacy", path: "", sectionPath: [], reasoningKey: "variant", exists: false },
      }),
      PRESETS,
      "deep-work",
      BACKUPS,
      new Map<string, JsoncError[]>([
        ["/cfg/oh-my-opencode.json", [{ offset: 7, length: 1, message: "Invalid symbol" }]],
      ]),
      ASSIGNMENTS,
    );
    const ids = collectIds(roots);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// g. Provider
// ---------------------------------------------------------------------------

describe("ConfigTreeDataProvider", () => {
  it("root returns the five section roots in fixed order", async () => {
    const snap = makeSnapshot();
    const provider = new ConfigTreeDataProvider(() => snap);

    const roots = await provider.getChildren();
    expect(roots.map((r) => r.kind)).toEqual(["configRoot", "presetRoot", "backupRoot", "modelRoot", "pluginRoot"]);

    const configKids = await provider.getChildren(roots[0]);
    expect(configKids.map((k) => k.kind)).toEqual([
      "configFile",
      "configFile",
      "agentsMd",
      "agentsMd",
      "dirSummary",
      "dirSummary",
      "dirSummary",
    ]);
    const presetKids = await provider.getChildren(roots[1]);
    expect(presetKids.map((k) => k.kind)).toEqual(["captureAction", "preset", "preset"]);
    const backupKids = await provider.getChildren(roots[2]);
    expect(backupKids.map((k) => k.kind)).toEqual(["backup", "backup"]);
  });

  it("getChildren(childNode) returns the node's children", async () => {
    const snap = makeSnapshot();
    const provider = new ConfigTreeDataProvider(() => snap);
    const roots = (await provider.getChildren())!;
    const configKids = await provider.getChildren(roots[0]);
    const ohMy = find(configKids, "config:agentConfig");
    const kids = await provider.getChildren(ohMy);
    expect(kids.map((k) => k.contextValue)).toEqual(["agent", "agent", "agent", "category", "category"]);
    expect(await provider.getChildren(configKids[0])).toEqual([]); // leaf → []
  });

  it("getTreeItem maps a preset node: collapsibleState None, edit command, pin icon for current", () => {
    const snap = makeSnapshot();
    const provider = new ConfigTreeDataProvider(() => snap);
    const deep = find(
      buildConfigTree(
        snap.discovered,
        snap.presets,
        snap.currentPreset,
        snap.backups,
        snap.parseErrors,
        snap.assignments,
      )[1].children!,
      "preset:deep-work",
    );

    const item = provider.getTreeItem(deep);
    expect(item.collapsibleState).toBe(0); // TreeItemCollapsibleState.None
    expect((item.command as { command: string } | undefined)?.command).toBe("opencode.editPreset");
    expect(item.contextValue).toBe("preset");
    expect(item.label).toBe("deep-work");
    expect(item.description).toBe(CURRENT_PRESET_BADGE);
    expect((item.iconPath as unknown as { id: string }).id).toBe("pin");
  });

  it("getTreeItem maps a configFile node: command wiring + file icon", async () => {
    const snap = makeSnapshot();
    const provider = new ConfigTreeDataProvider(() => snap);
    const roots = (await provider.getChildren())!;
    const node = find(await provider.getChildren(roots[0]), "config:opencode.json");

    const item = provider.getTreeItem(node);
    expect(item.collapsibleState).toBe(0);
    expect(item.command?.command).toBe("opencode.openConfigFile");
    expect(item.command?.title).toBe("opencode.json");
    // Slim RPC payload: only the scalar fields commands consume, never the children subtree.
    expect(item.command?.arguments).toEqual([
      { kind: "configFile", id: "config:opencode.json", label: "opencode.json", filePath: "/cfg/opencode.json" },
    ]);
    expect((item.iconPath as unknown as { id: string }).id).toBe("file");
  });

  it("getTreeItem maps a plugin node: plug icon, no click command", async () => {
    const snap = makeSnapshot({ plugins: PLUGINS });
    const provider = new ConfigTreeDataProvider(() => snap);
    const roots = (await provider.getChildren())!;
    const node = (await provider.getChildren(roots[4]))[0];

    const item = provider.getTreeItem(node);
    expect(item.collapsibleState).toBe(1); // Collapsed — has a file tree
    expect(item.command).toBeUndefined();
    expect((item.iconPath as unknown as { id: string }).id).toBe("plug");

    const rootItem = provider.getTreeItem(roots[4]);
    expect((rootItem.iconPath as unknown as { id: string }).id).toBe("extensions");
    expect(rootItem.command?.arguments?.[0]).toEqual({
      kind: "pluginRoot",
      id: "root:plugins",
      label: "插件",
      filePath: "/cfg/opencode.json",
    });
  });

  it("maps collapsibleState strings to None/Collapsed/Expanded and guide gets info icon", () => {
    const snap = makeSnapshot({ backups: [] });
    const provider = new ConfigTreeDataProvider(() => snap);
    const guide = buildConfigTree(snap.discovered, snap.presets, snap.currentPreset, [], snap.parseErrors)[2]
      .children![0];
    const item = provider.getTreeItem(guide);
    expect(item.collapsibleState).toBe(0);
    expect((item.iconPath as unknown as { id: string }).id).toBe("info");

    const expanded = provider.getTreeItem({
      kind: "configRoot",
      id: "x",
      label: "x",
      contextValue: "configRoot",
      collapsibleState: "expanded",
    });
    expect(expanded.collapsibleState).toBe(2); // Expanded
    const collapsed = provider.getTreeItem({
      kind: "parseError",
      id: "y",
      label: "y",
      contextValue: "parseError",
      collapsibleState: "collapsed",
    });
    expect(collapsed.collapsibleState).toBe(1); // Collapsed
  });

  it("refresh() clears the snapshot cache so new data is reloaded", async () => {
    const snap = makeSnapshot({ backups: [] });
    let calls = 0;
    const provider = new ConfigTreeDataProvider(() => {
      calls++;
      return snap;
    });

    const root = (await provider.getChildren())![2];
    expect((await provider.getChildren(root))[0].label).toBe("暂无备份");
    expect(calls).toBe(1);

    snap.backups = BACKUPS;
    await provider.getChildren(root);
    expect(calls).toBe(1); // cached — loadData not called again

    await provider.refresh();
    const after = await provider.getChildren((await provider.getChildren())![2]);
    expect(calls).toBe(2); // cache cleared → fresh loadData
    expect(after[0].kind).toBe("backup");
  });

  it("supports async loadData", async () => {
    const provider = new ConfigTreeDataProvider(async () => makeSnapshot());
    const roots = await provider.getChildren();
    const kids = await provider.getChildren(roots[1]);
    expect(kids[0].kind).toBe("captureAction");
  });
});
