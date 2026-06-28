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
let failActivation = false;
const startConfiguredSyncMock = mock(async () => ({
  unsubscribe: () => undefined,
  tables: {},
  ensureGroupStarted: async (groupKey: string) => {
    ensureGroupStartedCalls.push(groupKey);
    if (!failActivation) started.add(groupKey);
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
          electric: { initMetadataTables: async () => undefined, deleteSubscription: async () => undefined },
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
      LOCAL_META_TABLE: "pgxsinkit_local_meta",
    }));
  });

  afterAll(() => mock.restore());

  beforeEach(() => {
    started.clear();
    ensureGroupStartedCalls.length = 0;
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
