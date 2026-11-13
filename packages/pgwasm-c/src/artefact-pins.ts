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
  "amcheck.tar.gz": { bytes: 21906, sha256: "1af3d942e088a8a8317d46861b56603dd6fe38e5d9d7ae26e809efdf1f784f5d" },
  "initdb.js": { bytes: 105130, sha256: "cf3fff4109879f3be1ba321f19b126c4f8d518d9909846927d3104b1ec0a8129" },
  "initdb.wasm": { bytes: 308968, sha256: "2c9bb1c3ad3267b4ae5d21c1bc9ebfaf608ecfbb2e14e671ad4ed0a24657edb3" },
  "postgres.data": { bytes: 6332734, sha256: "eaa28b912167539490fedb7f37ccecfd4d569919b16da7708b2aad62442bde98" },
  "postgres.js": { bytes: 337357, sha256: "6c6c65b7fcbc3651f8bb38a4536216b186eb8cd57bca5fca1ce712a1fcc83009" },
  "postgres.wasm": { bytes: 9483613, sha256: "9d3b5b288cd1e0dc5d7adcb4b7a17de0d6dd6f5545c1fa350b98f67f3ed15306" },
  "prepopulated.tar.gz": { bytes: 4474382, sha256: "7f0c6af78341f4bbbd80030e2131a86ee19791864f192a82f5d4ad49ee7d969f" },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
