import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
);

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: {
      "@shared": path.resolve(rootDir, "src/shared"),
    },
  },
  build: {
    outDir: "build",
    assetsDir: "./",
    rollupOptions: {
      input: path.resolve(rootDir, "webview-ui/index.html"),
      output: {
        entryFileNames: "index.js",
        chunkFileNames: "[name].js",
        assetFileNames: (assetInfo) => {
          const isCss =
            assetInfo.names.some((n) => n.endsWith(".css")) ||
            assetInfo.originalFileNames.some((f) => f.endsWith(".css"));
          return isCss ? "main.css" : "[name].[ext]";
        },
        inlineDynamicImports: true,
      },
    },
  },
});
