import { afterEach, describe, expect, it, spyOn } from "bun:test";
// Lifecycle-slot ADOPTION on the in-process client (ADR-0035 decision 4): `destroy()`, `discardEphemeral()`,
// and `dropReadCache()` now run inside the SAME single-occupancy slot the three exports use, so a destructive
// op can never interleave a running export (nor an export interleave a destructive op) — the typed
// {@link LifecycleBusyError} fires in BOTH directions. Uses a REAL in-memory PGlite (`syncEnabled: false`, no
// network); the contention is made deterministic by GATING the export's `dumpDataDir` on a barrier we
// control, so the export provably holds the slot at the moment the second op is attempted (no timing races).

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { createSyncClient, LifecycleBusyError, type SyncClient } from "../../packages/client/src/index";
import { memoryStoreForTests } from "../../packages/client/src/testing";

// A persistent readwrite table plus a lazy+ephemeral one (`secret_window`) whose whole group is ephemeral —
// the only shape `discardEphemeral` accepts (lazy subscription + every group member `retention: "ephemeral"`).
const registry = defineSyncRegistry({
  todos: defineSyncTable({
    tableName: "todos",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 200 }).notNull(),
      done: boolean("done").notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
  secret_window: defineSyncTable({
    tableName: "secret_window",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      answer: varchar("answer", { length: 200 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
    }),
    mode: "readwrite",
    subscription: "lazy",
    retention: "ephemeral",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});
type Registry = typeof registry;

let client: SyncClient<Registry> | undefined;

afterEach(async () => {
  await client?.stop().catch(() => undefined);
  client = undefined;
});

async function makeClient(storePath: string): Promise<SyncClient<Registry>> {
  return createSyncClient<Registry>({
    registry,
    electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    syncEnabled: false,
    ...memoryStoreForTests(storePath),
  });
}

/**
 * Start an `exportStore` that PROVABLY holds the lifecycle slot: spy on the store's `dumpDataDir` so it blocks
 * on a caller-released barrier. The returned `exportPromise` is in flight and holding the slot once `held`
 * resolves; `release()` lets the real dump proceed so the export completes. This is what makes "op X is
 * refused while an export runs" a deterministic assertion rather than a race on real dump timing.
 */
function holdSlotWithGatedExport(active: SyncClient<Registry>): {
  exportPromise: Promise<unknown>;
  held: Promise<void>;
  release: () => void;
} {
  let markHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const realDump = active.pglite.dumpDataDir.bind(active.pglite);
  spyOn(active.pglite, "dumpDataDir").mockImplementation(async (compression) => {
    // The export is inside the slot by the time `dumpDataDir` runs (slot claimed → CHECKPOINT → dump), so
    // signalling here means the slot is genuinely occupied; then block until the test releases us.
    markHeld();
    await gate;
    return realDump(compression);
  });
  const exportPromise = active.exportStore({ compression: "none" });
  return { exportPromise, held, release };
}

describe("lifecycle-slot adoption on the in-process client (ADR-0035 decision 4)", () => {
  it("refuses destroy while an export holds the slot, then destroy succeeds once the export settles", async () => {
    client = await makeClient("contention-export-vs-destroy");
    await client.ready;

    const { exportPromise, held, release } = holdSlotWithGatedExport(client);
    await held; // the export now provably owns the slot

    // destroy attempted MID-EXPORT is refused immediately with the typed busy error naming the holder.
    const refused = await client.destroy().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LifecycleBusyError);
    expect((refused as LifecycleBusyError).runningLabel).toBe("exportStore");
    expect((refused as LifecycleBusyError).attemptedLabel).toBe("destroy");

    // Free the slot: the export completes normally (its guards/behaviour unchanged by the slot).
    release();
    const { report } = (await exportPromise) as { report: { kind: string } };
    expect(report.kind).toBe("store-backup");

    // After the slot frees, the previously-refused op succeeds.
    await client.destroy();
    client = undefined; // destroy closed the store — nothing for afterEach to stop.
  });

  it("refuses discardEphemeral while an export holds the slot, then it succeeds once the export settles", async () => {
    client = await makeClient("contention-export-vs-discard");
    await client.ready;
    // A real row in the ephemeral (pg_temp) cluster, so the eventual discard has something to clean-truncate.
    await client.rawExec(
      "INSERT INTO secret_window (id, answer, updated_at_us) VALUES ('77777777-7777-7777-7777-777777777777', 'ephemeral-row', 0)",
    );

    const { exportPromise, held, release } = holdSlotWithGatedExport(client);
    await held;

    const refused = await client.discardEphemeral("secret_window").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LifecycleBusyError);
    expect((refused as LifecycleBusyError).runningLabel).toBe("exportStore");
    expect((refused as LifecycleBusyError).attemptedLabel).toBe("discardEphemeral");

    release();
    await exportPromise;

    // Slot free → discardEphemeral runs (its lazy/ephemeral gates unchanged) and drops the ephemeral rows.
    await client.discardEphemeral("secret_window");
    const remaining = await client.rawQuery("SELECT count(*)::int AS n FROM secret_window");
    expect((remaining.rows[0] as { n: number } | undefined)?.n).toBe(0);
  });

  it("refuses dropReadCache while an export holds the slot, then it succeeds once the export settles", async () => {
    client = await makeClient("contention-export-vs-dropcache");
    await client.ready;

    const { exportPromise, held, release } = holdSlotWithGatedExport(client);
    await held;

    const refused = await client.dropReadCache().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LifecycleBusyError);
    expect((refused as LifecycleBusyError).runningLabel).toBe("exportStore");
    expect((refused as LifecycleBusyError).attemptedLabel).toBe("dropReadCache");

    release();
    await exportPromise;

    // Slot free → the drop+rebuild runs and the synced read cache is queryable again (rebuilt, empty).
    await client.dropReadCache();
    const rows = await client.rawQuery("SELECT count(*)::int AS n FROM todos");
    expect((rows.rows[0] as { n: number } | undefined)?.n).toBe(0);
  });

  it("refuses an export while destroy holds the slot (the other direction)", async () => {
    client = await makeClient("contention-destroy-vs-export");
    await client.ready;

    // `destroy` claims the slot SYNCHRONOUSLY (no `await ready` ahead of its `lifecycleSlot.run`), whereas
    // `exportStore` awaits engine-ready first — so issued in the same tick, destroy is the holder and the
    // export is the refused entrant. Deterministic without a gate.
    const [destroyResult, exportResult] = await Promise.allSettled([client.destroy(), client.exportStore()]);
    expect(destroyResult.status).toBe("fulfilled");
    expect(exportResult.status).toBe("rejected");
    const rejected = exportResult as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(LifecycleBusyError);
    expect((rejected.reason as LifecycleBusyError).runningLabel).toBe("destroy");
    expect((rejected.reason as LifecycleBusyError).attemptedLabel).toBe("exportStore");
    client = undefined; // destroy closed the store.
  });
});
