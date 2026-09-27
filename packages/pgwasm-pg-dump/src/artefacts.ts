/**
 * pg_dump's artefacts, referenced relative to this module so bundlers copy and fingerprint them.
 *
 * This is the ONLY module that names `../artefacts/`: Bun.build rewrites neither a relative external
 * import nor `new URL("…", import.meta.url)` when it bundles a module into a shallower output, and this
 * file is bundled into `dist/index.js`, one level below the package root like itself
 * (tests/unit/pgwasm-artefacts.test.ts enforces the rule). The `new URL` stays a literal so bundlers can
 * see it.
 */

import createPgDumpModule from "../artefacts/pg_dump.js";

/** The pg_dump WebAssembly module. */
export const pgDumpWasm = new URL("../artefacts/pg_dump.wasm", import.meta.url);

export { createPgDumpModule };
