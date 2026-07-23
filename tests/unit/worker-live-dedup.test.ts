import { afterEach, describe, expect, it } from "bun:test";
// Real-PGlite coverage for live-query DEDUPLICATION over the worker bridge (ADR-0040 Slice 3, decisions 2/3).
// A real in-memory engine behind `defineSyncWorker`, driven by two `attachSyncClient` tabs over bun
// `MessageChannel`s (no actual Worker). `pglite.live` is wrapped to COUNT registrations, so "one registration
// per fingerprint" is asserted directly. Proves: two tabs on the same SQL share ONE registration and both
// receive a local mutation's diff; unsubscribing/closing one tab leaves the other live; and two tabs with
// DIFFERENT `use` sets on the same SQL still share one registration (`use` is excluded from the fingerprint).

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
  // A `lazy` relation so the `use`-set test can pass different `use` arrays for the SAME SQL.
  archive: defineSyncTable({
    tableName: "archive",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      label: varchar("label", { length: 200 }).notNull(),
    }),
    mode: "readonly",
    subscription: "lazy",
  }),
});
type TodosRegistry = typeof todosRegistry;
const readModel = getReadModelView(todosRegistry, "todos");
const ID_A = "a0000000-0000-0000-0000-000000000000";
const ID_B = "b0000000-0000-0000-0000-000000000000";

let hosts: SyncWorkerHost<TodosRegistry>[] = [];
let channels: MessageChannel[] = [];
let liveRegistrations = 0;

/** Boot a host over a prepopulated in-memory PGlite whose `live` registrations are counted. */
async function makeHost(): Promise<SyncWorkerHost<TodosRegistry>> {
  const pg = await PGlite.create({ loadDataDir: await prepopulatedDataDir(), extensions: { live } });
  // Count every registration so dedup is provable — the manager must call these ONCE per fingerprint.
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

describe("live-query dedup over the worker bridge (ADR-0040 Slice 3)", () => {
  it("two tabs on the same SQL share ONE registration and both receive a local mutation's diff", async () => {
    const host = await makeHost();
    const tabA = await attach(host);
    const tabB = await attach(host);
    await tabA.ready;
    await tabB.ready;
    await tabA.tables.todos.create({ id: ID_A, title: "A", done: false });

    const sqlBuilt = tabA.drizzle
      .select({ id: readModel.id, title: readModel.title, done: readModel.done })
      .from(readModel)
      .orderBy(readModel.id)
      .toSQL();

    const rowsA: Array<Array<{ id: string; title: string }>> = [];
    const rowsB: Array<Array<{ id: string; title: string }>> = [];
    const subA = await tabA.subscribeLiveRows<{ id: string; title: string; done: boolean }>(
      { sql: sqlBuilt.sql, params: sqlBuilt.params, pkColumns: ["id"] },
      (rows) => rowsA.push(rows),
    );
    const subB = await tabB.subscribeLiveRows<{ id: string; title: string; done: boolean }>(
      { sql: sqlBuilt.sql, params: sqlBuilt.params, pkColumns: ["id"] },
      (rows) => rowsB.push(rows),
    );

    // ONE PGlite registration for two identical subscriptions across two tabs (decision 2).
    expect(liveRegistrations).toBe(1);
    expect(subA.initialRows.map((r) => r.title)).toEqual(["A"]);
    expect(subB.initialRows.map((r) => r.title)).toEqual(["A"]);

    // A local mutation on tab A reaches BOTH tabs' live listeners from the single shared registration.
    await tabA.tables.todos.update({ id: ID_A }, { title: "A2" });
    await tick();
    expect(rowsA.at(-1)?.map((r) => r.title)).toEqual(["A2"]);
    expect(rowsB.at(-1)?.map((r) => r.title)).toEqual(["A2"]);
    expect(liveRegistrations).toBe(1); // still one — the mutation did not re-register

    subA.unsubscribe();
    subB.unsubscribe();
    await tick();
  });

  it("unsubscribing/closing one tab leaves the other tab's subscription live", async () => {
    const host = await makeHost();
    const tabA = await attach(host);
    const tabB = await attach(host);
    await tabA.ready;
    await tabB.ready;
    await tabA.tables.todos.create({ id: ID_A, title: "A", done: false });

    const sqlBuilt = tabA.drizzle
      .select({ id: readModel.id, title: readModel.title })
      .from(readModel)
      .orderBy(readModel.id)
      .toSQL();

    const rowsB: Array<Array<{ id: string; title: string }>> = [];
    const subA = await tabA.subscribeLiveRows<{ id: string; title: string }>(
      { sql: sqlBuilt.sql, params: sqlBuilt.params, pkColumns: ["id"] },
      () => undefined,
    );
    const subB = await tabB.subscribeLiveRows<{ id: string; title: string }>(
      { sql: sqlBuilt.sql, params: sqlBuilt.params, pkColumns: ["id"] },
      (rows) => rowsB.push(rows),
    );
    expect(liveRegistrations).toBe(1);

    // Close tab A entirely (detach + unsubscribe). The shared registration survives for tab B.
    subA.unsubscribe();
    await tabA.stop();
    await tick();

    const beforeB = rowsB.length;
    await tabB.tables.todos.update({ id: ID_A }, { title: "A2" });
    await tick();
    expect(rowsB.length).toBeGreaterThan(beforeB);
    expect(rowsB.at(-1)?.map((r) => r.title)).toEqual(["A2"]);
    expect(liveRegistrations).toBe(1); // never re-registered

    subB.unsubscribe();
    await tick();
  });

  it("two tabs with DIFFERENT `use` sets on the same SQL still share one registration (`use` excluded)", async () => {
    const host = await makeHost();
    const tabA = await attach(host);
    const tabB = await attach(host);
    await tabA.ready;
    await tabB.ready;
    await tabA.tables.todos.create({ id: ID_B, title: "B", done: false });

    // Same SQL over the todos read model; the two tabs pass DIFFERENT `use` hints. `use` drives per-subscriber
    // activation (decision 3), NOT the fingerprint — so the registration is shared regardless.
    const sqlBuilt = tabA.drizzle
      .select({ id: readModel.id, title: readModel.title })
      .from(readModel)
      .orderBy(readModel.id)
      .toSQL();

    const subA = await tabA.subscribeLiveRows<{ id: string; title: string }>(
      { sql: sqlBuilt.sql, params: sqlBuilt.params, pkColumns: ["id"], use: [] },
      () => undefined,
    );
    const subB = await tabB.subscribeLiveRows<{ id: string; title: string }>(
      { sql: sqlBuilt.sql, params: sqlBuilt.params, pkColumns: ["id"], use: ["archive"] },
      () => undefined,
    );
    expect(liveRegistrations).toBe(1);
    expect(subA.initialRows.map((r) => r.title)).toEqual(["B"]);
    expect(subB.initialRows.map((r) => r.title)).toEqual(["B"]);

    subA.unsubscribe();
    subB.unsubscribe();
    await tick();
  });
});
