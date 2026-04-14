import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@pgxsinkit/contracts": fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
      "@pgxsinkit/client": fileURLToPath(new URL("./packages/client/src/index.ts", import.meta.url)),
      "@pgxsinkit/demo": fileURLToPath(new URL("./packages/demo/src/index.ts", import.meta.url)),
      "@pgxsinkit/server": fileURLToPath(new URL("./packages/server/src/index.ts", import.meta.url)),
      "@pgxsinkit/client/schema": fileURLToPath(new URL("./packages/client/src/schema.ts", import.meta.url)),
      "@pgxsinkit/sync-engine": fileURLToPath(new URL("./packages/sync-engine/src/index.ts", import.meta.url)),
      "@pgxsinkit/test-utils": fileURLToPath(new URL("./packages/test-utils/src/index.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/**/*.ts", "apps/write-api/src/**/*.ts"],
    },
  },
});
