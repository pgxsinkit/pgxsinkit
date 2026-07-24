import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import { memoryStoreForTests } from "../../packages/client/src/testing";

// ADR-0041 staged boot readiness (stage 1) — the in-process core, driven over a fully controllable mock
// harness (mirrors client-lazy-facade.test.ts) so the boot STAGES can be gated and their ordering asserted
// deterministically, no sleeps. The mock seams:
//   * `createMutationRuntime` — `runBootRecovery` awaits `recoveryGate` (contrived slow recovery), records
//     its call order, and `create` records its own; `create` fires `onOrdinaryEnqueue` so ADR-0039
//     write-activation flows through the real client indirection.
//   * `startConfiguredSync` — awaits `syncGate`, records order, and records `ensureGroupStarted` calls.
//   * `reconcileLocalStoreVersion` — records order (proves reconcile runs in the local-read core, before
//     recovery, on a normal boot).
// `mock.module` is process-global, so this file runs isolated (registered in scripts/run-unit-tests.ts).

const secretTable = pgTable("secret", { id: uuid("id").primaryKey(), owner: text("owner") });
const boardTable = pgTable("board", { id: uuid("id").primaryKey(), title: text("title") });

// `secret` is a LAZY writable relation (write-activation target, ADR-0039); `board` is eager readonly.
function stagedRegistry(): SyncTableRegistry {
  return {
    secret: {
      table: secretTable,
      mode: "readwrite",
      subscription: "lazy",
      primaryKey: { columns: ["id"] },
      shape: { tableName: "secret", shapeKey: "schema.secret" },
      clientProjection: { syncedTable: "secret" },
    },
    board: {
      table: boardTable,
      mode: "readonly",
      primaryKey: { columns: ["id"] },
      shape: { tableName: "board", shapeKey: "schema.board" },
      clientProjection: { syncedTable: "board" },
    },
  } as unknown as SyncTableRegistry;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
// Flush pending microtasks so already-resolved stage `.then` callbacks land before we assert order.
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const order: string[] = [];
let recoveryGate: Deferred;
let syncGate: Deferred;
let restoreRecovery = false;
let syncUnsubscribed = false;
const ensureGroupStartedCalls: string[] = [];
const startedTables = new Set<string>();
// Captured from the mutation-runtime options so the mock `create` can drive ADR-0039 write-activation.
let capturedOnOrdinaryEnqueue: ((tables: readonly string[]) => void) | undefined;

// Minimal `pglite.live` so `subscribeLiveRows` (via the live-query manager) works in the mock harness.
type LiveListener = (results: { rows: Record<string, unknown>[] }) => void;
class FakeLiveQuery {
  readonly initialResults = { rows: [] as Record<string, unknown>[] };
  private readonly listeners = new Set<LiveListener>();
  subscribe(listener: LiveListener) {
    this.listeners.add(listener);
  }
  unsubscribe(listener: LiveListener) {
    this.listeners.delete(listener);
  }
  async refresh() {
    for (const listener of this.listeners) listener({ rows: [] });
  }
}
const fakeLive = { query: async () => new FakeLiveQuery() };

const startConfiguredSyncMock = mock(async () => {
  await syncGate.promise;
  order.push("syncStart");
  return {
    unsubscribe: () => {
      syncUnsubscribed = true;
    },
    tables: {},
    ensureGroupStarted: async (groupKey: string) => {
      ensureGroupStartedCalls.push(groupKey);
      startedTables.add(groupKey.replace(/-shape$/, ""));
    },
    stopGroup: () => undefined,
    groupKeyForTable: (tableKey: string) => `${tableKey}-shape`,
    isTableStarted: (tableKey: string) => startedTables.has(tableKey),
    groupReady: () => Promise.resolve(),
    isGroupReady: () => true,
  };
});

describe("ADR-0041 staged boot readiness (stage 1) — in-process core", () => {
  beforeAll(async () => {
    await mock.module("@electric-sql/pglite", () => ({
      PGlite: {
        create: async () => ({
          exec: async () => undefined,
          close: async () => undefined,
          query: async () => ({ rows: [] }),
          live: fakeLive,
        }),
      },
    }));
    await mock.module("@electric-sql/pglite/live", () => ({ live: {} }));
    await mock.module("drizzle-orm/pglite", () => ({ drizzle: () => ({ mocked: true }) }));
    await mock.module("../../packages/client/src/sync", () => ({
      createSyncEngine: async () => ({
        namespace: {
          initMetadataTables: async () => undefined,
          deleteSubscription: async () => undefined,
          syncShapesToTables: async () => undefined,
          syncShapeToTable: async () => undefined,
        },
        close: async () => undefined,
      }),
    }));
    await mock.module("../../packages/client/src/shape-sync", () => ({
      startConfiguredSync: startConfiguredSyncMock,
    }));
    await mock.module("../../packages/client/src/local-store", () => ({
      reconcileLocalStoreVersion: async () => {
        order.push("reconcile");
        return null;
      },
      readActivatedLazyGroups: async () => new Set<string>(),
      writeLazyGroupActivation: async () => undefined,
      clearLazyGroupActivation: async () => undefined,
      readStoredLocalSchemaFingerprint: async () => null,
      writeStoredLocalSchemaFingerprint: async () => undefined,
    }));
    await mock.module("../../packages/client/src/mutation", () => ({
      createMutationRuntime: (options: { onOrdinaryEnqueue?: (tables: readonly string[]) => void }) => {
        capturedOnOrdinaryEnqueue = options.onOrdinaryEnqueue;
        return {
          recoverSending: async () => undefined,
          runBootRecovery: async () => {
            // Restore quarantine (if any) is part of this stage — record it BEFORE the gate so a restore
            // boot's ordering (quarantine before read exposure) can be asserted, then contrive slowness.
            order.push(restoreRecovery ? "recovery+quarantine" : "recovery");
            await recoveryGate.promise;
            return { skipped: false, required: true, tablesVisited: 0, rowsRecovered: null };
          },
          quarantineRecovered: async () => undefined,
          create: async (table: string) => {
            order.push(`create:${table}`);
            capturedOnOrdinaryEnqueue?.([table]);
          },
          update: async () => undefined,
          delete: async () => undefined,
          batch: async () => undefined,
          flush: async () => undefined,
          reconcile: async () => undefined,
          retryFailed: async () => undefined,
          discardConflict: async () => undefined,
          readMutationDetails: async () => [],
          abortInFlight: () => undefined,
          readMutationStats: async () => ({
            pendingCount: 0,
            sendingCount: 0,
            failedCount: 0,
            // ADR-0046: the restore-boot lane models a backup that recovered a write — a non-zero quarantined
            // count keeps that restore OFFLINE (the protective case), so its ordering assertion has no
            // `syncStart`. Normal boots (`restoreRecovery` false) report a clean journal, unchanged.
            quarantinedCount: restoreRecovery ? 1 : 0,
            conflictedCount: 0,
            rejectedCount: 0,
            ackedCount: 0,
          }),
        };
      },
    }));
    await mock.module("../../packages/client/src/schema", () => ({
      generateLocalSchemaSql: () => "SELECT 1;",
      generateDurableLocalSchemaSql: () => "SELECT 1;",
      generateEphemeralLocalSchemaSql: () => "",
      buildLocalMetaBootstrapSql: () => "SELECT 1;",
      computeLocalSchemaFingerprint: () => "lsf1:mock",
      buildDropReadCacheSql: () => "SELECT 1;",
      buildWipeLocalStoreSql: () => "SELECT 1;",
      buildDesyncTableSql: () => "SELECT 1;",
      collectDataExportSyncedTableNames: () => [],
      buildDataExportEnumHeaderSql: () => "",
      buildDataExportCloneCleanupSql: () => "",
      ALL_MUTATIONS_VIEW: "pgxsinkit_all_mutations",
      LOCAL_META_TABLE: "pgxsinkit_local_meta",
    }));
  });

  afterAll(() => mock.restore());

  beforeEach(() => {
    order.length = 0;
    ensureGroupStartedCalls.length = 0;
    startedTables.clear();
    recoveryGate = deferred();
    syncGate = deferred();
    restoreRecovery = false;
    syncUnsubscribed = false;
    capturedOnOrdinaryEnqueue = undefined;
    startConfiguredSyncMock.mockClear();
  });

  async function makeClient(storePath: string, extra: Record<string, unknown> = {}) {
    const { createSyncClient } = await import("../../packages/client/src/index");
    return createSyncClient({
      registry: stagedRegistry(),
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests(storePath),
      ...extra,
    } as Parameters<typeof createSyncClient>[0]);
  }

  it("resolves localReadReady, then writeReady, then bootSettled — a strict monotonic order (normal boot)", async () => {
    // Recovery + sync are gated, so the write/sync tail is suspended when createSyncClient resolves.
    const client = await makeClient("staged-order");

    const stageOrder: string[] = [];
    void client.localReadReady.then(() => stageOrder.push("localReadReady"));
    void client.writeReady.then(() => stageOrder.push("writeReady"));
    void client.bootSettled.then(() => stageOrder.push("bootSettled"));
    await flush();
    // The function resolved AT localReadReady; writeReady + bootSettled are still gated. Reconcile ran in the
    // local-read core BEFORE recovery (the ADR-0041 normal-boot reorder); recovery has ENTERED but is gated,
    // so writeReady has not resolved.
    expect(stageOrder).toEqual(["localReadReady"]);
    expect(order).toEqual(["reconcile", "recovery"]);

    recoveryGate.resolve();
    await flush();
    // writeReady resolves once recovery completes — still before sync start (gated).
    expect(stageOrder).toEqual(["localReadReady", "writeReady"]);
    expect(order).toEqual(["reconcile", "recovery"]);

    syncGate.resolve();
    await client.bootSettled;
    await flush();
    expect(stageOrder).toEqual(["localReadReady", "writeReady", "bootSettled"]);
    expect(order).toEqual(["reconcile", "recovery", "syncStart"]);
    await client.stop();
  });

  it("a write issued the instant localReadReady resolves awaits writeReady, then completes — never opaquely", async () => {
    const client = await makeClient("staged-write-before-writeready");
    // The moment we hold the client (localReadReady), start a write. Recovery is gated, so writeReady is
    // still pending: the write must AWAIT it, not race an unfinished boot nor throw.
    let writeError: unknown = null;
    let writeDone = false;
    const writePromise = client.mutate
      .create("secret", { id: "11111111-1111-1111-1111-111111111111", owner: "me" })
      .then(
        () => {
          writeDone = true;
        },
        (error: unknown) => {
          writeError = error;
        },
      );
    await flush();
    // The write is parked on writeReady (recovery is gated) — its runtime `create` has NOT run and it has
    // not errored. Recovery has been ENTERED but not completed, so writeReady is still pending.
    expect(order).not.toContain("create:secret");
    expect(writeDone).toBe(false);
    expect(writeError).toBeNull();

    // Release recovery → writeReady resolves → the write proceeds.
    recoveryGate.resolve();
    syncGate.resolve();
    await writePromise;
    expect(writeError).toBeNull();
    expect(writeDone).toBe(true);
    // The runtime write ran only AFTER recovery (writeReady), never before.
    expect(order.indexOf("create:secret")).toBeGreaterThan(order.indexOf("recovery"));
    await client.stop();
  });

  it("restore boot: recovery + quarantine complete BEFORE localReadReady resolves (read exposure)", async () => {
    // A restore boot must quarantine every recovered write before any read facade is handed out. On a restore
    // boot recovery+quarantine run in the CORE, so `localReadReady` cannot resolve until they finish.
    restoreRecovery = true;
    recoveryGate.resolve();
    syncGate.resolve();
    const client = await makeClient("staged-restore", { restoreFrom: new Blob([new Uint8Array([1])]) });

    let localReadResolved = false;
    void client.localReadReady.then(() => {
      localReadResolved = true;
    });
    await flush();
    expect(localReadResolved).toBe(true);
    // recovery+quarantine ran FIRST, THEN reconcile — and `localReadReady` resolves after reconcile in the
    // core, so read exposure is strictly after quarantine (the ADR-0041 restore invariant). This restore
    // recovered a write (quarantined > 0), so it stays offline (ADR-0046) — no `syncStart` entry.
    expect(order).toEqual(["recovery+quarantine", "reconcile"]);
    await client.stop();
  });

  it("ADR-0039: a write enqueued at writeReady (before sync is wired) still activates its lazy group once sync starts", async () => {
    const client = await makeClient("staged-adr0039");
    // Release recovery only — writeReady resolves, but sync is still gated (sync == null in the client).
    recoveryGate.resolve();
    await client.writeReady;
    await flush();

    // Enqueue a write to the LAZY relation `secret` while sync is still down: its activation is buffered.
    await client.mutate.create("secret", { id: "22222222-2222-2222-2222-222222222222", owner: "me" });
    await flush();
    // Sync is not wired yet, so nothing has been activated — the activation is queued, not lost.
    expect(ensureGroupStartedCalls).toEqual([]);

    // Wire sync → the buffered activation replays and starts the lazy group's stream.
    syncGate.resolve();
    await client.bootSettled;
    await flush();
    expect(ensureGroupStartedCalls).toEqual(["secret-shape"]);
    await client.stop();
  });

  it("BLOCKER 2: stop() at localReadReady quiesces the tail — no sync stream is started after stop", async () => {
    // Recovery is gated, so the tail is parked at recovery when the constructor resolves (localReadReady).
    const client = await makeClient("staged-stop-race");

    // Stop immediately (the StrictMode mount/unmount case). `stop()` flags disposal and awaits `bootSettled`;
    // do NOT await it yet — the tail is still parked behind the recovery gate.
    const stopPromise = client.stop();
    await flush();
    // Sync has not started (the tail never reached sync-start), and it cannot now.
    expect(startConfiguredSyncMock).not.toHaveBeenCalled();

    // Release recovery: the tail resumes, sees `disposed`, and BAILS before writeReady / sync-start.
    recoveryGate.resolve();
    syncGate.resolve(); // proves it is the disposal bail, not the gate, that prevents sync start
    await stopPromise; // stop completes (bootSettled resolved by the bailed tail) — no hang
    await flush();

    // The tail never started a shape stream, and never set the runtime running.
    expect(startConfiguredSyncMock).not.toHaveBeenCalled();
    expect(order).not.toContain("syncStart");
    expect(syncUnsubscribed).toBe(false); // nothing to unsubscribe — nothing was started
    expect(client.status.isRunning).toBe(false);
  });

  it("BLOCKER 3: a lazy subscription opened at localReadReady (sync pending) is hydrating, then activates + hydrates once sync wires", async () => {
    // Recovery released, sync gated → after writeReady the client sits in the sync-PENDING window (sync == null
    // but syncEnabled true), exactly the Option B gap a mounted component subscribes in.
    const client = await makeClient("staged-hydrate-window");
    recoveryGate.resolve();
    await client.writeReady;
    await flush();

    // hydratingTablesFor treats the not-yet-wired group as hydrating (NOT trivially ready).
    expect(client.hydratingTablesFor({ sql: `select * from "secret"` })).toEqual(["secret"]);

    // Open a live subscription on the lazy relation in the pending window: a `hydrated` promise IS built.
    const sub = await client.subscribeLiveRows({ sql: `select * from "secret"`, params: [] }, () => undefined);
    expect(sub.hydrated).toBeDefined();
    let hydratedResolved = false;
    void sub.hydrated!.then(() => {
      hydratedResolved = true;
    });

    // Activate the group (what the React hook's prepareQuery does): it parks on `syncWired`, not dropped.
    const activation = client.ensureSynced(["secret"]);
    let activated = false;
    void activation.then(() => {
      activated = true;
    });
    await flush();
    expect(activated).toBe(false); // parked until sync wires
    expect(hydratedResolved).toBe(false); // still hydrating
    expect(ensureGroupStartedCalls).toEqual([]);

    // Wire sync → the parked activation completes, the group starts, and hydration resolves.
    syncGate.resolve();
    await client.bootSettled;
    await activation;
    await sub.hydrated;
    await flush();
    expect(activated).toBe(true);
    expect(ensureGroupStartedCalls).toContain("secret-shape");
    expect(hydratedResolved).toBe(true);
    // Now wired + group ready → no longer hydrating.
    expect(client.hydratingTablesFor({ sql: `select * from "secret"` })).toEqual([]);
    await client.stop();
  });

  it("FIX 2: stop() mid-boot rejects a parked write (writeReady) and `ready` with ClientDisposedError — no hang", async () => {
    // Recovery is gated, so at localReadReady `writeReady`/`ready` are still pending.
    const client = await makeClient("staged-dispose-reject");

    // Park a mutation on `writeReady` and an `await ready` / `start()` before stopping.
    let writeError: unknown = null;
    let readyError: unknown = null;
    const writePromise = client.mutate
      .create("secret", { id: "33333333-3333-3333-3333-333333333333", owner: "me" })
      .then(
        () => undefined,
        (error: unknown) => {
          writeError = error;
        },
      );
    const readyPromise = client.ready.then(
      () => undefined,
      (error: unknown) => {
        readyError = error;
      },
    );
    await flush();

    // Stop mid-boot: quiesce rejects the still-pending `writeReady` + `ready` immediately, then awaits the
    // tail's settlement (which needs the gates released to bail). Do not await stop() yet.
    const stopPromise = client.stop();
    await flush();

    // The parked write and the ready-awaiter reject with the typed disposed error — BEFORE any teardown wait.
    await Promise.all([writePromise, readyPromise]);
    expect((writeError as Error | null)?.name).toBe("ClientDisposedError");
    expect((readyError as Error | null)?.name).toBe("ClientDisposedError");

    // Release the gates so the tail bails on `disposed` and `bootSettled` resolves → stop() completes (no hang).
    recoveryGate.resolve();
    syncGate.resolve();
    await stopPromise;
    // `bootSettled` still RESOLVES as teardown completion (not rejected).
    await client.bootSettled;
    // No sync stream was started after the stop.
    expect(startConfiguredSyncMock).not.toHaveBeenCalled();
  });
});
