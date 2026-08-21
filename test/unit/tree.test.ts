import { describe, expect, it, vi } from "vitest";
import type { BackupEntry, DiscoveredConfig, JsoncError, Preset } from "../../src/core/types";
import { buildConfigTree, CURRENT_PRESET_BADGE, type BaseNode } from "../../src/tree/nodes";
import { ConfigTreeDataProvider, type TreeDataSnapshot } from "../../src/tree/provider";

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
    ohMyOpencodeJson: "/cfg/oh-my-opencode.json",
    agentsMd: [
      { scope: "global", path: "/cfg/AGENTS.md", exists: true },
      { scope: "project", path: "/work/proj-a/AGENTS.md", exists: false },
    ],
    commandDir: "/cfg/command",
    commandFiles: ["deploy.md", "git.md"],
    skillsDir: "/cfg/skills",
    skillNames: ["pdf", "xlsx"],
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
  );

  it("returns exactly three roots in order 配置文件 / 预设 / 备份, all expanded", () => {
    expect(roots.map((r) => r.label)).toEqual(["配置文件", "预设", "备份"]);
    expect(roots.map((r) => r.kind)).toEqual(["configRoot", "presetRoot", "backupRoot"]);
    expect(roots.every((r) => r.collapsibleState === "expanded")).toBe(true);
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

  it("oh-my-opencode.json node: collapsed with agent+category children, KNOWN order first", () => {
    const n = find(roots[0].children!, "config:oh-my-opencode.json");
    expect(n.label).toBe("oh-my-opencode.json");
    expect(n.collapsibleState).toBe("collapsed");

    const kids = n.children!;
    expect(kids.map((k) => k.contextValue)).toEqual(["agent", "agent", "agent", "category", "category"]);
    // hephaestus & oracle are KNOWN (in that order); zeus is an extra, sorted after.
    expect(kids.map((k) => k.id)).toEqual(["agent:hephaestus", "agent:oracle", "agent:zeus", "category:visual-engineering", "category:frontend"]);

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

  it("dirSummary rows: command/ (N) and skills/ (N) with dir tooltips", () => {
    const kids = roots[0].children!;
    expect(find(kids, "dir:command")).toMatchObject({
      label: "command/ (2)",
      tooltip: "/cfg/command",
      contextValue: "dirSummary",
      command: "opencode.openConfigFile",
      filePath: "/cfg/command",
    });
    expect(find(kids, "dir:skills")).toMatchObject({ label: "skills/ (2)", tooltip: "/cfg/skills" });
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
    expect(kids[0].description).toBe("预设 deep-work");
    expect(kids[0].contextValue).toBe("backup");
    expect(kids[0].tooltip).toContain("/cfg/backups/20260821-100000-pre-apply");
    expect(kids[0].tooltip).toContain("2");
    expect(kids[1].label).toBe("2026-08-19 09:00 手动");
    expect(kids[1].description).toBeUndefined();
  });

  it("without assignments, oh-my-opencode.json node is a childless leaf", () => {
    const roots2 = buildConfigTree(makeSnapshot().discovered, PRESETS, null, BACKUPS, new Map());
    const n = find(roots2[0].children!, "config:oh-my-opencode.json");
    expect(n.children).toBeUndefined();
    expect(n.collapsibleState).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// b. Both configs missing → guide node
// ---------------------------------------------------------------------------

describe("buildConfigTree — missing configs guide", () => {
  const roots = buildConfigTree(
    makeDiscovered({ opencodeJson: "", ohMyOpencodeJson: "" }),
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
    expect(kids.slice(1).map((k) => k.kind)).toEqual(["configFile", "configFile", "agentsMd", "agentsMd", "dirSummary", "dirSummary"]);
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
    const other = find(roots[0].children!, "config:oh-my-opencode.json");
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
    // Preset rows must NOT auto-apply on click (menus handle it) — no command.
    expect(deep.command).toBeUndefined();
    expect(balanced.command).toBeUndefined();
    expect(deep.tooltip).toContain(CURRENT_PRESET_BADGE);
    expect(deep.tooltip).toContain("2026-08-20T08:30:00.000Z");
  });

  it("backup description carries manifest.preset name", () => {
    const newest = roots[2].children![0];
    expect(newest.description).toBe("预设 deep-work");
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

// ---------------------------------------------------------------------------
// f. Unique stable ids across the whole tree
// ---------------------------------------------------------------------------

describe("buildConfigTree — id uniqueness", () => {
  it("has no duplicate ids anywhere (recursive)", () => {
    const roots = buildConfigTree(
      makeDiscovered({ opencodeJson: "", ohMyOpencodeJson: "" }),
      PRESETS,
      "deep-work",
      BACKUPS,
      new Map<string, JsoncError[]>([["/cfg/oh-my-opencode.json", [{ offset: 7, length: 1, message: "Invalid symbol" }]]]),
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
  it("returns section-filtered top-level nodes for each of the three sections", async () => {
    const snap = makeSnapshot();

    const configKids = await new ConfigTreeDataProvider("config", () => snap).getChildren();
    expect(configKids.map((k) => k.kind)).toEqual([
      "configFile",
      "configFile",
      "agentsMd",
      "agentsMd",
      "dirSummary",
      "dirSummary",
    ]);

    const presetKids = await new ConfigTreeDataProvider("presets", () => snap).getChildren();
    expect(presetKids.map((k) => k.kind)).toEqual(["captureAction", "preset", "preset"]);

    const backupKids = await new ConfigTreeDataProvider("backups", () => snap).getChildren();
    expect(backupKids.map((k) => k.kind)).toEqual(["backup", "backup"]);
  });

  it("getChildren(childNode) returns the node's children", async () => {
    const snap = makeSnapshot();
    const provider = new ConfigTreeDataProvider("config", () => snap);
    const top = (await provider.getChildren())!;
    const ohMy = find(top, "config:oh-my-opencode.json");
    const kids = await provider.getChildren(ohMy);
    expect(kids.map((k) => k.contextValue)).toEqual(["agent", "agent", "agent", "category", "category"]);
    expect(await provider.getChildren(top[0])).toEqual([]); // leaf → []
  });

  it("getTreeItem maps a preset node: collapsibleState None, no command, pin icon for current", () => {
    const snap = makeSnapshot();
    const provider = new ConfigTreeDataProvider("presets", () => snap);
    const deep = find(buildConfigTree(snap.discovered, snap.presets, snap.currentPreset, snap.backups, snap.parseErrors, snap.assignments)[1].children!, "preset:deep-work");

    const item = provider.getTreeItem(deep);
    expect(item.collapsibleState).toBe(0); // TreeItemCollapsibleState.None
    expect(item.command).toBeUndefined();
    expect(item.contextValue).toBe("preset");
    expect(item.label).toBe("deep-work");
    expect(item.description).toBe(CURRENT_PRESET_BADGE);
    expect((item.iconPath as unknown as { id: string }).id).toBe("pin");
  });

  it("getTreeItem maps a configFile node: command wiring + file icon", async () => {
    const snap = makeSnapshot();
    const provider = new ConfigTreeDataProvider("config", () => snap);
    const node = find((await provider.getChildren())!, "config:opencode.json");

    const item = provider.getTreeItem(node);
    expect(item.collapsibleState).toBe(0);
    expect(item.command?.command).toBe("opencode.openConfigFile");
    expect(item.command?.title).toBe("opencode.json");
    expect(item.command?.arguments).toEqual([node]);
    expect((item.iconPath as unknown as { id: string }).id).toBe("file");
  });

  it("maps collapsibleState strings to None/Collapsed/Expanded and guide gets info icon", () => {
    const snap = makeSnapshot({ backups: [] });
    const provider = new ConfigTreeDataProvider("backups", () => snap);
    const guide = buildConfigTree(snap.discovered, snap.presets, snap.currentPreset, [], snap.parseErrors)[2].children![0];
    const item = provider.getTreeItem(guide);
    expect(item.collapsibleState).toBe(0);
    expect((item.iconPath as unknown as { id: string }).id).toBe("info");

    const expanded = provider.getTreeItem({ kind: "configRoot", id: "x", label: "x", contextValue: "configRoot", collapsibleState: "expanded" });
    expect(expanded.collapsibleState).toBe(2); // Expanded
    const collapsed = provider.getTreeItem({ kind: "parseError", id: "y", label: "y", contextValue: "parseError", collapsibleState: "collapsed" });
    expect(collapsed.collapsibleState).toBe(1); // Collapsed
  });

  it("refresh() clears the snapshot cache so new data is reloaded", async () => {
    const snap = makeSnapshot({ backups: [] });
    let calls = 0;
    const provider = new ConfigTreeDataProvider("backups", () => {
      calls++;
      return snap;
    });

    expect((await provider.getChildren())[0].label).toBe("暂无备份");
    expect(calls).toBe(1);

    snap.backups = BACKUPS;
    await provider.getChildren();
    expect(calls).toBe(1); // cached — loadData not called again

    provider.refresh();
    const after = await provider.getChildren();
    expect(calls).toBe(2); // cache cleared → fresh loadData
    expect(after[0].kind).toBe("backup");
  });

  it("supports async loadData", async () => {
    const provider = new ConfigTreeDataProvider("presets", async () => makeSnapshot());
    const kids = await provider.getChildren();
    expect(kids[0].kind).toBe("captureAction");
  });
});
