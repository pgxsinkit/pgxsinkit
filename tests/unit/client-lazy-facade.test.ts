import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import type { DrizzleQueryBuilder } from "../../packages/client/src/index";
import { LazyRelationNotActivatedError } from "../../packages/client/src/lazy-guard";
import { memoryStoreForTests } from "../../packages/client/src/testing";

// A lazy readonly relation (read via the directly-imported synced table — no view) plus an eager one.
const archiveTable = pgTable("archive", { id: uuid("id").primaryKey(), label: text("label") });
const profileTable = pgTable("profile", { id: uuid("id").primaryKey(), name: text("name") });

function lazyFacadeRegistry(): SyncTableRegistry {
  return {
    profile: {
      table: profileTable,
      mode: "readonly",
      primaryKey: { columns: ["id"] },
      shape: { tableName: "profile", shapeKey: "schema.profile" },
      clientProjection: { syncedTable: "profile" },
    },
    archive: {
      table: archiveTable,
      mode: "readonly",
      subscription: "lazy",
      primaryKey: { columns: ["id"] },
      shape: { tableName: "archive", shapeKey: "schema.archive" },
      clientProjection: { syncedTable: "archive" },
    },
  } as unknown as SyncTableRegistry;
}

// Controllable sync stub: 1 group per table (`<key>-shape`), `started` tracks activation so
// isTableStarted reflects ensureGroupStarted. With `failActivation`, ensureGroupStarted records the call
// but never marks the group started — simulating a start that didn't take (backstop path). Reset per test.
const started = new Set<string>();
const ensureGroupStartedCalls: string[] = [];
const stopGroupCalls: string[] = [];
const deleteSubscriptionCalls: string[] = [];
const desyncTableCalls: string[] = [];
let failActivation = false;
// Controllable mutation-journal stats so the group-teardown owed-writes refusal (shared by desync +
// discardEphemeral) can be exercised. Defaults to all-zero (settled); reset per test.
let mutationStats = {
  pendingCount: 0,
  sendingCount: 0,
  failedCount: 0,
  quarantinedCount: 0,
  conflictedCount: 0,
  rejectedCount: 0,
  ackedCount: 0,
};
// Controllable per-group readiness (catch-up completion, decoupled from activation): a group with a
// registered deferred stays pending until the test resolves it; any other group is trivially ready.
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
  ensureGroupStarted: async (groupKey: string) => {
    ensureGroupStartedCalls.push(groupKey);
    if (!failActivation) started.add(groupKey);
  },
  stopGroup: (groupKey: string) => {
    stopGroupCalls.push(groupKey);
    started.delete(groupKey);
  },
  groupKeyForTable: (tableKey: string) => `${tableKey}-shape`,
  isTableStarted: (tableKey: string) => started.has(`${tableKey}-shape`),
  groupReady: (groupKey: string) => groupReadyDeferreds.get(groupKey)?.promise ?? Promise.resolve(),
  isGroupReady: (groupKey: string) => !groupReadyDeferreds.has(groupKey),
}));

/** A fake Drizzle builder: inspectable SQL + a thenable that resolves the given rows on execution. */
function fakeBuilder<T>(sqlText: string, rows: T[]): DrizzleQueryBuilder<T[]> {
  return {
    toSQL: () => ({ sql: sqlText, params: [] }),
    then: (onFulfilled: (value: T[]) => unknown) => Promise.resolve(rows).then(onFulfilled),
  } as unknown as DrizzleQueryBuilder<T[]>;
}

describe("createSyncClient lazy-relation facade (ADR-0021)", () => {
  beforeAll(async () => {
    await mock.module("@electric-sql/pglite", () => ({
      PGlite: {
        create: async () => ({
          exec: async () => undefined,
          close: async () => undefined,
        }),
      },
    }));
    await mock.module("@electric-sql/pglite/live", () => ({ live: {} }));
    await mock.module("drizzle-orm/pglite", () => ({ drizzle: () => ({ mocked: true }) }));
    // The sync engine is attached post-create as `.electric` (ADR-0032 S1), so the recording namespace
    // now lives on `createSyncEngine`'s return rather than on the mocked `PGlite.create` instance.
    await mock.module("../../packages/client/src/sync", () => ({
      createSyncEngine: async () => ({
        namespace: {
          initMetadataTables: async () => undefined,
          deleteSubscription: async (key: string) => {
            deleteSubscriptionCalls.push(key);
          },
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
        readMutationStats: async () => mutationStats,
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
      buildDesyncTableSql: (_registry: unknown, tableKey: string) => {
        desyncTableCalls.push(tableKey);
        return "SELECT 1;";
      },
      // The data-export (ADR-0035) schema helpers `createSyncClient` imports — the mock must name every
      // export index.ts binds, or bun fails the link with "export not found".
      collectDataExportSyncedTableNames: () => [],
      buildDataExportEnumHeaderSql: () => "",
      buildDataExportCloneCleanupSql: () => "",
      ALL_MUTATIONS_VIEW: "pgxsinkit_all_mutations",
      LOCAL_META_TABLE: "pgxsinkit_local_meta",
    }));
  });

  afterAll(() => mock.restore());

  beforeEach(() => {
    started.clear();
    groupReadyDeferreds.clear();
    ensureGroupStartedCalls.length = 0;
    stopGroupCalls.length = 0;
    deleteSubscriptionCalls.length = 0;
    desyncTableCalls.length = 0;
    mutationStats = {
      pendingCount: 0,
      sendingCount: 0,
      failedCount: 0,
      quarantinedCount: 0,
      conflictedCount: 0,
      rejectedCount: 0,
      ackedCount: 0,
    };
    startConfiguredSyncMock.mockClear();
  });

  async function makeClient(storePath: string) {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const client = await createSyncClient({
      registry: lazyFacadeRegistry(),
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests(storePath),
    });
    // ADR-0041: `createSyncClient` now resolves at `localReadReady`; the sync engine (its mock here) is wired
    // in the background write/sync tail. Await `bootSettled` so `sync` is up before the test drives it.
    await client.bootSettled;
    return client;
  }

  it("queryRaw({ use }) activates the declared lazy relation, then runs and returns rows", async () => {
    const client = await makeClient("lazy-facade-use");
    const rows = await client.queryRaw({
      use: ["archive"],
      build: () => fakeBuilder(`select * from "archive"`, [{ id: "a1" }]),
    });

    expect(ensureGroupStartedCalls).toEqual(["archive-shape"]);
    expect(client.isSynced("archive")).toBe(true);
    expect(rows).toEqual([{ id: "a1" }]);
  });

  it("AUTO-ACTIVATES an undeclared lazy relation found in the compiled SQL (no `use` needed)", async () => {
    const client = await makeClient("lazy-facade-undeclared");
    // No `use` — the SQL scan alone finds `"archive"` and activates it before the query runs.
    const rows = await client.query(() => fakeBuilder(`select * from "archive"`, [{ id: "a1" }]));
    expect(ensureGroupStartedCalls).toEqual(["archive-shape"]);
    expect(client.isSynced("archive")).toBe(true);
    expect(rows).toEqual([{ id: "a1" }]);
  });

  it("the backstop THROWS when a referenced lazy relation cannot be activated (would read empty/stale)", async () => {
    const client = await makeClient("lazy-facade-backstop");
    failActivation = true;
    try {
      // archive is scanned and ensureGroupStarted is called, but the start does not take (isTableStarted
      // stays false) — so the backstop refuses to run the query rather than read empty data.
      // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
      await expect(client.query(() => fakeBuilder(`select * from "archive"`, []))).rejects.toBeInstanceOf(
        LazyRelationNotActivatedError,
      );
      expect(ensureGroupStartedCalls).toEqual(["archive-shape"]); // it DID try to activate
    } finally {
      failActivation = false;
    }
  });

  it("does not trip on a query that touches only eager relations", async () => {
    const client = await makeClient("lazy-facade-eager");
    const rows = await client.query(() => fakeBuilder(`select * from "profile"`, [{ id: "p1" }]));
    expect(rows).toEqual([{ id: "p1" }]);
    expect(ensureGroupStartedCalls).toEqual([]);
  });

  it("queryRow returns the first row, or null when empty", async () => {
    const client = await makeClient("lazy-facade-row");
    const row = await client.queryRow(() => fakeBuilder(`select * from "archive"`, [{ id: "a1" }, { id: "a2" }]));
    expect(row).toEqual({ id: "a1" });

    const none = await client.queryRow(() => fakeBuilder<{ id: string }>(`select * from "archive"`, []));
    expect(none).toBeNull();
  });

  it("queryRawRow({ use }) activates the declared relation and returns the first row", async () => {
    const client = await makeClient("lazy-facade-raw-row");
    const row = await client.queryRawRow({
      use: ["archive"],
      build: () => fakeBuilder(`select * from "archive"`, [{ id: "a1" }, { id: "a2" }]),
    });
    expect(row).toEqual({ id: "a1" });
    expect(ensureGroupStartedCalls).toEqual(["archive-shape"]);
  });

  it("prepareQuery (the live-hook seam) auto-activates lazy relations scanned from the compiled SQL", async () => {
    const client = await makeClient("lazy-facade-prepare");
    // The seam the React live hooks call: scanning the compiled SQL alone activates `archive` — no `use`.
    await client.prepareQuery({ sql: `select * from "archive"` });
    expect(ensureGroupStartedCalls).toEqual(["archive-shape"]);
    expect(client.isSynced("archive")).toBe(true);
  });

  it("prepareQuery returns the activated lazy keys (scan ∪ use); an eager-only query returns none", async () => {
    const client = await makeClient("lazy-facade-prepare-result");
    // The hooks drive `hydrating` off this result: the keys to await `groupReady` for after subscribing.
    const scanned = await client.prepareQuery({ sql: `select * from "archive"` });
    expect(scanned.lazyTables).toEqual(["archive"]);
    const withUse = await client.prepareQuery({ sql: `select 1`, use: ["archive"] });
    expect(withUse.lazyTables).toEqual(["archive"]);
    const eagerOnly = await client.prepareQuery({ sql: `select * from "profile"` });
    expect(eagerOnly.lazyTables).toEqual([]);
  });

  it("activation (prepareQuery) resolves at stream-start while groupReady stays pending until catch-up", async () => {
    const client = await makeClient("lazy-facade-ready-decoupled");
    // Hold the archive group's catch-up open: activation must NOT block on it (offline-first — cached
    // rows stay readable), while `groupReady` — the hooks' `hydrating` gate — must wait for it.
    const releaseCatchUp = holdGroupReady("archive-shape");

    const prepared = await client.prepareQuery({ sql: `select * from "archive"` }); // resolves: stream started
    expect(prepared.lazyTables).toEqual(["archive"]);
    expect(client.isSynced("archive")).toBe(true);

    let caughtUp = false;
    const readyPromise = client.groupReady("archive").then(() => {
      caughtUp = true;
    });
    await Promise.resolve(); // give a wrongly-early resolution the chance to surface
    expect(caughtUp).toBe(false);

    releaseCatchUp();
    await readyPromise;
    expect(caughtUp).toBe(true);
  });

  it("desync stops a lazy relation's group, clears the persisted subscription, and truncates it (ADR-0021 §2)", async () => {
    const client = await makeClient("lazy-facade-desync");
    await client.ensureSynced(["archive"]);
    expect(client.isSynced("archive")).toBe(true);

    await client.desync("archive");
    // It stopped the group (so the stream can't re-fill the truncated cache) and the relation is dormant.
    expect(stopGroupCalls).toEqual(["archive-shape"]);
    expect(client.isSynced("archive")).toBe(false);
    // CRITICAL (review fix): it deleted the group's persisted Electric subscription, so re-activation
    // re-streams from scratch rather than resuming the old cursor and never re-sending the truncated rows.
    expect(deleteSubscriptionCalls).toEqual(["archive-shape"]);
    // And it truncated the (singleton) group's local cluster.
    expect(desyncTableCalls).toEqual(["archive"]);

    // A later reference re-activates it from scratch — desync is the inverse of activation, not destroy.
    await client.ensureSynced(["archive"]);
    expect(client.isSynced("archive")).toBe(true);
  });

  it("desync is group-wide: it truncates EVERY member of a multi-table lazy consistency group (ADR-0021 §4)", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const docsTable = pgTable("docs", { id: uuid("id").primaryKey(), body: text("body") });
    const notesTable = pgTable("notes", { id: uuid("id").primaryKey(), body: text("body") });
    const groupRegistry = {
      docs: {
        table: docsTable,
        mode: "readonly",
        subscription: "lazy",
        consistencyGroup: "library",
        primaryKey: { columns: ["id"] },
        shape: { tableName: "docs", shapeKey: "schema.docs" },
        clientProjection: { syncedTable: "docs" },
      },
      notes: {
        table: notesTable,
        mode: "readonly",
        subscription: "lazy",
        consistencyGroup: "library",
        primaryKey: { columns: ["id"] },
        shape: { tableName: "notes", shapeKey: "schema.notes" },
        clientProjection: { syncedTable: "notes" },
      },
    } as unknown as SyncTableRegistry;

    const client = await createSyncClient({
      registry: groupRegistry,
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("lazy-facade-desync-group"),
    });
    await client.bootSettled;

    // Desyncing one member reverts the whole group: both tables' clusters are truncated, not just `docs`.
    await client.desync("docs");
    expect(desyncTableCalls.sort()).toEqual(["docs", "notes"]);
    expect(deleteSubscriptionCalls).toEqual(["docs-shape"]); // one subscription for the whole group
  });

  it("desync refuses an eager relation (always-on, would immediately re-sync)", async () => {
    const client = await makeClient("lazy-facade-desync-eager");
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(client.desync("profile")).rejects.toThrow(/only a lazy relation/);
    expect(stopGroupCalls).toEqual([]);
  });

  it("discardEphemeral drops an ephemeral lazy relation's rows and reverts it to dormant (ADR-0021)", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const secureTable = pgTable("secure_exam", { id: uuid("id").primaryKey(), body: text("body") });
    const ephemeralRegistry = {
      secure_exam: {
        table: secureTable,
        mode: "readonly",
        subscription: "lazy",
        retention: "ephemeral",
        primaryKey: { columns: ["id"] },
        shape: { tableName: "secure_exam", shapeKey: "schema.secure_exam" },
        clientProjection: { syncedTable: "secure_exam" },
      },
    } as unknown as SyncTableRegistry;

    const client = await createSyncClient({
      registry: ephemeralRegistry,
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("lazy-facade-discard-ephemeral"),
    });
    await client.bootSettled;

    await client.ensureSynced(["secure_exam"]);
    expect(client.isSynced("secure_exam")).toBe(true);

    await client.discardEphemeral("secure_exam");
    // Same group-teardown machinery as desync: stop the stream, drop the persisted subscription, truncate.
    expect(stopGroupCalls).toEqual(["secure_exam-shape"]);
    expect(client.isSynced("secure_exam")).toBe(false);
    expect(deleteSubscriptionCalls).toEqual(["secure_exam-shape"]);
    expect(desyncTableCalls).toEqual(["secure_exam"]);

    // A later reference re-activates it from scratch — discardEphemeral reverts to dormant, it does not destroy.
    await client.ensureSynced(["secure_exam"]);
    expect(client.isSynced("secure_exam")).toBe(true);
  });

  it("discardEphemeral refuses a persistent relation (only ephemeral windows are discardable)", async () => {
    const client = await makeClient("lazy-facade-discard-persistent");
    // `archive` is lazy but PERSISTENT (default retention) — discardEphemeral refuses it; use desync instead.
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(client.discardEphemeral("archive")).rejects.toThrow(/persistent/);
    expect(stopGroupCalls).toEqual([]);
    expect(desyncTableCalls).toEqual([]);
  });

  it("discardEphemeral refuses when ANY consistency-group member is persistent (ADR-0021 §4)", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const windowTable = pgTable("exam_window", { id: uuid("id").primaryKey(), body: text("body") });
    const keysTable = pgTable("exam_keys", { id: uuid("id").primaryKey(), body: text("body") });
    const mixedRegistry = {
      exam_window: {
        table: windowTable,
        mode: "readonly",
        subscription: "lazy",
        retention: "ephemeral",
        consistencyGroup: "exam",
        primaryKey: { columns: ["id"] },
        shape: { tableName: "exam_window", shapeKey: "schema.exam_window" },
        clientProjection: { syncedTable: "exam_window" },
      },
      exam_keys: {
        table: keysTable,
        mode: "readonly",
        subscription: "lazy",
        retention: "persistent",
        consistencyGroup: "exam",
        primaryKey: { columns: ["id"] },
        shape: { tableName: "exam_keys", shapeKey: "schema.exam_keys" },
        clientProjection: { syncedTable: "exam_keys" },
      },
    } as unknown as SyncTableRegistry;

    const client = await createSyncClient({
      registry: mixedRegistry,
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("lazy-facade-discard-mixed"),
    });
    await client.bootSettled;

    // The gate names the persistent member and refuses BEFORE any teardown (no stop, no truncate).
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(client.discardEphemeral("exam_window")).rejects.toThrow(/exam_keys/);
    expect(stopGroupCalls).toEqual([]);
    expect(desyncTableCalls).toEqual([]);
  });

  it("discardEphemeral refuses when the group owes unsettled mutations (shared with desync)", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const draftTable = pgTable("draft", { id: uuid("id").primaryKey(), body: text("body") });
    const writableEphemeral = {
      draft: {
        table: draftTable,
        mode: "readwrite",
        subscription: "lazy",
        retention: "ephemeral",
        conflictPolicy: "last-write-wins",
        primaryKey: { columns: ["id"] },
        shape: { tableName: "draft", shapeKey: "schema.draft" },
        clientProjection: { syncedTable: "draft" },
      },
    } as unknown as SyncTableRegistry;

    const client = await createSyncClient({
      registry: writableEphemeral,
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("lazy-facade-discard-owed"),
    });
    await client.bootSettled;

    mutationStats = { ...mutationStats, pendingCount: 2 };
    // The truncate would drop un-acked local intent — refuse until flushed/discarded (shared owed-writes gate).
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(client.discardEphemeral("draft")).rejects.toThrow(/unsettled mutation/);
    expect(desyncTableCalls).toEqual([]);
  });

  it("ensureSynced activates a lazy group and isSynced reflects it; both are idempotent", async () => {
    const client = await makeClient("lazy-facade-ensure");
    expect(client.isSynced("archive")).toBe(false);

    await client.ensureSynced(["archive"]);
    expect(ensureGroupStartedCalls).toEqual(["archive-shape"]);
    expect(client.isSynced("archive")).toBe(true);

    await client.ensureSynced(["archive"]);
    // ensureGroupStarted is invoked again, but the underlying start is single-flight (verified in
    // shape-sync.test); the stub's Set keeps it idempotent.
    expect(client.isSynced("archive")).toBe(true);
  });
});
