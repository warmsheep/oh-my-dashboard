import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

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
      // Two standalone webview pages: the preset matrix editor and the merged
      // manager page (额度 + 设置 tabs).
      input: {
        index: path.resolve(rootDir, "webview-ui/index.html"),
        manager: path.resolve(rootDir, "webview-ui/manager.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: (assetInfo) => {
          const isCss =
            assetInfo.names.some((n) => n.endsWith(".css")) ||
            assetInfo.originalFileNames.some((f) => f.endsWith(".css"));
          return isCss ? "[name].css" : "[name].[ext]";
        },
        // react/react-dom shared by both entries land in one deterministic vendor chunk
        // (auto-naming would still work but stays guesswork; this is stable).
        manualChunks: (id) => (id.includes("node_modules") ? "vendor" : undefined),
      },
    },
  },
});
