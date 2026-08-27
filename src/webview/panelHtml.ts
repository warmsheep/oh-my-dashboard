import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { errorMessage } from "../core/errors";
import { rewriteWebviewAssets } from "./assetRewrite";

/** Which dist-webview HTML file a panel host serves (one bundle per webview page). */
export type WebviewPage = "index.html" | "manager.html";

/**
 * Read a dist-webview HTML document. Returns undefined (after logging) when the
 * bundle is missing — the caller surfaces the "run npm run build:webview" hint.
 */
export function readWebviewHtml(
  ctx: vscode.ExtensionContext,
  page: WebviewPage,
  log: (message: string) => void,
): string | undefined {
  const htmlPath = ctx.asAbsolutePath(path.join("dist-webview", page));
  try {
    return fs.readFileSync(htmlPath, "utf8");
  } catch (error) {
    log(`webview: 无法读取 ${htmlPath}: ${errorMessage(error)}`);
    return undefined;
  }
}

/**
 * vscode shell around the pure {@link rewriteWebviewAssets}: maps every
 * (already basename-flattened) asset reference to a webview URI inside
 * dist-webview — multi-entry builds emit shared chunks like vendor.js flat
 * next to the entry files.
 */
export function buildWebviewHtml(webview: vscode.Webview, html: string, distWebviewUri: vscode.Uri): string {
  return rewriteWebviewAssets(html, {
    cspSource: webview.cspSource,
    assetUri: (basename) => webview.asWebviewUri(vscode.Uri.joinPath(distWebviewUri, basename)).toString(),
  });
}
