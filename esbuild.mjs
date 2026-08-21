import esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// jsonc-parser's UMD build (default `main`) does runtime `require("./impl/*")`
// through its UMD factory parameter, which esbuild cannot statically trace —
// the emitted bundle then crashes at load (dist/ has no impl/ siblings).
// Prefer the ESM build (`module`) whose static imports bundle correctly.
const mainFields = ["module", "main"];

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node22",
  mainFields,
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  legalComments: "none",
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
