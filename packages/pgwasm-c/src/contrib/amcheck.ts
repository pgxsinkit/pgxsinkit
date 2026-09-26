// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

import type { ServerExtension } from "@pgxsinkit/pgwasm/build";

/**
 * `amcheck`, compiled for the C build: pass it in `extensions`, then `CREATE EXTENSION amcheck`.
 *
 * The bundle URL sits in this entry point, which is emitted at its own depth (dist/contrib/), so the
 * relative reference stays valid once bundled.
 */
export const amcheck: ServerExtension = {
  kind: "server",
  name: "amcheck",
  build: "c",
  bundle: new URL("../../artefacts/amcheck.tar.gz", import.meta.url),
};
