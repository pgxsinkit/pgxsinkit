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

const migrateMetadataTablesMock = mock(async (): Promise<void> => {
  order.push("migrateSubscriptionMetadataTables");
});

const deleteSubscriptionStateMock = mock(async ({ subscriptionKey }: { subscriptionKey: string }): Promise<void> => {
  order.push(`deleteSubscriptionState:${subscriptionKey}`);
});

// Slice 3 (durable-schema fingerprint fast path) split the single boot schema exec into TWO crossings —
// (1) the minimal `pgxsinkit_local_meta` bootstrap, then (2) the durable schema (replayed here because the
// mocked `readStoredLocalSchemaFingerprint` returns null → a fingerprint miss). Both land through this
// mock, so the boot records two `applyLocalSchema` steps, still bracketed by the prepare hooks.
const execMock = mock(async (_sql: string): Promise<void> => {
  order.push("applyLocalSchema");
});

type StartCircuitsSyncInput = {
  // ADR-0013: ONE adapter resolved per request, rather than per-header values frozen at boot. The
  // native control plane is asked for headers on every call it makes, so a token that refreshed
  // mid-subscription is picked up without the subscription noticing.
  authHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
};

const startCircuitsSyncMock = mock(
  async (
    _pglite: unknown,
    _input: StartCircuitsSyncInput,
  ): Promise<{ unsubscribe: () => void; tables: Record<string, never> }> => {
    order.push("startCircuitsSync");
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

    // The reset path calls the subscription metadata store DIRECTLY (there is no engine namespace to
    // route through any more), so this is the module the ordering assertions observe. Every export
    // index.ts and the sync engine bind must be named, or the client fails to link.
    await mock.module("../../packages/client/src/sync/subscription-state", () => ({
      migrateSubscriptionMetadataTables: migrateMetadataTablesMock,
      deleteSubscriptionState: deleteSubscriptionStateMock,
      getSubscriptionState: async () => null,
      updateSubscriptionState: async () => undefined,
    }));

    await mock.module("../../packages/client/src/circuits/group-sync", () => ({
      startCircuitsSync: startCircuitsSyncMock,
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
      // The native read path's subscription metadata store (ADR-0055) reaches this module directly
      // rather than through the mocked `./sync` barrel, so the partial mock must carry the DDL
      // renderer, or the whole client fails to load.
      renderCreateTableSql: () => [],
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
      // The Event lane's Outbox (ADR-0053): `local-tables.ts` imports the name from this module, so a
      // partial mock of it must carry the constant or the whole client fails to load.
      OUTBOX_TABLE: "pgxsinkit_outbox",
      OUTBOX_SEQUENCE: "pgxsinkit_outbox_seq",
      REGISTRY_FINGERPRINT_KEY: "registry_fingerprint",
    }));
  });

  afterAll(() => mock.restore());

  beforeEach(() => {
    order.length = 0;
    execMock.mockClear();
    migrateMetadataTablesMock.mockClear();
    deleteSubscriptionStateMock.mockClear();
    startCircuitsSyncMock.mockClear();
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
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-reset-test"),
      resetSubscriptionKeys: ["schema.items", "schema.items", "  "],
    });
    await client.bootSettled;

    expect(execMock).toHaveBeenCalledTimes(2);
    expect(migrateMetadataTablesMock).toHaveBeenCalledTimes(1);
    expect(deleteSubscriptionStateMock).toHaveBeenCalledTimes(1);
    expect(deleteSubscriptionStateMock.mock.calls[0]?.[0]?.subscriptionKey).toBe("schema.items");
    expect(startCircuitsSyncMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "applyLocalSchema",
      "applyLocalSchema",
      "migrateSubscriptionMetadataTables",
      "deleteSubscriptionState:schema.items",
      "startCircuitsSync",
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
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
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
      "migrateSubscriptionMetadataTables",
      "deleteSubscriptionState:schema.items",
      "startCircuitsSync",
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
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
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
      "migrateSubscriptionMetadataTables",
      "deleteSubscriptionState:schema.items",
      "startCircuitsSync",
    ]);
  });

  it("resolves Authorization from getAuthToken per request, not from a boot-frozen token (ADR-0013)", async () => {
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
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-get-auth-token-shape-header-test"),
      resetSubscriptionKeys: ["schema.items"],
      getAuthToken: getAuthTokenMock,
    });
    await client.bootSettled;

    // Boot does NOT consult the provider: the token is resolved per request, not frozen up front.
    expect(getAuthTokenMock).not.toHaveBeenCalled();
    const syncInput = startCircuitsSyncMock.mock.calls[0]?.[1] as StartCircuitsSyncInput | undefined;
    const authHeaders = syncInput?.authHeaders;
    expect(typeof authHeaders).toBe("function");

    // The control plane calls the adapter on each request → a fresh `Bearer <token>`, consulting the provider.
    if (typeof authHeaders !== "function") throw new Error("expected an auth-header adapter");
    expect((await authHeaders())["Authorization"]).toBe("Bearer token-from-get-auth-token");
    expect(getAuthTokenMock).toHaveBeenCalledTimes(1);
  });

  it("still installs the auth adapter when the token is momentarily undefined (omits the header, resumes on re-auth)", async () => {
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
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-no-auth-token-shape-header-test"),
      resetSubscriptionKeys: ["schema.items"],
      getAuthToken: getAuthTokenMock,
    });
    await client.bootSettled;

    // The adapter is installed regardless of the token's current value — it is resolved per request,
    // so a later re-auth is picked up without rebuilding anything (unlike a boot-time freeze, which
    // would have omitted the header forever).
    const syncInput = startCircuitsSyncMock.mock.calls[0]?.[1] as StartCircuitsSyncInput | undefined;
    const authHeaders = syncInput?.authHeaders;
    expect(typeof authHeaders).toBe("function");
    if (typeof authHeaders !== "function") throw new Error("expected an auth-header adapter");
    // No token yet → the header is ABSENT, not "Bearer undefined". An unauthenticated subscribe is
    // refused with a 401 the client can retry through, which is what makes re-auth recoverable.
    expect((await authHeaders())["Authorization"]).toBeUndefined();
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
    onSubscribeError?: (error: Error) => void;
    onAuthError?: (error: Error) => void;
    onSyncActivity?: () => void;
    onSyncError?: (error: Error) => void;
    onInitialSync?: () => void;
  };

  it("refreshes lastError on each new subscribe fault, then clears the stream-degraded status on recovery", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");

    const client = await createSyncClient({
      registry: degradedTestRegistry(),
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-reset-degraded-refresh"),
    });
    await client.bootSettled;

    const input = startCircuitsSyncMock.mock.calls.at(-1)?.[1] as DegradedSyncCallbacks;

    // First non-auth subscribe fault → degraded, carrying its message.
    input.onSubscribeError?.(new Error("blip-1"));
    expect(client.status.phase).toBe("degraded");
    expect(client.status.lastError).toContain("blip-1");

    // A *different* fault while still degraded must refresh lastError (finding 5: not frozen at the
    // first), staying degraded.
    input.onSubscribeError?.(new Error("blip-2"));
    expect(client.status.phase).toBe("degraded");
    expect(client.status.lastError).toContain("blip-2");
    expect(client.status.lastError).not.toContain("blip-1");

    // A delivered batch clears a stream-degraded status (initial sync never completed here, so it
    // returns to `syncing`, not `ready`).
    input.onSyncActivity?.();
    expect(client.status.phase).toBe("syncing");
  });

  it("a refused credential surfaces auth-needed once, and a delivered batch clears it (ADR-0013)", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");

    const emissions: string[] = [];
    const client = await createSyncClient({
      registry: degradedTestRegistry(),
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-reset-auth-needed"),
      onStatusChange: (status) => emissions.push(status.phase),
      // Only wired when a token provider exists — without one there is no auth lifecycle to track.
      getAuthToken: async () => "stale-token",
    });
    await client.bootSettled;

    const input = startCircuitsSyncMock.mock.calls.at(-1)?.[1] as DegradedSyncCallbacks;
    emissions.length = 0;

    // A control plane that refused the subject's own credential. The subscription keeps retrying, so
    // this fires on every attempt for as long as the token stays stale.
    input.onAuthError?.(new Error("401"));
    expect(client.status.phase).toBe("auth-needed");
    expect(emissions).toEqual(["auth-needed"]);

    // TRANSITION-only: re-entering would re-emit to every status listener (and, in worker mode,
    // re-broadcast to every attached tab) on every retry tick, forever.
    input.onAuthError?.(new Error("401"));
    input.onAuthError?.(new Error("401"));
    expect(emissions).toEqual(["auth-needed"]);

    // Re-auth: the next delivered batch is proof the fresh token works, with no restart and no manual
    // re-subscribe (initial sync never completed here, so it returns to `syncing`, not `ready`).
    input.onSyncActivity?.();
    expect(client.status.phase).toBe("syncing");
    expect(emissions).toEqual(["auth-needed", "syncing"]);
  });

  it("a subscribe outage never masks auth-needed, nor a sticky commit-failure degraded", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");

    const client = await createSyncClient({
      registry: degradedTestRegistry(),
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-reset-stall-precedence"),
    });
    await client.bootSettled;

    const input = startCircuitsSyncMock.mock.calls.at(-1)?.[1] as DegradedSyncCallbacks;

    // A commit that exhausted its retries is the more serious cause: a subscribe outage must not
    // overwrite its `lastError`, and the delivered-batch recovery must not lift it.
    input.onSyncError?.(new Error("commit-dead"));
    input.onSubscribeError?.(new Error("control-plane-down"));
    expect(client.status.phase).toBe("degraded");
    expect(client.status.lastError).toBe("commit-dead");
    input.onSyncActivity?.();
    expect(client.status.phase).toBe("degraded");
  });

  it("a subscribe fault never overwrites a sticky commit-failure degraded status", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");

    const client = await createSyncClient({
      registry: degradedTestRegistry(),
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-reset-degraded-commit"),
    });
    await client.bootSettled;

    const input = startCircuitsSyncMock.mock.calls.at(-1)?.[1] as DegradedSyncCallbacks;

    // A commit exhausted its retries → degraded with the more-serious commit cause.
    input.onSyncError?.(new Error("commit-dead"));
    expect(client.status.phase).toBe("degraded");
    expect(client.status.lastError).toBe("commit-dead");

    // A transient control-plane blip must NOT mask the commit cause, and a delivered batch must NOT
    // clear a commit-failure degraded (only a clean commit lifts it).
    input.onSubscribeError?.(new Error("control-plane-blip"));
    expect(client.status.lastError).toBe("commit-dead");
    input.onSyncActivity?.();
    expect(client.status.phase).toBe("degraded");
    expect(client.status.lastError).toBe("commit-dead");
  });

  it("ready falls to degraded when the read stream goes silent, and recovers on the next batch", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");

    // The "Up to date offline" lie (maintainer-observed): a pulled cable HANGS the live long-poll, so
    // nothing fails (the stall probe hears only settled attempts) and nothing delivers — a runtime that
    // reached `ready` this session kept claiming it indefinitely. A healthy Electric stream is never
    // silent (the long-poll cycles with at least a bare up-to-date), so silence past the window while
    // claiming `ready` IS evidence, and the phase must drop to the shared stream-degraded state.
    const emissions: string[] = [];
    const client = await createSyncClient({
      registry: degradedTestRegistry(),
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-reset-read-silence"),
      readSilenceMs: 40,
      onStatusChange: (status) => emissions.push(status.phase),
    });
    await client.bootSettled;
    const input = startCircuitsSyncMock.mock.calls.at(-1)?.[1] as DegradedSyncCallbacks;

    input.onSyncActivity?.();
    input.onInitialSync?.();
    expect(client.status.phase).toBe("ready");

    // Traffic inside every window keeps re-arming the watchdog: two windows with activity stay ready.
    await new Promise((resolve) => setTimeout(resolve, 25));
    input.onSyncActivity?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(client.status.phase).toBe("ready");

    // Silence past the window → degraded, with a lastError that names the silence. Recovery is the
    // shared stream-degraded path: the next delivered batch returns it to ready (initial sync completed
    // this session), never a permanent wedge.
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(client.status.phase).toBe("degraded");
    expect(client.status.lastError).toContain("silent");
    input.onSyncActivity?.();
    expect(client.status.phase).toBe("ready");
    expect(emissions.at(-2)).toBe("degraded");
    expect(emissions.at(-1)).toBe("ready");
  });

  it("stop clears the read-silence watchdog — no post-stop emission", async () => {
    const { createSyncClient } = await import("../../packages/client/src/index");

    const emissions: string[] = [];
    const client = await createSyncClient({
      registry: degradedTestRegistry(),
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...memoryStoreForTests("client-sync-reset-read-silence-stop"),
      readSilenceMs: 40,
      onStatusChange: (status) => emissions.push(status.phase),
    });
    await client.bootSettled;
    const input = startCircuitsSyncMock.mock.calls.at(-1)?.[1] as DegradedSyncCallbacks;

    input.onSyncActivity?.();
    input.onInitialSync?.();
    expect(client.status.phase).toBe("ready");

    // Snapshot AFTER stop (stop may emit its own transition); the assertion is that the armed watchdog
    // never fires past it — a cleared timer, not a suppressed emission.
    await client.stop();
    const emissionsAfterStop = emissions.length;
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(emissions.length).toBe(emissionsAfterStop);
  });
});
