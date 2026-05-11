import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const workspaceAliases = {
  "@pgxsinkit/client": fileURLToPath(new URL("../../packages/client/src/index.ts", import.meta.url)),
  "@pgxsinkit/contracts": fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)),
  "@pgxsinkit/schema": fileURLToPath(new URL("../../packages/schema/src/index.ts", import.meta.url)),
  "@pgxsinkit/sync-engine": fileURLToPath(new URL("../../packages/sync-engine/src/index.ts", import.meta.url)),
};

export default defineConfig({
  envDir: workspaceRoot,
  plugins: [react()],
  resolve: {
    alias: workspaceAliases,
  },
  optimizeDeps: {
    exclude: ["@electric-sql/pglite", ...Object.keys(workspaceAliases)],
  },
  server: {
    port: 5173,
  },
});
