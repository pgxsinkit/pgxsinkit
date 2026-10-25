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
  "amcheck.tar.gz": { bytes: 21881, sha256: "200978d0b73e9d5b254088625f9975a61bbbfd584558d4b53acb8bc667f26a02" },
  "initdb.js": { bytes: 105130, sha256: "cf3fff4109879f3be1ba321f19b126c4f8d518d9909846927d3104b1ec0a8129" },
  "initdb.wasm": { bytes: 308968, sha256: "71b468843c8b75dea04a5c3775606ca8d0612f0d3240953159b44132d29e0015" },
  "postgres.data": { bytes: 6330058, sha256: "be7b9fd708ddffcc627aefaff8fdc35310978d8f274a87046cfd232e306a861b" },
  "postgres.js": { bytes: 336823, sha256: "49f427bd890b89ba5b29cf96e3032dcc13cbaf5aadf62b782290480317ea0178" },
  "postgres.wasm": { bytes: 9451369, sha256: "3caccc979114e3ac7177a77bdc4511dab775738ea397bcdde04e6959ce682eb3" },
  "prepopulated.tar.gz": { bytes: 4443562, sha256: "7542c86ecdb058aa18553087b28ebf155b6270773abfb206ddcb05a446266052" },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
