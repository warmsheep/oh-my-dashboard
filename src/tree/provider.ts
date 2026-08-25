import * as vscode from "vscode";

import type {
  BackupEntry,
  DiscoveredConfig,
  JsoncError,
  ModelEntry,
  ModelSetting,
  PluginEntry,
  Preset,
} from "../core/types";
import { buildConfigTree, CURRENT_PRESET_BADGE } from "./nodes";
import type { BaseNode } from "./nodes";

export interface TreeDataSnapshot {
  discovered: DiscoveredConfig;
  presets: Preset[];
  currentPreset: string | null;
  backups: BackupEntry[];
  parseErrors: Map<string, JsoncError[]>;
  assignments?: { agents: Record<string, ModelSetting>; categories: Record<string, ModelSetting> };
  models?: ModelEntry[];
  plugins?: PluginEntry[];
}

const COLLAPSIBLE: Record<BaseNode["collapsibleState"], vscode.TreeItemCollapsibleState> = {
  none: vscode.TreeItemCollapsibleState.None,
  collapsed: vscode.TreeItemCollapsibleState.Collapsed,
  expanded: vscode.TreeItemCollapsibleState.Expanded,
};

const iconCache = new Map<string, vscode.ThemeIcon>();
function iconFor(id: string): vscode.ThemeIcon {
  let icon = iconCache.get(id);
  if (!icon) {
    icon = new vscode.ThemeIcon(id);
    iconCache.set(id, icon);
  }
  return icon;
}

function iconId(node: BaseNode): string {
  switch (node.kind) {
    case "configFile":
      return "file";
    case "agent":
      return "robot";
    case "category":
      return "package";
    case "preset":
      return node.description === CURRENT_PRESET_BADGE ? "pin" : "bookmark";
    case "captureAction":
      return "add";
    case "backup":
      return "history";
    case "guide":
      return "info";
    case "dirSummary":
      return "folder";
    case "agentsMd":
      return "book";
    case "parseError":
      return "error";
    case "configRoot":
      return "files";
    case "presetRoot":
      return "bookmark";
    case "backupRoot":
      return "history";
    case "modelRoot":
      return "circuit-board";
    case "modelProvider":
      return "server";
    case "model":
      return "symbol-misc";
    case "modelAddAction":
      return "add";
    case "pluginRoot":
      return "extensions";
    case "plugin":
      return "plug";
    case "dirEntry":
      return "folder";
    case "fileEntry":
      return "file";
  }
}

export class ConfigTreeDataProvider implements vscode.TreeDataProvider<BaseNode> {
  private cache: TreeDataSnapshot | null = null;
  private reloading: Promise<TreeDataSnapshot> | null = null;
  /** A refresh trigger arrived mid-reload — chain ONE trailing reload with fresh data. */
  private dirty = false;
  /** Root nodes memo keyed by snapshot identity — repeated root renders (view visibility
   * changes, multiple getChildren per refresh) reuse one built tree instead of rebuilding. */
  private rootNodes: { snapshot: TreeDataSnapshot; roots: BaseNode[] } | null = null;
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BaseNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly loadData: () => TreeDataSnapshot | Promise<TreeDataSnapshot>) {}

  /**
   * Stale-while-revalidate: getChildren always serves the last snapshot once loaded, so a
   * refresh can never stall rendering (the reload happens in the background and re-renders
   * only after the new snapshot lands). A trigger arriving mid-reload marks the data dirty
   * and chains exactly one trailing reload — the older burst's events are not lost.
   */
  refresh(): Promise<TreeDataSnapshot> {
    if (this.reloading) {
      this.dirty = true;
      return this.reloading;
    }
    this.reloading = Promise.resolve(this.loadData())
      .then((snapshot) => {
        this.cache = snapshot;
        this.rootNodes = null; // a new generation must rebuild roots even if the loader reuses objects
        this.reloading = null;
        const rerun = this.dirty;
        this.dirty = false;
        if (rerun) {
          void this.refresh();
        }
        this._onDidChangeTreeData.fire();
        return snapshot;
      })
      .catch((error) => {
        this.reloading = null;
        this.dirty = false;
        throw error;
      });
    return this.reloading;
  }

  /**
   * Populate the snapshot cache WITHOUT firing onDidChangeTreeData. Views that were never
   * rendered yet must not receive change events — the pending refresh would re-run on first
   * reveal and add an extra render pass to the interactive expand path. If a view already
   * rendered (race with a very fast sidebar click), its own getChildren owns the cache.
   */
  warmup(): Promise<void> {
    if (this.reloading) {
      return this.reloading.then(() => undefined);
    }
    if (this.cache !== null) {
      return Promise.resolve();
    }
    return Promise.resolve(this.loadData()).then(
      (snapshot) => {
        if (this.cache === null) {
          this.cache = snapshot;
          this.rootNodes = null;
        }
      },
      () => undefined,
    );
  }

  getTreeItem(element: BaseNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, COLLAPSIBLE[element.collapsibleState]);
    item.id = element.id;
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.contextValue = element.contextValue;
    item.iconPath = iconFor(iconId(element));
    if (element.command) {
      // Slim RPC payload: the full element (with recursive children subtrees) used to ride
      // along in every visible TreeItem; commands only consume these five scalar fields.
      item.command = {
        command: element.command,
        title: element.label,
        arguments: [
          {
            kind: element.kind,
            id: element.id,
            label: element.label,
            filePath: element.filePath,
          },
        ],
      };
    }
    return item;
  }

  async getChildren(element?: BaseNode): Promise<BaseNode[]> {
    if (element) {
      return element.children ?? [];
    }

    if (!this.cache) {
      this.cache = await this.loadData();
    }
    if (this.rootNodes?.snapshot !== this.cache) {
      this.rootNodes = {
        snapshot: this.cache,
        roots: buildConfigTree(
          this.cache.discovered,
          this.cache.presets,
          this.cache.currentPreset,
          this.cache.backups,
          this.cache.parseErrors,
          this.cache.assignments,
          this.cache.models,
          this.cache.plugins,
        ),
      };
    }
    return this.rootNodes.roots;
  }
}
