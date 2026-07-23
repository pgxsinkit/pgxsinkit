import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
// The hydration guarantee over the WORKER bridge (ADR-0021/0032): `defineSyncWorker`'s `subscribe` handler
// computes the pending referenced groups (eager AND lazy) on its owned client, reports them on
// `live-initial` (`hydratingTables`), and posts `live-hydrated` only after the caught-up rows' diff on the
// SAME port (rows-before-signal). The tab (`attachSyncClient`) turns a non-empty `hydratingTables` into the
// subscription's `hydrated` promise. Driven over a bun `MessageChannel` with a fully controllable fake
// `pglite.live` + startConfiguredSync stub — no real PGlite/network (mirrors `client-lazy-facade`).

import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

// One EAGER readonly relation `profile` — eager so it is never lazy-activated, yet its consistency group can
// still be mid-catch-up when a subscription registers (the exact gap this change closes over the bridge).
const profileTable = pgTable("profile", { id: uuid("id").primaryKey(), name: text("name") });
const workerRegistry = {
  profile: {
    table: profileTable,
    mode: "readonly",
    primaryKey: { columns: ["id"] },
    shape: { tableName: "profile", shapeKey: "schema.profile" },
    clientProjection: { syncedTable: "profile" },
  },
} as unknown as SyncTableRegistry;

// ─── Controllable fake `pglite.live` (incrementalQuery for single-PK subscriptions) ──────────────────
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
  async refresh() {
    this.refreshCount++;
    for (const listener of this.listeners) listener({ rows: this.currentRows });
  }
}

let liveInitialRows: Record<string, unknown>[] = [];
const createdLiveQueries: FakeLiveQuery[] = [];
const makeFake = () => {
  const q = new FakeLiveQuery(liveInitialRows);
  createdLiveQueries.push(q);
  return q;
};
const fakeLive = {
  query: async () => makeFake(),
  incrementalQuery: async () => makeFake(),
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
// Fire `onInitialSync` so the worker's engine reaches phase "ready" (the tab awaits `client.ready`), while
// a held group's `groupReady`/`isGroupReady` stay pending — decoupling boot readiness from a group still
// catching up, exactly what the hydration signal must observe.
const startConfiguredSyncMock = mock(async (_pg: unknown, opts: { onInitialSync?: () => void }) => {
  opts.onInitialSync?.();
  return {
    unsubscribe: () => undefined,
    tables: {},
    ensureGroupStarted: async () => undefined,
    stopGroup: () => undefined,
    groupKeyForTable: (tableKey: string) => `${tableKey}-shape`,
    isTableStarted: () => true,
    groupReady: (groupKey: string) => groupReadyDeferreds.get(groupKey)?.promise ?? Promise.resolve(),
    isGroupReady: (groupKey: string) => !groupReadyDeferreds.has(groupKey),
  };
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
let channels: MessageChannel[] = [];

describe("worker-bridge live-rows hydration across eager + lazy groups (ADR-0021/0032)", () => {
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

  afterEach(() => {
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
    channels = [];
  });

  async function bootWorkerAndAttach() {
    const { attachSyncClient, defineSyncWorker } = await import("../../packages/client/src/index");
    const host = defineSyncWorker({
      registry: workerRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: true,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
    });
    const channel = new MessageChannel();
    channels.push(channel);
    host.connect(channel.port1 as unknown as never);
    const client = await attachSyncClient({
      registry: workerRegistry,
      port: channel.port2 as unknown as never,
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    await client.ready;
    return { host, client };
  }

  it("carries `hydratingTables` for a not-ready EAGER group and settles `hydrated` after the caught-up diff", async () => {
    const release = holdGroupReady("profile-shape"); // eager group still catching up
    liveInitialRows = []; // fresh empty local store
    const { host, client } = await bootWorkerAndAttach();

    const emissions: string[] = [];
    const sub = await client.subscribeLiveRows<{ id: string; name: string }>(
      { sql: `select * from "profile"`, params: [], pkColumns: ["id"] },
      () => emissions.push("rows"),
    );

    // The worker reported the pending eager group → the tab built a `hydrated` promise (no lazy relation).
    expect(sub.lazyTables).toBeUndefined();
    expect(sub.hydrated).toBeDefined();
    void sub.hydrated!.then(() => emissions.push("hydrated"));

    await tick();
    expect(emissions).toEqual([]); // nothing while the group is still catching up

    // Catch-up lands: stage the caught-up rows on the worker's live query, then release the group.
    createdLiveQueries[0]!.currentRows = [{ id: "p1", name: "Ada" }];
    release();
    await sub.hydrated;
    await tick();

    // Rows-before-signal across the bridge: the refresh diff (rows) was delivered to the tab BEFORE the
    // `live-hydrated` that resolves `hydrated`.
    expect(emissions).toEqual(["rows", "hydrated"]);
    sub.unsubscribe();
    await tick();
    await host.close().catch(() => undefined);
  });

  it("omits `hydratingTables`/`hydrated` when every referenced group is already ready (steady state)", async () => {
    // No held group → isGroupReady("profile-shape") === true.
    liveInitialRows = [{ id: "p1", name: "Ada" }];
    const { host, client } = await bootWorkerAndAttach();

    const sub = await client.subscribeLiveRows<{ id: string; name: string }>(
      { sql: `select * from "profile"`, params: [], pkColumns: ["id"] },
      () => undefined,
    );
    expect(sub.initialRows).toEqual([{ id: "p1", name: "Ada" }]);
    expect(sub.hydrated).toBeUndefined();
    // No pending group → the worker never force-refreshes the live query.
    await tick();
    expect(createdLiveQueries[0]!.refreshCount).toBe(0);
    sub.unsubscribe();
    await tick();
    await host.close().catch(() => undefined);
  });
});
