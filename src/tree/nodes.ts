import * as path from "node:path";
import type { BackupEntry, DiscoveredConfig, JsoncError, ModelSetting, Preset } from "../core/types";

export type NodeKind =
  | "configRoot"
  | "configFile"
  | "agent"
  | "category"
  | "agentsMd"
  | "dirSummary"
  | "presetRoot"
  | "preset"
  | "captureAction"
  | "backupRoot"
  | "backup"
  | "guide"
  | "parseError";

export interface BaseNode {
  kind: NodeKind;
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  contextValue: string;
  collapsibleState: "none" | "collapsed" | "expanded";
  children?: BaseNode[];
  filePath?: string;
  errorOffsets?: JsoncError[];
  /** VSCode command id executed on row click; the command handler receives this node as arguments[0]. */
  command?: string;
}

/** Description badge marking the currently applied preset (also used to pick its pin icon). */
export const CURRENT_PRESET_BADGE = "（当前）";

// Mirrors of KNOWN_AGENTS / KNOWN_CATEGORIES from src/core/types.ts. The tree layer may only
// import types from src/core, so the canonical ordering lists are duplicated here.
// KEEP IN SYNC with src/core/types.ts.
const KNOWN_AGENT_ORDER: readonly string[] = [
  "hephaestus",
  "oracle",
  "librarian",
  "explore",
  "multimodal-looker",
  "prometheus",
  "metis",
  "momus",
  "atlas",
  "sisyphus",
];

const KNOWN_CATEGORY_ORDER: readonly string[] = [
  "visual-engineering",
  "ultrabrain",
  "deep",
  "artistry",
  "quick",
  "unspecified-low",
  "unspecified-high",
  "writing",
  "architect",
  "backend",
  "frontend",
  "qa",
  "product",
];

export interface Assignments {
  agents: Record<string, ModelSetting>;
  categories: Record<string, ModelSetting>;
}

/**
 * Existence convention: frozen `DiscoveredConfig` carries no exists-flags for the two JSON
 * files, so an empty path means "missing" (the extension glue clears paths of non-existent
 * files when assembling the snapshot).
 */
function configFileNode(id: string, fileName: string, filePath: string, parseErrors: Map<string, JsoncError[]>): BaseNode {
  const errors = filePath ? (parseErrors.get(filePath) ?? []) : [];
  const hasErrors = errors.length > 0;
  const node: BaseNode = {
    kind: "configFile",
    id,
    label: hasErrors ? `${fileName} ⚠️` : fileName,
    tooltip: filePath || undefined,
    contextValue: "configFile",
    collapsibleState: "none",
    command: "opencode.openConfigFile",
    filePath: filePath || undefined,
  };
  if (hasErrors) {
    node.collapsibleState = "collapsed";
    node.children = [
      {
        kind: "parseError",
        id: `parseError:${fileName}`,
        label: `解析错误：偏移 ${errors[0].offset} — ${errors[0].message}`,
        description: `共 ${errors.length} 处错误`,
        contextValue: "parseError",
        collapsibleState: "none",
        errorOffsets: errors,
      },
    ];
  }
  return node;
}

function assignmentNodes(assignments: Assignments): BaseNode[] {
  const ordered = (record: Record<string, ModelSetting>, known: readonly string[]): string[] => {
    const keys = Object.keys(record);
    const knownHits = known.filter((k) => keys.includes(k));
    const extras = keys.filter((k) => !known.includes(k)).sort((a, b) => a.localeCompare(b));
    return [...knownHits, ...extras];
  };

  const toNode = (kind: "agent" | "category", icon: string, name: string, setting: ModelSetting): BaseNode => ({
    kind,
    id: `${kind}:${name}`,
    label: `${icon} ${name}`,
    description: setting.variant ? `${setting.model} · ${setting.variant}` : setting.model,
    tooltip: name,
    contextValue: kind,
    collapsibleState: "none",
  });

  return [
    ...ordered(assignments.agents, KNOWN_AGENT_ORDER).map((name) => toNode("agent", "🤖", name, assignments.agents[name])),
    ...ordered(assignments.categories, KNOWN_CATEGORY_ORDER).map((name) =>
      toNode("category", "📦", name, assignments.categories[name]),
    ),
  ];
}

function agentsMdNodes(d: DiscoveredConfig): BaseNode[] {
  return d.agentsMd.map((entry) => {
    const isGlobal = entry.scope === "global";
    return {
      kind: "agentsMd" as const,
      id: isGlobal ? "agentsMd:global" : `agentsMd:${entry.path}`,
      label: isGlobal ? "AGENTS.md（全局）" : `AGENTS.md（${path.basename(path.dirname(entry.path))}）`,
      description: entry.exists ? undefined : "（不存在）",
      tooltip: entry.path,
      contextValue: "agentsMd",
      collapsibleState: "none" as const,
      command: "opencode.openConfigFile",
      filePath: entry.path,
    };
  });
}

function dirSummaryNodes(d: DiscoveredConfig): BaseNode[] {
  return [
    {
      kind: "dirSummary",
      id: "dir:command",
      label: `command/ (${d.commandFiles.length})`,
      tooltip: d.commandDir,
      contextValue: "dirSummary",
      collapsibleState: "none",
      command: "opencode.openConfigFile",
      filePath: d.commandDir,
    },
    {
      kind: "dirSummary",
      id: "dir:skills",
      label: `skills/ (${d.skillNames.length})`,
      tooltip: d.skillsDir,
      contextValue: "dirSummary",
      collapsibleState: "none",
      command: "opencode.openConfigFile",
      filePath: d.skillsDir,
    },
  ];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toDate(iso: string): Date | null {
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function formatBackupStamp(iso: string): string {
  const dt = toDate(iso);
  if (!dt) return iso;
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())} ${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}`;
}

function formatAppliedStamp(iso: string): string {
  const dt = toDate(iso);
  if (!dt) return iso;
  return `${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

const BACKUP_REASON_LABELS: Record<string, string> = {
  manual: "手动",
  "pre-apply": "应用前",
  "pre-save": "保存前",
  "pre-restore": "恢复前",
};

/**
 * Pure builder for the OpenCode Config Manager sidebar tree.
 *
 * @param assignments Optional model assignments read from oh-my-opencode.json. When provided,
 *   the oh-my-opencode.json node gets agent/category children (KNOWN order first, extras
 *   alphabetical); when absent it stays a leaf. Injecting content keeps this function pure.
 *   A config file counts as missing when its path is empty (see existence convention above).
 */
export function buildConfigTree(
  d: DiscoveredConfig,
  presets: Preset[],
  currentPreset: string | null,
  backups: BackupEntry[],
  parseErrors: Map<string, JsoncError[]>,
  assignments?: Assignments,
): BaseNode[] {
  const ohMy = configFileNode("config:oh-my-opencode.json", "oh-my-opencode.json", d.ohMyOpencodeJson, parseErrors);
  const assignmentChildren = assignments ? assignmentNodes(assignments) : [];
  if (assignments) {
    ohMy.children = [...(ohMy.children ?? []), ...assignmentChildren];
    if (ohMy.children.length > 0) ohMy.collapsibleState = "collapsed";
  }

  const configChildren: BaseNode[] = [
    configFileNode("config:opencode.json", "opencode.json", d.opencodeJson, parseErrors),
    ohMy,
    ...agentsMdNodes(d),
    ...dirSummaryNodes(d),
  ];
  if (!d.opencodeJson && !d.ohMyOpencodeJson) {
    configChildren.unshift({
      kind: "guide",
      id: "guide:createConfig",
      label: "配置不存在，点击从模板创建",
      contextValue: "guide",
      collapsibleState: "none",
      command: "opencode.createConfig",
    });
  }

  const presetChildren: BaseNode[] = [
    {
      kind: "captureAction",
      id: "action:capturePreset",
      label: "➕ 从当前配置捕获…",
      contextValue: "captureAction",
      collapsibleState: "none",
      command: "opencode.capturePreset",
    },
    ...[...presets]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p): BaseNode => {
        const isCurrent = p.name === currentPreset;
        const description = isCurrent
          ? CURRENT_PRESET_BADGE
          : p.appliedAt
            ? `应用于 ${formatAppliedStamp(p.appliedAt)}`
            : undefined;
        const tooltip = [description, p.appliedAt ?? undefined].filter(Boolean).join("\n") || undefined;
        return {
          kind: "preset",
          id: `preset:${p.name}`,
          label: p.name,
          description,
          tooltip,
          contextValue: "preset",
          collapsibleState: "none",
        };
      }),
  ];

  const backupChildren: BaseNode[] =
    backups.length === 0
      ? [
          {
            kind: "guide",
            id: "guide:noBackups",
            label: "暂无备份",
            contextValue: "guide",
            collapsibleState: "none",
          },
        ]
      : [...backups]
          .sort((a, b) => {
            const ta = toDate(a.manifest.createdAt)?.getTime() ?? 0;
            const tb = toDate(b.manifest.createdAt)?.getTime() ?? 0;
            return tb - ta;
          })
          .map((b): BaseNode => ({
            kind: "backup",
            id: `backup:${b.dirName}`,
            label: `${formatBackupStamp(b.manifest.createdAt)} ${BACKUP_REASON_LABELS[b.manifest.reason] ?? b.manifest.reason}`,
            description: b.manifest.preset ? `预设 ${b.manifest.preset}` : undefined,
            tooltip: `${b.dir}（${b.manifest.fileCount} 个文件）`,
            contextValue: "backup",
            collapsibleState: "none",
            filePath: b.dir,
          }));

  return [
    { kind: "configRoot", id: "root:config", label: "配置文件", tooltip: d.configDir, contextValue: "configRoot", collapsibleState: "expanded", children: configChildren },
    { kind: "presetRoot", id: "root:presets", label: "预设", contextValue: "presetRoot", collapsibleState: "expanded", children: presetChildren },
    { kind: "backupRoot", id: "root:backups", label: "备份", contextValue: "backupRoot", collapsibleState: "expanded", children: backupChildren },
  ];
}
