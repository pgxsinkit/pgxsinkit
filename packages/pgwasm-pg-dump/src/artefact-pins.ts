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
  tag: "19.0.0-rc.1",
  name: "pgwasm-postgres 19.0.0-rc.1",
  commit: "df4458a4fd3c0a546af29eb399bdfaa54eee70dd",
  upstream: { tag: "REL_19_RC1", commit: "0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89" },
  dataFormat: 2,
  builderImage:
    "ghcr.io/pgxsinkit/pgwasm-builder@sha256:cbb378a50de43cd2fbd8718b72ce4c7595ffe421148a3c32435906f096bc5130",
  manifestSha256: "3451d5f8c0cc67c9dc8dd7d69862bebf81c700907f0a7d42860acc7a7548222a",
} as const;

/** Every pinned file, by its name in `artefacts/` (the release asset of the same name). */
export const ARTEFACT_FILES = {
  "pg_dump.js": { bytes: 111187, sha256: "3703508f8e8897e982e3cd1d1ef67b5d721e02e899578435c177895dabac1477" },
  "pg_dump.wasm": { bytes: 663555, sha256: "ca2e05d8787a36f84b12b2c7cf7d6442f9aec7963ab88bdb7d4511a5b525361d" },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
