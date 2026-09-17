import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        panel: resolve(import.meta.dirname, "panel.html"),
      },
    },
  },
});
