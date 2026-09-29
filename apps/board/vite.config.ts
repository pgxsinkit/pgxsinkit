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

// Cross-origin isolation, OPT-IN (`VITE_BOARD_ISOLATED=1` on the command that starts vite, like
// BOARD_DEMO_BASE above). An engine that runs on threads (SharedArrayBuffer + Atomics.wait) is only
// constructible on a cross-origin-ISOLATED page, and isolation is a property of the SERVED HEADERS, not of
// the app: `crossOriginIsolated` is false without them, in the document AND in the SharedWorker (a shared
// worker takes its embedder policy from its OWN script response, so serving these on every response — which
// is what `headers` does — is what makes the engine home isolated too). The default board (pgwasm, no
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

// The pgwasm packages from source (their package exports point at a build): every importer — the client's
// source, pgwasm-c, pgwasm-pg-dump — must reach the same modules, or error classes and the wire registry
// would be other instances than the page's.
const pgwasmSource = [
  ["@pgxsinkit/pgwasm", "pgwasm/src/index.ts"],
  ["@pgxsinkit/pgwasm/build", "pgwasm/src/build/index.ts"],
  ["@pgxsinkit/pgwasm/drizzle", "pgwasm/src/drizzle/index.ts"],
  ["@pgxsinkit/pgwasm/fs", "pgwasm/src/fs/index.ts"],
  ["@pgxsinkit/pgwasm/live", "pgwasm/src/live/index.ts"],
  ["@pgxsinkit/pgwasm/opfs", "pgwasm/src/opfs/index.ts"],
  ["@pgxsinkit/pgwasm/protocol", "pgwasm/src/protocol/index.ts"],
  ["@pgxsinkit/pgwasm-c", "pgwasm-c/src/index.ts"],
  ["@pgxsinkit/pgwasm-c/prepopulated", "pgwasm-c/src/prepopulated.ts"],
  ["@pgxsinkit/pgwasm-pg-dump", "pgwasm-pg-dump/src/index.ts"],
  ["@pgxsinkit/pgwasm-repl", "pgwasm-repl/src/index.ts"],
].map(([name, path]) => ({
  find: new RegExp(`^${name!.replace(/[/.]/g, "\\$&")}$`),
  replacement: fileURLToPath(new URL(`../../packages/${path}`, import.meta.url)),
}));

export default defineConfig({
  envDir: workspaceRoot,
  base: demoBase ?? "/",
  ...(demoOutDir ? { build: { outDir: demoOutDir, emptyOutDir: true } } : {}),
  plugins: [react()],
  resolve: {
    alias: [...Object.entries(workspaceAliases).map(([find, replacement]) => ({ find, replacement })), ...pgwasmSource],
    dedupe: ["react", "react-dom"],
  },
  optimizeDeps: {
    exclude: [
      "@pgxsinkit/pgwasm",
      "@pgxsinkit/pgwasm-c",
      "@pgxsinkit/pgwasm-pg-dump",
      ...Object.keys(workspaceAliases),
    ],
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
