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

// Cross-origin isolation, OPT-IN (`VITE_BOARD_ISOLATED=1` on the command that starts vite, like
// BOARD_DEMO_BASE above). An engine that runs on threads (SharedArrayBuffer + Atomics.wait) is only
// constructible on a cross-origin-ISOLATED page, and isolation is a property of the SERVED HEADERS, not of
// the app: `crossOriginIsolated` is false without them, in the document AND in the SharedWorker (a shared
// worker takes its embedder policy from its OWN script response, so serving these on every response — which
// is what `headers` does — is what makes the engine home isolated too). The default board (PGlite, no
// threads) neither needs nor wants them, so this stays off unless asked for: COEP `require-corp` makes every
// NO-CORS cross-origin subresource fail closed. The board loads none — its own assets are same-origin and
// its backend traffic is `fetch` with CORS, which COEP does not touch — but a store-factory module served
// from another origin (see src/board/store-factory.ts) must answer with CORS and
// `Cross-Origin-Resource-Policy: cross-origin`. Dev and preview both, so `bun run dev` and the built
// artifact behave identically. See apps/board/docs/local-store-seam.md.
const isolationHeaders =
  process.env["VITE_BOARD_ISOLATED"] === "1"
    ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" }
    : undefined;

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
    ...(isolationHeaders ? { headers: isolationHeaders } : {}),
  },
  server: {
    port: 5660,
    host: "0.0.0.0",
    allowedHosts: true,
    ...(isolationHeaders ? { headers: isolationHeaders } : {}),
  },
});
