import { createRequire } from "node:module";
import { dirname } from "node:path";
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

// PGlite's boot-asset pre-warm (board optimisation A) needs to `?url`-import the wasm/data files, but
// PGlite's package `exports` field does not expose `./dist/*`, so a bare `@electric-sql/pglite/dist/…`
// specifier is rejected by the resolver. Resolve the dist directory from the package main and alias a
// `pglite-boot-asset/<file>` prefix onto the real absolute paths, so `pglite-boot-asset/pglite.wasm?url`
// resolves (with the `?url` query preserved) in both `vite dev` and `vite build`. The regex form keeps
// the trailing `?url` on the captured group.
const pgliteDistDir = dirname(createRequire(import.meta.url).resolve("@electric-sql/pglite"));
const pgliteAssetAlias = { find: /^pglite-boot-asset\/(.+)$/, replacement: `${pgliteDistDir}/$1` };

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
    alias: [
      ...Object.entries(workspaceAliases).map(([find, replacement]) => ({ find, replacement })),
      pgliteAssetAlias,
    ],
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    exclude: ["@electric-sql/pglite", ...Object.keys(workspaceAliases)],
  },
  // The e2e lane (`test:integration:worker`) serves the BUILT app via `vite preview` on 5173 — the
  // board's established origin in every CORS allow-list (board-compose, packages/server defaults,
  // board-api defaults). Kept separate from `server.port` so the kube/dev flow on 5660 and the lane
  // never collide.
  preview: {
    port: 5173,
    strictPort: true,
  },
  server: {
    port: 5660,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
