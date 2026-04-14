import { beforeEach, describe, expect, it, vi } from "vitest";

const order: string[] = [];

const initMetadataTablesMock = vi.fn<() => Promise<void>>(async () => {
  order.push("initMetadataTables");
});

const deleteSubscriptionMock = vi.fn<(key: string) => Promise<void>>(async (key: string) => {
  order.push(`deleteSubscription:${key}`);
});

const startConfiguredSyncMock = vi.fn<() => Promise<{ unsubscribe: () => void; tables: Record<string, never> }>>(
  async () => {
    order.push("startConfiguredSync");
    return {
      unsubscribe: () => undefined,
      tables: {},
    };
  },
);

const recoverSendingMock = vi.fn<() => Promise<void>>(async () => undefined);

vi.mock("@electric-sql/pglite", () => ({
  PGlite: {
    create: async () => ({
      exec: async () => undefined,
      close: async () => undefined,
      electric: {
        initMetadataTables: initMetadataTablesMock,
        deleteSubscription: deleteSubscriptionMock,
      },
    }),
  },
}));

vi.mock("@electric-sql/pglite/live", () => ({
  live: {},
}));

vi.mock("drizzle-orm/pglite", () => ({
  drizzle: () => ({ mocked: true }),
}));

vi.mock("@pgxsinkit/sync-engine", () => ({
  createElectricExtension: () => ({}),
  startConfiguredSync: startConfiguredSyncMock,
}));

vi.mock("../../packages/client/src/mutation", () => ({
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

vi.mock("../../packages/client/src/schema", () => ({
  generateLocalSchemaSql: () => "SELECT 1;",
}));

describe("createSyncClient subscription reset", () => {
  beforeEach(() => {
    order.length = 0;
    initMetadataTablesMock.mockClear();
    deleteSubscriptionMock.mockClear();
    startConfiguredSyncMock.mockClear();
    recoverSendingMock.mockClear();
  });

  it("clears requested subscriptions before starting sync", async () => {
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
            readModel: "items_read_model",
          },
        },
      } as any,
      electricUrl: "http://127.0.0.1:3101/v1/shape-proxy",
      writeUrl: "http://127.0.0.1:3101",
      dataDir: "memory:/client-sync-reset-test",
      resetSubscriptionKeys: ["schema.items", "schema.items", "  "],
    });

    expect(initMetadataTablesMock).toHaveBeenCalledTimes(1);
    expect(deleteSubscriptionMock).toHaveBeenCalledTimes(1);
    expect(deleteSubscriptionMock).toHaveBeenCalledWith("schema.items");
    expect(startConfiguredSyncMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["initMetadataTables", "deleteSubscription:schema.items", "startConfiguredSync"]);
    expect(recoverSendingMock).toHaveBeenCalledTimes(1);
  });

  it("prepares the local database before starting sync", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const prepareLocalDbMock = vi.fn<(db: unknown) => Promise<void>>(async (_db) => {
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
            readModel: "items_read_model",
          },
        },
      } as any,
      electricUrl: "http://127.0.0.1:3101/v1/shape-proxy",
      writeUrl: "http://127.0.0.1:3101",
      dataDir: "memory:/client-sync-prepare-test",
      resetSubscriptionKeys: ["schema.items"],
      prepareLocalDb: prepareLocalDbMock,
    });

    expect(prepareLocalDbMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "prepareLocalDb",
      "initMetadataTables",
      "deleteSubscription:schema.items",
      "startConfiguredSync",
    ]);
  });
});
