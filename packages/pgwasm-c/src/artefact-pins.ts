/**
 * The C build's artefacts, pinned by version and checksum (ADR-0062 decision 9).
 *
 * They are the files `@electric-sql/pglite` 0.5.8 published, republished byte-identical. They are not
 * in git: `scripts/pgwasm-artefacts.ts` (the root `postinstall`) downloads the npm tarball, checks
 * its integrity, extracts these files into `packages/pgwasm-c/artefacts/` and checks every one of
 * them against the digests below. The published package carries the files themselves.
 */

/** Where the files come from: the npm tarball and its integrity, as the registry reports it. */
export const ARTEFACT_SOURCE = {
  package: "@electric-sql/pglite",
  version: "0.5.8",
  tarball: "https://registry.npmjs.org/@electric-sql/pglite/-/pglite-0.5.8.tgz",
  integrity: "sha512-n9tsbUOhwx2epK1V0ZG9Ar4SHWUju04dhmzZXiSBXwBoleOvIfals33NAaWgagQVAL4Rbvx/Ptsu3P+pA09f6Q==",
} as const;

export interface ArtefactPin {
  /** The member's path inside the npm tarball. */
  readonly from: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Every file the C build loads, by its name in `artefacts/`. */
export const ARTEFACT_FILES = {
  "pglite.wasm": {
    from: "package/dist/pglite.wasm",
    bytes: 10088161,
    sha256: "356b89f6fcb2ab3a397bec4128327b67b7137ec2a900b13251dade81bcbc0ef0",
  },
  "pglite.data": {
    from: "package/dist/pglite.data",
    bytes: 6295316,
    sha256: "c574cc331d96e33311470ec57bf58c579d972c111dbd9c0ab54bb42d79ec4c0d",
  },
  "pglite.js": {
    from: "package/dist/pglite.js",
    bytes: 516332,
    sha256: "d7db324430326d0a2189a4aa10a11214fd0c92fdbf0df5781bb57f947b491707",
  },
  "initdb.wasm": {
    from: "package/dist/initdb.wasm",
    bytes: 395242,
    sha256: "4c8988dca3b2f0bbfd23a0714023e4822a2909ead01804f37acffd9ff3ca9f8a",
  },
  "initdb.js": {
    from: "package/dist/initdb.js",
    bytes: 109978,
    sha256: "6852f5292d9528c7aa2093a853236f0ba2ee6777b9d43a10f17b04ef22886194",
  },
  "amcheck.tar.gz": {
    from: "package/dist/amcheck.tar.gz",
    bytes: 21887,
    sha256: "c1f90ddcf1d1051f49bf6c47b41221a4911e265b66ce31816b0abdc72e9285f6",
  },
} as const satisfies Record<string, ArtefactPin>;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
