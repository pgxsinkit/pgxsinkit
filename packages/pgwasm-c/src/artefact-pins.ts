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
  "amcheck.tar.gz": { bytes: 21850, sha256: "6151f1f4ff507dd4401dc3dff9e5ad769727c2eb3d510e9fe75329bf52667c3f" },
  "initdb.js": { bytes: 106390, sha256: "a402bd734fda0faf36696b68324471f853d52bd248ab8219893a6344386f6fac" },
  "initdb.wasm": { bytes: 298938, sha256: "0fdc9cb46e2efe6dc1fc957c47c0c7364022c98d327eb8072af3f7fb75237d3e" },
  "postgres.data": { bytes: 6246509, sha256: "012a2ed052fc0a05d50b9920afb5cb1692b3fbf9e09d486da61e4a59bb8f249a" },
  "postgres.js": { bytes: 335115, sha256: "1bfb5740bd836121c0444d058593bbc7fa0de625596214a8e4805414191a23b2" },
  "postgres.wasm": { bytes: 9140085, sha256: "f2d217be96e05dd01c02a6b62e89110d3658ac5be6032fe1d28effc9348b15ac" },
  "prepopulated.tar.gz": { bytes: 4404457, sha256: "f5228a3690329edf675f630bedad6a4f6196f40c277f34aec3ac4d1ee426e0b3" },
} as const;

export type ArtefactName = keyof typeof ARTEFACT_FILES;
