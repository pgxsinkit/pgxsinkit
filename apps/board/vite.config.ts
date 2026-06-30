import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const workspaceAliases = {
  "@pgxsinkit/board-schema": fileURLToPath(new URL("../../packages/board-schema/src/index.ts", import.meta.url)),
  "@pgxsinkit/client": fileURLToPath(new URL("../../packages/client/src/index.ts", import.meta.url)),
  "@pgxsinkit/contracts": fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)),
  "@pgxsinkit/react": fileURLToPath(new URL("../../packages/react/src/index.ts", import.meta.url)),
};

// The hosted GitHub Pages /demo build (`bun run demo:build`, board ADR-0009) sets these so the same
// board builds into a subpath of the docs-site publish: BOARD_DEMO_BASE rewrites asset/index URLs to
// `/demo/`, BOARD_DEMO_OUTDIR redirects the output into the docs `dist/` so both deploy as one artifact.
// Unset for normal local builds (base `/`, default `dist`).
const demoBase = process.env["BOARD_DEMO_BASE"];
const demoOutDir = process.env["BOARD_DEMO_OUTDIR"];

export default defineConfig({
  envDir: workspaceRoot,
  base: demoBase ?? "/",
  ...(demoOutDir ? { build: { outDir: demoOutDir, emptyOutDir: true } } : {}),
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
