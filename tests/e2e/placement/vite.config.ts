import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

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
  replacement: fileURLToPath(new URL(`../../../packages/${path}`, import.meta.url)),
}));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: pgwasmSource },
  optimizeDeps: { exclude: ["@pgxsinkit/pgwasm", "@pgxsinkit/pgwasm-c", "@pgxsinkit/pgwasm-pg-dump"] },
  build: {
    outDir: fileURLToPath(new URL("../../../tmp/placement-browser", import.meta.url)),
    emptyOutDir: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4290,
    strictPort: true,
  },
});
