import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
      input: path.resolve(rootDir, "webview-ui/index.html"),
      output: {
        entryFileNames: "index.js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
        inlineDynamicImports: true,
      },
    },
  },
});
