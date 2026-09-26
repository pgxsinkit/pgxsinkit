/**
 * The C build's artefacts, referenced relative to this module so bundlers copy and fingerprint them.
 *
 * This is the ONLY module at `src/`'s depth that names `../artefacts/`: Bun.build rewrites neither a
 * relative external import nor `new URL("…", import.meta.url)` when it bundles a module into a
 * shallower output, and this file is bundled into `dist/index.js`, one level below the package root
 * like itself (tests/unit/pgwasm-c-artefacts.test.ts enforces the rule). Each `new URL` stays a literal
 * so bundlers can see it.
 */

import createInitdbModule from "../artefacts/initdb.js";
import createPostgresModule from "../artefacts/pglite.js";

/** The URLs of the files the C build loads, for fetching and compiling them ahead of a boot. */
export const cBuildArtefacts = {
  /** The Postgres WebAssembly module. */
  postgresWasm: new URL("../artefacts/pglite.wasm", import.meta.url),
  /** The filesystem bundle (share/, lib/, the ICU data) the Postgres module mounts. */
  fsBundle: new URL("../artefacts/pglite.data", import.meta.url),
  /** The initdb WebAssembly module, used when a data directory is created. */
  initdbWasm: new URL("../artefacts/initdb.wasm", import.meta.url),
} as const;

export { createInitdbModule, createPostgresModule };
