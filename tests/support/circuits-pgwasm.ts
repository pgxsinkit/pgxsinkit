import type { Pgwasm } from "@pgxsinkit/pgwasm";

import { DEFAULT_METADATA_SCHEMA } from "../../packages/client/src/sync/metadata-tables";
import { migrateSubscriptionMetadataTables } from "../../packages/client/src/sync/subscription-state";
import { createFreshTestPgwasm } from "./pgwasm-store";

// A fresh test pgwasm carrying the subscription metadata the native sync engine reads and writes
// (ADR-0029 D3 relations + ADR-0042's session cursors). `createSyncClient` provisions these during
// boot; a test driving `startCircuitsSync` over a bare store has to do it itself, and this is the one
// line that does.
//
// Deliberately NOT folded into `support/pgwasm-store.ts`: this file statically imports client modules, and
// the mock-driven unit suites must not pull them in transitively through a `support/pgwasm-store` import.
// Only the real-stream integration suites use it.
export async function createCircuitsTestPgwasm(): Promise<Pgwasm> {
  const pg = await createFreshTestPgwasm();
  await migrateSubscriptionMetadataTables({ pg, metadataSchema: DEFAULT_METADATA_SCHEMA });
  return pg;
}
