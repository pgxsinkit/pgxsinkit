/**
 * `pg_dump`'s artefacts, pinned by release and checksum (ADR-0062 decision 9, ADR-0064).
 *
 * Written by `bun run pgwasm:pin <tag>`, from the same pgxsinkit/pgwasm-postgres release as the C build's
 * (pg_dump refuses a server newer than itself, so it always ships with its server); never edit it by hand.
 * They are not in git: `scripts/pgwasm-artefacts.ts` (the root `postinstall`) downloads each asset into
 * `packages/pgwasm-pg-dump/artefacts/` and checks it against its bytes and sha256 below. The published
 * package carries the files.
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
  "pg_dump.js": { bytes: 126562, sha256: "1c2eb5278d148a6fa977c617ad728c0f878b5d937c10dfd3a7eed403911997cc" },
  "pg_dump.wasm": { bytes: 703947, sha256: "29ecc71fea0865b114cc15733e325aaf7afcdcb6c5a65a5538d937f1df3fb301" },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
