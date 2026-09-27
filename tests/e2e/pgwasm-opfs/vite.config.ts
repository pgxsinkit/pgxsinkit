import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

const packageSource = (path: string) => fileURLToPath(new URL(`../../../packages/${path}`, import.meta.url));

// The pgwasm packages from source: pgwasm-c's own imports of `@pgxsinkit/pgwasm` must reach the same
// modules as the worker's, or the store's errors would be other classes than the ones it checks against.
const workspaceSource = [
  { find: /^@pgxsinkit\/pgwasm$/, replacement: packageSource("pgwasm/src/index.ts") },
  { find: /^@pgxsinkit\/pgwasm\/build$/, replacement: packageSource("pgwasm/src/build/index.ts") },
  { find: /^@pgxsinkit\/pgwasm\/fs$/, replacement: packageSource("pgwasm/src/fs/index.ts") },
  { find: /^@pgxsinkit\/pgwasm\/opfs$/, replacement: packageSource("pgwasm/src/opfs/index.ts") },
  { find: /^@pgxsinkit\/pgwasm-c$/, replacement: packageSource("pgwasm-c/src/index.ts") },
];

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: workspaceSource },
  // The Emscripten glue loads its wasm and filesystem bundle by URL; pre-bundling would move it away
  // from them.
  optimizeDeps: { exclude: ["@pgxsinkit/pgwasm", "@pgxsinkit/pgwasm-c"] },
  build: {
    outDir: fileURLToPath(new URL("../../../tmp/pgwasm-opfs-browser", import.meta.url)),
    emptyOutDir: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4192,
    strictPort: true,
  },
});
