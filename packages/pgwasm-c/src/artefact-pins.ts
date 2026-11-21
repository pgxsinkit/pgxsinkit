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
  "amcheck.tar.gz": { bytes: 21901, sha256: "1d01e05449f16f259ac9f123bde6a3cedf5df63976eb6e12f8111a9636e068e2" },
  "initdb.js": { bytes: 105130, sha256: "cf3fff4109879f3be1ba321f19b126c4f8d518d9909846927d3104b1ec0a8129" },
  "initdb.wasm": { bytes: 308968, sha256: "ca82d1ee91e260001f813de6076f2c3a87fb2e856362cb51b5d4059fbead9c76" },
  "postgres.data": { bytes: 6332724, sha256: "59b01bd0a90fcbdc7fea17c9aae06bfdc53036f8ca0d7cffcaa8adabf4c42624" },
  "postgres.js": { bytes: 337355, sha256: "e3ce8a5d2b123b6e0cab190c987695e065d9eade671b53a7f0a828a68f3db399" },
  "postgres.wasm": { bytes: 9484304, sha256: "5934afc02711178271207d4f21430d82f2737a7433b5db2e69e1112538bcf317" },
  "prepopulated.tar.gz": { bytes: 4474260, sha256: "c522e15dd0b53aa41b7e1822b61397ed87c1fd991985abad8b1d9892597ab1be" },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
