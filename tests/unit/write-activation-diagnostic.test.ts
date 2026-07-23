import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import { sql } from "drizzle-orm";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import { DENY_ALL, type JwtClaims, type SyncTableRegistry } from "@pgxsinkit/contracts";

import { memoryStoreForTests } from "../../packages/client/src/testing";

// ADR-0039 — activating a claims-dependent lazy group (its row filter denies unauthenticated callers)
// with no auth token opens an empty subscription by construction, so the client emits ONE console.warn
// per group. Write-triggered and read-triggered activation both flow through the same `ensureSynced`
// choke point, so this diagnostic covers writes too. It never blocks or fails activation.

const secretTable = pgTable("secret", { id: uuid("id").primaryKey(), owner: text("owner") });
const publicTable = pgTable("public_notes", { id: uuid("id").primaryKey(), body: text("body") });
const boardTable = pgTable("board", { id: uuid("id").primaryKey(), title: text("title") });

// `secret` denies anonymous callers via the DENY_ALL sentinel (claims-dependent); `public_notes` has no
// filter (not claims-dependent). Both are lazy so activation is deferred to first reference. `board` is
// eager (default) — a registry key that is NOT a lazy activation target, so a write to it activates nothing.
function diagnosticRegistry(): SyncTableRegistry {
  return {
    secret: {
      table: secretTable,
      mode: "readonly",
      subscription: "lazy",
      primaryKey: { columns: ["id"] },
      shape: {
        tableName: "secret",
        shapeKey: "schema.secret",
        rowFilter: { customWhere: (claims: JwtClaims) => (claims.sub ? sql`"owner" = ${claims.sub}` : DENY_ALL) },
      },
      clientProjection: { syncedTable: "secret" },
    },
    public_notes: {
      table: publicTable,
      mode: "readonly",
      subscription: "lazy",
      primaryKey: { columns: ["id"] },
      shape: { tableName: "public_notes", shapeKey: "schema.public_notes" },
      clientProjection: { syncedTable: "public_notes" },
    },
    board: {
      table: boardTable,
      mode: "readonly",
      primaryKey: { columns: ["id"] },
      shape: { tableName: "board", shapeKey: "schema.board" },
      clientProjection: { syncedTable: "board" },
    },
  } as unknown as SyncTableRegistry;
}

const started = new Set<string>();
// When true, the NEXT ensureGroupStarted rejects once (then self-clears) — to prove a failed activation
// is swallowed by the client's fire-and-forget `.catch` and never becomes an unhandled rejection.
let failNextActivation = false;
const startConfiguredSyncMock = mock(async () => ({
  unsubscribe: () => undefined,
  tables: {},
  ensureGroupStarted: async (groupKey: string) => {
    if (failNextActivation) {
      failNextActivation = false;
      throw new Error("activation failed");
    }
    started.add(groupKey);
  },
  stopGroup: (groupKey: string) => {
    started.delete(groupKey);
  },
  groupKeyForTable: (tableKey: string) => `${tableKey}-shape`,
  isTableStarted: (tableKey: string) => started.has(`${tableKey}-shape`),
  groupReady: () => Promise.resolve(),
  isGroupReady: () => true,
}));

// The `onOrdinaryEnqueue` hook the client wires into the (mocked) mutation runtime — captured so a test
// can drive it exactly as the real runtime would on an ordinary write, exercising the index.ts seam:
// filter-to-lazy → fire-and-forget ensureSynced.
let capturedOnOrdinaryEnqueue: ((tables: readonly string[]) => void) | undefined;

/** Flush the fire-and-forget auth probe (one awaited `getAuthToken`) so its warn (if any) has emitted. */
async function settleProbe() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const ANON_WARN_PREFIX = "pgxsinkit: activating the lazy group";

describe("anonymous-activation diagnostic (ADR-0039)", () => {
  const originalWarn = console.warn;
  let warnings: string[] = [];

  beforeAll(async () => {
    await mock.module("@electric-sql/pglite", () => ({
      PGlite: {
        create: async () => ({ exec: async () => undefined, close: async () => undefined }),
      },
    }));
    await mock.module("@electric-sql/pglite/live", () => ({ live: {} }));
    await mock.module("drizzle-orm/pglite", () => ({ drizzle: () => ({ mocked: true }) }));
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
      reconcileLocalStoreVersion: async () => undefined,
      readActivatedLazyGroups: async () => new Set<string>(),
      writeLazyGroupActivation: async () => undefined,
      clearLazyGroupActivation: async () => undefined,
      readStoredLocalSchemaFingerprint: async () => null,
      writeStoredLocalSchemaFingerprint: async () => undefined,
    }));
    await mock.module("../../packages/client/src/mutation", () => ({
      createMutationRuntime: (options: { onOrdinaryEnqueue?: (tables: readonly string[]) => void }) => {
        capturedOnOrdinaryEnqueue = options.onOrdinaryEnqueue;
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
    startConfiguredSyncMock.mockClear();
    capturedOnOrdinaryEnqueue = undefined;
    failNextActivation = false;
    warnings = [];
    console.warn = (...args: unknown[]) => {
      const message = typeof args[0] === "string" ? args[0] : "";
      if (message.startsWith(ANON_WARN_PREFIX)) warnings.push(message);
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  async function makeClient(storePath: string, getAuthToken?: () => Promise<string | undefined>) {
    const { createSyncClient } = await import("../../packages/client/src/index");
    const client = await createSyncClient({
      registry: diagnosticRegistry(),
      electricUrl: "http://127.0.0.1:3101/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:3101/api/mutations",
      ...(getAuthToken ? { getAuthToken } : {}),
      ...memoryStoreForTests(storePath),
    });
    // ADR-0041: `createSyncClient` resolves at `localReadReady`; `sync` (and thus `ensureSynced`'s activation
    // path, where the anonymous-activation warning fires) is wired in the background tail. Await `bootSettled`.
    await client.bootSettled;
    return client;
  }

  it("warns exactly once when a claims-dependent group is activated with no token, even across repeats", async () => {
    const client = await makeClient("anon-warn-none");
    await client.ensureSynced(["secret"]);
    await client.ensureSynced(["secret"]); // repeated activation must not spam
    await settleProbe();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("secret");
  });

  it("does not warn when a token is available", async () => {
    const client = await makeClient("anon-warn-token", async () => "a-real-token");
    await client.ensureSynced(["secret"]);
    await settleProbe();
    expect(warnings).toEqual([]);
  });

  it("does not warn for a non-claims-dependent group activated without a token", async () => {
    const client = await makeClient("anon-warn-public");
    await client.ensureSynced(["public_notes"]);
    await settleProbe();
    expect(warnings).toEqual([]);
  });

  // ─── The index.ts write-activation seam (ADR-0039 decision 1) ──────────────────────────────────
  // The mutation runtime reports non-blind tables through `onOrdinaryEnqueue`; the client filters to
  // lazy keys and fire-and-forget `ensureSynced`s them. Drive the captured hook the way the runtime would.

  it("a write to a lazy claims-dependent table activates its group (and warns anonymously)", async () => {
    await makeClient("write-activate-secret");
    expect(capturedOnOrdinaryEnqueue).toBeDefined();
    capturedOnOrdinaryEnqueue!(["secret"]);
    await settleProbe();
    // The write self-activated the group — no manual activator query needed.
    expect(started.has("secret-shape")).toBe(true);
    // And because it activated a claims-denied group with no token, the one warning fired for the write too.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("secret");
  });

  it("a write to a non-lazy (eager) table activates nothing", async () => {
    await makeClient("write-activate-eager");
    expect(capturedOnOrdinaryEnqueue).toBeDefined();
    capturedOnOrdinaryEnqueue!(["board"]);
    await settleProbe();
    expect(started.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("a failed group activation is swallowed, never an unhandled rejection", async () => {
    await makeClient("write-activate-reject");
    expect(capturedOnOrdinaryEnqueue).toBeDefined();
    failNextActivation = true; // the next ensureGroupStarted rejects
    // If the client's fire-and-forget activation lacked its `.catch`, this rejection would surface as an
    // unhandled rejection — which bun reports as a test failure. Settling cleanly IS the assertion.
    capturedOnOrdinaryEnqueue!(["secret"]);
    await settleProbe();
    expect(started.has("secret-shape")).toBe(false);
  });
});
