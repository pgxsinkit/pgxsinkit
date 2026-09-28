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
 * - 18.6.0: pgxsinkit 0.4.1's C build, Emscripten 3.1.74 like ElectricSQL's PGlite 0.5.8 wasm that
 *   pgxsinkit ≤0.3.x shipped (through the @pgxsinkit/pglite fork). 18.6.1 moved to Emscripten 6.0.10.
 */

/** A pinned file: the release asset of the same name, byte for byte (`scripts/pgwasm-artefacts.ts`' pin). */
export interface ContinuityFilePin {
  readonly bytes: number;
  readonly sha256: string;
}

/** The files a C build boots from, glue and all. */
export const CONTINUITY_FILES = ["initdb.js", "initdb.wasm", "pglite.data", "pglite.js", "pglite.wasm"] as const;

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

export const CONTINUITY_BUILDS: readonly ContinuityBuild[] = [
  {
    tag: "18.6.0",
    dataFormat: 1,
    files: {
      "initdb.js": { bytes: 109978, sha256: "5da5c8aa5443ba113153f49d71b6fdacd4b888b4d4547bc7d9b5a7c45f5356c7" },
      "initdb.wasm": { bytes: 395467, sha256: "1691997a10d595f0850bc0f0eaffd1ed6cbb22e1de6faec7a5f925e09305d336" },
      "pglite.data": { bytes: 6290545, sha256: "0d836559779b3658b05e8b0fa74fe310d0f0c897ef2cbe4815ec3a3e8d7204e3" },
      "pglite.js": { bytes: 380859, sha256: "5969cf9cd1cf54661f9838e14a4435b6b4f169f741d77eee2a7c32531d8bc8ee" },
      "pglite.wasm": { bytes: 10089345, sha256: "9e30c88fb9bc8efe4e8e9a84b2c62a99cc55369b513b7bbda6f4ecb384110847" },
    },
  },
];
