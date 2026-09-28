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
  tag: "18.6.0",
  name: "pgwasm-postgres 18.6.0",
  commit: "efcbf6eee6dacc454fcb123e3730ad8f051a6eda",
  upstream: { tag: "REL_18_6", commit: "724edf9bde9d356724ad384a2e196edc3c9f80f7" },
  dataFormat: 1,
  builderImage:
    "ghcr.io/pgxsinkit/pgwasm-builder@sha256:c9eacc51a7c25d67aef3daa418a39592a97f471aff099fa5a88fa1c82107435d",
  manifestSha256: "d293bbe0a33f24bc4e70b3cfe4a0d48b8bc4f7a970c48be8fe2dd6617273e2f5",
} as const;

/** Every pinned file, by its name in `artefacts/` (the release asset of the same name). */
export const ARTEFACT_FILES = {
  "amcheck.tar.gz": { bytes: 21912, sha256: "74233ac5a0e561a55ba206827669f2c45aa2b137af1546a0315f32365e4cc228" },
  "initdb.js": { bytes: 109978, sha256: "5da5c8aa5443ba113153f49d71b6fdacd4b888b4d4547bc7d9b5a7c45f5356c7" },
  "initdb.wasm": { bytes: 395467, sha256: "1691997a10d595f0850bc0f0eaffd1ed6cbb22e1de6faec7a5f925e09305d336" },
  "pglite.data": { bytes: 6290545, sha256: "0d836559779b3658b05e8b0fa74fe310d0f0c897ef2cbe4815ec3a3e8d7204e3" },
  "pglite.js": { bytes: 380859, sha256: "5969cf9cd1cf54661f9838e14a4435b6b4f169f741d77eee2a7c32531d8bc8ee" },
  "pglite.wasm": { bytes: 10089345, sha256: "9e30c88fb9bc8efe4e8e9a84b2c62a99cc55369b513b7bbda6f4ecb384110847" },
  "prepopulated.tar.gz": { bytes: 4400286, sha256: "b82dc81f225c311f743397929c4a64689e1ac9b4e9b1a43a469d07071b9d69de" },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
