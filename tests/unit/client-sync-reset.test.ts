import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

const order: string[] = [];

const initMetadataTablesMock = mock(async (): Promise<void> => {
  order.push("initMetadataTables");
});

const deleteSubscriptionMock = mock(async (key: string): Promise<void> => {
  order.push(`deleteSubscription:${key}`);
});

const execMock = mock(async (_sql: string): Promise<void> => {
  order.push("applyLocalSchema");
});

type StartConfiguredSyncInput = {
  shapeHeaders?: Record<string, string>;
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
          electric: {
            initMetadataTables: initMetadataTablesMock,
            deleteSubscription: deleteSubscriptionMock,
          },
        }),
      },
    }));

    await mock.module("@electric-sql/pglite/live", () => ({
      live: {},
    }));

    await mock.module("drizzle-orm/pglite", () => ({
      drizzle: () => ({ mocked: true }),
    }));

    await mock.module("@pgxsinkit/sync-engine", () => ({
      createElectricExtension: () => ({}),
      startConfiguredSync: startConfiguredSyncMock,
    }));

    await mock.module("../../packages/client/src/mutation", () => ({
      createMutationRuntime: () => ({
        recoverSending: recoverSendingMock,
        create: async () => undefined,
        update: async () => undefined,
        delete: async () => undefined,
        flush: async () => undefined,
        reconcile: async () => undefined,
        retryFailed: async () => undefined,
        readMutationDetails: async () => [],
        readMutationStats: async () => ({ pendingCount: 0, sendingCount: 0, failedCount: 0, ackedCount: 0 }),
      }),
    }));

    await mock.module("../../packages/client/src/schema", () => ({
      generateLocalSchemaSql: () => "SELECT 1;",
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

    await createSyncClient({
      registry: {
        items: {
          table: {},
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
      } as any,
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      writeUrl: "http://127.0.0.1:3101",
      dataDir: "memory:/client-sync-reset-test",
      resetSubscriptionKeys: ["schema.items", "schema.items", "  "],
    });

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(initMetadataTablesMock).toHaveBeenCalledTimes(1);
    expect(deleteSubscriptionMock).toHaveBeenCalledTimes(1);
    expect(deleteSubscriptionMock).toHaveBeenCalledWith("schema.items");
    expect(startConfiguredSyncMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "applyLocalSchema",
      "initMetadataTables",
      "deleteSubscription:schema.items",
      "startConfiguredSync",
    ]);
    expect(recoverSendingMock).toHaveBeenCalledTimes(1);
  });

  it("applies schema, then prepares the local database before starting sync", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const prepareLocalDbMock = mock(async (_db: unknown): Promise<void> => {
      order.push("prepareLocalDb");
    });

    await createSyncClient({
      registry: {
        items: {
          table: {},
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
      } as any,
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      writeUrl: "http://127.0.0.1:3101",
      dataDir: "memory:/client-sync-prepare-test",
      resetSubscriptionKeys: ["schema.items"],
      prepareLocalDb: prepareLocalDbMock,
    });

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(prepareLocalDbMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "applyLocalSchema",
      "prepareLocalDb",
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

    await createSyncClient({
      registry: {
        items: {
          table: {},
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
      } as any,
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      writeUrl: "http://127.0.0.1:3101",
      dataDir: "memory:/client-sync-prepare-before-schema-test",
      resetSubscriptionKeys: ["schema.items"],
      prepareLocalDbBeforeSchema: prepareLocalDbBeforeSchemaMock,
    });

    expect(prepareLocalDbBeforeSchemaMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "prepareLocalDbBeforeSchema",
      "applyLocalSchema",
      "initMetadataTables",
      "deleteSubscription:schema.items",
      "startConfiguredSync",
    ]);
  });

  it("uses getAuthToken to set shape Authorization headers when authToken is omitted", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const getAuthTokenMock = mock(async (): Promise<string | undefined> => "token-from-get-auth-token");

    await createSyncClient({
      registry: {
        items: {
          table: {},
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
      } as any,
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      writeUrl: "http://127.0.0.1:3101",
      dataDir: "memory:/client-sync-get-auth-token-shape-header-test",
      resetSubscriptionKeys: ["schema.items"],
      getAuthToken: getAuthTokenMock,
    });

    expect(getAuthTokenMock).toHaveBeenCalledTimes(1);
    const syncInput = startConfiguredSyncMock.mock.calls[0]?.[1] as StartConfiguredSyncInput | undefined;
    expect(syncInput?.shapeHeaders).toEqual({ Authorization: "Bearer token-from-get-auth-token" });
  });

  it("does not set shape Authorization headers when getAuthToken returns undefined", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const getAuthTokenMock = mock(async (): Promise<string | undefined> => undefined);

    await createSyncClient({
      registry: {
        items: {
          table: {},
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
      } as any,
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      writeUrl: "http://127.0.0.1:3101",
      dataDir: "memory:/client-sync-no-auth-token-shape-header-test",
      resetSubscriptionKeys: ["schema.items"],
      getAuthToken: getAuthTokenMock,
    });

    expect(getAuthTokenMock).toHaveBeenCalledTimes(1);
    const syncInput = startConfiguredSyncMock.mock.calls[0]?.[1] as StartConfiguredSyncInput | undefined;
    expect(syncInput?.shapeHeaders).toBeUndefined();
  });
});
