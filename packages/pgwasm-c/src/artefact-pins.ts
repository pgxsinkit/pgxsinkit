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
  tag: "18.6.1",
  name: "pgwasm-postgres 18.6.1",
  commit: "28f0c1551db8c7f5df143ef1e424c641af93072d",
  upstream: { tag: "REL_18_6", commit: "724edf9bde9d356724ad384a2e196edc3c9f80f7" },
  dataFormat: 1,
  builderImage:
    "ghcr.io/pgxsinkit/pgwasm-builder@sha256:0c4d5255c5f1824216d1eb347cc231a6f881574c3d5b8172796a8cbe5f9f63c8",
  manifestSha256: "f74ddedfb91c2550fed1d76eea0a4ed9a07244221830e35f52051146685674a4",
} as const;

/** Every pinned file, by its name in `artefacts/` (the release asset of the same name). */
export const ARTEFACT_FILES = {
  "amcheck.tar.gz": { bytes: 21851, sha256: "7174bd2057e62039557d7256544cdbb8c65ffb515efd164a30474edad7161a3b" },
  "initdb.js": { bytes: 106390, sha256: "a402bd734fda0faf36696b68324471f853d52bd248ab8219893a6344386f6fac" },
  "initdb.wasm": { bytes: 298938, sha256: "4cfd4fa9e2b11dc8a0589dd0aaefa52ff99f66b808f34448b57f38a224f0ee5e" },
  "pglite.data": { bytes: 6246509, sha256: "b5fe3e2bbd321399458a78757ec7644b28db7c869a90d3a3f7871ffe73959734" },
  "pglite.js": { bytes: 335082, sha256: "ec547c04cc571ceedbe0affa7133534a33bfa7579a44be513ba0777216c4a138" },
  "pglite.wasm": { bytes: 9140085, sha256: "fc2c0e5a1c1588c8f1bc9f3b3afb99da562cd1b90114d054ee8fef881d8931fa" },
  "prepopulated.tar.gz": { bytes: 4404475, sha256: "2a0be441c2b14860c2aec29caea0c70a951f982900bd0617d982145918ec52e6" },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
