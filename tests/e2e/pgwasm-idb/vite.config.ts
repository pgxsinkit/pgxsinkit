import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

const packageSource = (path: string) => fileURLToPath(new URL(`../../../packages/${path}`, import.meta.url));

// The pgwasm packages from source: pgwasm-c's and pgwasm-pg-dump's own imports of `@pgxsinkit/pgwasm` must
// reach the same modules as the page's, or its errors would be other classes than the ones the page
// checks against, and the wire registry /protocol reads another instance's.
const workspaceSource = [
  { find: /^@pgxsinkit\/pgwasm$/, replacement: packageSource("pgwasm/src/index.ts") },
  { find: /^@pgxsinkit\/pgwasm\/build$/, replacement: packageSource("pgwasm/src/build/index.ts") },
  { find: /^@pgxsinkit\/pgwasm\/fs$/, replacement: packageSource("pgwasm/src/fs/index.ts") },
  { find: /^@pgxsinkit\/pgwasm\/live$/, replacement: packageSource("pgwasm/src/live/index.ts") },
  { find: /^@pgxsinkit\/pgwasm\/protocol$/, replacement: packageSource("pgwasm/src/protocol/index.ts") },
  { find: /^@pgxsinkit\/pgwasm-c$/, replacement: packageSource("pgwasm-c/src/index.ts") },
  { find: /^@pgxsinkit\/pgwasm-c\/prepopulated$/, replacement: packageSource("pgwasm-c/src/prepopulated.ts") },
  { find: /^@pgxsinkit\/pgwasm-pg-dump$/, replacement: packageSource("pgwasm-pg-dump/src/index.ts") },
  { find: /^@pgxsinkit\/pgwasm-repl$/, replacement: packageSource("pgwasm-repl/src/index.ts") },
];

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: workspaceSource },
  // The Emscripten glue loads its wasm and filesystem bundle by URL; pre-bundling would move it away
  // from them.
  optimizeDeps: { exclude: ["@pgxsinkit/pgwasm", "@pgxsinkit/pgwasm-c", "@pgxsinkit/pgwasm-pg-dump"] },
  build: {
    outDir: fileURLToPath(new URL("../../../tmp/pgwasm-idb-browser", import.meta.url)),
    emptyOutDir: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4191,
    strictPort: true,
  },
});
