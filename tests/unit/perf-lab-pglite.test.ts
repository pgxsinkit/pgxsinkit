import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

const destroyMock = mock(async (): Promise<void> => undefined);
const createSyncClientMock = mock(
  async (): Promise<{ pglite: { name: string }; ready: Promise<void>; destroy: () => Promise<void> }> => ({
    pglite: { name: "perf-lab-db" },
    ready: Promise.resolve(),
    destroy: destroyMock,
  }),
);

describe("perf-lab pglite loader", () => {
  beforeAll(async () => {
    await mock.module("@pgxsinkit/client", () => ({
      createSyncClient: createSyncClientMock,
    }));
  });

  afterAll(() => mock.restore());

  beforeEach(() => {
    destroyMock.mockClear();
    createSyncClientMock.mockClear();
  });

  it("resets persisted shape subscriptions for live synced registries", async () => {
    const { loadPerfClient } = await import("../../apps/perf-lab/src/pglite");

    await loadPerfClient(
      {
        perf_items_000: {
          mode: "readwrite",
          table: {},
          primaryKey: { columns: ["id"] },
          shape: { tableName: "perf_items_000", shapeKey: "perf_lab_local_100k.perf_items_000" },
          routes: { basePath: "/api/perf_items_000" },
          clientProjection: {
            syncedTable: "perf_items_000",
            overlayTable: "perf_items_000_overlay",
            journalTable: "perf_items_000_mutations",
          },
        },
      } as unknown as SyncTableRegistry,
      "idb://pgxsinkit-perf-lab-browser",
      {
        mode: "live",
        batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
        electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
        getAuthToken: async () => "token-user1",
        syncEnabled: true,
      },
    );

    expect(createSyncClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resetSubscriptionKeys: ["perf_lab_local_100k.perf_items_000"],
        syncEnabled: true,
      }),
    );
  });

  it("does not request subscription reset for offline mode", async () => {
    const { loadPerfClient } = await import("../../apps/perf-lab/src/pglite");

    await loadPerfClient(
      {
        perf_items_000: {
          mode: "readwrite",
          table: {},
          primaryKey: { columns: ["id"] },
          shape: { tableName: "perf_items_000", shapeKey: "perf_lab_local_100k.perf_items_000" },
          routes: { basePath: "/api/perf_items_000" },
          clientProjection: {
            syncedTable: "perf_items_000",
            overlayTable: "perf_items_000_overlay",
            journalTable: "perf_items_000_mutations",
          },
        },
      } as unknown as SyncTableRegistry,
      "idb://pgxsinkit-perf-lab-browser",
      {
        mode: "offline",
        batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
        electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
        syncEnabled: true,
      },
    );

    expect(createSyncClientMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ resetSubscriptionKeys: expect.anything() }),
    );
    expect(createSyncClientMock).toHaveBeenCalledWith(expect.objectContaining({ syncEnabled: false }));
  });

  it("passes the local database preparation hook through to the sync client", async () => {
    const { loadPerfClient } = await import("../../apps/perf-lab/src/pglite");
    const prepareLocalDbAfterSchema = mock(async (_db: unknown): Promise<void> => undefined);

    await loadPerfClient(
      {
        perf_items_000: {
          mode: "readwrite",
          table: {},
          primaryKey: { columns: ["id"] },
          shape: { tableName: "perf_items_000", shapeKey: "perf_lab_local_100k.perf_items_000" },
          routes: { basePath: "/api/perf_items_000" },
          clientProjection: {
            syncedTable: "perf_items_000",
            overlayTable: "perf_items_000_overlay",
            journalTable: "perf_items_000_mutations",
          },
        },
      } as unknown as SyncTableRegistry,
      "idb://pgxsinkit-perf-lab-browser",
      {
        mode: "live",
        batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
        electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
        getAuthToken: async () => "token-user1",
        syncEnabled: true,
      },
      { prepareLocalDbAfterSchema },
    );

    expect(createSyncClientMock).toHaveBeenCalledWith(expect.objectContaining({ prepareLocalDbAfterSchema }));
  });

  it("passes the pre-schema local database preparation hook through to the sync client", async () => {
    const { loadPerfClient } = await import("../../apps/perf-lab/src/pglite");
    const prepareLocalDbBeforeSchema = mock(async (_db: unknown): Promise<void> => undefined);

    await loadPerfClient(
      {
        perf_items_000: {
          mode: "readwrite",
          table: {},
          primaryKey: { columns: ["id"] },
          shape: { tableName: "perf_items_000", shapeKey: "perf_lab_local_100k.perf_items_000" },
          routes: { basePath: "/api/perf_items_000" },
          clientProjection: {
            syncedTable: "perf_items_000",
            overlayTable: "perf_items_000_overlay",
            journalTable: "perf_items_000_mutations",
          },
        },
      } as unknown as SyncTableRegistry,
      "idb://pgxsinkit-perf-lab-browser",
      {
        mode: "live",
        batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
        electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
        getAuthToken: async () => "token-user1",
        syncEnabled: true,
      },
      { prepareLocalDbBeforeSchema },
    );

    expect(createSyncClientMock).toHaveBeenCalledWith(expect.objectContaining({ prepareLocalDbBeforeSchema }));
  });
});
