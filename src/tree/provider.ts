import * as vscode from "vscode";
import type { BackupEntry, DiscoveredConfig, JsoncError, ModelSetting, Preset } from "../core/types";
import { buildConfigTree, CURRENT_PRESET_BADGE, type BaseNode } from "./nodes";

export type TreeSection = "config" | "presets" | "backups";

export interface TreeDataSnapshot {
  discovered: DiscoveredConfig;
  presets: Preset[];
  currentPreset: string | null;
  backups: BackupEntry[];
  parseErrors: Map<string, JsoncError[]>;
  assignments?: { agents: Record<string, ModelSetting>; categories: Record<string, ModelSetting> };
}

const COLLAPSIBLE: Record<BaseNode["collapsibleState"], vscode.TreeItemCollapsibleState> = {
  none: vscode.TreeItemCollapsibleState.None,
  collapsed: vscode.TreeItemCollapsibleState.Collapsed,
  expanded: vscode.TreeItemCollapsibleState.Expanded,
};

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
  }
}

export class ConfigTreeDataProvider implements vscode.TreeDataProvider<BaseNode> {
  private cache: TreeDataSnapshot | null = null;
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BaseNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly section: TreeSection,
    private readonly loadData: () => TreeDataSnapshot | Promise<TreeDataSnapshot>,
  ) {}

  refresh(): void {
    this.cache = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: BaseNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, COLLAPSIBLE[element.collapsibleState]);
    item.id = element.id;
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.contextValue = element.contextValue;
    item.iconPath = new vscode.ThemeIcon(iconId(element));
    if (element.command) {
      item.command = { command: element.command, title: element.label, arguments: [element] };
    }
    return item;
  }

  async getChildren(element?: BaseNode): Promise<BaseNode[]> {
    if (element) return element.children ?? [];

    if (!this.cache) this.cache = await this.loadData();
    const roots = buildConfigTree(
      this.cache.discovered,
      this.cache.presets,
      this.cache.currentPreset,
      this.cache.backups,
      this.cache.parseErrors,
      this.cache.assignments,
    );
    const root = this.section === "config" ? roots[0] : this.section === "presets" ? roots[1] : roots[2];
    return root?.children ?? [];
  }
}
