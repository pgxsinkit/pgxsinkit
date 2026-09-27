/**
 * The C build's artefacts, pinned by release and checksum (ADR-0062 decision 9, ADR-0064).
 *
 * Written by `bun run pgwasm:pin <tag>`; never edit it by hand. The files are the assets of one
 * pgxsinkit/pgwasm-postgres GitHub release, built from PostgreSQL plus patches derived from ElectricSQL's
 * postgres-pglite (PostgreSQL License). They are not in git: `scripts/pgwasm-artefacts.ts` (the root
 * `postinstall`) downloads each asset into `packages/pgwasm-c/artefacts/` and checks it against its bytes
 * and sha256 below. The published package carries the files themselves. `C_BUILD_IDENTITY` takes its
 * `release` and `dataFormat` from `ARTEFACT_RELEASE`.
 */

/** The release the files are assets of. */
export const ARTEFACT_RELEASE = {
  repository: "pgxsinkit/pgwasm-postgres",
  tag: "18.3.0",
  name: "pgwasm-postgres 18.3.0",
  commit: "b206c07782f3248dfd780d06005966dcafe11d97",
  upstream: { tag: "REL_18_3", commit: "62d6c7d3df6287f1bd83199c1a746e50d31571a0" },
  dataFormat: 1,
  builderImage:
    "ghcr.io/pgxsinkit/pgwasm-builder@sha256:c9eacc51a7c25d67aef3daa418a39592a97f471aff099fa5a88fa1c82107435d",
  manifestSha256: "86212051b87b8b691ce195463d1aa0bf830733d00ec9d8152970bc6dc725e44f",
} as const;

/** Every pinned file, by its name in `artefacts/` (the release asset of the same name). */
export const ARTEFACT_FILES = {
  "amcheck.tar.gz": { bytes: 21865, sha256: "cb49fc2abf989ba38e8701acf7e340ea55f4e9fed63a71e2b9b7d0f95244fe34" },
  "initdb.js": { bytes: 109978, sha256: "6852f5292d9528c7aa2093a853236f0ba2ee6777b9d43a10f17b04ef22886194" },
  "initdb.wasm": { bytes: 395242, sha256: "4c8988dca3b2f0bbfd23a0714023e4822a2909ead01804f37acffd9ff3ca9f8a" },
  "pglite.data": { bytes: 6293220, sha256: "67dccef2c115b0b8e0853ed6139054436dbda07c79c609f498d3fab8a7b1731d" },
  "pglite.js": { bytes: 380679, sha256: "cabac9d6a431cac2e3d70f112fec2dfd7ce518acced85181c417502ba366da5b" },
  "pglite.wasm": { bytes: 10061242, sha256: "acbf58c590c85ce5837de71d40c5aac818e2c811cc9b8e7c0becbbea4b1b093a" },
  "prepopulated.tar.gz": { bytes: 4400286, sha256: "70a8a3114fb8cdd28dc2ed801f39b41e5d0fd627640b727211f2e50729ed6679" },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
