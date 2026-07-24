import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import { memoryStoreForTests } from "../../packages/client/src/testing";

// A real Drizzle table so `buildSyncConfigFromRegistry` can derive column types / the apply strategy
// (ADR-0009 decision 3) from it; the registry shape is otherwise hand-stubbed for these reset tests.
const itemsTable = pgTable("items", {
  id: uuid("id").primaryKey(),
  title: text("title"),
});

const order: string[] = [];

const initMetadataTablesMock = mock(async (): Promise<void> => {
  order.push("initMetadataTables");
});

const deleteSubscriptionMock = mock(async (key: string): Promise<void> => {
  order.push(`deleteSubscription:${key}`);
});

// Slice 3 (durable-schema fingerprint fast path) split the single boot schema exec into TWO crossings —
// (1) the minimal `pgxsinkit_local_meta` bootstrap, then (2) the durable schema (replayed here because the
// mocked `readStoredLocalSchemaFingerprint` returns null → a fingerprint miss). Both land through this
// mock, so the boot records two `applyLocalSchema` steps, still bracketed by the prepare hooks.
const execMock = mock(async (_sql: string): Promise<void> => {
  order.push("applyLocalSchema");
});

type StartConfiguredSyncInput = {
  // ADR-0013: header values may be async functions resolved per request (the Authorization token),
  // not just frozen strings.
  shapeHeaders?: Record<string, string | (() => string | Promise<string>)>;
};

const startConfiguredSyncMock = mock(
  async (
    _pglite: unknown,
    _input: StartConfiguredSyncInput,
  ): Promise<{ unsubscribe: () => void; tables: Record<string, never> }> => {
    order.push("startConfiguredSync");
    return {
      unsubscribe: () => undefined,
      tables: {},
    };
  },
);

const recoverSendingMock = mock(async (): Promise<void> => undefined);

describe("createSyncClient subscription reset", () => {
  beforeAll(async () => {
    await mock.module("@electric-sql/pglite", () => ({
      PGlite: {
        create: async () => ({
          exec: execMock,
          close: async () => undefined,
        }),
      },
    }));

    await mock.module("@electric-sql/pglite/live", () => ({
      live: {},
    }));

    await mock.module("drizzle-orm/pglite", () => ({
      drizzle: () => ({ mocked: true }),
    }));

    // The sync engine is attached post-create as `.electric` (ADR-0032 S1), so the recording namespace
    // (init + deleteSubscription mocks the reset assertions inspect) now lives on `createSyncEngine`'s
    // return rather than on the mocked `PGlite.create` instance.
    await mock.module("../../packages/client/src/sync", () => ({
      createSyncEngine: async () => ({
        namespace: {
          initMetadataTables: initMetadataTablesMock,
          deleteSubscription: deleteSubscriptionMock,
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
      readStoredRegistryFingerprint: async () => null,
      writeStoredRegistryFingerprint: async () => undefined,
      readActivatedLazyGroups: async () => new Set<string>(),
      writeLazyGroupActivation: async () => undefined,
      clearLazyGroupActivation: async () => undefined,
      readStoredLocalSchemaFingerprint: async () => null,
      writeStoredLocalSchemaFingerprint: async () => undefined,
    }));

    await mock.module("../../packages/client/src/mutation", () => ({
      createMutationRuntime: () => ({
        registryVersion: "stub-fingerprint",
        recoverSending: recoverSendingMock,
        // Boot now drives recovery via `runBootRecovery`; keep the mock delegating to `recoverSendingMock`
        // so the "recovery ran once at boot" assertion below still observes the call.
        runBootRecovery: async () => {
          await recoverSendingMock();
          return { skipped: false, required: true, tablesVisited: 0, rowsRecovered: null };
        },
        quarantineRecovered: async () => undefined,
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
        flush: async () => undefined,
        reconcile: async () => undefined,
        retryFailed: async () => undefined,
        abortInFlight: () => undefined,
        readMutationDetails: async () => [],
        readMutationStats: async () => ({
          pendingCount: 0,
          sendingCount: 0,
          failedCount: 0,
          quarantinedCount: 0,
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
      // The data-export (ADR-0035) schema helpers `createSyncClient` imports — the mock must name every
      // export index.ts binds, or bun fails the link with "export not found".
      collectDataExportSyncedTableNames: () => [],
      buildDataExportEnumHeaderSql: () => "",
      buildDataExportCloneCleanupSql: () => "",
      ALL_MUTATIONS_VIEW: "pgxsinkit_all_mutations",
      LOCAL_META_TABLE: "pgxsinkit_local_meta",
      REGISTRY_FINGERPRINT_KEY: "registry_fingerprint",
    }));
  });

  afterAll(() => mock.restore());

  beforeEach(() => {
    order.length = 0;
    execMock.mockClear();
    initMetadataTablesMock.mockClear();
    deleteSubscriptionMock.mockClear();
    startConfiguredSyncMock.mockClear();
    recoverSendingMock.mockClear();
  });

  it("applies schema and clears requested subscriptions before starting sync", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");

    const client = await createSyncClient({
      registry: {
        items: {
          table: itemsTable,
          mode: "readwrite",
          primaryKey: { columns: ["id"] },
          shape: { tableName: "items", shapeKey: "schema.items" },
          routes: { basePath: "/api/items" },
          clientProjection: {
            syncedTable: "items",
            overlayTable: "items_overlay",
            journalTable: "items_mutations",
          },
        },
      } as unknown as SyncTableRegistry,
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-reset-test"),
      resetSubscriptionKeys: ["schema.items", "schema.items", "  "],
    });
    await client.bootSettled;

    expect(execMock).toHaveBeenCalledTimes(2);
    expect(initMetadataTablesMock).toHaveBeenCalledTimes(1);
    expect(deleteSubscriptionMock).toHaveBeenCalledTimes(1);
    expect(deleteSubscriptionMock).toHaveBeenCalledWith("schema.items");
    expect(startConfiguredSyncMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "applyLocalSchema",
      "applyLocalSchema",
      "initMetadataTables",
      "deleteSubscription:schema.items",
      "startConfiguredSync",
    ]);
    expect(recoverSendingMock).toHaveBeenCalledTimes(1);
  });

  it("applies schema, then prepares the local database before starting sync", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const prepareLocalDbAfterSchemaMock = mock(async (_db: unknown): Promise<void> => {
      order.push("prepareLocalDbAfterSchema");
    });

    const client = await createSyncClient({
      registry: {
        items: {
          table: itemsTable,
          mode: "readwrite",
          primaryKey: { columns: ["id"] },
          shape: { tableName: "items", shapeKey: "schema.items" },
          routes: { basePath: "/api/items" },
          clientProjection: {
            syncedTable: "items",
            overlayTable: "items_overlay",
            journalTable: "items_mutations",
          },
        },
      } as unknown as SyncTableRegistry,
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-prepare-test"),
      resetSubscriptionKeys: ["schema.items"],
      prepareLocalDbAfterSchema: prepareLocalDbAfterSchemaMock,
    });
    await client.bootSettled;

    expect(execMock).toHaveBeenCalledTimes(2);
    expect(prepareLocalDbAfterSchemaMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "applyLocalSchema",
      "applyLocalSchema",
      "prepareLocalDbAfterSchema",
      "initMetadataTables",
      "deleteSubscription:schema.items",
      "startConfiguredSync",
    ]);
  });

  it("calls prepareLocalDbBeforeSchema before applying schema", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const prepareLocalDbBeforeSchemaMock = mock(async (_db: unknown): Promise<void> => {
      order.push("prepareLocalDbBeforeSchema");
    });

    const client = await createSyncClient({
      registry: {
        items: {
          table: itemsTable,
          mode: "readwrite",
          primaryKey: { columns: ["id"] },
          shape: { tableName: "items", shapeKey: "schema.items" },
          routes: { basePath: "/api/items" },
          clientProjection: {
            syncedTable: "items",
            overlayTable: "items_overlay",
            journalTable: "items_mutations",
          },
        },
      } as unknown as SyncTableRegistry,
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-prepare-before-schema-test"),
      resetSubscriptionKeys: ["schema.items"],
      prepareLocalDbBeforeSchema: prepareLocalDbBeforeSchemaMock,
    });
    await client.bootSettled;

    expect(prepareLocalDbBeforeSchemaMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      "prepareLocalDbBeforeSchema",
      "applyLocalSchema",
      "applyLocalSchema",
      "initMetadataTables",
      "deleteSubscription:schema.items",
      "startConfiguredSync",
    ]);
  });

  it("sets a per-request Authorization header function from getAuthToken, not a boot-frozen token (ADR-0013)", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const getAuthTokenMock = mock(async (): Promise<string | undefined> => "token-from-get-auth-token");

    const client = await createSyncClient({
      registry: {
        items: {
          table: itemsTable,
          mode: "readwrite",
          primaryKey: { columns: ["id"] },
          shape: { tableName: "items", shapeKey: "schema.items" },
          routes: { basePath: "/api/items" },
          clientProjection: {
            syncedTable: "items",
            overlayTable: "items_overlay",
            journalTable: "items_mutations",
          },
        },
      } as unknown as SyncTableRegistry,
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-get-auth-token-shape-header-test"),
      resetSubscriptionKeys: ["schema.items"],
      getAuthToken: getAuthTokenMock,
    });
    await client.bootSettled;

    // Boot does NOT consult the provider: the token is resolved per request, not frozen up front.
    expect(getAuthTokenMock).not.toHaveBeenCalled();
    const syncInput = startConfiguredSyncMock.mock.calls[0]?.[1] as StartConfiguredSyncInput | undefined;
    const authorization = syncInput?.shapeHeaders?.["Authorization"];
    expect(typeof authorization).toBe("function");

    // Electric resolves the function on each request → a fresh `Bearer <token>`, consulting the provider.
    if (typeof authorization !== "function") throw new Error("expected an async header function");
    expect(await authorization()).toBe("Bearer token-from-get-auth-token");
    expect(getAuthTokenMock).toHaveBeenCalledTimes(1);
  });

  it("still installs the Authorization function when the token is momentarily undefined (resolves empty, resumes on re-auth)", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const getAuthTokenMock = mock(async (): Promise<string | undefined> => undefined);

    const client = await createSyncClient({
      registry: {
        items: {
          table: itemsTable,
          mode: "readwrite",
          primaryKey: { columns: ["id"] },
          shape: { tableName: "items", shapeKey: "schema.items" },
          routes: { basePath: "/api/items" },
          clientProjection: {
            syncedTable: "items",
            overlayTable: "items_overlay",
            journalTable: "items_mutations",
          },
        },
      } as unknown as SyncTableRegistry,
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-no-auth-token-shape-header-test"),
      resetSubscriptionKeys: ["schema.items"],
      getAuthToken: getAuthTokenMock,
    });
    await client.bootSettled;

    // The header is a function regardless of the token's current value — it is resolved per request,
    // so a later re-auth is picked up without rebuilding the header (unlike a boot-time freeze, which
    // would have omitted the header forever).
    const syncInput = startConfiguredSyncMock.mock.calls[0]?.[1] as StartConfiguredSyncInput | undefined;
    const authorization = syncInput?.shapeHeaders?.["Authorization"];
    expect(typeof authorization).toBe("function");
    if (typeof authorization !== "function") throw new Error("expected an async header function");
    expect(await authorization()).toBe(""); // no token yet → unauthenticated, not "Bearer undefined"
  });

  // #4 + audit finding 5: the read-stream degraded status surfaced through createSyncClient.
  function degradedTestRegistry(): SyncTableRegistry {
    return {
      items: {
        table: itemsTable,
        mode: "readwrite",
        primaryKey: { columns: ["id"] },
        shape: { tableName: "items", shapeKey: "schema.items" },
        routes: { basePath: "/api/items" },
        clientProjection: { syncedTable: "items", overlayTable: "items_overlay", journalTable: "items_mutations" },
      },
    } as unknown as SyncTableRegistry;
  }

  type DegradedSyncCallbacks = {
    onReadStreamError?: (error: Error) => void;
    onSyncActivity?: () => void;
    onSyncError?: (error: Error) => void;
  };

  it("refreshes lastError on each new read-stream fault, then clears the stream-degraded status on recovery", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");

    const client = await createSyncClient({
      registry: degradedTestRegistry(),
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-reset-degraded-refresh"),
    });
    await client.bootSettled;

    const input = startConfiguredSyncMock.mock.calls.at(-1)?.[1] as DegradedSyncCallbacks;

    // First non-auth read-stream fault → degraded, carrying its message.
    input.onReadStreamError?.(new Error("blip-1"));
    expect(client.status.phase).toBe("degraded");
    expect(client.status.lastError).toBe("blip-1");

    // A *different* fault while still degraded must refresh lastError (finding 5: not frozen at the
    // first), staying degraded.
    input.onReadStreamError?.(new Error("blip-2"));
    expect(client.status.phase).toBe("degraded");
    expect(client.status.lastError).toBe("blip-2");

    // A delivered batch clears a stream-degraded status (initial sync never completed here, so it
    // returns to `syncing`, not `ready`).
    input.onSyncActivity?.();
    expect(client.status.phase).toBe("syncing");
  });

  it("a read-stream fault never overwrites a sticky commit-failure degraded status", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");

    const client = await createSyncClient({
      registry: degradedTestRegistry(),
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-reset-degraded-commit"),
    });
    await client.bootSettled;

    const input = startConfiguredSyncMock.mock.calls.at(-1)?.[1] as DegradedSyncCallbacks;

    // A commit exhausted its retries → degraded with the more-serious commit cause.
    input.onSyncError?.(new Error("commit-dead"));
    expect(client.status.phase).toBe("degraded");
    expect(client.status.lastError).toBe("commit-dead");

    // A transient stream blip must NOT mask the commit cause, and a delivered batch must NOT clear a
    // commit-failure degraded (only a clean commit lifts it).
    input.onReadStreamError?.(new Error("stream-blip"));
    expect(client.status.lastError).toBe("commit-dead");
    input.onSyncActivity?.();
    expect(client.status.phase).toBe("degraded");
    expect(client.status.lastError).toBe("commit-dead");
  });
});
