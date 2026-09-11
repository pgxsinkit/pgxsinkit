import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
// One-shot guarded Drizzle reads over the WORKER bridge (ADR-0032 decision 4). `attachSyncClient`'s
// `query`/`queryRow`/`queryRaw`/`queryRawRow` compile a read to SQL on the tab (its `drizzle` is a real
// Drizzle database over a bridge executor) and route it to `defineSyncWorker`'s `guardedQuery` RPC, which
// runs the engine's `guardedRawQuery` — the ADR-0041 read gate + the ADR-0021 lazy-group guard — on its owned
// in-process client and returns the full PGlite `Results` so Drizzle's own mapping runs on the tab.
//
// The harness boots a REAL in-process engine over a prepopulated in-memory PGlite behind `defineSyncWorker`,
// driven by `attachSyncClient` across a bun `MessageChannel` (no real Worker), so Drizzle's result mapping is
// exercised for real. ONLY `startCircuitsSync` is mocked — a controllable sync stub whose `ensureGroupStarted`
// records activation — so the lazy-activation assertions (tests 3 & 7) can observe a guarded read starting a
// lazy group exactly as `client-lazy-facade`/`lazy-guard` prove in-process, while everything else (PGlite,
// Drizzle, schema, mutation, local store) runs unmocked. mock.module → this file is registered in the
// ISOLATED set of scripts/run-unit-tests.ts so it runs in its own process.

import { PGlite } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { live } from "@electric-sql/pglite/live";
import { eq } from "drizzle-orm";
import { bigint, boolean, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable, type SyncTableName } from "@pgxsinkit/contracts";

import type { ClientPGlite, SyncClient } from "../../packages/client/src/index";
import type { SyncWorkerHost } from "../../packages/client/src/worker/define-sync-worker";

const registry = defineSyncRegistry({
  // Writable — the awaited write-then-read case reads the optimistic overlay through the read model.
  todos: defineSyncTable({
    tableName: "todos",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 200 }).notNull(),
      done: boolean("done").notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
  // A parent/child readonly pair for the relational mapping-parity case. `published_at` is a `mode: "string"`
  // timestamp so the parser-mirroring is load-bearing: without the worker re-applying drizzle's identity
  // parsers (temporal OIDs + numeric[]), PGlite would hand back a `Date` for this temporal column and
  // drizzle's string column would surface a `Date` — a parity break against the in-process session, which
  // sees the raw string.
  authors: defineSyncTable({
    tableName: "authors",
    makeColumns: () => ({ id: uuid("id").primaryKey(), name: varchar("name", { length: 200 }).notNull() }),
    mode: "readonly",
  }),
  books: defineSyncTable({
    tableName: "books",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      authorId: uuid("author_id").notNull(),
      title: varchar("title", { length: 200 }).notNull(),
      publishedAt: timestamp("published_at", { mode: "string" }).notNull(),
    }),
    mode: "readonly",
  }),
  // Two distinct lazy relations: a guarded read activates its group (an inspection read must NOT), and the
  // concurrency case activates each via a DIFFERENT call's `use` to prove no cross-read contamination.
  archive: defineSyncTable({
    tableName: "archive",
    makeColumns: () => ({ id: uuid("id").primaryKey(), label: varchar("label", { length: 200 }).notNull() }),
    mode: "readonly",
    subscription: "lazy",
  }),
  vault: defineSyncTable({
    tableName: "vault",
    makeColumns: () => ({ id: uuid("id").primaryKey(), secret: varchar("secret", { length: 200 }).notNull() }),
    mode: "readonly",
    subscription: "lazy",
  }),
});
type Registry = typeof registry;

// ─── Controllable sync stub (only `startCircuitsSync` is mocked) ───────────────────────────────────
// 1 group per table (`<key>-shape`); `ensureGroupStarted` records activation so `isTableStarted` reflects it,
// mirroring the in-process `client-lazy-facade` stub. `onInitialSync` fires so the engine reaches phase
// "ready" without any network. An activated group's catch-up lands at once (`onGroupReady`) UNLESS its key is
// in `catchUpHeld` — the started-but-not-caught-up shape (a promoted group whose subscribe is still retrying),
// where `isTableStarted` is true while `isGroupReady`/`groupReady` stay pending. Reset per test.
const startedGroups = new Set<string>();
const ensureGroupStartedCalls: string[] = [];
/** Group keys whose CATCH-UP is deliberately withheld — activated, not yet caught up. */
const catchUpHeld = new Set<string>();
/** Group keys that count as STARTED while their catch-up is still in flight (the real promoted branch). */
const promotedGroups = new Set<string>();
const catchUpWaiters = new Map<string, Array<() => void>>();
let reportGroupReady: ((groupKey: string) => void) | undefined;
/** Land a held group's catch-up, exactly as the runtime reports it — no RPC involved. */
function releaseCatchUp(groupKey: string): void {
  catchUpHeld.delete(groupKey);
  const waiters = catchUpWaiters.get(groupKey) ?? [];
  catchUpWaiters.delete(groupKey);
  for (const resolve of waiters) resolve();
  reportGroupReady?.(groupKey);
}
const startCircuitsSyncMock = mock(
  async (_pg: unknown, opts: { onInitialSync?: () => void; onGroupReady?: (groupKey: string) => void }) => {
    reportGroupReady = opts.onGroupReady;
    opts.onInitialSync?.();
    return {
      unsubscribe: () => undefined,
      tables: {},
      ensureGroupStarted: async (groupKey: string) => {
        ensureGroupStartedCalls.push(groupKey);
        startedGroups.add(groupKey);
        // Catch-up lands with the start unless this group is held — the runtime reports it separately.
        if (!catchUpHeld.has(groupKey)) opts.onGroupReady?.(groupKey);
      },
      stopGroup: (groupKey: string) => startedGroups.delete(groupKey),
      groupKeyForTable: (tableKey: string) => `${tableKey}-shape`,
      // The real `isTableStarted` (group-sync.ts): an ordinary group counts as started once its catch-up
      // has landed; a PROMOTED one counts from the moment its start was kicked off, catch-up or not.
      isTableStarted: (tableKey: string) => {
        const groupKey = `${tableKey}-shape`;
        if (!startedGroups.has(groupKey)) return false;
        return promotedGroups.has(groupKey) || !catchUpHeld.has(groupKey);
      },
      groupReady: (groupKey: string) =>
        catchUpHeld.has(groupKey)
          ? new Promise<void>((resolve) => {
              const waiters = catchUpWaiters.get(groupKey) ?? [];
              waiters.push(resolve);
              catchUpWaiters.set(groupKey, waiters);
            })
          : Promise.resolve(),
      isGroupReady: (groupKey: string) => !catchUpHeld.has(groupKey),
    };
  },
);

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

let hosts: SyncWorkerHost<Registry>[] = [];
let inProcessClients: SyncClient<Registry>[] = [];
let channels: MessageChannel[] = [];

// Dynamic import so the `startCircuitsSync` mock (set in beforeAll) is in place before `index` binds it.
async function indexModule() {
  return import("../../packages/client/src/index");
}
// Resolve the registry-derived Drizzle table/view objects (properly typed — the same objects regardless of
// which client's `drizzle` runs them), so the builders below need no casts.
async function tables() {
  const { getSyncedLocalTable, getReadModelView } = await indexModule();
  return {
    authors: getSyncedLocalTable(registry, "authors"),
    books: getSyncedLocalTable(registry, "books"),
    archive: getSyncedLocalTable(registry, "archive"),
    todosReadModel: getReadModelView(registry, "todos"),
  };
}

async function makeHost(syncEnabled: boolean): Promise<SyncWorkerHost<Registry>> {
  const { defineSyncWorker } = await indexModule();
  const { testStoreAcknowledgment } = await import("../../packages/client/src/testing");
  const pg = await PGlite.create({ loadDataDir: await prepopulatedDataDir(), extensions: { live } });
  const host = defineSyncWorker({
    registry,
    controlPlaneUrl: "http://127.0.0.1:1",
    streamBaseUrl: "http://127.0.0.1:1/v1/stream",
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    ...testStoreAcknowledgment(),
    precreatedPglite: Promise.resolve(pg as unknown as ClientPGlite),
    syncEnabled,
    installGlobal: false,
    convergenceIntervalMs: 10_000_000,
  }) as unknown as SyncWorkerHost<Registry>;
  hosts.push(host);
  return host;
}

async function attach(host: SyncWorkerHost<Registry>): Promise<SyncClient<Registry>> {
  const { attachSyncClient } = await indexModule();
  const channel = new MessageChannel();
  channels.push(channel);
  (host as unknown as { connect: (p: unknown) => void }).connect(channel.port1 as unknown as never);
  const client = await attachSyncClient({
    registry,
    port: channel.port2 as unknown as never,
    getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
  });
  return client as unknown as SyncClient<Registry>;
}

/** A fresh in-process client over its own memory store (the parity oracle). */
async function makeInProcessClient(storePath: string): Promise<SyncClient<Registry>> {
  const { createSyncClient } = await indexModule();
  const { memoryStoreForTests } = await import("../../packages/client/src/testing");
  const client = await createSyncClient({
    registry,
    controlPlaneUrl: "http://127.0.0.1:1",
    streamBaseUrl: "http://127.0.0.1:1/v1/stream",
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    syncEnabled: false,
    ...memoryStoreForTests(storePath),
  });
  inProcessClients.push(client);
  return client;
}

/** Seed the readonly authors/books tables directly (readonly synced tables carry no write API). */
async function seedLibrary(client: Pick<SyncClient<Registry>, "rawQuery">): Promise<void> {
  await client.rawQuery("insert into authors (id, name) values ($1, $2)", [
    "a0000000-0000-0000-0000-000000000001",
    "Ada",
  ]);
  await client.rawQuery("insert into authors (id, name) values ($1, $2)", [
    "a0000000-0000-0000-0000-000000000002",
    "Bell",
  ]);
  await client.rawQuery("insert into books (id, author_id, title, published_at) values ($1, $2, $3, $4)", [
    "b0000000-0000-0000-0000-000000000001",
    "a0000000-0000-0000-0000-000000000001",
    "Notes",
    "2024-01-02 03:04:05",
  ]);
  await client.rawQuery("insert into books (id, author_id, title, published_at) values ($1, $2, $3, $4)", [
    "b0000000-0000-0000-0000-000000000002",
    "a0000000-0000-0000-0000-000000000002",
    "Letters",
    "2023-06-07 08:09:10",
  ]);
}

beforeAll(async () => {
  await mock.module("../../packages/client/src/circuits/group-sync", () => ({
    startCircuitsSync: startCircuitsSyncMock,
  }));
});

afterAll(() => mock.restore());

beforeEach(() => {
  startedGroups.clear();
  ensureGroupStartedCalls.length = 0;
  catchUpHeld.clear();
  promotedGroups.clear();
  catchUpWaiters.clear();
  reportGroupReady = undefined;
  startCircuitsSyncMock.mockClear();
});

afterEach(async () => {
  for (const client of inProcessClients) await client.stop().catch(() => undefined);
  for (const host of hosts) await host.close().catch(() => undefined);
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  inProcessClients = [];
  hosts = [];
  channels = [];
});

describe("guarded one-shot reads over the worker bridge (ADR-0032 decision 4)", () => {
  it("1. round-trips a simple guarded query through attach", async () => {
    const host = await makeHost(false);
    const client = await attach(host);
    await client.ready;
    await seedLibrary(client);

    const { authors } = await tables();
    const rows = await client.query((c) =>
      c.drizzle.select({ id: authors.id, name: authors.name }).from(authors).orderBy(authors.id),
    );
    expect(rows).toEqual([
      { id: "a0000000-0000-0000-0000-000000000001", name: "Ada" },
      { id: "a0000000-0000-0000-0000-000000000002", name: "Bell" },
    ]);
  });

  it("2. mapping parity: the same relational builder is deep-equal in-process and through attach", async () => {
    const host = await makeHost(false);
    const attached = await attach(host);
    await attached.ready;
    await seedLibrary(attached);

    const inProcess = await makeInProcessClient("one-shot-parity");
    await inProcess.localReadReady;
    await seedLibrary(inProcess);

    const { books, authors } = await tables();
    // The SAME relational (joined + nested projection) builder, run against either client's `drizzle`.
    const build = (c: SyncClient<Registry>) =>
      c.drizzle
        .select({
          book: { id: books.id, title: books.title },
          author: { name: authors.name },
          publishedAt: books.publishedAt,
        })
        .from(books)
        .leftJoin(authors, eq(books.authorId, authors.id))
        .orderBy(books.id);
    const attachedRows = await attached.query(build);
    const inProcessRows = await inProcess.query(build);

    // The load-bearing "transparently proxied" assertion: identical nested/joined shape AND identical
    // temporal round-trip (the `mode: "string"` timestamp only matches if the worker re-applied drizzle's
    // identity parsers — temporal OIDs + numeric[] — before executing).
    expect(attachedRows).toEqual(inProcessRows);
    expect(attachedRows).toEqual([
      {
        book: { id: "b0000000-0000-0000-0000-000000000001", title: "Notes" },
        author: { name: "Ada" },
        publishedAt: "2024-01-02 03:04:05",
      },
      {
        book: { id: "b0000000-0000-0000-0000-000000000002", title: "Letters" },
        author: { name: "Bell" },
        publishedAt: "2023-06-07 08:09:10",
      },
    ]);
    expect(typeof (attachedRows[0] as { publishedAt: unknown }).publishedAt).toBe("string");
  });

  it("3. a guarded read referencing a lazy table activates its group (as in-process)", async () => {
    const host = await makeHost(true);
    const client = await attach(host);
    await client.ready; // sync (the stub) is wired

    const { archive } = await tables();
    const rows = await client.query((c) =>
      c.drizzle.select({ id: archive.id, label: archive.label }).from(archive).orderBy(archive.id),
    );
    expect(rows).toEqual([]); // empty lazy cache, but the read still ran under the guard
    // The worker's guard scanned the SQL and started the archive group — exactly `client-lazy-facade`'s
    // in-process expectation, now observed worker-side across the bridge.
    expect(ensureGroupStartedCalls).toContain("archive-shape");
    const workerClient = await host.whenBooted();
    expect(workerClient.isSynced("archive")).toBe(true);
  });

  it("4. a guarded read issued immediately after attach resolves (read gate, no race)", async () => {
    const host = await makeHost(false);
    const client = await attach(host);
    // Do NOT await client.ready — issue the read straight away. The gate (`await localReadReady`) runs
    // worker-side inside the RPC; the attach resolved AT localReadReady, so the read resolves rather than
    // racing/crashing.
    await seedLibrary(client);
    const { authors } = await tables();
    const rows = await client.query((c) =>
      c.drizzle.select({ name: authors.name }).from(authors).orderBy(authors.name),
    );
    expect(rows).toEqual([{ name: "Ada" }, { name: "Bell" }]);
  });

  it("5. an awaited write is observed by a following guarded read (overlay)", async () => {
    const host = await makeHost(false);
    const client = await attach(host);
    await client.ready;

    await client.tables.todos.create({
      id: "d0000000-0000-0000-0000-000000000001",
      title: "overlay row",
      done: false,
    });

    const { todosReadModel } = await tables();
    const rows = await client.query((c) =>
      c.drizzle.select({ id: todosReadModel.id, title: todosReadModel.title }).from(todosReadModel),
    );
    expect(rows).toEqual([{ id: "d0000000-0000-0000-0000-000000000001", title: "overlay row" }]);
  });

  it("6. invalid SQL rejects cleanly over the rpc-result route; the client stays usable", async () => {
    const host = await makeHost(false);
    const client = await attach(host);
    await client.ready;
    await seedLibrary(client);

    // A bad statement travels the guarded route (`guardedQuery` RPC → worker `guardedRawQuery`) and rejects.
    // try/catch, not `expect().rejects` — a MessageChannel-driven rejection does not settle the bun matcher.
    let message = "";
    try {
      await client.guardedRawQuery("select * from a_table_that_does_not_exist");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);

    // No orphan state — the client still answers a good guarded read.
    const { authors } = await tables();
    const rows = await client.query((c) =>
      c.drizzle.select({ name: authors.name }).from(authors).orderBy(authors.name),
    );
    expect(rows).toEqual([{ name: "Ada" }, { name: "Bell" }]);
  });

  it("7. guarded-vs-inspection: rawQuery does NOT activate a lazy group; query does", async () => {
    const host = await makeHost(true);
    const client = await attach(host);
    await client.ready;
    const workerClient = await host.whenBooted();

    // Inspection read (`rawQuery`) — raw against the store, NO guard: the archive group stays dormant.
    const inspected = await client.rawQuery("select * from archive");
    expect(inspected.rows).toEqual([]);
    expect(ensureGroupStartedCalls).not.toContain("archive-shape");
    expect(workerClient.isSynced("archive")).toBe(false);

    // Guarded read (`query`) — the worker's guard activates the archive group.
    const { archive } = await tables();
    await client.query((c) => c.drizzle.select({ id: archive.id }).from(archive));
    await tick();
    expect(ensureGroupStartedCalls).toContain("archive-shape");
    expect(workerClient.isSynced("archive")).toBe(true);
  });

  it("8. concurrency: each queryRaw's `use` is scoped to its own read (no cross-contamination)", async () => {
    const host = await makeHost(true);
    const client = await attach(host);
    await client.ready;
    await seedLibrary(client);
    const workerClient = await host.whenBooted();
    const { authors, books } = await tables();

    // Issue three reads SYNCHRONOUSLY, no await between them, so their builders execute as interleaved
    // microtasks: `queryRaw A` (use: archive), a plain `query B` (no use), `queryRaw C` (use: vault). Neither
    // raw builder NAMES its lazy target in SQL (they read eager `authors`/`books`), so each lazy group can be
    // activated ONLY via the `use` its OWN call carried. A shared `use` stash would let B/C overwrite A's `use`
    // before A's microtask executor drains — the racy code would drop `archive` (and/or `vault`). The scoped
    // executor binds each `use` in its own closure, so both activate.
    const pA = client.queryRaw({
      use: ["archive"],
      build: (c) => c.drizzle.select({ name: authors.name }).from(authors).orderBy(authors.name),
    });
    const pB = client.query((c) => c.drizzle.select({ name: authors.name }).from(authors).orderBy(authors.name));
    const pC = client.queryRaw({
      use: ["vault"],
      build: (c) => c.drizzle.select({ id: books.id }).from(books).orderBy(books.id),
    });
    const [rowsA, rowsB, rowsC] = await Promise.all([pA, pB, pC]);
    await tick();

    // Every read returned its OWN correct rows.
    expect(rowsA).toEqual([{ name: "Ada" }, { name: "Bell" }]);
    expect(rowsB).toEqual([{ name: "Ada" }, { name: "Bell" }]);
    expect(rowsC).toEqual([
      { id: "b0000000-0000-0000-0000-000000000001" },
      { id: "b0000000-0000-0000-0000-000000000002" },
    ]);
    // A carried EXACTLY `archive`, C carried EXACTLY `vault`, B carried none — so the activated set is exactly
    // both lazy groups. The racy shared-stash design would drop at least one (a single mutable `use` cannot
    // hold both across the interleave), so this set equality is the discriminator.
    expect(new Set(ensureGroupStartedCalls)).toEqual(new Set(["archive-shape", "vault-shape"]));
    expect(workerClient.isSynced("archive")).toBe(true);
    expect(workerClient.isSynced("vault")).toBe(true);
  });

  it("9. ensureSynced activates a lazy group over the bridge and resolves", async () => {
    const host = await makeHost(true);
    const client = await attach(host);
    await client.ready;
    const workerClient = await host.whenBooted();

    expect(workerClient.isSynced("archive")).toBe(false);
    // The async lazy-activation RPC starts the group on the shared engine (additive/idempotent) and resolves.
    await client.ensureSynced(["archive"]);
    expect(ensureGroupStartedCalls).toContain("archive-shape");
    expect(workerClient.isSynced("archive")).toBe(true);

    // Idempotent: a second activation is a no-op that still resolves.
    await client.ensureSynced(["archive"]);
    expect(workerClient.isSynced("archive")).toBe(true);
  });

  it("10. queryRow returns the first row, and null for an empty result", async () => {
    const host = await makeHost(false);
    const client = await attach(host);
    await client.ready;
    await seedLibrary(client);

    const { authors } = await tables();
    // First row of an ordered result — the single-shot twin of `query`.
    const first = await client.queryRow((c) =>
      c.drizzle.select({ name: authors.name }).from(authors).orderBy(authors.name),
    );
    expect(first).toEqual({ name: "Ada" });

    // An empty result resolves to null (not undefined, not an empty array).
    const none = await client.queryRow((c) =>
      c.drizzle.select({ name: authors.name }).from(authors).where(eq(authors.name, "Nobody")),
    );
    expect(none).toBeNull();
  });

  it("11. queryRawRow with a `use`-carrying raw fragment activates the lazy group and returns the row", async () => {
    const host = await makeHost(true);
    const client = await attach(host);
    await client.ready;
    await seedLibrary(client);
    const workerClient = await host.whenBooted();

    const { authors } = await tables();
    // The raw builder reads eager `authors` but declares the lazy `archive` in `use` (its SQL never names it —
    // the single-shot mirror of case 8), so the group can be activated ONLY via this call's `use`.
    const row = await client.queryRawRow({
      use: ["archive"],
      build: (c) => c.drizzle.select({ name: authors.name }).from(authors).orderBy(authors.name),
    });
    expect(row).toEqual({ name: "Ada" });
    expect(ensureGroupStartedCalls).toContain("archive-shape");
    expect(workerClient.isSynced("archive")).toBe(true);
  });

  it("12. a bare awaited client.drizzle read over attach IS guarded (activates the lazy group)", async () => {
    const host = await makeHost(true);
    const client = await attach(host);
    await client.ready;
    const workerClient = await host.whenBooted();

    const { archive } = await tables();
    // No `client.query` wrapper — a plain awaited builder off `client.drizzle`. On attach this still routes
    // through the worker's `guardedQuery` (the bridge executor), so the guard activates the archive group:
    // the attach client is STRICTLY MORE protected than the in-process escape hatch (worker-mode.md), where a
    // bare `client.drizzle` read runs ungated.
    const rows = await client.drizzle
      .select({ id: archive.id, label: archive.label })
      .from(archive)
      .orderBy(archive.id);
    expect(rows).toEqual([]); // empty lazy cache, but the read ran under the guard
    expect(ensureGroupStartedCalls).toContain("archive-shape");
    expect(workerClient.isSynced("archive")).toBe(true);
  });

  it("13. client.drizzle.transaction() rejects — no tab-local PGlite for a read transaction", async () => {
    const host = await makeHost(false);
    const client = await attach(host);
    await client.ready;

    // A read transaction needs a local store the tab does not have; the bridge executor's `transaction` refuses.
    let message = "";
    try {
      await client.drizzle.transaction(async () => undefined);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not available on a worker-attached client/);
  });
});

describe("isSynced from the worker-pushed started-state snapshot (ADR-0059)", () => {
  // Every case asserts BOTH the attached answer and full parity with the worker's own in-process client:
  // the snapshot is computed by asking that client `isSynced(key)` for every registry key, so any divergence
  // is a bridge bug, not a semantic one. A catch-up-readiness implementation would fail case 7.
  const registryKeys = Object.keys(registry) as SyncTableName<Registry>[];
  const syncedMap = (client: SyncClient<Registry>): Record<string, boolean> =>
    Object.fromEntries(registryKeys.map((key) => [key, client.isSynced(key)]));

  it("1. answers a boolean for eager and lazy keys right after attach (it no longer throws)", async () => {
    const host = await makeHost(true);
    const attached = await attach(host);
    await attached.ready;
    const workerClient = await host.whenBooted();

    expect(typeof attached.isSynced("authors")).toBe("boolean"); // eager
    expect(typeof attached.isSynced("archive")).toBe("boolean"); // lazy
    expect(syncedMap(attached)).toEqual(syncedMap(workerClient));
  });

  it("2. a dormant lazy key reads false, then true in the statement after `await ensureSynced` (no tick)", async () => {
    // A promoted group with its catch-up held: it reads STARTED the moment its start is kicked off, and no
    // status/group-ready transition accompanies the activation — so the snapshot the assertion below reads
    // can only have come from the publish the worker makes before the RPC's result.
    catchUpHeld.add("archive-shape");
    promotedGroups.add("archive-shape");
    const host = await makeHost(true);
    const attached = await attach(host);
    await attached.ready;
    const workerClient = await host.whenBooted();

    expect(attached.isSynced("archive")).toBe(false);
    await attached.ensureSynced(["archive"]);
    // The ordering guarantee: the worker broadcasts the new snapshot BEFORE the RPC's result, and both ride
    // the same port (FIFO delivery), so the next SYNCHRONOUS statement already sees it — no tick, no await.
    expect(attached.isSynced("archive")).toBe(true);
    expect(syncedMap(attached)).toEqual(syncedMap(workerClient));
  });

  it("3. a lazy group activated through the guard (one-shot read, live subscription) updates the snapshot", async () => {
    const host = await makeHost(true);
    const attached = await attach(host);
    await attached.ready;
    const workerClient = await host.whenBooted();
    const { archive } = await tables();

    // No `ensureSynced` anywhere: the worker's guard starts the archive group inside the guarded read.
    await attached.query((c) => c.drizzle.select({ id: archive.id }).from(archive));
    expect(attached.isSynced("archive")).toBe(true);
    expect(syncedMap(attached)).toEqual(syncedMap(workerClient));

    // The live path activates through the same guard (the worker's `prepareQuery` inside `subscribe`). Its
    // group is promoted with catch-up held, so no status transition accompanies the activation either: the
    // snapshot can only have come from the publish the subscribe path makes before the initial snapshot.
    catchUpHeld.add("vault-shape");
    promotedGroups.add("vault-shape");
    expect(attached.isSynced("vault")).toBe(false);
    const subscription = await attached.subscribeLiveRows(
      { sql: "select id from vault", params: [], use: ["vault"] },
      () => undefined,
    );
    expect(attached.isSynced("vault")).toBe(true);
    expect(syncedMap(attached)).toEqual(syncedMap(workerClient));
    subscription.unsubscribe();
  });

  it("4. desync reverts the key to false; re-activation reads true again", async () => {
    const host = await makeHost(true);
    const attached = await attach(host);
    await attached.ready;
    const workerClient = await host.whenBooted();

    await attached.ensureSynced(["archive"]);
    expect(attached.isSynced("archive")).toBe(true);

    await attached.desync("archive");
    expect(attached.isSynced("archive")).toBe(false);
    expect(syncedMap(attached)).toEqual(syncedMap(workerClient));

    await attached.ensureSynced(["archive"]);
    expect(attached.isSynced("archive")).toBe(true);
    expect(syncedMap(attached)).toEqual(syncedMap(workerClient));
  });

  it("5. sync disabled: every key reads true the moment `attachSyncClient` resolves (the ack snapshot)", async () => {
    const host = await makeHost(false);
    const attached = await attach(host);
    // Read BEFORE any further await: only the snapshot folded off the `attach-ack` can answer this, because
    // the worker's first `status` event is posted after the ack and is still undelivered here.
    const immediate = syncedMap(attached);
    expect(immediate).toEqual({ todos: true, authors: true, books: true, archive: true, vault: true });

    const workerClient = await host.whenBooted();
    expect(immediate).toEqual(syncedMap(workerClient));
  });

  it("6. a tab attaching after activation reads true immediately, with no await of its own", async () => {
    const host = await makeHost(true);
    const first = await attach(host);
    await first.ready;
    await first.ensureSynced(["archive"]);

    // The late tab missed every broadcast; its ack carries the current snapshot.
    const second = await attach(host);
    expect(second.isSynced("archive")).toBe(true);

    const workerClient = await host.whenBooted();
    expect(syncedMap(second)).toEqual(syncedMap(workerClient));
  });

  it("7. a STARTED but not caught-up group reads true while `groupReady` is still pending", async () => {
    // The discriminating case — the promoted-group shape: started, durable and readable, catch-up still in
    // flight. An implementation answering from the tab's catch-up cache would read false here.
    catchUpHeld.add("archive-shape");
    promotedGroups.add("archive-shape");
    const host = await makeHost(true);
    const attached = await attach(host);
    await attached.ready;
    const workerClient = await host.whenBooted();

    await attached.ensureSynced(["archive", "vault"]);
    // Both groups are started; only `vault` has caught up. The tab reads BOTH as synced — it is answering
    // the started question, not the catch-up one, and a catch-up-cache implementation would read `archive`
    // false (no group-ready edge for it has ever crossed the bridge).
    expect(attached.isSynced("archive")).toBe(true);
    expect(attached.isSynced("vault")).toBe(true);
    expect(syncedMap(attached)).toEqual(syncedMap(workerClient));

    // Catch-up readiness — the strictly weaker question — is still unanswered for `archive` and settled for
    // `vault`. Asserted on the worker's own client: the stub's synthetic group keys (`<key>-shape`) are not
    // the registry-derived keys the TAB maps a table to, so tab-side `groupReady` is not a signal here.
    const settled = await Promise.race([
      workerClient.groupReady("archive").then(() => "ready"),
      tick().then(() => "pending"),
    ]);
    expect(settled).toBe("pending");
    await workerClient.groupReady("vault");
  });

  it("8. a catch-up landing with no RPC in flight refreshes the tab (the status-edge publish)", async () => {
    // An ordinary (unpromoted) group is STARTED only once its catch-up lands, and that edge arrives on the
    // engine's own schedule — no RPC, no subscribe. The status transition carrying it is the only place the
    // new snapshot can be published from.
    catchUpHeld.add("archive-shape");
    const host = await makeHost(true);
    const attached = await attach(host);
    await attached.ready;
    const workerClient = await host.whenBooted();

    await attached.ensureSynced(["archive"]);
    expect(attached.isSynced("archive")).toBe(false); // activated, not yet caught up → not started
    expect(syncedMap(attached)).toEqual(syncedMap(workerClient));

    releaseCatchUp("archive-shape");
    await tick();
    expect(attached.isSynced("archive")).toBe(true);
    expect(syncedMap(attached)).toEqual(syncedMap(workerClient));
  });
});
