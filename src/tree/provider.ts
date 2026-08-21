import * as vscode from "vscode";
import type { BaseNode } from "./nodes";

export class ConfigTreeDataProvider implements vscode.TreeDataProvider<BaseNode> {
  getTreeItem(_element: BaseNode): vscode.TreeItem {
    throw new Error("NOT_IMPLEMENTED");
  }

  getChildren(_element?: BaseNode): vscode.ProviderResult<BaseNode[]> {
    throw new Error("NOT_IMPLEMENTED");
  }

  refresh(): void {
    throw new Error("NOT_IMPLEMENTED");
  }
}
