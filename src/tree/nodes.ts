import * as path from "node:path";

import { CMD } from "../constants";
import { BACKUP_REASON_LABELS, KNOWN_AGENTS, KNOWN_CATEGORIES } from "../core/types";
import type {
  BackupEntry,
  DirEntry,
  DiscoveredConfig,
  JsoncError,
  ModelEntry,
  ModelSetting,
  PluginEntry,
  Preset,
} from "../core/types";

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
  | "modelRoot"
  | "modelProvider"
  | "model"
  | "modelAddAction"
  | "pluginRoot"
  | "plugin"
  | "dirEntry"
  | "fileEntry"
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

export interface Assignments {
  agents: Record<string, ModelSetting>;
  categories: Record<string, ModelSetting>;
}

/**
 * Existence convention: frozen `DiscoveredConfig` carries no exists-flags for the two JSON
 * files, so an empty path means "missing" (the extension glue clears paths of non-existent
 * files when assembling the snapshot).
 */
function configFileNode(
  id: string,
  fileName: string,
  filePath: string,
  parseErrors: Map<string, JsoncError[]>,
): BaseNode {
  const errors = filePath ? (parseErrors.get(filePath) ?? []) : [];
  const hasErrors = errors.length > 0;
  const node: BaseNode = {
    kind: "configFile",
    id,
    label: hasErrors ? `${fileName} ⚠️` : fileName,
    tooltip: filePath || undefined,
    contextValue: "configFile",
    collapsibleState: "none",
    command: CMD.openConfigFile,
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
    ...ordered(assignments.agents, KNOWN_AGENTS).map((name) => toNode("agent", "🤖", name, assignments.agents[name])),
    ...ordered(assignments.categories, KNOWN_CATEGORIES).map((name) =>
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
      command: CMD.openConfigFile,
      filePath: entry.path,
    };
  });
}

function dirEntryNodes(entries: DirEntry[]): BaseNode[] {
  return entries.map((entry) =>
    entry.isDir
      ? {
          kind: "dirEntry" as const,
          id: `dir:${entry.path}`,
          label: entry.name,
          tooltip: entry.path,
          contextValue: "dirEntry",
          collapsibleState: "collapsed" as const,
          children: dirEntryNodes(entry.children ?? []),
        }
      : {
          kind: "fileEntry" as const,
          id: `file:${entry.path}`,
          label: entry.name,
          tooltip: entry.path,
          contextValue: "fileEntry",
          collapsibleState: "none" as const,
          command: CMD.openConfigFile,
          filePath: entry.path,
        },
  );
}

function dirSummaryNodes(d: DiscoveredConfig): BaseNode[] {
  const roots: { id: string; label: string; description?: string; dir: string; tree: DirEntry[] }[] = [
    { id: "dir:command", label: `command/ (${d.commandFiles.length})`, dir: d.commandDir, tree: d.commandTree },
    ...d.skillLocations.map((loc) => ({
      id: `dir:skills:${loc.dir}`,
      label: loc.label,
      description: `${loc.scope === "global" ? "全局" : "项目"} ${loc.skillNames.length}`,
      dir: loc.dir,
      tree: loc.tree,
    })),
  ];
  return roots.map((root) => ({
    kind: "dirSummary" as const,
    id: root.id,
    label: root.label,
    description: root.description,
    tooltip: root.dir,
    contextValue: "dirSummary",
    collapsibleState: root.tree.length > 0 ? ("collapsed" as const) : ("none" as const),
    children: dirEntryNodes(root.tree),
    command: CMD.openConfigFile,
    filePath: root.dir,
  }));
}

function pluginDescription(entry: PluginEntry): string {
  if (entry.kind === "npm") {
    if (!entry.installed) {
      return "未安装";
    }
    return entry.version ?? "已安装";
  }
  return entry.installed ? "本地路径" : "缺失";
}

function pluginNodes(plugins: PluginEntry[]): BaseNode[] {
  if (plugins.length === 0) {
    return [
      {
        kind: "guide",
        id: "guide:noPlugins",
        label: "opencode.json 中未声明插件",
        contextValue: "guide",
        collapsibleState: "none",
      },
    ];
  }
  return plugins.map((entry, index) => {
    // A path plugin pointing at one file needs no self-duplicating child.
    // Plugin rows never navigate on click (no file window); only fileEntry rows inside do.
    const selfFile = entry.tree.length === 1 && entry.tree[0].path === entry.resolvedPath;
    return {
      kind: "plugin" as const,
      id: `plugin:${index}`,
      label: entry.name,
      description: pluginDescription(entry),
      tooltip: `${entry.specifier}\n${entry.resolvedPath}`,
      contextValue: "plugin",
      collapsibleState: entry.tree.length > 0 && !selfFile ? ("collapsed" as const) : ("none" as const),
      children: selfFile ? undefined : dirEntryNodes(entry.tree),
    };
  });
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
  if (!dt) {
    return iso;
  }
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())} ${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}`;
}

function formatAppliedStamp(iso: string): string {
  const dt = toDate(iso);
  if (!dt) {
    return iso;
  }
  return `${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

const MODEL_SOURCE_LABELS: Record<ModelEntry["source"], string> = {
  opencode: "opencode.json",
  local: "models.json",
  both: "opencode.json + models.json",
};

function modelNodes(models: ModelEntry[]): BaseNode[] {
  const byProvider = new Map<string, ModelEntry[]>();
  for (const entry of models) {
    const list = byProvider.get(entry.option.provider) ?? [];
    list.push(entry);
    byProvider.set(entry.option.provider, list);
  }
  const providerNames = [...byProvider.keys()].sort((a, b) => a.localeCompare(b));
  return providerNames.map((provider) => {
    const entries = byProvider.get(provider) ?? [];
    return {
      kind: "modelProvider" as const,
      id: `modelProvider:${provider}`,
      label: provider,
      description: `（${entries.length}）`,
      contextValue: "modelProvider",
      collapsibleState: "collapsed" as const,
      children: entries.map((entry) => ({
        kind: "model" as const,
        id: `model:${entry.option.id}`,
        label: `${entry.option.label}（${entry.option.id}）`,
        description: MODEL_SOURCE_LABELS[entry.source],
        tooltip: `${entry.option.id} — 来源: ${MODEL_SOURCE_LABELS[entry.source]}`,
        contextValue: entry.source === "opencode" ? "modelOpencode" : "modelLocal",
        collapsibleState: "none" as const,
      })),
    };
  });
}

/**
 * Pure builder for the OpenCode Config Manager sidebar tree.
 *
 * @param assignments Optional model assignments read from the detected agent config
 *   (omo.jsonc / oh-my-opencode.json...). When provided, the agent-config node gets
 *   agent/category children (KNOWN order first, extras alphabetical); when absent it stays a leaf.
 *   A config file counts as missing when its path is empty (see existence convention above).
 * @param plugins Optional plugin entries from opencode.json's plugin array; when absent or
 *   empty the plugins section shows a single guide row.
 */
export function buildConfigTree(
  d: DiscoveredConfig,
  presets: Preset[],
  currentPreset: string | null,
  backups: BackupEntry[],
  parseErrors: Map<string, JsoncError[]>,
  assignments?: Assignments,
  models?: ModelEntry[],
  plugins?: PluginEntry[],
): BaseNode[] {
  const agentConfigPath = d.agentConfig.path;
  const ohMy = configFileNode(
    "config:agentConfig",
    agentConfigPath ? path.basename(agentConfigPath) : "oh-my-opencode.json",
    agentConfigPath,
    parseErrors,
  );
  if (assignments) {
    ohMy.children = [...(ohMy.children ?? []), ...assignmentNodes(assignments)];
    if (ohMy.children.length > 0) {
      ohMy.collapsibleState = "collapsed";
    }
  }

  const configChildren: BaseNode[] = [
    configFileNode("config:opencode.json", "opencode.json", d.opencodeJson, parseErrors),
    ohMy,
    ...agentsMdNodes(d),
    ...dirSummaryNodes(d),
  ];
  if (!d.opencodeJson && !d.agentConfig.path) {
    configChildren.unshift({
      kind: "guide",
      id: "guide:createConfig",
      label: "配置不存在，点击从模板创建",
      contextValue: "guide",
      collapsibleState: "none",
      command: CMD.createConfig,
    });
  }

  const presetChildren: BaseNode[] = [
    {
      kind: "captureAction",
      id: "action:capturePreset",
      label: "➕ 从当前配置捕获…",
      contextValue: "captureAction",
      collapsibleState: "none",
      command: CMD.capturePreset,
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
          command: CMD.editPreset,
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
            // The timestamp is display-only (from manifest.createdAt); the dir keeps its id.
            label: b.manifest.name
              ? `${b.manifest.name} · ${formatBackupStamp(b.manifest.createdAt)}`
              : `${formatBackupStamp(b.manifest.createdAt)} ${BACKUP_REASON_LABELS[b.manifest.reason] ?? b.manifest.reason}`,
            description: b.manifest.preset ? `模板 ${b.manifest.preset}` : undefined,
            tooltip: `${b.dir}（${b.manifest.fileCount} 个文件）`,
            contextValue: "backup",
            collapsibleState: "none",
            filePath: b.dir,
          }));

  const modelChildren: BaseNode[] = [
    {
      kind: "modelAddAction",
      id: "action:addModel",
      label: "➕ 添加模型…",
      contextValue: "modelAddAction",
      collapsibleState: "none",
      command: CMD.addModel,
    },
    ...modelNodes(models ?? []),
  ];

  return [
    {
      kind: "configRoot",
      id: "root:config",
      label: "配置",
      tooltip: d.configDir,
      contextValue: "configRoot",
      collapsibleState: "expanded",
      children: configChildren,
    },
    {
      kind: "presetRoot",
      id: "root:presets",
      label: "模板",
      contextValue: "presetRoot",
      collapsibleState: "expanded",
      children: presetChildren,
    },
    {
      kind: "backupRoot",
      id: "root:backups",
      label: "备份",
      contextValue: "backupRoot",
      collapsibleState: "expanded",
      children: backupChildren,
    },
    {
      kind: "modelRoot",
      id: "root:models",
      label: "模型",
      contextValue: "modelRoot",
      collapsibleState: "expanded",
      children: modelChildren,
    },
    {
      kind: "pluginRoot",
      id: "root:plugins",
      label: "插件",
      tooltip: d.opencodeJson || undefined,
      contextValue: "pluginRoot",
      collapsibleState: "expanded",
      children: pluginNodes(plugins ?? []),
      command: CMD.openConfigFile,
      filePath: d.opencodeJson || undefined,
    },
  ];
}
