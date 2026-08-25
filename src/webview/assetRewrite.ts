import * as path from "node:path";

/**
 * Pure asset/CSP rewrite for webview panel HTML (vscode-free so root vitest can
 * cover the security-relevant regexes directly). The vscode-dependent URI mapping
 * is injected as a callback — see panelHtml.ts for the shell.
 */

export interface RewriteOptions {
  /** CSP source of the target webview (panel.webview.cspSource). */
  cspSource: string;
  /** Maps an ALREADY-FLATTENED asset basename to a loadable webview URI. */
  assetUri(basename: string): string;
}

/**
 * Prepare a built webview HTML document: rewrite EVERY asset reference (script
 * src, stylesheet and modulepreload link href) to `assetUri(<basename>)`, and
 * inject the CSP meta tag as the first <head> child (prepended for head-less
 * documents). References are flattened with path.basename HERE — traversal
 * (`../../x`), absolute paths and external URLs collapse to a local basename so
 * they can never escape the panel's localResourceRoots, independent of the
 * injected URI mapper.
 *
 * CSP note: script-src is deliberately a bare source allowlist with NO nonce —
 * bundler entries are ES modules whose runtime `import` requests carry no nonce,
 * and on VSCode-web / code-server (service-worker-proxied webview resources) a
 * nonce-augmented CSP blocks those imports so the page never boots (observed as
 * 额度面板初始化超时 with 0.22.1 on code-server). Do not re-add nonces here.
 */
export function rewriteWebviewAssets(html: string, opts: RewriteOptions): string {
  const csp = `default-src 'none'; style-src ${opts.cspSource} 'unsafe-inline'; script-src ${opts.cspSource};`;
  let out = html.replace(
    /(<script[^>]*?\ssrc=["'])([^"']+)(["'])/gi,
    (_match, before: string, src: string, after: string) => `${before}${opts.assetUri(path.basename(src))}${after}`,
  );
  out = out.replace(
    /(<link[^>]*?\shref=["'])([^"']+\.(?:css|js))(["'])/gi,
    (_match, before: string, href: string, after: string) => `${before}${opts.assetUri(path.basename(href))}${after}`,
  );
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (/<head[^>]*>/i.test(out)) {
    return out.replace(/<head([^>]*)>/i, `<head$1>\n    ${meta}`);
  }
  return `${meta}\n${out}`;
}
