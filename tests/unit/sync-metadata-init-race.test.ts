/**
 * F2 — metadata-table initialization must be race-safe across concurrent eager sync groups.
 *
 * `startConfiguredSync` starts eager groups concurrently (`Promise.all`). The old guard set a boolean
 * `initMetadataTablesDone = true` BEFORE awaiting the async DDL, so a second concurrent group could see
 * the flag, skip the wait, and query the metadata tables before the first group's DDL had run. The fix
 * memoizes the DDL as a PROMISE every concurrent caller awaits. This drives two concurrent
 * `syncShapeToTable` starts (each with a non-null key, so each reads subscription state right after
 * init) against a fresh store and proves the migration runs exactly once and both callers complete.
 *
 * Runs in its own `bun test` invocation (the ISOLATED set) because `mock.module` is process-global.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { integer, text } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import type { ShapeStreamOptions } from "../../packages/client/src/sync/types";
import { createTablesFromSchema } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

const registry = defineSyncRegistry({
  alpha: defineSyncTable({
    tableName: "alpha",
    makeColumns: () => ({ id: integer("id").primaryKey(), note: text("note") }),
  }),
  beta: defineSyncTable({
    tableName: "beta",
    makeColumns: () => ({ id: integer("id").primaryKey(), note: text("note") }),
  }),
});

// A minimal stream mock: the engine only needs `shapes.shape` and a `subscribe` — this test never drives
// messages, it exercises the pre-subscribe metadata-init path.
const MockMultiShapeStream = mock((_initOpts?: ShapeStreamOptions) => ({
  subscribe: mock(),
  unsubscribeAll: mock(),
  isUpToDate: true,
  shapes: { shape: { subscribe: mock(), unsubscribeAll: mock() } },
}));
await mock.module("@electric-sql/experimental", () => ({ MultiShapeStream: MockMultiShapeStream }));

const { createSyncEngine } = await import("../../packages/client/src/sync/index");

// Attach the sync engine as `.electric` on a freshly-created PGlite (ADR-0032 S1) — a plain module over
// the instance, no longer a create-time extension. Setup-only shim; assertions are unchanged.
type SyncEnginePGlite = PGlite & { electric: Awaited<ReturnType<typeof createSyncEngine>>["namespace"] };
async function attachSyncEngine(
  pg: PGlite,
  options?: Parameters<typeof createSyncEngine>[1],
): Promise<SyncEnginePGlite> {
  const engine = await createSyncEngine(pg, options);
  (pg as unknown as { electric: SyncEnginePGlite["electric"] }).electric = engine.namespace;
  return pg as SyncEnginePGlite;
}

describe("metadata-table init race (F2 — concurrent eager groups)", () => {
  let pg: SyncEnginePGlite;

  beforeEach(async () => {
    pg = await attachSyncEngine(await createFreshTestPGlite(), { debug: false });
    await createTablesFromSchema(pg, { alpha: registry.alpha.table, beta: registry.beta.table });
  });

  it("runs the metadata migration exactly once and both concurrent starts complete", async () => {
    // Count the metadata migration by the `CREATE SCHEMA` statement it (and only it) issues via pg.exec.
    let migrationExecs = 0;
    const realExec = pg.exec.bind(pg);
    pg.exec = ((query: string, ...rest: unknown[]) => {
      if (typeof query === "string" && query.includes("CREATE SCHEMA IF NOT EXISTS")) {
        migrationExecs += 1;
      }
      return (realExec as (q: string, ...r: unknown[]) => unknown)(query, ...rest);
    }) as typeof pg.exec;

    const start = (tableKey: "alpha" | "beta", shapeKey: string) =>
      pg.electric.syncShapeToTable({
        shape: { url: "http://localhost:3000/v1/shape", params: { table: tableKey } },
        registry,
        tableKey,
        // Non-null key ⇒ each start reads subscription state right after init — the exact read the old
        // boolean guard let race ahead of the DDL.
        shapeKey,
      });

    // Both eager groups start together, as `Promise.all` in startConfiguredSync would.
    const [a, b] = await Promise.all([start("alpha", "ka"), start("beta", "kb")]);

    // Reaching here without throwing means neither start queried the metadata tables before the DDL ran.
    expect(migrationExecs).toBe(1);
    expect(typeof a.unsubscribe).toBe("function");
    expect(typeof b.unsubscribe).toBe("function");

    a.unsubscribe();
    b.unsubscribe();
  });
});
