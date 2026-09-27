/**
 * `pg_dump`'s artefacts, pinned by version and checksum (ADR-0062 decision 9).
 *
 * They are the pg_dump build ElectricSQL published in `@electric-sql/pglite-tools` 0.4.8 (built in the
 * same run, from the same Postgres tree, as the C build's `@electric-sql/pglite` 0.5.8), republished
 * byte-identical. They are not in git: `scripts/pgwasm-artefacts.ts` (the root `postinstall`) downloads
 * the npm tarball, checks its integrity, extracts these files into `packages/pgwasm-pg-dump/artefacts/`
 * and checks every one of them against the digests below. The published package carries the files.
 */

const PGLITE_TOOLS = {
  package: "@electric-sql/pglite-tools",
  version: "0.4.8",
  tarball: "https://registry.npmjs.org/@electric-sql/pglite-tools/-/pglite-tools-0.4.8.tgz",
  integrity: "sha512-WjgS8US6xfuE0wLYn5m9WrZ/+8dQWoQuQSRkpe7eYcxxx1UjZjvq30rpYSHfGrGtTke/zNiCd9ijVGeRUD8ukg==",
} as const;

/** Every file pg_dump loads, by its name in `artefacts/`, with where it comes from in the tarball. */
export const ARTEFACT_FILES = {
  /** The pg_dump WebAssembly module; it reports `pg_dump (PostgreSQL) 18.3`, the server's version. */
  "pg_dump.wasm": {
    source: PGLITE_TOOLS,
    from: { member: "package/dist/pg_dump.wasm" },
    bytes: 701466,
    sha256: "cdbc551ec339cc9867003203bc8f03911858be2be92b3e88376922b09ccdf58c",
  },
  /**
   * The Emscripten loader for it. The npm package ships the loader only minified, inlined into a tsup
   * chunk; the chunk's source map carries the original file verbatim in `sourcesContent`, so the
   * loader is taken from there: the entry for the source `../release/pg_dump.js`, UTF-8 encoded.
   */
  "pg_dump.js": {
    source: PGLITE_TOOLS,
    from: { sourceMap: "package/dist/chunk-RKAX3U4S.js.map", source: "../release/pg_dump.js" },
    bytes: 126562,
    sha256: "7a30ef1ec52a8ae18a84463c503d86096d3f003a0d7f5e52e29af2855b5dc5f8",
  },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
