import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
// One-shot guarded Drizzle reads over the WORKER bridge (ADR-0032 decision 4). `attachSyncClient`'s
// `query`/`queryRow`/`queryRaw`/`queryRawRow` compile a read to SQL on the tab (its `drizzle` is a real
// Drizzle database over a bridge executor) and route it to `defineSyncWorker`'s `guardedQuery` RPC, which
// runs the engine's `guardedRawQuery` — the ADR-0041 read gate + the ADR-0021 lazy-group guard — on its owned
// in-process client and returns the full PGlite `Results` so Drizzle's own mapping runs on the tab.
//
// The harness boots a REAL in-process engine over a prepopulated in-memory PGlite behind `defineSyncWorker`,
// driven by `attachSyncClient` across a bun `MessageChannel` (no real Worker), so Drizzle's result mapping is
// exercised for real. ONLY `startConfiguredSync` is mocked — a controllable sync stub whose `ensureGroupStarted`
// records activation — so the lazy-activation assertions (tests 3 & 7) can observe a guarded read starting a
// lazy group exactly as `client-lazy-facade`/`lazy-guard` prove in-process, while everything else (PGlite,
// Drizzle, schema, mutation, local store) runs unmocked. mock.module → this file is registered in the
// ISOLATED set of scripts/run-unit-tests.ts so it runs in its own process.

import { PGlite } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { live } from "@electric-sql/pglite/live";
import { eq } from "drizzle-orm";
import { bigint, boolean, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

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

// ─── Controllable sync stub (only `startConfiguredSync` is mocked) ───────────────────────────────────
// 1 group per table (`<key>-shape`); `ensureGroupStarted` records activation so `isTableStarted` reflects it,
// mirroring the in-process `client-lazy-facade` stub. `onInitialSync` fires so the engine reaches phase
// "ready" without any network. Reset per test.
const startedGroups = new Set<string>();
const ensureGroupStartedCalls: string[] = [];
const startConfiguredSyncMock = mock(async (_pg: unknown, opts: { onInitialSync?: () => void }) => {
  opts.onInitialSync?.();
  return {
    unsubscribe: () => undefined,
    tables: {},
    ensureGroupStarted: async (groupKey: string) => {
      ensureGroupStartedCalls.push(groupKey);
      startedGroups.add(groupKey);
    },
    stopGroup: (groupKey: string) => startedGroups.delete(groupKey),
    groupKeyForTable: (tableKey: string) => `${tableKey}-shape`,
    isTableStarted: (tableKey: string) => startedGroups.has(`${tableKey}-shape`),
    groupReady: () => Promise.resolve(),
    isGroupReady: () => true,
  };
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

let hosts: SyncWorkerHost<Registry>[] = [];
let inProcessClients: SyncClient<Registry>[] = [];
let channels: MessageChannel[] = [];

// Dynamic import so the `startConfiguredSync` mock (set in beforeAll) is in place before `index` binds it.
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
    electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
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
    electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
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
  await mock.module("../../packages/client/src/shape-sync", () => ({
    startConfiguredSync: startConfiguredSyncMock,
  }));
});

afterAll(() => mock.restore());

beforeEach(() => {
  startedGroups.clear();
  ensureGroupStartedCalls.length = 0;
  startConfiguredSyncMock.mockClear();
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

  it("10. isSynced throws a clear not-supported error (a sync activation-started peek the tab cannot answer)", async () => {
    const host = await makeHost(false);
    const client = await attach(host);
    await client.ready;

    expect(() => client.isSynced("archive")).toThrow(/isSynced is not available/);
  });

  it("11. queryRow returns the first row, and null for an empty result", async () => {
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

  it("12. queryRawRow with a `use`-carrying raw fragment activates the lazy group and returns the row", async () => {
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

  it("13. a bare awaited client.drizzle read over attach IS guarded (activates the lazy group)", async () => {
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

  it("14. client.drizzle.transaction() rejects — no tab-local PGlite for a read transaction", async () => {
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
