import { afterEach, describe, expect, it } from "bun:test";
// In-process adoption of the live-query manager (ADR-0040 decision 6, Slice 6). The direct `createSyncClient`
// now delegates `subscribeLiveRows` to its OWN `LiveQueryManager` (same module the worker uses), so within one
// client identical subscriptions DEDUPLICATE onto one PGlite registration, keep-alive retains a zero-subscriber
// entry, and `liveQueryDiagnostics()` returns real records. Driven over a real in-memory PGlite (no worker).

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import {
  createClientPGlite,
  createSyncClient,
  getReadModelView,
  type SyncClient,
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
type TodosRegistry = typeof todosRegistry;
const readModel = getReadModelView(todosRegistry, "todos");
const ID_A = "a0000000-0000-0000-0000-000000000000";
const ID_B = "b0000000-0000-0000-0000-000000000000";

let client: SyncClient<TodosRegistry> | undefined;

afterEach(async () => {
  await client?.stop();
  client = undefined;
});

async function bootClient(storePath: string, liveQueries?: { defaultKeepAliveMs?: number }) {
  const active = await createSyncClient({
    registry: todosRegistry,
    electricUrl: "http://127.0.0.1:1/v1/electric-proxy",
    batchWriteUrl: "http://127.0.0.1:1/api/mutations",
    syncEnabled: false,
    ...testStoreAcknowledgment(),
    precreatedPglite: createClientPGlite(memoryStoreForTests(storePath)),
    ...(liveQueries ? { liveQueries } : {}),
  });
  await active.ready;
  return active;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("in-process live-query manager adoption (ADR-0040 Slice 6)", () => {
  it("dedups two identical subscriptions onto one registration and fans diffs to both", async () => {
    client = await bootClient("inproc-dedup");
    await client.tables.todos.create({ id: ID_A, title: "A", done: false });

    const built = client.drizzle
      .select({ id: readModel.id, title: readModel.title })
      .from(readModel)
      .orderBy(readModel.id)
      .toSQL();

    const rowsA: Array<Array<{ id: string; title: string }>> = [];
    const rowsB: Array<Array<{ id: string; title: string }>> = [];
    const subA = await client.subscribeLiveRows<{ id: string; title: string }>(
      { sql: built.sql, params: built.params },
      (rows) => rowsA.push(rows),
    );
    const subB = await client.subscribeLiveRows<{ id: string; title: string }>(
      { sql: built.sql, params: built.params },
      (rows) => rowsB.push(rows),
    );

    // ONE managed entry, two subscribers (dedup within the client).
    const diags = await client.liveQueryDiagnostics();
    expect(diags).toHaveLength(1);
    expect(diags[0]!.subscriberCount).toBe(2);
    expect(diags[0]!.rowCount).toBe(1);
    expect(subA.initialRows.map((r) => r.title)).toEqual(["A"]);
    expect(subB.initialRows.map((r) => r.title)).toEqual(["A"]);

    // A local mutation reaches BOTH subscribers off the shared registration.
    await client.tables.todos.update({ id: ID_A }, { title: "A2" });
    await tick();
    expect(rowsA.at(-1)?.map((r) => r.title)).toEqual(["A2"]);
    expect(rowsB.at(-1)?.map((r) => r.title)).toEqual(["A2"]);

    // Unsubscribing one leaves the other live.
    subA.unsubscribe();
    await tick();
    const beforeB = rowsB.length;
    await client.tables.todos.update({ id: ID_A }, { title: "A3" });
    await tick();
    expect(rowsB.length).toBeGreaterThan(beforeB);
    expect(rowsB.at(-1)?.map((r) => r.title)).toEqual(["A3"]);
    expect((await client.liveQueryDiagnostics())[0]!.subscriberCount).toBe(1);

    subB.unsubscribe();
    await tick();
  });

  it("retains a zero-subscriber entry under keepAliveMs and reuses it on resubscribe", async () => {
    client = await bootClient("inproc-keepalive", { defaultKeepAliveMs: 60_000 });
    await client.tables.todos.create({ id: ID_B, title: "B", done: false });

    const built = client.drizzle.select({ id: readModel.id, title: readModel.title }).from(readModel).toSQL();
    const sub = await client.subscribeLiveRows<{ id: string; title: string }>(
      { sql: built.sql, params: built.params },
      () => undefined,
    );
    sub.unsubscribe();
    await tick();

    // Retained (not torn down): one record, zero subscribers, retained flag set.
    const retainedDiags = await client.liveQueryDiagnostics();
    expect(retainedDiags).toHaveLength(1);
    expect(retainedDiags[0]!.subscriberCount).toBe(0);
    expect(retainedDiags[0]!.retained).toBe(true);

    // Resubscribe the same query → reuse the retained entry (still ONE record, now active).
    const digestBefore = retainedDiags[0]!.digest;
    const reSub = await client.subscribeLiveRows<{ id: string; title: string }>(
      { sql: built.sql, params: built.params },
      () => undefined,
    );
    const rejoinDiags = await client.liveQueryDiagnostics();
    expect(rejoinDiags).toHaveLength(1);
    expect(rejoinDiags[0]!.digest).toBe(digestBefore); // same entry, not a fresh registration
    expect(rejoinDiags[0]!.subscriberCount).toBe(1);
    expect(rejoinDiags[0]!.retained).toBe(false);
    reSub.unsubscribe();
    await tick();
  });

  it("keeps === identity for unchanged rows across a diff (materializer folding)", async () => {
    client = await bootClient("inproc-identity");
    await client.tables.todos.create({ id: ID_A, title: "A", done: false });
    await client.tables.todos.create({ id: ID_B, title: "B", done: false });

    const built = client.drizzle
      .select({ id: readModel.id, title: readModel.title })
      .from(readModel)
      .orderBy(readModel.id)
      .toSQL();

    const emissions: Array<Array<{ id: string; title: string }>> = [];
    const sub = await client.subscribeLiveRows<{ id: string; title: string }>(
      { sql: built.sql, params: built.params },
      (rows) => emissions.push(rows),
    );
    const initialRows = sub.initialRows;
    expect(initialRows.map((r) => r.title)).toEqual(["A", "B"]);

    // Change only B → A is unchanged and must keep its object identity through the materializer.
    await client.tables.todos.update({ id: ID_B }, { title: "B2" });
    await tick();
    const latest = emissions.at(-1)!;
    expect(latest.map((r) => r.title)).toEqual(["A", "B2"]);
    expect(latest[0]).toBe(initialRows[0]); // A unchanged → same object (===)
    expect(latest[1]).not.toBe(initialRows[1]); // B changed → fresh object

    sub.unsubscribe();
    await tick();
  });
});
