import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@replay/ir": fileURLToPath(new URL("../ir/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
  },
});
