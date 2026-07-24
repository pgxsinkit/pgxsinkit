import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
// Worker-side lifecycle races for the live-query bridge (ADR-0040 fix round, decision 1). A subscribe records
// its `liveSubs` entry only AFTER prepareQuery/hydration/manager-setup awaits complete; an `unsubscribe` or
// `detach` arriving during those awaits must not leave an orphan subscription live past the port. The worker
// registers the in-flight subscribe SYNCHRONOUSLY in `pendingSubscribes` before the first await and marks it
// cancelled on unsubscribe/detach; after the awaits it tears the subscription down instead of recording it.
// Driven over a fully-mocked `pglite.live` whose registration can be HELD pending, with raw bridge envelopes
// posted on a second port so `queryId` and message timing are fully controllable.

import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

const profileTable = pgTable("profile", { id: uuid("id").primaryKey(), name: text("name") });
const workerRegistry = {
  profile: {
    table: profileTable,
    mode: "readonly",
    // `lazy` so a subscribe's `prepareQuery` awaits the (mockable) `ensureGroupStarted` — a holdable seam
    // that runs BEFORE `ensureLiveManager`, letting the FIX-1 test block a subscribe in its pre-manager phase.
    subscription: "lazy",
    primaryKey: { columns: ["id"] },
    shape: { tableName: "profile", shapeKey: "schema.profile" },
    clientProjection: { syncedTable: "profile" },
  },
} as unknown as SyncTableRegistry;

type LiveListener = (results: { rows: Record<string, unknown>[] }) => void;
class FakeLiveQuery {
  readonly initialResults: { rows: Record<string, unknown>[] };
  private readonly listeners = new Set<LiveListener>();
  unsubscribeCount = 0;
  constructor(rows: Record<string, unknown>[]) {
    this.initialResults = { rows };
  }
  subscribe(listener: LiveListener) {
    this.listeners.add(listener);
  }
  async unsubscribe(listener?: LiveListener) {
    this.unsubscribeCount++;
    if (listener) this.listeners.delete(listener);
    else this.listeners.clear();
  }
  async refresh() {
    /* not exercised here */
  }
}

const createdLiveQueries: FakeLiveQuery[] = [];
let holdRegistration = false;
let releaseRegistration: (() => void) | null = null;
async function maybeHold(): Promise<void> {
  if (!holdRegistration) return;
  await new Promise<void>((resolve) => {
    releaseRegistration = resolve;
  });
}
// A holdable PRE-MANAGER seam (FIX 1): `prepareQuery` awaits `ensureGroupStarted` for the lazy `profile`
// table, which runs BEFORE `ensureLiveManager` — so blocking here blocks a subscribe in its pending-before-
// manager phase, the exact `host.close()` wedge race ADR-0040 decision 1 closes.
let holdGroupStarted = false;
let releaseGroupStarted: (() => void) | null = null;
async function maybeHoldGroupStarted(): Promise<void> {
  if (!holdGroupStarted) return;
  await new Promise<void>((resolve) => {
    releaseGroupStarted = resolve;
  });
}
const fakeLive = {
  query: async () => {
    await maybeHold();
    const q = new FakeLiveQuery([]);
    createdLiveQueries.push(q);
    return q;
  },
  incrementalQuery: async () => {
    await maybeHold();
    const q = new FakeLiveQuery([]);
    createdLiveQueries.push(q);
    return q;
  },
};

const startConfiguredSyncMock = mock(async (_pg: unknown, opts: { onInitialSync?: () => void }) => {
  opts.onInitialSync?.();
  return {
    unsubscribe: () => undefined,
    tables: {},
    ensureGroupStarted: async () => {
      await maybeHoldGroupStarted();
    },
    stopGroup: () => undefined,
    groupKeyForTable: (tableKey: string) => `${tableKey}-shape`,
    isTableStarted: () => true,
    groupReady: () => Promise.resolve(),
    isGroupReady: () => true,
  };
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
let channels: MessageChannel[] = [];

describe("worker live-query lifecycle races (ADR-0040 fix round)", () => {
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
        abortInFlight: () => undefined,
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
    createdLiveQueries.length = 0;
    holdRegistration = false;
    releaseRegistration = null;
    holdGroupStarted = false;
    releaseGroupStarted = null;
    startConfiguredSyncMock.mockClear();
  });

  afterEach(() => {
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
    channels = [];
  });

  async function bootHostAndDriver() {
    const { attachSyncClient, defineSyncWorker, encodeEnvelope, identityCodec } =
      await import("../../packages/client/src/index");
    const host = defineSyncWorker({
      registry: workerRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: true,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
    });
    // Boot the engine via a normal attach on channel A.
    const bootChannel = new MessageChannel();
    channels.push(bootChannel);
    host.connect(bootChannel.port1 as unknown as never);
    const client = await attachSyncClient({
      registry: workerRegistry,
      port: bootChannel.port2 as unknown as never,
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    await client.ready;

    // A second raw-driven port B (the engine is already booted, so it can subscribe without its own attach).
    const driverChannel = new MessageChannel();
    channels.push(driverChannel);
    host.connect(driverChannel.port1 as unknown as never);
    driverChannel.port2.start?.();
    const post = (type: "subscribe" | "unsubscribe" | "detach", payload: unknown, id?: string) => {
      const { envelope } = encodeEnvelope(identityCodec, type, payload as never, id);
      driverChannel.port2.postMessage(envelope);
    };
    return { host, post, encodeEnvelope, identityCodec };
  }

  it("detach during registration setup tears the pending subscription down (no orphan)", async () => {
    const { host, post } = await bootHostAndDriver();
    holdRegistration = true;

    // Subscribe on port B — handleSubscribe registers the pending subscribe, then blocks on the held registration.
    post("subscribe", { queryId: "q-detach", sql: `select * from "profile"`, params: [] }, "sub-1");
    await tick();
    expect(createdLiveQueries).toHaveLength(0); // still blocked in registration

    // Detach port B WHILE the subscribe is mid-await → the pending subscribe is marked cancelled.
    post("detach", null);
    await tick();

    // Release the registration → handleSubscribe resumes, sees the cancellation, and tears the query down.
    releaseRegistration?.();
    await tick();
    expect(createdLiveQueries).toHaveLength(1);
    expect(createdLiveQueries[0]!.unsubscribeCount).toBe(1);

    // host.close() disposes cleanly with nothing leaked.
    await host.close();
  });

  it("unsubscribe arriving before live-initial tears the pending subscription down", async () => {
    const { host, post } = await bootHostAndDriver();
    holdRegistration = true;

    post("subscribe", { queryId: "q-unsub", sql: `select * from "profile"`, params: [] }, "sub-2");
    await tick();
    expect(createdLiveQueries).toHaveLength(0);

    // Unsubscribe the SAME queryId while it is still mid-registration (no liveSubs entry yet) → cancelled.
    post("unsubscribe", { queryId: "q-unsub" });
    await tick();

    releaseRegistration?.();
    await tick();
    expect(createdLiveQueries).toHaveLength(1);
    expect(createdLiveQueries[0]!.unsubscribeCount).toBe(1);

    await host.close();
  });

  it("a normal subscribe (no race) records the subscription and is torn down on close", async () => {
    const { host, post } = await bootHostAndDriver();
    // No hold: the subscribe completes and records its liveSubs entry.
    post("subscribe", { queryId: "q-ok", sql: `select * from "profile"`, params: [] }, "sub-3");
    await tick();
    expect(createdLiveQueries).toHaveLength(1);
    expect(createdLiveQueries[0]!.unsubscribeCount).toBe(0); // live, recorded

    // close() disposes the manager → the recorded subscription is torn down.
    await host.close();
    expect(createdLiveQueries[0]!.unsubscribeCount).toBe(1);
  });

  it("two ports with the SAME queryId stay independent: one port's unsubscribe never touches the other's", async () => {
    // Regression for the cross-tab queryId collision (found by board e2e scenario (c)): `queryId`s are minted
    // by a PER-TAB counter, so two tabs both send `live-1`. The worker's bookkeeping must be port-scoped —
    // before the fix, tab A's unsubscribe looked up the bare id, found tab B's (clobbered) record, and tore
    // down B's live subscription, killing the surviving tab's queries the moment any other tab closed.
    const { host, post, encodeEnvelope, identityCodec } = await bootHostAndDriver();

    // A second raw driver port, C, using the IDENTICAL queryId and SQL as port B's subscription.
    const secondChannel = new MessageChannel();
    channels.push(secondChannel);
    host.connect(secondChannel.port1 as unknown as never);
    secondChannel.port2.start?.();
    const postC = (type: "subscribe" | "unsubscribe" | "detach", payload: unknown, id?: string) => {
      const { envelope } = encodeEnvelope(identityCodec, type, payload as never, id);
      secondChannel.port2.postMessage(envelope);
    };

    post("subscribe", { queryId: "live-1", sql: `select * from "profile"`, params: [] }, "sub-B");
    postC("subscribe", { queryId: "live-1", sql: `select * from "profile"`, params: [] }, "sub-C");
    await tick();
    // Identical SQL dedups onto ONE registration with two subscribers (one per port).
    expect(createdLiveQueries).toHaveLength(1);
    expect(createdLiveQueries[0]!.unsubscribeCount).toBe(0);

    // Port B unsubscribes ITS `live-1`. Port C's identically-numbered subscription must survive: the shared
    // registration stays alive (C still holds it) — pre-fix this tore the whole entry down.
    post("unsubscribe", { queryId: "live-1" });
    await tick();
    expect(createdLiveQueries[0]!.unsubscribeCount).toBe(0);

    // Port C detaches → last subscriber gone → NOW the registration tears down.
    postC("detach", null);
    await tick();
    expect(createdLiveQueries[0]!.unsubscribeCount).toBe(1);

    await host.close();
  });

  it("host.close() awaits a subscribe pending BEFORE manager creation and creates no registration (wedge guard)", async () => {
    // The P1 wedge class (ADR-0040 decision 1): the FIRST-EVER subscribe is held in its pre-manager phase
    // (mid `prepareQuery`, before `ensureLiveManager`). Pre-fix, `close()` saw `liveManager === null`, skipped
    // disposal, and closed the engine while the subscribe went on to build a manager + registration against a
    // closing PGlite — re-creating the close-vs-unsubscribe hang. Now `close()` flips `closing`, cancels the
    // pending subscribe, and AWAITS its in-flight task before disposing; the resumed subscribe early-bails on
    // `closing` and creates nothing.
    const { host, post } = await bootHostAndDriver();
    holdGroupStarted = true; // hold in prepareQuery's group activation → BEFORE ensureLiveManager

    post("subscribe", { queryId: "q-pre", sql: `select * from "profile"`, params: [] }, "sub-pre");
    await tick();
    // Blocked in the pre-manager phase: no manager, hence no fake live query yet.
    expect(createdLiveQueries).toHaveLength(0);

    // close() WITHOUT awaiting: it synchronously flips `closing` + cancels the pending subscribe, then awaits
    // the in-flight `handleSubscribe` task (still blocked on the hold).
    const closed = host.close();
    // Release the pre-manager hold → the subscribe resumes, hits the `closing` early-bail, and returns without
    // creating a manager/registration. `close()`'s await then settles and the rest of teardown runs.
    releaseGroupStarted?.();
    await closed; // resolves cleanly — the wedge shape does not hang

    // No live registration was EVER created: the manager stayed null, so nothing raced the engine close.
    expect(createdLiveQueries).toHaveLength(0);
  });
});
