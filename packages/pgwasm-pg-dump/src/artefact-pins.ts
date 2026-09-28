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
  "pg_dump.js": { bytes: 112499, sha256: "e53c8f6e0388e793ffc8c7ec629c1a6c05ff49904c023a8ff1d1ef36cd3a2619" },
  "pg_dump.wasm": { bytes: 655066, sha256: "31fa706cc6671b7e6031f989e65feb8f419b5b0ca751f095e2dd806b1f2ae6e3" },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
