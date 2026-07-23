import { describe, expect, it } from "bun:test";
// Awaited live-query teardown (ADR-0040 decision 1, Slice 1). These pin the close-vs-unsubscribe race
// that wedged the bun runner forever (repro'd against @electric-sql/pglite 0.5.4 — see
// tmp/agents/upstream-pglite-live-unsubscribe-close-hang.md): a fire-and-forget live `unsubscribe()`
// still in flight when the engine closes leaves an internal PGlite promise forever pending, so the
// process never exits. Both seams (worker host `close()` and in-process client `stop()`) now retain
// every teardown promise and settle them BEFORE the PGlite close. The proof is structural: each test
// unsubscribes and IMMEDIATELY closes with NO intervening macrotask tick, and the whole file must
// still exit cleanly — the pre-fix shape would hang the runner here.

import { PGlite } from "@electric-sql/pglite";
import { dataDir as prepopulatedDataDir } from "@electric-sql/pglite-prepopulatedfs";
import { live } from "@electric-sql/pglite/live";
import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  type ClientPGlite,
  createClientPGlite,
  createSyncClient,
  defineSyncWorker,
  getReadModelView,
} from "../../packages/client/src/index";
import { memoryStoreForTests, testStoreAcknowledgment } from "../../packages/client/src/testing";

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
const readModel = getReadModelView(todosRegistry, "todos");
const TODO_ID = "a0000000-0000-0000-0000-000000000000";

describe("awaited live-query teardown (ADR-0040 Slice 1)", () => {
  it("worker host.close() immediately after unsubscribe resolves cleanly (no macrotask tick)", async () => {
    const pg = await PGlite.create({ loadDataDir: await prepopulatedDataDir(), extensions: { live } });
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
    const channel = new MessageChannel();
    host.connect(channel.port1 as unknown as never);
    channel.port2.start?.();
    const client = await attachSyncClient({
      registry: todosRegistry,
      port: channel.port2 as unknown as never,
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    await client.ready;
    await client.tables.todos.create({ id: TODO_ID, title: "A", done: false });

    const { sql, params } = client.drizzle
      .select({ id: readModel.id, title: readModel.title, done: readModel.done })
      .from(readModel)
      .orderBy(readModel.id)
      .toSQL();
    const sub = await client.subscribeLiveRows<{ id: string; title: string; done: boolean }>(
      { sql, params, pkColumns: ["id"] },
      () => undefined,
    );
    expect(sub.initialRows.map((r) => r.title)).toEqual(["A"]);

    // The exact hang shape: fire the tab-side unsubscribe, then close the host in the SAME macrotask.
    // `close()` awaits the worker-side live-query teardown before it closes PGlite, so this resolves.
    sub.unsubscribe();
    await host.close();

    channel.port1.close();
    channel.port2.close();
    // Reaching this line at all is the assertion: the runner did not wedge on the teardown race.
    expect(true).toBe(true);
  });

  it("in-process client.stop() immediately after unsubscribe resolves cleanly (no macrotask tick)", async () => {
    const client = await createSyncClient({
      registry: todosRegistry,
      electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: false,
      ...testStoreAcknowledgment(),
      precreatedPglite: createClientPGlite(memoryStoreForTests("live-teardown-inproc")),
    });
    await client.ready;
    await client.tables.todos.create({ id: TODO_ID, title: "A", done: false });

    const { sql, params } = client.drizzle
      .select({ id: readModel.id, title: readModel.title, done: readModel.done })
      .from(readModel)
      .orderBy(readModel.id)
      .toSQL();
    const sub = await client.subscribeLiveRows<{ id: string; title: string; done: boolean }>(
      { sql, params, pkColumns: ["id"] },
      () => undefined,
    );
    expect(sub.initialRows.map((r) => r.title)).toEqual(["A"]);

    // Unsubscribe, then stop in the SAME macrotask: `stop()` awaits the retained teardown before the
    // PGlite close, so no in-flight `unsubscribe()` races the close.
    sub.unsubscribe();
    await client.stop();

    expect(true).toBe(true);
  });
});
