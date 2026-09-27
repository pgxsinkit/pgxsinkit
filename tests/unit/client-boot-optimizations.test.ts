import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

// Covers the two boot-path client options wired for the board optimisations:
//   1. `build` (Part A) — the caller's build, here `createCBuild({ assets })` over a pre-warmed WASM/fs
//      bundle promise, handed on to `createPgwasm`; a REJECTED warm must still boot (the build falls back
//      to its own lazy asset load).
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
let capturedBuildOptions: { assets?: Promise<Record<string, unknown>> } | undefined;
const fakeWarmBuild = { fake: "warm build" };
let capturedMutationOptions: Record<string, unknown> | undefined;
let capturedSyncOptions: Record<string, unknown> | undefined;

const startCircuitsSyncMock = mock(async (_pg: unknown, options: Record<string, unknown>) => {
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

describe("createSyncClient boot options (build + writeRequestHeaders)", () => {
  beforeAll(async () => {
    const realPgwasm = await import("@pgxsinkit/pgwasm");
    await mock.module("@pgxsinkit/pgwasm", () => ({
      ...realPgwasm,
      createPgwasm: async (options: Record<string, unknown>) => {
        capturedCreateOptions = options;
        return {
          exec: async () => undefined,
          close: async () => undefined,
        };
      },
    }));
    const realPgwasmC = await import("@pgxsinkit/pgwasm-c");
    await mock.module("@pgxsinkit/pgwasm-c", () => ({
      ...realPgwasmC,
      createCBuild: (options: { assets?: Promise<Record<string, unknown>> }) => {
        capturedBuildOptions = options;
        return fakeWarmBuild;
      },
    }));
    await mock.module("@pgxsinkit/pgwasm/live", () => ({ live: {} }));
    const realDrizzle = await import("@pgxsinkit/pgwasm/drizzle");
    await mock.module("@pgxsinkit/pgwasm/drizzle", () => ({ ...realDrizzle, drizzle: () => ({ mocked: true }) }));
    // The sync engine is attached post-create as `.electric` (ADR-0032 S1), so its namespace now comes
    // from `createSyncEngine`'s return rather than the mocked `pgwasm.create` instance.
    // The subscription metadata store, which the reset path now calls directly (there is no engine
    // namespace to route through). Stubbed whole: these tests drive boot, not the metadata store.
    await mock.module("../../packages/client/src/sync/subscription-state", () => ({
      migrateSubscriptionMetadataTables: async () => undefined,
      deleteSubscriptionState: async () => undefined,
      getSubscriptionState: async () => null,
      updateSubscriptionState: async () => undefined,
    }));
    await mock.module("../../packages/client/src/circuits/group-sync", () => ({
      startCircuitsSync: startCircuitsSyncMock,
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
    }));
  });

  afterAll(() => mock.restore());

  beforeEach(() => {
    capturedCreateOptions = undefined;
    capturedMutationOptions = undefined;
    capturedSyncOptions = undefined;
    startCircuitsSyncMock.mockClear();
  });

  async function makeClient(extra: Record<string, unknown>) {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const client = await createSyncClient({
      registry: bootRegistry(),
      controlPlaneUrl: "http://127.0.0.1:3101",
      streamBaseUrl: "http://127.0.0.1:3101/v1/stream",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      storePath: "boot-opts",
      ...extra,
    } as Parameters<typeof createSyncClient>[0]);
    // ADR-0041: `createSyncClient` resolves at `localReadReady`; `startCircuitsSync` (which captures the
    // read/shape header options this suite inspects) runs in the background tail. Await `bootSettled`.
    await client.bootSettled;
    return client;
  }

  it("hands the caller's build — a C build over pre-warmed assets — to createPgwasm", async () => {
    const { createCBuild } = await import("@pgxsinkit/pgwasm-c");
    const postgresWasmModule = { fake: "wasm" } as unknown as WebAssembly.Module;
    const fsBundle = new Blob([new Uint8Array([1, 2, 3])]);
    await makeClient({ build: createCBuild({ assets: Promise.resolve({ postgresWasmModule, fsBundle }) }) });

    expect(capturedCreateOptions?.["build"]).toBe(fakeWarmBuild);
    const assets = await capturedBuildOptions?.assets;
    expect(assets?.["postgresWasmModule"]).toBe(postgresWasmModule);
    expect(assets?.["fsBundle"]).toBe(fsBundle);
    // The extensions are still wired alongside the pre-warmed build.
    expect(capturedCreateOptions?.["extensions"]).toBeDefined();
  });

  it("boots when the caller's build carries a REJECTED warm — the build gets the rejection, never the boot", async () => {
    // A failed warm must never fail the boot: the rejection reaches the C build's `assets`, where the build
    // falls back to loading its own assets (pgwasm-c's contract); createSyncClient itself boots normally.
    const { createCBuild } = await import("@pgxsinkit/pgwasm-c");
    const warm = Promise.reject(new Error("warm failed"));
    warm.catch(() => undefined);
    const client = await makeClient({ build: createCBuild({ assets: warm }) });

    expect(client).toBeDefined();
    expect(capturedCreateOptions?.["build"]).toBe(fakeWarmBuild);
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(capturedBuildOptions?.assets).rejects.toThrow("warm failed");
    // Extensions still wired — the boot completed normally.
    expect(capturedCreateOptions?.["extensions"]).toBeDefined();
  });

  it("runs the store on the shared cBuild when no build is given", async () => {
    const { cBuild } = await import("@pgxsinkit/pgwasm-c");
    await makeClient({});
    expect(capturedCreateOptions?.["build"]).toBe(cBuild);
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

    // Read path sees the shared base only — NEVER the write-only region pin. It rides ONE adapter
    // resolved per request (not per-header thunks), so the assertion is on what that adapter returns.
    const authHeaders = capturedSyncOptions?.["authHeaders"] as (() => Promise<Record<string, string>>) | undefined;
    expect(typeof authHeaders).toBe("function");
    if (typeof authHeaders !== "function") throw new Error("expected an auth-header adapter");
    const resolved = await authHeaders();
    expect(resolved["apikey"]).toBe("shared-key");
    expect(resolved["x-region"]).toBeUndefined();
    expect(resolved["Authorization"]).toBe("Bearer tok");
  });

  it("leaves the write path on the shared base when no writeRequestHeaders are given", async () => {
    await makeClient({ requestHeaders: { apikey: "shared-key" } });
    expect(capturedMutationOptions?.["requestHeaders"]).toEqual({ apikey: "shared-key" });
  });

  // ─── Durability (registry-declared, ADR-0047 / ADR-0049 D9; pgwasm `relaxedDurability` below) ─────────
  // Durability is a property of the DATA CONTRACT: `storage.durability` on the registry (relaxed default),
  // resolved by `createSyncClient` at the single mint seam and threaded into `createPgwasmClient` via its
  // internal carrier — never a per-open/per-worker option. These assert the resolved mode reaches
  // `pgwasm.create` as `relaxedDurability` through each surface: the `createSyncClient` boot (default + declared
  // strict), the internal `createPgwasmClient` carrier directly, and the `defineSyncWorker` default
  // `createStore` factory whose provision mint resolves durability off its registry.
  it("defaults durability to relaxed → relaxedDurability true into PGlite.create (createSyncClient)", async () => {
    await makeClient({});
    expect(capturedCreateOptions?.["relaxedDurability"]).toBe(true);
  });

  it('resolves registry storage.durability:"strict" → relaxedDurability false into PGlite.create (createSyncClient)', async () => {
    const { attachSyncRegistryStorage } = await import("@pgxsinkit/contracts");
    await makeClient({ registry: attachSyncRegistryStorage(bootRegistry(), { durability: "strict" }) });
    expect(capturedCreateOptions?.["relaxedDurability"]).toBe(false);
  });

  it("createPgwasmClient defaults durability to relaxed → relaxedDurability true", async () => {
    const { createPgwasmClient } = await import("../../packages/client/src/index");
    const { memoryStoreForTests } = await import("../../packages/client/src/testing");
    await createPgwasmClient(memoryStoreForTests("rd-default"));
    expect(capturedCreateOptions?.["relaxedDurability"]).toBe(true);
  });

  it('createPgwasmClient internal durability carrier "strict" → relaxedDurability false', async () => {
    // The internal carrier (toolkit-only; createSyncClient threads the resolved registry mode through it).
    const { createPgwasmClient } = await import("../../packages/client/src/index");
    const { memoryStoreForTests } = await import("../../packages/client/src/testing");
    await createPgwasmClient(memoryStoreForTests("rd-false"), { durability: "strict" });
    expect(capturedCreateOptions?.["relaxedDurability"]).toBe(false);
  });

  it('defineSyncWorker default createStore factory resolves registry storage.durability:"strict" → relaxedDurability false on provision', async () => {
    const { defineSyncWorker, provisionSyncWorker } = await import("../../packages/client/src/index");
    const { attachSyncRegistryStorage } = await import("@pgxsinkit/contracts");
    const { memoryStoreForTests } = await import("../../packages/client/src/testing");

    // The registry declares `strict`, so the worker's DEFAULT createStore factory (no injected `createStore`) —
    // which the provision path uses to mint the spare store — must resolve it to `relaxedDurability: false`.
    const host = defineSyncWorker({
      registry: attachSyncRegistryStorage(bootRegistry(), { durability: "strict" }),
      controlPlaneUrl: "http://127.0.0.1:1",
      streamBaseUrl: "http://127.0.0.1:1/v1/stream",
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

  it("defineSyncWorker default createStore factory defaults durability to relaxed → relaxedDurability true on provision", async () => {
    const { defineSyncWorker, provisionSyncWorker } = await import("../../packages/client/src/index");
    const { memoryStoreForTests } = await import("../../packages/client/src/testing");

    // A registry with no storage declaration resolves to the relaxed default, so the provision mint is relaxed.
    const host = defineSyncWorker({
      registry: bootRegistry(),
      controlPlaneUrl: "http://127.0.0.1:1",
      streamBaseUrl: "http://127.0.0.1:1/v1/stream",
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
