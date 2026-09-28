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
  tag: "18.6.2",
  name: "pgwasm-postgres 18.6.2",
  commit: "bf7938ad6acd51e1f68a9cb14fee9fea879a3b48",
  upstream: { tag: "REL_18_6", commit: "724edf9bde9d356724ad384a2e196edc3c9f80f7" },
  dataFormat: 1,
  builderImage:
    "ghcr.io/pgxsinkit/pgwasm-builder@sha256:0c4d5255c5f1824216d1eb347cc231a6f881574c3d5b8172796a8cbe5f9f63c8",
  manifestSha256: "571b72a31003f89510f1bcbb37b5f70c142a5271cfdf24b7229423f9975d621d",
} as const;

/** Every pinned file, by its name in `artefacts/` (the release asset of the same name). */
export const ARTEFACT_FILES = {
  "pg_dump.js": { bytes: 112499, sha256: "e53c8f6e0388e793ffc8c7ec629c1a6c05ff49904c023a8ff1d1ef36cd3a2619" },
  "pg_dump.wasm": { bytes: 655066, sha256: "40e669ee2a218a73f9ca0138e56ce3180fcb0398134d98f53fae253c03174ce8" },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
