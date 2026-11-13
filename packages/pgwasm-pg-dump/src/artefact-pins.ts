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
  tag: "19.0.0-rc.2",
  name: "pgwasm-postgres 19.0.0-rc.2",
  commit: "528131bf65a410e6a533a3cf67e69abe2a122842",
  upstream: { tag: "REL_19_RC2", commit: "dffcca2e3c81178c64d4c1f44543a3507d0b7508" },
  dataFormat: 2,
  builderImage:
    "ghcr.io/pgxsinkit/pgwasm-builder@sha256:cbb378a50de43cd2fbd8718b72ce4c7595ffe421148a3c32435906f096bc5130",
  manifestSha256: "aa13280c998ac707210025f77fdf0c1afd9f7970d6f11b03d70757cbf9006d3b",
} as const;

/** Every pinned file, by its name in `artefacts/` (the release asset of the same name). */
export const ARTEFACT_FILES = {
  "pg_dump.js": { bytes: 111187, sha256: "3703508f8e8897e982e3cd1d1ef67b5d721e02e899578435c177895dabac1477" },
  "pg_dump.wasm": { bytes: 664958, sha256: "4210d9cb9c20bc9138d88fb0e323d8ee79b46b572a5bc7fd3681ca345d0d57f4" },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
