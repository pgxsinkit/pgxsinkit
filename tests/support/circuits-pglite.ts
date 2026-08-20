import type { PGlite } from "@electric-sql/pglite";

import { DEFAULT_METADATA_SCHEMA } from "../../packages/client/src/sync/metadata-tables";
import { migrateSubscriptionMetadataTables } from "../../packages/client/src/sync/subscription-state";
import { createFreshTestPGlite } from "./pglite";

// A fresh test PGlite carrying the subscription metadata the native sync engine reads and writes
// (ADR-0029 D3 relations + ADR-0042's session cursors). `createSyncClient` provisions these during
// boot; a test driving `startCircuitsSync` over a bare store has to do it itself, and this is the one
// line that does.
//
// Deliberately NOT folded into `support/pglite.ts`: this file statically imports client modules, and
// the mock-driven unit suites must not pull them in transitively through a `support/pglite` import.
// Only the real-stream integration suites use it.
export async function createCircuitsTestPGlite(): Promise<PGlite> {
  const pg = await createFreshTestPGlite();
  await migrateSubscriptionMetadataTables({ pg, metadataSchema: DEFAULT_METADATA_SCHEMA });
  return pg;
}
