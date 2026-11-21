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
  tag: "19.0.0",
  name: "pgwasm-postgres 19.0.0",
  commit: "77228df75b0b80e633c6153cbc17db69ca3a7f6e",
  upstream: { tag: "REL_19_0", commit: "5c839a2a08b9b87a349be97371fac6c5a2873b10" },
  dataFormat: 2,
  builderImage:
    "ghcr.io/pgxsinkit/pgwasm-builder@sha256:cbb378a50de43cd2fbd8718b72ce4c7595ffe421148a3c32435906f096bc5130",
  manifestSha256: "89e117f0eea51612a5b917466158047c8ce540b5ba226c60e6c1828986524c49",
} as const;

/** Every pinned file, by its name in `artefacts/` (the release asset of the same name). */
export const ARTEFACT_FILES = {
  "pg_dump.js": { bytes: 111187, sha256: "3703508f8e8897e982e3cd1d1ef67b5d721e02e899578435c177895dabac1477" },
  "pg_dump.wasm": { bytes: 664987, sha256: "97d16fc60b4cf729efcf005e572d8ce1ead2fbeb834cd6fe552915132b2a1680" },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
