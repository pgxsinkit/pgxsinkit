import { afterEach, describe, expect, it } from "bun:test";
// Real-PGlite coverage for bounded zero-subscriber KEEP-ALIVE over the worker bridge (ADR-0040 Slice 4). A
// real in-memory engine behind `defineSyncWorker` configured with a generous `defaultKeepAliveMs`, driven by
// an `attachSyncClient` tab over a bun `MessageChannel`. `pglite.live` is wrapped to COUNT registrations
// (injected timers aren't available across the bridge, so the assertion is on registration COUNT, not
// wall-clock): unsubscribe then resubscribe the same SQL reuses the retained registration (one registration
// total), and `host.close()` disposes cleanly with a retained entry present (its timer cancelled — no hang).

import { PGlite } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { live } from "@electric-sql/pglite/live";
import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  type ClientPGlite,
  defineSyncWorker,
  getReadModelView,
  type SyncWorkerHost,
} from "../../packages/client/src/index";
import { testStoreAcknowledgment } from "../../packages/client/src/testing";

const todosRegistry = defineSyncRegistry({
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
});
type TodosRegistry = typeof todosRegistry;
const readModel = getReadModelView(todosRegistry, "todos");
const ID_A = "a0000000-0000-0000-0000-000000000000";

let hosts: SyncWorkerHost<TodosRegistry>[] = [];
let channels: MessageChannel[] = [];
let liveRegistrations = 0;

async function makeHost(): Promise<SyncWorkerHost<TodosRegistry>> {
  const pg = await PGlite.create({ loadDataDir: await prepopulatedDataDir(), extensions: { live } });
  const realQuery = pg.live.query.bind(pg.live);
  const realIncremental = pg.live.incrementalQuery.bind(pg.live);
  pg.live.query = ((...args: Parameters<typeof realQuery>) => {
    liveRegistrations++;
    return realQuery(...args);
  }) as typeof pg.live.query;
  pg.live.incrementalQuery = ((...args: Parameters<typeof realIncremental>) => {
    liveRegistrations++;
    return realIncremental(...args);
  }) as typeof pg.live.incrementalQuery;

  const host = defineSyncWorker({
    registry: todosRegistry,
    electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    ...testStoreAcknowledgment(),
    precreatedPglite: Promise.resolve(pg as unknown as ClientPGlite),
    syncEnabled: false,
    installGlobal: false,
    convergenceIntervalMs: 10_000_000,
    // A generous keep-alive so a resubscribe lands well within the grace window (assert on count, not clock).
    liveQueries: { defaultKeepAliveMs: 60_000 },
  });
  hosts.push(host);
  return host;
}

async function attach(host: SyncWorkerHost<TodosRegistry>) {
  const channel = new MessageChannel();
  channels.push(channel);
  host.connect(channel.port1 as unknown as never);
  channel.port2.start?.();
  const client = await attachSyncClient({
    registry: todosRegistry,
    port: channel.port2 as unknown as never,
    getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
  });
  return client;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(async () => {
  for (const host of hosts) await host.close().catch(() => undefined);
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  hosts = [];
  channels = [];
  liveRegistrations = 0;
});

describe("live-query keep-alive over the worker bridge (ADR-0040 Slice 4)", () => {
  it("reuses the retained registration on resubscribe within grace, and disposes cleanly while retained", async () => {
    const host = await makeHost();
    const tab = await attach(host);
    await tab.ready;
    await tab.tables.todos.create({ id: ID_A, title: "A", done: false });

    const built = tab.drizzle
      .select({ id: readModel.id, title: readModel.title })
      .from(readModel)
      .orderBy(readModel.id)
      .toSQL();

    const subA = await tab.subscribeLiveRows<{ id: string; title: string }>(
      { sql: built.sql, params: built.params, pkColumns: ["id"] },
      () => undefined,
    );
    expect(liveRegistrations).toBe(1);

    // Unsubscribe → the entry is RETAINED (60s grace), not torn down.
    subA.unsubscribe();
    await tick();

    // Resubscribe the same SQL within grace → the retained registration is reused: NO second registration.
    const rowsB: Array<Array<{ id: string; title: string }>> = [];
    const subB = await tab.subscribeLiveRows<{ id: string; title: string }>(
      { sql: built.sql, params: built.params, pkColumns: ["id"] },
      (rows) => rowsB.push(rows),
    );
    expect(liveRegistrations).toBe(1); // reused
    expect(subB.initialRows.map((r) => r.title)).toEqual(["A"]);

    // Still live: a mutation reaches the rejoined subscription off the shared registration.
    await tab.tables.todos.update({ id: ID_A }, { title: "A2" });
    await tick();
    expect(rowsB.at(-1)?.map((r) => r.title)).toEqual(["A2"]);

    // Leave the entry RETAINED (unsubscribe, don't resubscribe): host.close() must dispose cleanly — cancelling
    // the 60s eviction timer and tearing the retained entry down — with no hang and no leaked timer.
    subB.unsubscribe();
    await tick();
    await host.close();
    hosts = []; // already closed; keep afterEach from double-closing
    expect(liveRegistrations).toBe(1);
  });

  it("exposes the manager's live-query diagnostics over the bridge RPC (digests + counts, no SQL/rows)", async () => {
    const host = await makeHost();
    const tab = await attach(host);
    await tab.ready;
    // Distinctive material that must NOT appear in the diagnostics snapshot.
    await tab.tables.todos.create({ id: ID_A, title: "SECRET_TITLE_XYZ", done: false });

    // Empty before any subscription.
    expect(await tab.liveQueryDiagnostics()).toEqual([]);

    const built = tab.drizzle
      .select({ id: readModel.id, title: readModel.title })
      .from(readModel)
      .orderBy(readModel.id)
      .toSQL();
    const sub = await tab.subscribeLiveRows<{ id: string; title: string }>(
      { sql: built.sql, params: built.params, pkColumns: ["id"] },
      () => undefined,
    );

    const diagnostics = await tab.liveQueryDiagnostics();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.digest).toMatch(/^[0-9a-f]{8}$/);
    expect(diagnostics[0]!.subscriberCount).toBe(1);
    expect(diagnostics[0]!.rowCount).toBe(1);
    expect(diagnostics[0]!.setupMs).not.toBeNull();

    // No SQL text or row material crosses the diagnostics wire.
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("SECRET_TITLE_XYZ");
    expect(serialized).not.toContain("todos");

    sub.unsubscribe();
    await tick();
  });
});
