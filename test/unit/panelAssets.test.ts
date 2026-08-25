import { describe, expect, it } from "vitest";

import { rewriteWebviewAssets } from "../../src/webview/assetRewrite";

/** Deterministic stand-in for the vscode-dependent webview URI mapping. */
const assetUri = (reference: string): string => `webview://dist/${reference}`;

const CSP = "default-src 'none'; style-src https://webview 'unsafe-inline'; script-src https://webview;";

function rewrite(html: string): string {
  return rewriteWebviewAssets(html, { cspSource: "https://webview", assetUri });
}

describe("rewriteWebviewAssets — script tags", () => {
  it("rewrites every module script src to the webview asset URI", () => {
    const out = rewrite(
      `<head><script type="module" crossorigin src="./index.js"></script>` +
        `<script type="module" crossorigin src="./quota.js"></script></head>`,
    );
    expect(out).toContain('<script type="module" crossorigin src="webview://dist/index.js">');
    expect(out).toContain('<script type="module" crossorigin src="webview://dist/quota.js">');
  });

  it("collapses traversal, absolute and external references to a flat local basename (no localResourceRoots escape)", () => {
    const out = rewrite(
      `<script src="../../evil.js"></script><script src="/abs/x.js"></script>` +
        `<script src="https://cdn.example.com/payload.js"></script>`,
    );
    expect(out).toContain('src="webview://dist/evil.js"');
    expect(out).toContain('src="webview://dist/x.js"');
    expect(out).toContain('src="webview://dist/payload.js"');
    expect(out).not.toContain("..");
    expect(out).not.toContain("https://cdn.example.com");
  });

  it("does not rewrite data-src style attributes (only a standalone src attribute matches)", () => {
    const out = rewrite(`<script data-src="./keep.js"></script>`);
    expect(out).toContain('data-src="./keep.js"');
  });

  it("leaves inline scripts untouched (CSP still blocks them)", () => {
    const out = rewrite(`<script>window.alert(1)</script>`);
    expect(out).toContain(`<script>window.alert(1)</script>`);
  });
});

describe("rewriteWebviewAssets — link tags", () => {
  it("rewrites stylesheet and modulepreload links (css and js hrefs)", () => {
    const out = rewrite(
      `<head><link rel="stylesheet" crossorigin href="./vscode.css">` +
        `<link rel="modulepreload" crossorigin href="./vendor.js"></head>`,
    );
    expect(out).toContain('href="webview://dist/vscode.css"');
    expect(out).toContain('href="webview://dist/vendor.js"');
  });

  it("ignores non-asset hrefs such as icons or external pages", () => {
    const out = rewrite(`<head><link rel="icon" href="./favicon.png"><link rel="canonical" href="https://x/y"></head>`);
    expect(out).toContain('href="./favicon.png"');
    expect(out).toContain('href="https://x/y"');
  });
});

describe("rewriteWebviewAssets — CSP injection", () => {
  it("injects the CSP meta as the first child of <head> when present", () => {
    const out = rewrite(`<html><head><title>t</title></head><body></body></html>`);
    expect(out).toMatch(
      new RegExp(`<head>\\s*<meta http-equiv="Content-Security-Policy" content="${CSP.replace(/[/\\]/g, "\\$&")}">`),
    );
  });

  it("prepends the CSP meta when the document has no <head>", () => {
    const out = rewrite(`<body></body>`);
    expect(out.startsWith(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`)).toBe(true);
  });

  it("keeps script-src a bare source allowlist — no nonce (nonces break ES-module imports on code-server)", () => {
    const out = rewrite(`<head><script type="module" src="./quota.js"></script></head>`);
    expect(out).not.toMatch(/nonce/i);
  });
});
