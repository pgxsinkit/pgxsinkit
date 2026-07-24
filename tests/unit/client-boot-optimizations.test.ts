import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

// Covers the two boot-path client options wired for the board optimisations:
//   1. `pgliteBootAssets` (Part A) — a pre-warmed WASM/fs bundle promise, awaited and passed into
//      `PGlite.create`; a REJECTED warm must be caught to `undefined` and still boot (fallback).
//   2. `writeRequestHeaders` — write-only headers merged over `requestHeaders` on the mutation-flush
//      path, while the read/shape path keeps `requestHeaders` alone (region-pin geometry).
// The real merge/await logic lives in `createSyncClient` (packages/client/src/index.ts); its collaborators
// are mocked so this test captures exactly what that function hands each of them. `mock.module` is
// process-global, so this file runs in its own process (registered in scripts/run-unit-tests.ts ISOLATED).

const profileTable = pgTable("profile", { id: uuid("id").primaryKey(), name: text("name") });

function bootRegistry(): SyncTableRegistry {
  return {
    profile: {
      table: profileTable,
      mode: "readonly",
      primaryKey: { columns: ["id"] },
      shape: { tableName: "profile", shapeKey: "schema.profile" },
      clientProjection: { syncedTable: "profile" },
    },
  } as unknown as SyncTableRegistry;
}

// Captured collaborator inputs, refreshed per test.
let capturedCreateOptions: Record<string, unknown> | undefined;
let capturedMutationOptions: Record<string, unknown> | undefined;
let capturedSyncOptions: Record<string, unknown> | undefined;

const startConfiguredSyncMock = mock(async (_pg: unknown, options: Record<string, unknown>) => {
  capturedSyncOptions = options;
  return {
    unsubscribe: () => undefined,
    tables: {},
    ensureGroupStarted: async () => undefined,
    stopGroup: () => undefined,
    groupKeyForTable: (tableKey: string) => `${tableKey}-shape`,
    isTableStarted: () => true,
  };
});

describe("createSyncClient boot options (pgliteBootAssets + writeRequestHeaders)", () => {
  beforeAll(async () => {
    await mock.module("@electric-sql/pglite", () => ({
      PGlite: {
        create: async (_dataDir: string, options: Record<string, unknown>) => {
          capturedCreateOptions = options;
          return {
            exec: async () => undefined,
            close: async () => undefined,
          };
        },
      },
      // `defineSyncWorker` imports `types` as a runtime value (the identity-parser OID map). The relaxed-
      // durability worker-plumbing test below imports it, so the mocked module must carry these OIDs.
      types: { TIMESTAMP: 1114, TIMESTAMPTZ: 1184, INTERVAL: 1186, DATE: 1082 },
    }));
    await mock.module("@electric-sql/pglite/live", () => ({ live: {} }));
    await mock.module("drizzle-orm/pglite", () => ({ drizzle: () => ({ mocked: true }) }));
    // The sync engine is attached post-create as `.electric` (ADR-0032 S1), so its namespace now comes
    // from `createSyncEngine`'s return rather than the mocked `PGlite.create` instance.
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
      reconcileLocalStoreVersion: async () => null,
      readActivatedLazyGroups: async () => new Set<string>(),
      writeLazyGroupActivation: async () => undefined,
      clearLazyGroupActivation: async () => undefined,
      readStoredLocalSchemaFingerprint: async () => null,
      writeStoredLocalSchemaFingerprint: async () => undefined,
    }));
    await mock.module("../../packages/client/src/mutation", () => ({
      createMutationRuntime: (options: Record<string, unknown>) => {
        capturedMutationOptions = options;
        return {
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
        };
      },
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
    }));
  });

  afterAll(() => mock.restore());

  beforeEach(() => {
    capturedCreateOptions = undefined;
    capturedMutationOptions = undefined;
    capturedSyncOptions = undefined;
    startConfiguredSyncMock.mockClear();
  });

  async function makeClient(extra: Record<string, unknown>) {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const client = await createSyncClient({
      registry: bootRegistry(),
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      storePath: "boot-opts",
      ...extra,
    } as Parameters<typeof createSyncClient>[0]);
    // ADR-0041: `createSyncClient` resolves at `localReadReady`; `startConfiguredSync` (which captures the
    // read/shape header options this suite inspects) runs in the background tail. Await `bootSettled`.
    await client.bootSettled;
    return client;
  }

  it("passes resolved pre-warmed boot assets straight into PGlite.create", async () => {
    const pgliteWasmModule = { fake: "wasm" } as unknown as WebAssembly.Module;
    const fsBundle = new Blob([new Uint8Array([1, 2, 3])]);
    await makeClient({ pgliteBootAssets: Promise.resolve({ pgliteWasmModule, fsBundle }) });

    expect(capturedCreateOptions?.["pgliteWasmModule"]).toBe(pgliteWasmModule);
    expect(capturedCreateOptions?.["fsBundle"]).toBe(fsBundle);
    // The extensions are still wired alongside the pre-warmed assets.
    expect(capturedCreateOptions?.["extensions"]).toBeDefined();
  });

  it("boots (fallback) when the pre-warm promise REJECTS — no asset fields reach PGlite.create", async () => {
    // A failed warm must never fail the boot: createSyncClient catches it to undefined so PGlite.create
    // falls back to loading its own assets.
    const client = await makeClient({ pgliteBootAssets: Promise.reject(new Error("warm failed")) });

    expect(client).toBeDefined();
    expect(capturedCreateOptions).toBeDefined();
    expect(capturedCreateOptions?.["pgliteWasmModule"]).toBeUndefined();
    expect(capturedCreateOptions?.["fsBundle"]).toBeUndefined();
    // Extensions still wired — the boot completed normally.
    expect(capturedCreateOptions?.["extensions"]).toBeDefined();
  });

  it("merges writeRequestHeaders over requestHeaders on the WRITE path only", async () => {
    await makeClient({
      requestHeaders: { apikey: "shared-key" },
      writeRequestHeaders: { "x-region": "eu-central-1" },
      getAuthToken: async () => "tok",
    });

    // Write path (mutation runtime) sees the merged set.
    expect(capturedMutationOptions?.["requestHeaders"]).toEqual({
      apikey: "shared-key",
      "x-region": "eu-central-1",
    });

    // Read/shape path sees the shared base only — NEVER the write-only region pin. `Authorization`
    // rides as an async function (resolved per request), so assert the static keys explicitly.
    const shapeHeaders = capturedSyncOptions?.["shapeHeaders"] as Record<string, unknown> | undefined;
    expect(shapeHeaders?.["apikey"]).toBe("shared-key");
    expect(shapeHeaders?.["x-region"]).toBeUndefined();
    expect(typeof shapeHeaders?.["Authorization"]).toBe("function");
  });

  it("leaves the write path on the shared base when no writeRequestHeaders are given", async () => {
    await makeClient({ requestHeaders: { apikey: "shared-key" } });
    expect(capturedMutationOptions?.["requestHeaders"]).toEqual({ apikey: "shared-key" });
  });

  // ─── Durability (registry-declared, ADR-0047 / ADR-0049 D9; PGlite `relaxedDurability` below) ─────────
  // Durability is a property of the DATA CONTRACT: `storage.durability` on the registry (relaxed default),
  // resolved by `createSyncClient` at the single mint seam and threaded into `createClientPGlite` via its
  // internal carrier — never a per-open/per-worker option. These assert the resolved mode reaches
  // `PGlite.create` as `relaxedDurability` through each surface: the `createSyncClient` boot (default + declared
  // strict), the internal `createClientPGlite` carrier directly, and the `defineSyncWorker` default
  // `createPglite` factory whose provision mint resolves durability off its registry.
  it("defaults durability to relaxed → relaxedDurability true into PGlite.create (createSyncClient)", async () => {
    await makeClient({});
    expect(capturedCreateOptions?.["relaxedDurability"]).toBe(true);
  });

  it('resolves registry storage.durability:"strict" → relaxedDurability false into PGlite.create (createSyncClient)', async () => {
    const { attachSyncRegistryStorage } = await import("@pgxsinkit/contracts");
    await makeClient({ registry: attachSyncRegistryStorage(bootRegistry(), { durability: "strict" }) });
    expect(capturedCreateOptions?.["relaxedDurability"]).toBe(false);
  });

  it("createClientPGlite defaults durability to relaxed → relaxedDurability true", async () => {
    const { createClientPGlite } = await import("../../packages/client/src/index");
    const { memoryStoreForTests } = await import("../../packages/client/src/testing");
    await createClientPGlite(memoryStoreForTests("rd-default"));
    expect(capturedCreateOptions?.["relaxedDurability"]).toBe(true);
  });

  it('createClientPGlite internal durability carrier "strict" → relaxedDurability false', async () => {
    // The internal carrier (toolkit-only; createSyncClient threads the resolved registry mode through it).
    const { createClientPGlite } = await import("../../packages/client/src/index");
    const { memoryStoreForTests } = await import("../../packages/client/src/testing");
    await createClientPGlite(memoryStoreForTests("rd-false"), { durability: "strict" });
    expect(capturedCreateOptions?.["relaxedDurability"]).toBe(false);
  });

  it('defineSyncWorker default createPglite factory resolves registry storage.durability:"strict" → relaxedDurability false on provision', async () => {
    const { defineSyncWorker, provisionSyncWorker } = await import("../../packages/client/src/index");
    const { attachSyncRegistryStorage } = await import("@pgxsinkit/contracts");
    const { memoryStoreForTests } = await import("../../packages/client/src/testing");

    // The registry declares `strict`, so the worker's DEFAULT createPglite factory (no injected `createPglite`) —
    // which the provision path uses to mint the spare store — must resolve it to `relaxedDurability: false`.
    const host = defineSyncWorker({
      registry: attachSyncRegistryStorage(bootRegistry(), { durability: "strict" }),
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      installGlobal: false,
    } as Parameters<typeof defineSyncWorker>[0]);
    const channel = new MessageChannel();
    host.connect(channel.port1 as unknown as never);
    await provisionSyncWorker({ port: channel.port2 as unknown as never, ...memoryStoreForTests("rd-worker-off") });
    expect(capturedCreateOptions?.["relaxedDurability"]).toBe(false);
    await host.close();
    channel.port1.close();
    channel.port2.close();
  });

  it("defineSyncWorker default createPglite factory defaults durability to relaxed → relaxedDurability true on provision", async () => {
    const { defineSyncWorker, provisionSyncWorker } = await import("../../packages/client/src/index");
    const { memoryStoreForTests } = await import("../../packages/client/src/testing");

    // A registry with no storage declaration resolves to the relaxed default, so the provision mint is relaxed.
    const host = defineSyncWorker({
      registry: bootRegistry(),
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      installGlobal: false,
    } as Parameters<typeof defineSyncWorker>[0]);
    const channel = new MessageChannel();
    host.connect(channel.port1 as unknown as never);
    await provisionSyncWorker({ port: channel.port2 as unknown as never, ...memoryStoreForTests("rd-worker-default") });
    expect(capturedCreateOptions?.["relaxedDurability"]).toBe(true);
    await host.close();
    channel.port1.close();
    channel.port2.close();
  });
});
