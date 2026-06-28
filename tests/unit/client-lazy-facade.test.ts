import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import type { DrizzleQueryBuilder } from "../../packages/client/src/index";
import { LazyRelationNotActivatedError } from "../../packages/client/src/lazy-guard";

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
          electric: {
            initMetadataTables: async () => undefined,
            deleteSubscription: async (key: string) => {
              deleteSubscriptionCalls.push(key);
            },
          },
        }),
      },
    }));
    await mock.module("@electric-sql/pglite/live", () => ({ live: {} }));
    await mock.module("drizzle-orm/pglite", () => ({ drizzle: () => ({ mocked: true }) }));
    await mock.module("../../packages/client/src/shape-sync", () => ({
      createElectricExtension: () => ({}),
      startConfiguredSync: startConfiguredSyncMock,
    }));
    await mock.module("../../packages/client/src/local-store", () => ({
      reconcileLocalStoreVersion: async () => undefined,
      readActivatedLazyGroups: async () => new Set<string>(),
      writeLazyGroupActivation: async () => undefined,
      clearLazyGroupActivation: async () => undefined,
    }));
    await mock.module("../../packages/client/src/mutation", () => ({
      createMutationRuntime: () => ({
        recoverSending: async () => undefined,
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
          ackedCount: 0,
        }),
      }),
    }));
    await mock.module("../../packages/client/src/schema", () => ({
      generateLocalSchemaSql: () => "SELECT 1;",
      buildDropReadCacheSql: () => "SELECT 1;",
      buildWipeLocalStoreSql: () => "SELECT 1;",
      buildDesyncTableSql: (_registry: unknown, tableKey: string) => {
        desyncTableCalls.push(tableKey);
        return "SELECT 1;";
      },
      LOCAL_META_TABLE: "pgxsinkit_local_meta",
    }));
  });

  afterAll(() => mock.restore());

  beforeEach(() => {
    started.clear();
    ensureGroupStartedCalls.length = 0;
    stopGroupCalls.length = 0;
    deleteSubscriptionCalls.length = 0;
    desyncTableCalls.length = 0;
    startConfiguredSyncMock.mockClear();
  });

  async function makeClient(dataDir: string) {
    const { createSyncClient } = await import("../../packages/client/src/index");
    return createSyncClient({
      registry: lazyFacadeRegistry(),
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      writeUrl: "http://127.0.0.1:3101",
      dataDir,
    });
  }

  it("query({ use }) activates the declared lazy relation, then runs and returns rows", async () => {
    const client = await makeClient("memory:/lazy-facade-use");
    const rows = await client.query({
      use: ["archive"],
      build: () => fakeBuilder(`select * from "archive"`, [{ id: "a1" }]),
    });

    expect(ensureGroupStartedCalls).toEqual(["archive-shape"]);
    expect(client.isSynced("archive")).toBe(true);
    expect(rows).toEqual([{ id: "a1" }]);
  });

  it("AUTO-ACTIVATES an undeclared lazy relation found in the compiled SQL (no `use` needed)", async () => {
    const client = await makeClient("memory:/lazy-facade-undeclared");
    // No `use` — the SQL scan alone finds `"archive"` and activates it before the query runs.
    const rows = await client.query({ build: () => fakeBuilder(`select * from "archive"`, [{ id: "a1" }]) });
    expect(ensureGroupStartedCalls).toEqual(["archive-shape"]);
    expect(client.isSynced("archive")).toBe(true);
    expect(rows).toEqual([{ id: "a1" }]);
  });

  it("the backstop THROWS when a referenced lazy relation cannot be activated (would read empty/stale)", async () => {
    const client = await makeClient("memory:/lazy-facade-backstop");
    failActivation = true;
    try {
      // archive is scanned and ensureGroupStarted is called, but the start does not take (isTableStarted
      // stays false) — so the backstop refuses to run the query rather than read empty data.
      // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
      await expect(client.query({ build: () => fakeBuilder(`select * from "archive"`, []) })).rejects.toBeInstanceOf(
        LazyRelationNotActivatedError,
      );
      expect(ensureGroupStartedCalls).toEqual(["archive-shape"]); // it DID try to activate
    } finally {
      failActivation = false;
    }
  });

  it("does not trip on a query that touches only eager relations", async () => {
    const client = await makeClient("memory:/lazy-facade-eager");
    const rows = await client.query({
      build: () => fakeBuilder(`select * from "profile"`, [{ id: "p1" }]),
    });
    expect(rows).toEqual([{ id: "p1" }]);
    expect(ensureGroupStartedCalls).toEqual([]);
  });

  it("queryRow returns the first row, or null when empty", async () => {
    const client = await makeClient("memory:/lazy-facade-row");
    const row = await client.queryRow({
      use: ["archive"],
      build: () => fakeBuilder(`select * from "archive"`, [{ id: "a1" }, { id: "a2" }]),
    });
    expect(row).toEqual({ id: "a1" });

    const none = await client.queryRow({
      use: ["archive"],
      build: () => fakeBuilder<{ id: string }>(`select * from "archive"`, []),
    });
    expect(none).toBeNull();
  });

  it("prepareQuery (the live-hook seam) auto-activates lazy relations scanned from the compiled SQL", async () => {
    const client = await makeClient("memory:/lazy-facade-prepare");
    // The seam the React live hooks call: scanning the compiled SQL alone activates `archive` — no `use`.
    await client.prepareQuery({ sql: `select * from "archive"` });
    expect(ensureGroupStartedCalls).toEqual(["archive-shape"]);
    expect(client.isSynced("archive")).toBe(true);
  });

  it("desync stops a lazy relation's group, clears the persisted subscription, and truncates it (ADR-0021 §2)", async () => {
    const client = await makeClient("memory:/lazy-facade-desync");
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
      writeUrl: "http://127.0.0.1:3101",
      dataDir: "memory:/lazy-facade-desync-group",
    });

    // Desyncing one member reverts the whole group: both tables' clusters are truncated, not just `docs`.
    await client.desync("docs");
    expect(desyncTableCalls.sort()).toEqual(["docs", "notes"]);
    expect(deleteSubscriptionCalls).toEqual(["docs-shape"]); // one subscription for the whole group
  });

  it("desync refuses an eager relation (always-on, would immediately re-sync)", async () => {
    const client = await makeClient("memory:/lazy-facade-desync-eager");
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(client.desync("profile")).rejects.toThrow(/only a lazy relation/);
    expect(stopGroupCalls).toEqual([]);
  });

  it("ensureSynced activates a lazy group and isSynced reflects it; both are idempotent", async () => {
    const client = await makeClient("memory:/lazy-facade-ensure");
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
