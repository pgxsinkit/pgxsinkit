import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
// Dedup × hydration over the worker bridge (ADR-0040 Slice 3, decisions 2/3). Two tabs subscribe the SAME
// SQL with DIFFERENT `use` sets against a consistency group that is still catching up. The assertions: ONE
// PGlite registration is shared (dedup — `use` is excluded from the fingerprint), and EACH tab's hydration
// flow settles independently with rows-before-`live-hydrated` on its own port. Uses the same fully-mocked
// `pglite.live` + startConfiguredSync harness as `worker-live-hydration.test.ts` (no real PGlite/network).

import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

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

// ─── Controllable fake `pglite.live`: one shared FakeLiveQuery, refresh fans to every subscribed listener ──
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
  async unsubscribe(listener: LiveListener) {
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
  const query = new FakeLiveQuery(liveInitialRows);
  createdLiveQueries.push(query);
  return query;
};
const fakeLive = {
  query: async () => makeFake(),
  incrementalQuery: async () => makeFake(),
};

const groupReadyDeferreds = new Map<string, { promise: Promise<void>; resolve: () => void }>();
function holdGroupReady(groupKey: string): () => void {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  groupReadyDeferreds.set(groupKey, { promise, resolve });
  return resolve;
}
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

describe("dedup × hydration over the worker bridge (ADR-0040 Slice 3)", () => {
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

  async function bootHost() {
    const { defineSyncWorker } = await import("../../packages/client/src/index");
    return defineSyncWorker({
      registry: workerRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: true,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
    });
  }

  async function attach(host: Awaited<ReturnType<typeof bootHost>>) {
    const { attachSyncClient } = await import("../../packages/client/src/index");
    const channel = new MessageChannel();
    channels.push(channel);
    host.connect(channel.port1 as unknown as never);
    const client = await attachSyncClient({
      registry: workerRegistry,
      port: channel.port2 as unknown as never,
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    await client.ready;
    return client;
  }

  it("two tabs, same SQL + different `use`, share one registration; each hydrates rows-before-signal", async () => {
    const release = holdGroupReady("profile-shape"); // eager group still catching up
    liveInitialRows = []; // empty local store at subscribe time
    const host = await bootHost();
    const tabA = await attach(host);
    const tabB = await attach(host);

    const orderA: string[] = [];
    const orderB: string[] = [];
    // Same SQL + pkColumns; DIFFERENT `use` (excluded from the fingerprint → still one registration).
    const subA = await tabA.subscribeLiveRows<{ id: string; name: string }>(
      { sql: `select * from "profile"`, params: [], pkColumns: ["id"], use: [] },
      () => orderA.push("rows"),
    );
    const subB = await tabB.subscribeLiveRows<{ id: string; name: string }>(
      { sql: `select * from "profile"`, params: [], pkColumns: ["id"], use: ["profile"] },
      () => orderB.push("rows"),
    );

    // ONE shared PGlite registration for the two identical-fingerprint subscriptions.
    expect(createdLiveQueries).toHaveLength(1);
    // Both tabs saw the pending group and built a hydration promise.
    expect(subA.hydrated).toBeDefined();
    expect(subB.hydrated).toBeDefined();
    void subA.hydrated!.then(() => orderA.push("hydrated"));
    void subB.hydrated!.then(() => orderB.push("hydrated"));

    await tick();
    expect(orderA).toEqual([]);
    expect(orderB).toEqual([]);

    // Catch-up lands on the shared live query, then release the group for BOTH subscribers.
    createdLiveQueries[0]!.currentRows = [{ id: "p1", name: "Ada" }];
    release();
    await Promise.all([subA.hydrated, subB.hydrated]);
    await tick();

    // Each port: the caught-up rows arrived BEFORE its `live-hydrated` signal (rows-before-signal), and the
    // shared registration refreshed at most twice (per-entry refresh coalescing collapses the two hydration
    // refreshes when they align; never once-per-subscriber-uncoalesced beyond the subscriber count).
    expect(orderA).toEqual(["rows", "hydrated"]);
    expect(orderB).toEqual(["rows", "hydrated"]);
    expect(createdLiveQueries[0]!.refreshCount).toBeGreaterThanOrEqual(1);
    expect(createdLiveQueries[0]!.refreshCount).toBeLessThanOrEqual(2);

    subA.unsubscribe();
    subB.unsubscribe();
    await tick();
    await host.close().catch(() => undefined);
  });
});
