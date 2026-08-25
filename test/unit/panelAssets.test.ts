import { describe, expect, it } from "vitest";

import { rewriteWebviewAssets } from "../../src/webview/assetRewrite";

/** Deterministic stand-in for the vscode-dependent webview URI mapping. */
const assetUri = (reference: string): string => `webview://dist/${reference}`;

const CSP =
  "default-src 'none'; style-src https://webview 'unsafe-inline'; script-src https://webview 'nonce-testnonce';";

function rewrite(html: string): string {
  return rewriteWebviewAssets(html, { cspSource: "https://webview", nonce: "testnonce", assetUri });
}

describe("rewriteWebviewAssets — script tags", () => {
  it("rewrites every module script src to the webview asset URI and stamps the nonce", () => {
    const out = rewrite(
      `<head><script type="module" crossorigin src="./index.js"></script>` +
        `<script type="module" crossorigin src="./quota.js"></script></head>`,
    );
    expect(out).toContain('<script type="module" crossorigin src="webview://dist/index.js" nonce="testnonce">');
    expect(out).toContain('<script type="module" crossorigin src="webview://dist/quota.js" nonce="testnonce">');
  });

  it("collapses traversal, absolute and external references to a flat local basename (no localResourceRoots escape)", () => {
    const out = rewrite(
      `<script src="../../evil.js"></script><script src="/abs/x.js"></script>` +
        `<script src="https://cdn.example.com/payload.js"></script>`,
    );
    expect(out).toContain('src="webview://dist/evil.js" nonce="testnonce"');
    expect(out).toContain('src="webview://dist/x.js" nonce="testnonce"');
    expect(out).toContain('src="webview://dist/payload.js" nonce="testnonce"');
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
    expect(out).not.toMatch(/<script[^>]*nonce/);
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
});
