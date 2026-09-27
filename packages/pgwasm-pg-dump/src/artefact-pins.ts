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
  "pg_dump.js": { bytes: 126562, sha256: "7a30ef1ec52a8ae18a84463c503d86096d3f003a0d7f5e52e29af2855b5dc5f8" },
  "pg_dump.wasm": { bytes: 701466, sha256: "cdbc551ec339cc9867003203bc8f03911858be2be92b3e88376922b09ccdf58c" },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
