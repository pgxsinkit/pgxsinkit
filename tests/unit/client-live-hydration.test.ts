import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
// The live-rows hydration guarantee on the DIRECT (in-process) client (ADR-0021/0032): a subscription's
// `hydrated` promise now spans EVERY referenced consistency group — eager AND lazy — that is not yet
// caught up at subscribe time, with the same rows-before-signal ordering the lazy path already had. Cached
// rows paint immediately; a steady-state (all-ready) subscription builds no promise and pays no extra
// refresh; a sync-disabled client never gates. Driven over a fully controllable fake `pglite.live` +
// startConfiguredSync stub (no real PGlite/network), mirroring `client-lazy-facade.test.ts`.

import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import { memoryStoreForTests } from "../../packages/client/src/testing";

// One EAGER readonly relation `profile` — eager so it is NOT lazy-activated, yet its consistency group can
// still be mid-catch-up at subscribe time (the exact gap this change closes).
const profileTable = pgTable("profile", { id: uuid("id").primaryKey(), name: text("name") });

function hydrationRegistry(): SyncTableRegistry {
  return {
    profile: {
      table: profileTable,
      mode: "readonly",
      primaryKey: { columns: ["id"] },
      shape: { tableName: "profile", shapeKey: "schema.profile" },
      clientProjection: { syncedTable: "profile" },
    },
  } as unknown as SyncTableRegistry;
}

// ─── Controllable fake `pglite.live` ────────────────────────────────────────────────────────────────
type LiveListener = (results: { rows: Record<string, unknown>[] }) => void;
class FakeLiveQuery {
  readonly initialResults: { rows: Record<string, unknown>[] };
  private readonly listeners = new Set<LiveListener>();
  currentRows: Record<string, unknown>[];
  refreshCount = 0;
  constructor(rows: Record<string, unknown>[]) {
    this.initialResults = { rows };
    this.currentRows = rows;
  }
  subscribe(listener: LiveListener) {
    this.listeners.add(listener);
  }
  unsubscribe(listener: LiveListener) {
    this.listeners.delete(listener);
  }
  // The seam awaits this after catch-up; it must deliver the caught-up rows to the subscriber BEFORE the
  // subscription's `hydrated` promise resolves (rows-before-signal).
  async refresh() {
    this.refreshCount++;
    for (const listener of this.listeners) listener({ rows: this.currentRows });
  }
}

let liveInitialRows: Record<string, unknown>[] = [];
const createdLiveQueries: FakeLiveQuery[] = [];
const fakeLive = {
  query: async () => {
    const q = new FakeLiveQuery(liveInitialRows);
    createdLiveQueries.push(q);
    return q;
  },
};

// ─── Controllable sync stub: 1 group per table (`<key>-shape`); held groups report NOT ready ──────────
const groupReadyDeferreds = new Map<string, { promise: Promise<void>; resolve: () => void }>();
function holdGroupReady(groupKey: string): () => void {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  groupReadyDeferreds.set(groupKey, { promise, resolve });
  return resolve;
}
const startConfiguredSyncMock = mock(async () => ({
  unsubscribe: () => undefined,
  tables: {},
  ensureGroupStarted: async () => undefined,
  stopGroup: () => undefined,
  groupKeyForTable: (tableKey: string) => `${tableKey}-shape`,
  isTableStarted: () => true,
  groupReady: (groupKey: string) => groupReadyDeferreds.get(groupKey)?.promise ?? Promise.resolve(),
  isGroupReady: (groupKey: string) => !groupReadyDeferreds.has(groupKey),
}));

describe("direct client live-rows hydration across eager + lazy groups (ADR-0021/0032)", () => {
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
      reconcileLocalStoreVersion: async () => undefined,
      readActivatedLazyGroups: async () => new Set<string>(),
      writeLazyGroupActivation: async () => undefined,
      clearLazyGroupActivation: async () => undefined,
      readStoredLocalSchemaFingerprint: async () => null,
      writeStoredLocalSchemaFingerprint: async () => undefined,
    }));
    await mock.module("../../packages/client/src/mutation", () => ({
      createMutationRuntime: () => ({
        recoverSending: async () => undefined,
        runBootRecovery: async () => ({ skipped: false, required: true, tablesVisited: 0, rowsRecovered: null }),
        quarantineRecovered: async () => undefined,
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
        batch: async () => undefined,
        flush: async () => undefined,
        reconcile: async () => undefined,
        retryFailed: async () => undefined,
        discardConflict: async () => undefined,
        readMutationDetails: async () => [],
        readMutationStats: async () => ({
          pendingCount: 0,
          sendingCount: 0,
          failedCount: 0,
          quarantinedCount: 0,
          conflictedCount: 0,
          rejectedCount: 0,
          ackedCount: 0,
        }),
      }),
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
    liveInitialRows = [];
    createdLiveQueries.length = 0;
    groupReadyDeferreds.clear();
    startConfiguredSyncMock.mockClear();
  });

  async function makeClient(storePath: string, syncEnabled = true) {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const client = await createSyncClient({
      registry: hydrationRegistry(),
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      syncEnabled,
      ...memoryStoreForTests(storePath),
    });
    // ADR-0041: `createSyncClient` resolves at `localReadReady`; `sync` is wired in the background tail.
    // Await `bootSettled` so `hydratingTablesFor` / `subscribeLiveRows` see the started groups.
    await client.bootSettled;
    return client;
  }

  it("gates hydration on an EAGER group still catching up, resolving only after the caught-up rows land", async () => {
    const client = await makeClient("hydration-eager-pending");
    // profile's group is NOT ready at subscribe time (an eager group mid-catch-up on a cold boot).
    const release = holdGroupReady("profile-shape");
    liveInitialRows = []; // fresh empty local store

    const events: string[] = [];
    const sub = await client.subscribeLiveRows<Record<string, unknown>>(
      { sql: `select * from "profile"`, params: [] },
      () => events.push("rows"),
    );

    // A hydrated promise IS built even though NO lazy relation is read — the eager group is pending.
    expect(sub.hydrated).toBeDefined();
    expect(sub.lazyTables).toBeUndefined(); // eager only → nothing "lazy"
    expect(sub.initialRows).toEqual([]); // painted immediately, still empty
    void sub.hydrated!.then(() => events.push("hydrated"));

    // Nothing resolves while the group is still catching up.
    await Promise.resolve();
    expect(events).toEqual([]);
    expect(createdLiveQueries[0]!.refreshCount).toBe(0);

    // Catch-up lands: stage the caught-up rows, then release the group.
    createdLiveQueries[0]!.currentRows = [{ id: "p1", name: "Ada" }];
    release();
    await sub.hydrated;

    // Rows-before-signal: the refreshed rows were delivered to the subscriber BEFORE `hydrated` resolved.
    expect(events).toEqual(["rows", "hydrated"]);
    expect(createdLiveQueries[0]!.refreshCount).toBe(1);
    sub.unsubscribe();
  });

  it("paints cached rows immediately while `hydrated` is still pending", async () => {
    const client = await makeClient("hydration-cached-rows");
    holdGroupReady("profile-shape"); // stays pending — never released in this test
    liveInitialRows = [{ id: "c1", name: "cached" }];

    const sub = await client.subscribeLiveRows<Record<string, unknown>>(
      { sql: `select * from "profile"`, params: [] },
      () => undefined,
    );
    // Cached rows are available synchronously from the initial snapshot, before any catch-up.
    expect(sub.initialRows).toEqual([{ id: "c1", name: "cached" }]);
    expect(sub.hydrated).toBeDefined();
    let resolved = false;
    void sub.hydrated!.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false); // still hydrating while the group catches up
    sub.unsubscribe();
  });

  it("steady state — every referenced group already ready → NO hydrated promise and NO extra refresh", async () => {
    const client = await makeClient("hydration-steady-state");
    // No held group: isGroupReady("profile-shape") === true.
    liveInitialRows = [{ id: "p1", name: "Ada" }];

    const sub = await client.subscribeLiveRows<Record<string, unknown>>(
      { sql: `select * from "profile"`, params: [] },
      () => undefined,
    );
    expect(sub.hydrated).toBeUndefined();
    expect(sub.initialRows).toEqual([{ id: "p1", name: "Ada" }]);
    // The steady-state fast path builds no promise, so the live query is never force-refreshed.
    expect(createdLiveQueries[0]!.refreshCount).toBe(0);
    sub.unsubscribe();
  });

  it("sync-disabled client never gates hydration (no promise, unchanged behaviour)", async () => {
    const client = await makeClient("hydration-sync-disabled", false);
    // Even a held group is irrelevant: with sync disabled there is no group runtime to consult.
    holdGroupReady("profile-shape");
    liveInitialRows = [];

    const sub = await client.subscribeLiveRows<Record<string, unknown>>(
      { sql: `select * from "profile"`, params: [] },
      () => undefined,
    );
    expect(sub.hydrated).toBeUndefined();
    expect(createdLiveQueries[0]!.refreshCount).toBe(0);
    sub.unsubscribe();
  });

  it("hydratingTablesFor exposes the pending referenced groups (empty in steady state / sync disabled)", async () => {
    const client = await makeClient("hydration-tables-for");
    holdGroupReady("profile-shape");
    // Pending: the eager group is not yet ready.
    expect(client.hydratingTablesFor({ sql: `select * from "profile"` })).toEqual(["profile"]);
    // `use` is folded into the referenced set too.
    expect(client.hydratingTablesFor({ sql: `select 1`, use: ["profile"] })).toEqual(["profile"]);

    // Once ready, the fast path reports nothing pending.
    groupReadyDeferreds.delete("profile-shape");
    expect(client.hydratingTablesFor({ sql: `select * from "profile"` })).toEqual([]);
  });
});
