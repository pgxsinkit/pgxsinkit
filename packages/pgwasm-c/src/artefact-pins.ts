/**
 * The C build's artefacts, pinned by version and checksum (ADR-0062 decision 9).
 *
 * They are files ElectricSQL published on npm, republished byte-identical. They are not in git:
 * `scripts/pgwasm-artefacts.ts` (the root `postinstall`) downloads each npm tarball, checks its
 * integrity, extracts these files into `packages/pgwasm-c/artefacts/` and checks every one of them
 * against the digests below. The published package carries the files themselves.
 */

/** The Postgres server, initdb, their Emscripten glue and the extensions: `@electric-sql/pglite` 0.5.8. */
const PGLITE = {
  package: "@electric-sql/pglite",
  version: "0.5.8",
  tarball: "https://registry.npmjs.org/@electric-sql/pglite/-/pglite-0.5.8.tgz",
  integrity: "sha512-n9tsbUOhwx2epK1V0ZG9Ar4SHWUju04dhmzZXiSBXwBoleOvIfals33NAaWgagQVAL4Rbvx/Ptsu3P+pA09f6Q==",
} as const;

/**
 * The prepopulated data directory: a Store backup ElectricSQL made by running initdb on PGlite 0.5.8,
 * published as `@electric-sql/pglite-prepopulatedfs` 0.5.8.
 */
const PREPOPULATED = {
  package: "@electric-sql/pglite-prepopulatedfs",
  version: "0.5.8",
  tarball: "https://registry.npmjs.org/@electric-sql/pglite-prepopulatedfs/-/pglite-prepopulatedfs-0.5.8.tgz",
  integrity: "sha512-VQsIpJjTRcyEdsoU84UGhGc67Dq+N/P5k9NPPHrvMgGTptHYIxpPcEbzxpFnLL56ThvZ/mJecC+0IbNhRN1zrg==",
} as const;

/** Every file the C build ships, by its name in `artefacts/`, with the tarball member it comes from. */
export const ARTEFACT_FILES = {
  "pglite.wasm": {
    source: PGLITE,
    from: { member: "package/dist/pglite.wasm" },
    bytes: 10088161,
    sha256: "356b89f6fcb2ab3a397bec4128327b67b7137ec2a900b13251dade81bcbc0ef0",
  },
  "pglite.data": {
    source: PGLITE,
    from: { member: "package/dist/pglite.data" },
    bytes: 6295316,
    sha256: "c574cc331d96e33311470ec57bf58c579d972c111dbd9c0ab54bb42d79ec4c0d",
  },
  "pglite.js": {
    source: PGLITE,
    from: { member: "package/dist/pglite.js" },
    bytes: 516332,
    sha256: "d7db324430326d0a2189a4aa10a11214fd0c92fdbf0df5781bb57f947b491707",
  },
  "initdb.wasm": {
    source: PGLITE,
    from: { member: "package/dist/initdb.wasm" },
    bytes: 395242,
    sha256: "4c8988dca3b2f0bbfd23a0714023e4822a2909ead01804f37acffd9ff3ca9f8a",
  },
  "initdb.js": {
    source: PGLITE,
    from: { member: "package/dist/initdb.js" },
    bytes: 109978,
    sha256: "6852f5292d9528c7aa2093a853236f0ba2ee6777b9d43a10f17b04ef22886194",
  },
  "amcheck.tar.gz": {
    source: PGLITE,
    from: { member: "package/dist/amcheck.tar.gz" },
    bytes: 21887,
    sha256: "c1f90ddcf1d1051f49bf6c47b41221a4911e265b66ce31816b0abdc72e9285f6",
  },
  "prepopulated.tar.gz": {
    source: PREPOPULATED,
    from: { member: "package/dist/prepopulatedfs.tgz" },
    bytes: 4513806,
    sha256: "c07835b228cf6e3d182f83042b78cd3c9d51e2b4f966d74768c09f71c24e5c85",
  },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
