import { existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

import { defineConfig, type Plugin } from "vite";

import { CONTINUITY_BUILDS, CONTINUITY_FILES, continuityFixtureDir } from "./continuity-builds.ts";

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

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const CONTINUITY_MODULE = "virtual:pgwasm-continuity-builds";
const RESOLVED_CONTINUITY_MODULE = `\0${CONTINUITY_MODULE}`;
const NODE_BUILTIN_STUB = "\0pgwasm-continuity-node-builtin";

/**
 * `virtual:pgwasm-continuity-builds`: each earlier build of `continuity-builds.ts`, as its glue factories
 * and the URLs of its files, from the verified copies `bun scripts/pgwasm-continuity-artefacts.ts` put in
 * `tmp/pgwasm-idb-continuity/<tag>/` (the serve script runs it first). A missing file fails the build.
 */
function continuityBuilds(): Plugin {
  const fixtureRoot = path.join(repoRoot, continuityFixtureDir(""));
  return {
    name: "pgwasm-continuity-builds",
    resolveId(source, importer) {
      if (source === CONTINUITY_MODULE) return RESOLVED_CONTINUITY_MODULE;
      // The glue loads Node builtins behind ENVIRONMENT_IS_NODE, never in a browser: stubbed, as the build
      // packages' browser fields stub them for their own glue.
      if (importer?.startsWith(fixtureRoot) === true && isBuiltin(source)) return NODE_BUILTIN_STUB;
      return null;
    },
    load(id) {
      if (id === NODE_BUILTIN_STUB) return "export default {};";
      if (id !== RESOLVED_CONTINUITY_MODULE) return null;
      const imports: string[] = [];
      const entries: string[] = [];
      for (const [index, build] of CONTINUITY_BUILDS.entries()) {
        const dir = path.join(repoRoot, continuityFixtureDir(build.tag));
        const missing = CONTINUITY_FILES.filter((name) => !existsSync(path.join(dir, name)));
        if (missing.length > 0) {
          this.error(
            `${continuityFixtureDir(build.tag)} lacks ${missing.join(", ")}: run \`bun scripts/pgwasm-continuity-artefacts.ts\``,
          );
        }
        const file = (name: string, query = "") => JSON.stringify(`${path.join(dir, name)}${query}`);
        imports.push(
          `import createPostgresModule${index} from ${file("pglite.js")};`,
          `import createInitdbModule${index} from ${file("initdb.js")};`,
          `import postgresWasm${index} from ${file("pglite.wasm", "?url")};`,
          `import initdbWasm${index} from ${file("initdb.wasm", "?url")};`,
          `import fsBundle${index} from ${file("pglite.data", "?url")};`,
        );
        entries.push(
          `{ tag: ${JSON.stringify(build.tag)}, dataFormat: ${build.dataFormat}, ` +
            `fsBundleBytes: ${build.files["pglite.data"].bytes}, ` +
            `createPostgresModule: createPostgresModule${index}, createInitdbModule: createInitdbModule${index}, ` +
            `postgresWasm: postgresWasm${index}, initdbWasm: initdbWasm${index}, fsBundle: fsBundle${index} }`,
        );
      }
      return `${imports.join("\n")}\nexport const continuityBuilds = [${entries.join(", ")}];\n`;
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [continuityBuilds()],
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
