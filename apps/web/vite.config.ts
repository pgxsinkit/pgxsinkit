import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const workspaceAliases = {
  "@pgxsinkit/client": fileURLToPath(new URL("../../packages/client/src/index.ts", import.meta.url)),
  "@pgxsinkit/contracts": fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)),
  "@pgxsinkit/pglite-sync": fileURLToPath(new URL("../../packages/pglite-sync/src/index.ts", import.meta.url)),
  "@pgxsinkit/react": fileURLToPath(new URL("../../packages/react/src/index.ts", import.meta.url)),
  "@pgxsinkit/schema": fileURLToPath(new URL("../../packages/schema/src/index.ts", import.meta.url)),
};

export default defineConfig({
  envDir: workspaceRoot,
  plugins: [react()],
  resolve: {
    alias: workspaceAliases,
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    exclude: ["@electric-sql/pglite", ...Object.keys(workspaceAliases)],
  },
  server: {
    port: 5173,
  },
});
