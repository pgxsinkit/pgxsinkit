/**
 * The earlier C builds whose IndexedDB stores exist in the wild, for the IndexedDB lane's continuity
 * test: each one creates an `idb://` store, and the current build must then open it, read it back and
 * write to it.
 *
 * Each entry pins one pgxsinkit/pgwasm-postgres release's glue and files, by bytes and sha256 copied from
 * that release's `manifest.json`. `bun scripts/pgwasm-continuity-artefacts.ts` (run by
 * `e2e:pgwasm-idb:serve`) fetches them into `tmp/pgwasm-idb-continuity/<tag>/` through the build packages'
 * own release-asset fetch and verification (`scripts/pgwasm-artefacts.ts`); they are never committed.
 * Adding a build is one entry here: the lane's Vite config and the test iterate over this list.
 *
 * The list starts empty again at PG19: its data format is 2, while every published PG18 build used
 * format 1. PG18 stores must be refused, not opened by this host. The browser lane separately checks
 * marked and unmarked PG18 refusal and that their files remain intact. Add earlier PG19 builds here
 * only when their store format and host ABI are compatible with the current build.
 */

/** A pinned file: the release asset of the same name, byte for byte (`scripts/pgwasm-artefacts.ts`' pin). */
export interface ContinuityFilePin {
  readonly bytes: number;
  readonly sha256: string;
}

/** The files a C build boots from, glue and all. */
export const CONTINUITY_FILES = ["initdb.js", "initdb.wasm", "postgres.data", "postgres.js", "postgres.wasm"] as const;

export type ContinuityFile = (typeof CONTINUITY_FILES)[number];

export interface ContinuityBuild {
  /** The pgwasm-postgres release tag. */
  readonly tag: string;
  /** Its data format (`manifest.json`); a store's marker records it. */
  readonly dataFormat: number;
  readonly files: Readonly<Record<ContinuityFile, ContinuityFilePin>>;
}

export const CONTINUITY_REPOSITORY = "pgxsinkit/pgwasm-postgres";

/** Where a build's verified files are put, relative to the repository root (gitignored, like all of tmp/). */
export const continuityFixtureDir = (tag: string): string => `tmp/pgwasm-idb-continuity/${tag}`;

export const CONTINUITY_BUILDS: readonly ContinuityBuild[] = [];
