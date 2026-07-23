import type { PGlite } from "@electric-sql/pglite";

import { createSyncEngine, type ElectricSyncOptions, type SyncEngine } from "../../packages/client/src/sync/index";
import { createFreshTestPGlite } from "./pglite";

// A fresh test PGlite carrying the pgxsinkit sync engine as its `.electric` namespace (ADR-0032 S1).
// The engine is a plain module over an already-created instance, no longer a create-time PGlite
// extension — so a test constructs the store, then attaches it explicitly, exactly as `createSyncClient`
// does in production. This is the setup-only replacement for the former
// `createFreshTestPGlite({ extensions: { electric: electricSync(...) } })` shim.
//
// Kept OUT of `support/pglite.ts` on purpose: this file statically imports the engine module, and the
// mock-driven unit suites (which `mock.module("@electric-sql/experimental", ...)` before importing the
// engine) must not load it transitively via a `support/pglite` import. Only the real-stream integration
// suites use this helper.
export type SyncEnginePGlite = PGlite & { electric: SyncEngine["namespace"] };

export async function createSyncEngineTestPGlite(options?: ElectricSyncOptions): Promise<SyncEnginePGlite> {
  const pg = await createFreshTestPGlite();
  const engine = await createSyncEngine(pg, options);
  (pg as unknown as { electric: SyncEngine["namespace"] }).electric = engine.namespace;
  return pg as unknown as SyncEnginePGlite;
}
