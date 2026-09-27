import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const workspaceAliases = {
  "@pgxsinkit/client": fileURLToPath(new URL("../../packages/client/src/index.ts", import.meta.url)),
  "@pgxsinkit/contracts": fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)),
  "@pgxsinkit/schema": fileURLToPath(new URL("../../packages/schema/src/index.ts", import.meta.url)),
};

// The docs-site publish (`bun run bench:publish`, the consumer-docs benchmark page) sets these so
// the SAME bench entry builds into a subpath of the GitHub Pages output: BENCH_BASE rewrites asset URLs to
// `/bench/`, BENCH_OUTDIR redirects the output into the docs `dist/` so the bench page + docs deploy as one
// artifact. When either is set, ONLY the bench.html entry is emitted (the React perf lab is dev-only).
// Unset for normal local builds (base `/`, default `dist`, both MPA entries).
const benchBase = process.env["BENCH_BASE"];
const benchOutDir = process.env["BENCH_OUTDIR"];
const benchPublish = benchBase !== undefined || benchOutDir !== undefined;

const indexEntry = fileURLToPath(new URL("./index.html", import.meta.url));
const benchEntry = fileURLToPath(new URL("./bench.html", import.meta.url));

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
  base: benchBase ?? "/",
  plugins: [react()],
  resolve: {
    alias: [...Object.entries(workspaceAliases).map(([find, replacement]) => ({ find, replacement })), ...pgwasmSource],
  },
  optimizeDeps: {
    exclude: [
      "@electric-sql/pglite",
      "@pgxsinkit/pgwasm",
      "@pgxsinkit/pgwasm-c",
      "@pgxsinkit/pgwasm-pg-dump",
      ...Object.keys(workspaceAliases),
    ],
  },
  // Two entries (MPA): the existing React perf lab, and the plain storage benchmark page. The
  // benchmark page is deliberately a second entry so the existing lab is untouched. The docs publish emits
  // only the bench entry, into BENCH_OUTDIR.
  build: {
    ...(benchOutDir ? { outDir: benchOutDir, emptyOutDir: true } : {}),
    rolldownOptions: {
      input: benchPublish ? { bench: benchEntry } : { main: indexEntry, bench: benchEntry },
    },
  },
  server: {
    port: 5174,
  },
  // Fixed preview port so scripts/run-bench.ts drives a known URL under Playwright.
  preview: {
    port: 4188,
    strictPort: true,
  },
});
