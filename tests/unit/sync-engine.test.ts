/**
 * Behavioural test of the sync engine internalized into `client/src/sync` (ADR-0009). Upstream
 * compatibility is an anti-goal (ADR-0028).
 *
 * Originally seeded from electric-sql/pglite (packages/pglite-sync/test/sync.test.ts, Apache-2.0,
 * © ElectricSQL — see NOTICE) and ported from Vitest to bun:test. We now own and maintain it as a
 * first-class test of OUR engine, held to this repo's standards (typecheck + lint clean): it drives
 * the engine through a process-global `MultiShapeStream` mock so its observable behaviour stays a
 * faithful contract. Because `mock.module` is process-global, this file runs in its own `bun test`
 * invocation (the parallel runner's ISOLATED set) so the mock never bleeds into other suites.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";
import { boolean, integer, text } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { setSyncDebugSink } from "../../packages/client/src/debug";
import {
  NUDGE_HOLD_GRACE_MS,
  NUDGE_MAX_ROUNDS,
  NUDGE_ROUND_GRACE_MS,
  NUDGE_ROUND_WAIT_MS,
} from "../../packages/client/src/sync/nudge";
// These upstream types resolve through the engine's own type surface (re-exported there), so this
// root-level test needs no direct dependency on the Electric client packages.
import type { MultiShapeMessages, Row, ShapeStreamOptions } from "../../packages/client/src/sync/types";
import { informationSchemaSchemata } from "../support/catalog-tables";
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// The engine imports `MultiShapeStream` from @electric-sql/experimental; we replace it
// with a controllable mock BEFORE importing the engine. bun's `mock.module` is process-global, so
// this file runs in its own `bun test` invocation (see package.json `test:unit`) to avoid bleeding
// the mock into suites that use the real stream.
const MockMultiShapeStream = mock((_initOpts?: ShapeStreamOptions) => ({
  subscribe: mock(),
  unsubscribeAll: mock(),
  isUpToDate: true,
  shapes: {},
}));
await mock.module("@electric-sql/experimental", () => ({ MultiShapeStream: MockMultiShapeStream }));

const { createSyncEngine } = await import("../../packages/client/src/sync/index");

// Attach the sync engine to a freshly-created PGlite as its `.electric` namespace (ADR-0032 S1): the
// engine is a plain module over an already-created instance, not a create-time extension — so the test
// creates the store then attaches it explicitly. Setup-only shim; the assertions below are unchanged.
type SyncEnginePGlite = PGlite & { electric: Awaited<ReturnType<typeof createSyncEngine>>["namespace"] };
async function attachSyncEngine(
  pg: PGlite,
  options?: Parameters<typeof createSyncEngine>[1],
): Promise<SyncEnginePGlite> {
  const engine = await createSyncEngine(pg, options);
  (pg as unknown as { electric: SyncEnginePGlite["electric"] }).electric = engine.namespace;
  return pg as SyncEnginePGlite;
}

// Small REAL registry built through the production registry-definition API (ADR-0029 D1): the engine
// resolves each shape's apply target from `(registry, tableKey)`. The entries' local tables serve both
// tier-① provisioning (`createTablesFromSchema`) and the assertion reads. Identifier casing is exact:
// drizzle quotes identifiers, so `cAseSENSiTiVe` and the camelCase columns round-trip verbatim; TS
// property keys deliberately match the wire-shaped keys the assertions compare against. `foo`/`bar` are
// entries the per-table-lock test drives (never provisioned — the lock check needs only the resolved key).
const todoEntry = defineSyncTable({
  tableName: "todo",
  makeColumns: () => ({ id: integer("id").primaryKey(), task: text("task"), done: boolean("done") }),
});
const projectEntry = defineSyncTable({
  tableName: "project",
  makeColumns: () => ({ id: integer("id").primaryKey(), name: text("name"), active: boolean("active") }),
});
const caseSensitiveEntry = defineSyncTable({
  tableName: "cAseSENSiTiVe",
  makeColumns: () => ({ id: integer("id").primaryKey(), task: text("task"), done: boolean("done") }),
});
const camelTestEntry = defineSyncTable({
  tableName: "camel_test",
  makeColumns: () => ({ id: integer("id").primaryKey(), firstName: text("firstName"), lastName: text("lastName") }),
});
const testSyncingEntry = defineSyncTable({
  tableName: "test_syncing",
  makeColumns: () => ({ id: text("id").primaryKey(), value: text("value"), is_syncing: boolean("is_syncing") }),
});
const fooEntry = defineSyncTable({ tableName: "foo", makeColumns: () => ({ id: text("id").primaryKey() }) });
const barEntry = defineSyncTable({ tableName: "bar", makeColumns: () => ({ id: text("id").primaryKey() }) });

const registry = defineSyncRegistry({
  todo: todoEntry,
  project: projectEntry,
  cAseSENSiTiVe: caseSensitiveEntry,
  camel_test: camelTestEntry,
  test_syncing: testSyncingEntry,
  foo: fooEntry,
  bar: barEntry,
});

const todo = todoEntry.localTable;
const project = projectEntry.localTable;
const caseSensitive = caseSensitiveEntry.localTable;
const camelTest = camelTestEntry.localTable;
const testSyncing = testSyncingEntry.localTable;

// ADR-0009 Phase 2 replaced the upstream fire-and-forget `void commitUpToLsn` with a serialized,
// error-surfacing commit queue, so commit failures no longer escape as unhandled rejections. This
// handler is retained as belt-and-suspenders for post-teardown timing (e.g. a backoff timer that
// resumes after a test has closed its PGlite) so the oracle always reports honest pass/fail.
const swallowEngineTeardownRejection = (): void => {};
process.on("unhandledRejection", swallowEngineTeardownRejection);
afterAll(() => {
  process.off("unhandledRejection", swallowEngineTeardownRejection);
  mock.restore();
});

type MultiShapeMessage = MultiShapeMessages<Record<string, Row<unknown>>>;

/** vitest's `vi.waitUntil`: poll until the predicate returns truthy or the timeout elapses. */
async function waitUntil<T>(
  predicate: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const timeout = options.timeout ?? 10_000;
  const interval = options.interval ?? 50;
  const start = Date.now();
  for (;;) {
    const result = await predicate();
    if (result) {
      return result;
    }
    if (Date.now() - start > timeout) {
      throw new Error("waitUntil: timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

describe("sync engine", () => {
  let pg: SyncEnginePGlite;

  beforeEach(async () => {
    // Prepopulated FS (skips the ~1.5s WASM initdb each test) — shim change, behaviour-preserving.
    pg = await attachSyncEngine(await createFreshTestPGlite(), { debug: false });
    // Fresh PGlite each test (beforeEach) — provision the fixture from its Drizzle schema; no
    // CREATE IF NOT EXISTS / TRUNCATE dance is needed on an empty store.
    await createTablesFromSchema(pg, { todo });
    // The per-store WASM create accumulates cost in this single process (each `it` mints a fresh PGlite);
    // by the tail of the suite the create alone can brush the default 5s hook budget under the sharded
    // runner's concurrent load, so give the setup hook explicit headroom (well under `waitUntil`'s 10s).
  }, 20_000);

  it("passes onError through to MultiShapeStream.subscribe", async () => {
    const subscribe = mock().mockReturnValue(() => {});
    MockMultiShapeStream.mockImplementation(() => ({
      subscribe,
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        todos: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
      },
    }));

    const onError = mock();

    await pg.electric.syncShapesToTables({
      registry,
      shapes: {
        todos: {
          shape: {
            url: "http://localhost:3000/v1/shape",
            params: { table: "todo" },
          },
          tableKey: "todo",
        },
      },
      key: null,
      onError,
    });

    expect(subscribe).toHaveBeenCalled();
    const [, passedOnError] = subscribe.mock.calls[0]!;
    expect(passedOnError).toBe(onError);
  });

  it("handles inserts/updates/deletes", async () => {
    let feedMessage: (lsn: number, message: MultiShapeMessage) => Promise<void> = async (_) => {};
    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
        feedMessage = (lsn, message) =>
          cb([
            message,
            {
              shape: "shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: lsn.toString(),
              },
            },
          ]);
      }),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
      },
    }));

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "todo" },
      },
      registry,
      tableKey: "todo",
      shapeKey: null,
    });

    // insert
    await feedMessage(0, {
      headers: { operation: "insert", lsn: "0" },
      key: "id1",
      value: {
        id: 1,
        task: "task1",
        done: false,
      },
      shape: "shape",
    });
    expect(await drizzleOver(pg).select().from(todo)).toEqual([
      {
        id: 1,
        task: "task1",
        done: false,
      },
    ]);

    // update
    await feedMessage(1, {
      headers: { operation: "update", lsn: "1" },
      key: "id1",
      value: {
        id: 1,
        task: "task2",
        done: true,
      },
      shape: "shape",
    });
    expect(await drizzleOver(pg).select().from(todo)).toEqual([
      {
        id: 1,
        task: "task2",
        done: true,
      },
    ]);

    // delete
    await feedMessage(2, {
      headers: { operation: "delete", lsn: "2" },
      key: "id1",
      value: {
        id: 1,
        task: "task2",
        done: true,
      },
      shape: "shape",
    });
    expect(await drizzleOver(pg).select().from(todo)).toEqual([]);

    shape.unsubscribe();
  });

  it("performs operations within a transaction", async () => {
    let feedMessages: (lsn: number, messages: MultiShapeMessage[]) => Promise<void> = async (_) => {};
    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
        feedMessages = (lsn, messages) =>
          cb([
            ...messages,
            {
              shape: "shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: lsn.toString(),
              },
            },
          ]);
      }),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
      },
    }));

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "todo" },
      },
      registry,
      tableKey: "todo",
      shapeKey: null,
    });

    const numInserts = 10000;
    const numBatches = 5;
    for (let i = 0; i < numBatches; i++) {
      const numBatchInserts = numInserts / numBatches;
      // Fire-and-forget by design: the test feeds all batches then waits for convergence.
      void feedMessages(
        i,
        Array.from({ length: numBatchInserts }, (_, idx) => {
          const itemIdx = i * numBatchInserts + idx;
          return {
            headers: { operation: "insert", lsn: i.toString() },
            key: `id${itemIdx}`,
            value: {
              id: itemIdx,
              task: `task${itemIdx}`,
              done: false,
            },
            shape: "shape",
          };
        }),
      );
    }

    // let timeToProcessMicrotask = Infinity
    // const startTime = performance.now()
    // Promise.resolve().then(() => {
    //   timeToProcessMicrotask = performance.now() - startTime
    // })

    let numItemsInserted = 0;
    await waitUntil(async () => {
      numItemsInserted = (await drizzleOver(pg).select({ count: count() }).from(todo))[0]?.count ?? 0;

      // ADR-0009 migration: wait for ALL rows, not just `> 0`. The serialized commit queue applies
      // the fire-and-forget batches in LSN-ordered transactions (e.g. 2000 then 8000), so `> 0`
      // could observe an intermediate count; the upstream engine's overlapping fire-and-forget
      // happened to coalesce into one. The behaviour under test — every row lands transactionally —
      // is preserved and asserted more strictly here.
      return numItemsInserted >= numInserts;
    });

    // should have exact number of inserts added transactionally
    expect(numItemsInserted).toBe(numInserts);

    // should have processed microtask within few ms, not blocking main loop
    // expect(timeToProcessMicrotask).toBeLessThan(15) // TODO: flaky on CI

    shape.unsubscribe();
  });

  it("persists shape stream state and automatically resumes", async () => {
    let feedMessages: (lsn: number, messages: MultiShapeMessage[]) => Promise<void> = async (_) => {};
    const shapeStreamInits = mock();
    let mockShapeId: string | void = undefined;
    MockMultiShapeStream.mockImplementation((initOpts?: ShapeStreamOptions) => {
      shapeStreamInits(initOpts);
      return {
        subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
          feedMessages = (lsn, messages) => {
            mockShapeId ??= Math.random() + "";
            return cb([
              ...messages,
              {
                shape: "shape",
                headers: {
                  control: "up-to-date",
                  global_last_seen_lsn: lsn.toString(),
                },
              },
            ]);
          };
        }),
        unsubscribeAll: mock(),
        isUpToDate: true,
        shapes: {
          shape: {
            subscribe: mock(),
            unsubscribeAll: mock(),
          },
        },
      };
    });

    let totalRowCount = 0;
    const numInserts = 3; //100
    const shapeIds: string[] = [];

    const numResumes = 3;
    for (let i = 0; i < numResumes; i++) {
      const shape = await pg.electric.syncShapeToTable({
        shape: {
          url: "http://localhost:3000/v1/shape",
          params: { table: "todo" },
        },
        registry,
        tableKey: "todo",
        shapeKey: "foo",
      });

      await feedMessages(
        i,
        Array.from({ length: numInserts }, (_, idx) => ({
          headers: {
            operation: "insert",
            lsn: i.toString(),
          },
          key: `id${i * numInserts + idx}`,
          value: {
            id: i * numInserts + idx,
            task: `task${idx}`,
            done: false,
          },
          shape: "shape",
        })),
      );

      await waitUntil(async () => {
        const result = await drizzleOver(pg).select({ count: count() }).from(todo);

        if ((result[0]?.count ?? 0) > totalRowCount) {
          totalRowCount = result[0]!.count;
          return true;
        }
        return false;
      });
      shapeIds.push(mockShapeId!);

      expect(shapeStreamInits).toHaveBeenCalledTimes(i + 1);
      if (i === 0) {
        expect(shapeStreamInits.mock.calls[i]![0]).not.toHaveProperty("shapeId");
        expect(shapeStreamInits.mock.calls[i]![0]).not.toHaveProperty("offset");
      }

      shape.unsubscribe();
    }
  });

  it("clears and restarts persisted shape stream state on refetch", async () => {
    let feedMessages: (messages: MultiShapeMessage[]) => Promise<void> = async (_) => {};
    const shapeStreamInits = mock();
    let mockShapeId: string | void = undefined;
    MockMultiShapeStream.mockImplementation((initOpts?: ShapeStreamOptions) => {
      shapeStreamInits(initOpts);
      return {
        subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
          feedMessages = (messages) => {
            mockShapeId ??= Math.random() + "";
            if (messages.find((m) => m.headers.control === "must-refetch")) {
              mockShapeId = undefined;
            }

            return cb([
              ...messages,
              {
                shape: "shape",
                headers: {
                  control: "up-to-date",
                  global_last_seen_lsn: "0",
                },
              },
            ]);
          };
        }),
        unsubscribeAll: mock(),
        isUpToDate: true,
        shapes: {
          shape: {
            subscribe: mock(),
            unsubscribeAll: mock(),
          },
        },
      };
    });

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "todo" },
      },
      registry,
      tableKey: "todo",
      shapeKey: "foo",
    });

    const numInserts = 100;
    await feedMessages([
      {
        headers: { operation: "insert" },
        key: `id${numInserts}`,
        value: {
          id: numInserts,
          task: `task`,
          done: false,
        },
        shape: "shape",
      },
      { headers: { control: "must-refetch" }, shape: "shape" },
      {
        headers: { operation: "insert" },
        key: `id21`,
        value: {
          id: 21,
          task: `task`,
          done: false,
        },
        shape: "shape",
      },
    ]);

    const result = await drizzleOver(pg).select().from(todo);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 21,
      done: false,
      task: "task",
    });

    shape.unsubscribe();

    // resuming should
    const resumedShape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "todo" },
      },
      registry,
      tableKey: "todo",
      shapeKey: "foo",
    });
    resumedShape.unsubscribe();

    expect(shapeStreamInits).toHaveBeenCalledTimes(2);

    expect(shapeStreamInits.mock.calls[1]![0]).not.toHaveProperty("shapeId");
    expect(shapeStreamInits.mock.calls[1]![0]).not.toHaveProperty("offset");
  });

  it("uses the specified metadata schema for subscription metadata", async () => {
    const metadataSchema = "foobar";
    const db = await attachSyncEngine(await createFreshTestPGlite(), { metadataSchema });
    await db.electric.initMetadataTables();

    const result = await drizzleOver(db)
      .select({ schema_name: informationSchemaSchemata.schemaName })
      .from(informationSchemaSchemata)
      .where(eq(informationSchemaSchemata.schemaName, metadataSchema));
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ schema_name: metadataSchema });
  });

  // ADR-0042: an ephemeral group's sync bookkeeping (cursor + tags) is SESSION-scoped — the engine stores
  // it in `pg_temp` relations that die with the engine, so a warm restart re-streams the shape from scratch
  // rather than resuming a stale durable cursor over a recreated-empty TEMP cluster. These tests pin the
  // storage-scope routing at the engine seam on real PGlite (the default metadata schema is `pgxsinkit`).
  const feedOneShape = () => {
    let feed: (lsn: number, messages: MultiShapeMessage[]) => Promise<void> = async () => {};
    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
        feed = (lsn, messages) =>
          cb([
            ...messages,
            { shape: "shape", headers: { control: "up-to-date", global_last_seen_lsn: lsn.toString() } },
          ]);
      }),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: { shape: { subscribe: mock(), unsubscribeAll: mock() } },
    }));
    return () => feed;
  };
  const cursorKeys = async (relation: string): Promise<string[]> =>
    (await pg.query<{ key: string }>(`SELECT key FROM ${relation} ORDER BY key`)).rows.map((r) => r.key);
  const tagRows = async (relation: string): Promise<{ shape_table: string; tag: string }[]> =>
    (
      await pg.query<{ shape_table: string; tag: string }>(
        `SELECT shape_table, tag FROM ${relation} ORDER BY shape_table, tag`,
      )
    ).rows;

  it("ADR-0042: an ephemeral (sessionScoped) group persists its cursor to pg_temp, not the durable table", async () => {
    const getFeed = feedOneShape();
    const shape = await pg.electric.syncShapeToTable({
      shape: { url: "http://localhost:3000/v1/shape", params: { table: "todo" } },
      registry,
      tableKey: "todo",
      shapeKey: "eph",
      sessionScoped: true,
    });

    await getFeed()(0, [
      {
        headers: { operation: "insert", lsn: "0" },
        key: "id1",
        value: { id: 1, task: "t", done: false },
        shape: "shape",
      },
    ]);
    await waitUntil(async () => ((await drizzleOver(pg).select({ count: count() }).from(todo))[0]?.count ?? 0) === 1);

    expect(await cursorKeys("pgxsinkit.subscriptions_metadata")).toEqual([]);
    expect(await cursorKeys("pg_temp.subscriptions_metadata")).toEqual(["eph"]);
    shape.unsubscribe();
  });

  it("ADR-0042: a persistent group persists its cursor durably (session table stays empty)", async () => {
    const getFeed = feedOneShape();
    const shape = await pg.electric.syncShapeToTable({
      shape: { url: "http://localhost:3000/v1/shape", params: { table: "todo" } },
      registry,
      tableKey: "todo",
      shapeKey: "per",
    });

    await getFeed()(0, [
      {
        headers: { operation: "insert", lsn: "0" },
        key: "id1",
        value: { id: 1, task: "t", done: false },
        shape: "shape",
      },
    ]);
    await waitUntil(async () => ((await drizzleOver(pg).select({ count: count() }).from(todo))[0]?.count ?? 0) === 1);

    expect(await cursorKeys("pgxsinkit.subscriptions_metadata")).toEqual(["per"]);
    expect(await cursorKeys("pg_temp.subscriptions_metadata")).toEqual([]);
    shape.unsubscribe();
  });

  it("ADR-0042: an ephemeral group's tagged-subquery reason sets land in the session tag store", async () => {
    const getFeed = feedOneShape();
    const shape = await pg.electric.syncShapeToTable({
      shape: { url: "http://localhost:3000/v1/shape", params: { table: "todo" } },
      registry,
      tableKey: "todo",
      shapeKey: "eph-tags",
      sessionScoped: true,
    });

    await getFeed()(0, [
      {
        headers: { operation: "insert", lsn: "0", tags: ["grantA"] },
        key: "id1",
        value: { id: 1, task: "t", done: false },
        shape: "shape",
      },
    ]);
    await waitUntil(async () => ((await drizzleOver(pg).select({ count: count() }).from(todo))[0]?.count ?? 0) === 1);

    expect(await tagRows("pgxsinkit.shape_row_tags")).toEqual([]);
    expect(await tagRows("pg_temp.shape_row_tags")).toEqual([{ shape_table: "public.todo", tag: "grantA" }]);
    shape.unsubscribe();
  });

  it("ADR-0042: deleteSubscription is scope-blind (removes the key from both cursor tables)", async () => {
    await pg.electric.initMetadataTables();
    // A durable row from persistent retention AND a session row for the same key.
    await pg.exec(
      `INSERT INTO pgxsinkit.subscriptions_metadata (key, shape_metadata, last_lsn) VALUES ('k', '{}', '0');
       INSERT INTO pg_temp.subscriptions_metadata (key, shape_metadata, last_lsn) VALUES ('k', '{}', '0');`,
    );
    expect(await cursorKeys("pgxsinkit.subscriptions_metadata")).toEqual(["k"]);
    expect(await cursorKeys("pg_temp.subscriptions_metadata")).toEqual(["k"]);

    await pg.electric.deleteSubscription("k");

    expect(await cursorKeys("pgxsinkit.subscriptions_metadata")).toEqual([]);
    expect(await cursorKeys("pg_temp.subscriptions_metadata")).toEqual([]);
  });

  it("ADR-0042: deleteSubscription self-provisions the metadata store (no 42P01 before any sync started)", async () => {
    // A warm-store reset can fire before any group started — so nothing has triggered `initMetadataTables`
    // yet and the `pg_temp` cursor table does not exist. The scope-blind delete now touches it, so
    // `deleteSubscription` must self-provision first (idempotent) rather than throw 42P01 (undefined_table).
    await pg.electric.deleteSubscription("never-synced");
    // Both cursor tables now exist (provisioned) and are empty.
    expect(await cursorKeys("pgxsinkit.subscriptions_metadata")).toEqual([]);
    expect(await cursorKeys("pg_temp.subscriptions_metadata")).toEqual([]);
  });

  it("forbids multiple subscriptions to the same table", async () => {
    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock(),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
      },
    }));

    const table = "foo";
    const altTable = "bar";

    const shape1 = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "todo" },
      },
      registry,
      tableKey: table,
      shapeKey: null,
    });

    // should throw if syncing a second shape into the same table. (Asserted via try/catch rather than
    // `.rejects.toThrow(msg)` so the message check is plainly typed through the dynamically-imported
    // engine namespace — the matcher-with-message overload isn't seen as thenable by the type-lint.)
    const conflictingSync: Promise<unknown> = pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "todo_alt" },
      },
      registry,
      tableKey: table,
      shapeKey: null,
    });
    let conflictError: Error | undefined;
    try {
      await conflictingSync;
    } catch (error) {
      conflictError = error as Error;
    }
    expect(conflictError?.message).toBe(`Already syncing shape for table ${table}`);

    // should be able to sync shape into other table
    const altShape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "bar" },
      },
      registry,
      tableKey: altTable,
      shapeKey: null,
    });
    altShape.unsubscribe();

    // should be able to sync different shape if previous is unsubscribed
    // (and we assume data has been cleaned up?)
    shape1.unsubscribe();

    const shape2 = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "todo_alt" },
      },
      registry,
      tableKey: table,
      shapeKey: null,
    });
    shape2.unsubscribe();
  });

  it("handles an update message with no columns to update", async () => {
    let feedMessage: (message: MultiShapeMessage) => Promise<void> = async (_) => {};
    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
        feedMessage = (message) =>
          cb([
            message,
            {
              shape: "shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: "0",
              },
            },
          ]);
      }),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
      },
    }));

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "todo" },
      },
      registry,
      tableKey: "todo",
      shapeKey: null,
    });

    // insert
    await feedMessage({
      headers: { operation: "insert" },
      key: "id1",
      value: {
        id: 1,
        task: "task1",
        done: false,
      },
      shape: "shape",
    });
    expect(await drizzleOver(pg).select().from(todo)).toEqual([
      {
        id: 1,
        task: "task1",
        done: false,
      },
    ]);

    // update with no columns to update
    await feedMessage({
      headers: { operation: "update" },
      key: "id1",
      value: {
        id: 1,
      },
      shape: "shape",
    });
    expect(await drizzleOver(pg).select().from(todo)).toEqual([
      {
        id: 1,
        task: "task1",
        done: false,
      },
    ]);

    shape.unsubscribe();
  });

  it("sets the syncing flag to true when syncing begins", async () => {
    let feedMessage: (message: MultiShapeMessage) => Promise<void> = async (_) => {};
    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
        feedMessage = (message) =>
          cb([
            message,
            {
              shape: "shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: "0",
              },
            },
          ]);
      }),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
      },
    }));

    await createTablesFromSchema(pg, { testSyncing });
    // Tier-③ (ADR-0028 allow-list): a PL/pgSQL function body + trigger — genuinely inexpressible in
    // Drizzle — that stamps rows with the sync-origin GUC so the assertions below can observe it.
    await pg.exec(`
      CREATE OR REPLACE FUNCTION check_syncing()
      RETURNS TRIGGER AS $$
      DECLARE
        is_syncing BOOLEAN;
      BEGIN
        is_syncing := COALESCE(current_setting('pgxsinkit.syncing', true)::boolean, false);
        IF is_syncing THEN
          NEW.is_syncing := TRUE;
        ELSE
          NEW.is_syncing := FALSE;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER test_syncing_trigger
      BEFORE INSERT ON test_syncing
      FOR EACH ROW EXECUTE FUNCTION check_syncing();
    `);

    // Check the flag is not set outside of a sync. Tier-③ (ADR-0028 allow-list): a `current_setting(...)`
    // GUC probe has no Drizzle form.
    const result0 = await pg.sql`SELECT current_setting('pgxsinkit.syncing', true)`;
    expect(result0.rows[0]).toEqual({ current_setting: null }); // not set yet as syncShapeToTable hasn't been called

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "test_syncing" },
      },
      registry,
      tableKey: "test_syncing",
      shapeKey: null,
    });

    await feedMessage({
      headers: { operation: "insert" },
      key: "id1",
      value: {
        id: "id1",
        value: "test value",
      },
      shape: "shape",
    });

    // Check the flag is set during a sync
    const result = await drizzleOver(pg).select().from(testSyncing).where(eq(testSyncing.id, "id1"));
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "id1",
      value: "test value",
      is_syncing: true,
    });

    // Check the flag is not set outside of a sync. Tier-③ (ADR-0028 allow-list): a `current_setting(...)`
    // GUC probe has no Drizzle form.
    const result2 = await pg.sql`SELECT current_setting('pgxsinkit.syncing', true)`;
    expect(result2.rows[0]).toEqual({ current_setting: "false" });

    shape.unsubscribe();
  });

  it("uses COPY FROM for initial batch of inserts", async () => {
    let feedMessages: (messages: MultiShapeMessage[]) => Promise<void> = async (_) => {};
    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
        feedMessages = (messages) =>
          cb([
            ...messages,
            {
              shape: "shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: "0",
              },
            },
          ]);
      }),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
      },
    }));

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "todo" },
      },
      registry,
      tableKey: "todo",
      initialInsertMethod: "copy",
      shapeKey: null,
    });

    // Create a batch of insert messages followed by an update
    const numInserts = 1000;
    const messages: MultiShapeMessage[] = [
      ...Array.from(
        { length: numInserts },
        (_, idx) =>
          ({
            headers: { operation: "insert" as const },
            key: `id${idx}`,
            value: {
              id: idx,
              task: `task${idx}`,
              done: idx % 2 === 0,
            },
            shape: "shape",
          }) as MultiShapeMessage,
      ),
      {
        headers: { operation: "update" as const },
        key: `id0`,
        value: {
          id: 0,
          task: "updated task",
          done: true,
        },
        shape: "shape",
      },
    ];

    await feedMessages(messages);

    // Wait for all inserts to complete
    await waitUntil(async () => {
      const result = await drizzleOver(pg).select({ count: count() }).from(todo);
      return result[0]!.count === numInserts;
    });

    // Verify the data was inserted correctly
    const result = await drizzleOver(pg).select().from(todo).orderBy(todo.id).limit(5);
    expect(result).toEqual([
      { id: 0, task: "updated task", done: true },
      { id: 1, task: "task1", done: false },
      { id: 2, task: "task2", done: true },
      { id: 3, task: "task3", done: false },
      { id: 4, task: "task4", done: true },
    ]);

    // Verify total count
    const countResult = await drizzleOver(pg).select({ count: count() }).from(todo);
    expect(countResult[0]!.count).toBe(numInserts);

    shape.unsubscribe();
  });

  it("handles special characters in COPY FROM data", async () => {
    let feedMessages: (messages: MultiShapeMessage[]) => Promise<void> = async (_) => {};
    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
        feedMessages = (messages) =>
          cb([
            ...messages,
            {
              shape: "shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: "0",
              },
            },
          ]);
      }),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
      },
    }));

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "todo" },
      },
      registry,
      tableKey: "todo",
      initialInsertMethod: "copy",
      shapeKey: null,
    });

    const specialCharMessages: MultiShapeMessage[] = [
      {
        headers: { operation: "insert" },
        key: "id1",
        value: {
          id: 1,
          task: "task with, comma",
          done: false,
        },
        shape: "shape",
      },
      {
        headers: { operation: "insert" },
        key: "id2",
        value: {
          id: 2,
          task: 'task with "quotes"',
          done: true,
        },
        shape: "shape",
      },
      {
        headers: { operation: "insert" },
        key: "id3",
        value: {
          id: 3,
          task: "task with\nnewline",
          done: false,
        },
        shape: "shape",
      },
    ];

    await feedMessages(specialCharMessages);

    // Wait for inserts to complete
    await waitUntil(async () => {
      const result = await drizzleOver(pg).select({ count: count() }).from(todo);
      return result[0]!.count === specialCharMessages.length;
    });

    // Verify the data was inserted correctly with special characters preserved
    const result = await drizzleOver(pg).select().from(todo).orderBy(todo.id);
    expect(result).toEqual([
      { id: 1, task: "task with, comma", done: false },
      { id: 2, task: 'task with "quotes"', done: true },
      { id: 3, task: "task with\nnewline", done: false },
    ]);

    shape.unsubscribe();
  });

  it("calls onInitialSync callback after initial sync", async () => {
    let feedMessages: (lsn: number, messages: MultiShapeMessage[]) => Promise<void> = async (_) => {};
    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
        feedMessages = (lsn, messages) =>
          cb([
            ...messages,
            {
              shape: "shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: lsn.toString(),
              },
            },
          ]);
      }),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
      },
    }));

    const onInitialSync = mock(() => {
      console.log("onInitialSync");
    });
    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "todo" },
      },
      registry,
      tableKey: "todo",
      onInitialSync,
      shapeKey: null,
    });

    // Send some initial data
    await feedMessages(0, [
      {
        headers: { operation: "insert", lsn: "0" },
        key: "id1",
        value: {
          id: 1,
          task: "task1",
          done: false,
        },
        shape: "shape",
      },
      {
        headers: { operation: "insert", lsn: "0" },
        key: "id2",
        value: {
          id: 2,
          task: "task2",
          done: true,
        },
        shape: "shape",
      },
    ]);

    // Verify callback was called once
    expect(onInitialSync).toHaveBeenCalledTimes(1);

    // Send more data - callback should not be called again
    await feedMessages(1, [
      {
        headers: { operation: "insert", lsn: "1" },
        key: "id3",
        value: {
          id: 3,
          task: "task3",
          done: false,
        },
        shape: "shape",
      },
    ]);

    // Verify callback was still only called once
    expect(onInitialSync).toHaveBeenCalledTimes(1);

    // Verify all data was inserted
    expect((await drizzleOver(pg).select({ count: count() }).from(todo))[0]!.count).toBe(3);

    shape.unsubscribe();
  });

  it("syncs multiple shapes to multiple tables simultaneously", async () => {
    // Second fixture table for the multi-shape tests — provisioned from its Drizzle schema.
    await createTablesFromSchema(pg, { project });

    // Setup mock for MultiShapeStream with two shapes
    let feedMessages: (lsn: number, messages: MultiShapeMessage[]) => Promise<void> = async (_) => {};
    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
        feedMessages = (lsn, messages) =>
          cb([
            ...messages,
            {
              shape: "todo_shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: lsn.toString(),
              },
            },
            {
              shape: "project_shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: lsn.toString(),
              },
            },
          ]);
      }),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        todo_shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
        project_shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
      },
    }));

    // Set up sync for both tables
    const onInitialSync = mock();
    const syncResult = await pg.electric.syncShapesToTables({
      registry,
      key: "multi_sync_test",
      shapes: {
        todo_shape: {
          shape: {
            url: "http://localhost:3000/v1/shape",
            params: { table: "todo" },
          },
          tableKey: "todo",
        },
        project_shape: {
          shape: {
            url: "http://localhost:3000/v1/shape",
            params: { table: "project" },
          },
          tableKey: "project",
        },
      },
      onInitialSync,
    });

    // Send data for both shapes in a single batch
    await feedMessages(0, [
      // Todo table inserts
      {
        headers: { operation: "insert", lsn: "0" },
        key: "id1",
        value: {
          id: 1,
          task: "task1",
          done: false,
        },
        shape: "todo_shape",
      },
      {
        headers: { operation: "insert", lsn: "0" },
        key: "id2",
        value: {
          id: 2,
          task: "task2",
          done: true,
        },
        shape: "todo_shape",
      },
      // Project table inserts
      {
        headers: { operation: "insert", lsn: "0" },
        key: "id1",
        value: {
          id: 1,
          name: "Project 1",
          active: true,
        },
        shape: "project_shape",
      },
      {
        headers: { operation: "insert", lsn: "0" },
        key: "id2",
        value: {
          id: 2,
          name: "Project 2",
          active: false,
        },
        shape: "project_shape",
      },
    ]);

    // Verify data was inserted into both tables
    const todoResult = await drizzleOver(pg).select().from(todo).orderBy(todo.id);
    expect(todoResult).toEqual([
      { id: 1, task: "task1", done: false },
      { id: 2, task: "task2", done: true },
    ]);

    const projectResult = await drizzleOver(pg).select().from(project).orderBy(project.id);
    expect(projectResult).toEqual([
      { id: 1, name: "Project 1", active: true },
      { id: 2, name: "Project 2", active: false },
    ]);

    // Verify onInitialSync was called
    expect(onInitialSync).toHaveBeenCalledTimes(1);

    // Test updates across both tables
    await feedMessages(1, [
      // Update todo
      {
        headers: { operation: "update", lsn: "1" },
        key: "id1",
        value: {
          id: 1,
          task: "Updated task 1",
          done: true,
        },
        shape: "todo_shape",
      },
      // Update project
      {
        headers: { operation: "update", lsn: "1" },
        key: "id2",
        value: {
          id: 2,
          name: "Updated Project 2",
          active: true,
        },
        shape: "project_shape",
      },
    ]);

    // Verify updates were applied to both tables
    const updatedTodoResult = await drizzleOver(pg).select().from(todo).where(eq(todo.id, 1));
    expect(updatedTodoResult[0]).toEqual({
      id: 1,
      task: "Updated task 1",
      done: true,
    });

    const updatedProjectResult = await drizzleOver(pg).select().from(project).where(eq(project.id, 2));
    expect(updatedProjectResult[0]).toEqual({
      id: 2,
      name: "Updated Project 2",
      active: true,
    });

    // Test deletes across both tables
    await feedMessages(2, [
      {
        headers: { operation: "delete", lsn: "2" },
        key: "id2",
        shape: "todo_shape",
        value: { id: 2 },
      },
      {
        headers: { operation: "delete", lsn: "2" },
        key: "id1",
        shape: "project_shape",
        value: { id: 1 },
      },
    ]);

    // Verify deletes were applied to both tables
    const todoCountAfterDelete = await drizzleOver(pg).select({ count: count() }).from(todo);
    expect(todoCountAfterDelete[0]!.count).toBe(1);

    const projectCountAfterDelete = await drizzleOver(pg).select({ count: count() }).from(project);
    expect(projectCountAfterDelete[0]!.count).toBe(1);

    // Cleanup
    syncResult.unsubscribe();
  });

  it("handles transactions across multiple tables with syncShapesToTables", async () => {
    // Second fixture table for the multi-shape tests — provisioned from its Drizzle schema.
    await createTablesFromSchema(pg, { project });

    // Setup mock for MultiShapeStream with two shapes and LSN tracking
    let feedMessages: (lsn: number, messages: MultiShapeMessage[]) => Promise<void> = async (_lsn, _messages) => {};

    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
        feedMessages = (lsn, messages) =>
          cb([
            ...messages.map((msg) => {
              if ("headers" in msg && "operation" in msg.headers) {
                return {
                  ...msg,
                  headers: {
                    ...msg.headers,
                    lsn: lsn.toString(),
                  },
                } as MultiShapeMessage;
              }
              return msg;
            }),
            {
              shape: "todo_shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: lsn.toString(),
              },
            } as MultiShapeMessage,
            {
              shape: "project_shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: lsn.toString(),
              },
            } as MultiShapeMessage,
          ]);
      }),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        todo_shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
        project_shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
      },
    }));

    // Set up sync for both tables
    const syncResult = await pg.electric.syncShapesToTables({
      registry,
      key: "transaction_test",
      shapes: {
        todo_shape: {
          shape: {
            url: "http://localhost:3000/v1/shape",
            params: { table: "todo" },
          },
          tableKey: "todo",
        },
        project_shape: {
          shape: {
            url: "http://localhost:3000/v1/shape",
            params: { table: "project" },
          },
          tableKey: "project",
        },
      },
    });

    // Send initial data with LSN 1
    await feedMessages(1, [
      {
        headers: { operation: "insert" },
        key: "id1",
        value: {
          id: 1,
          task: "Initial task",
          done: false,
        },
        shape: "todo_shape",
      },
      {
        headers: { operation: "insert" },
        key: "id1",
        value: {
          id: 1,
          name: "Initial project",
          active: true,
        },
        shape: "project_shape",
      },
    ]);

    // Verify initial data was inserted
    const initialTodoCount = await drizzleOver(pg).select({ count: count() }).from(todo);
    expect(initialTodoCount[0]!.count).toBe(1);

    const initialProjectCount = await drizzleOver(pg).select({ count: count() }).from(project);
    expect(initialProjectCount[0]!.count).toBe(1);

    // Simulate a transaction with LSN 2 that updates both tables
    await feedMessages(2, [
      {
        headers: { operation: "update" },
        key: "id1",
        value: {
          id: 1,
          task: "Updated in transaction",
          done: true,
        },
        shape: "todo_shape",
      },
      {
        headers: { operation: "update" },
        key: "id1",
        value: {
          id: 1,
          name: "Updated in transaction",
          active: false,
        },
        shape: "project_shape",
      },
    ]);

    // Verify both updates were applied
    const todoResult = await drizzleOver(pg).select().from(todo).where(eq(todo.id, 1));
    expect(todoResult[0]).toEqual({
      id: 1,
      task: "Updated in transaction",
      done: true,
    });

    const projectResult = await drizzleOver(pg).select().from(project).where(eq(project.id, 1));
    expect(projectResult[0]).toEqual({
      id: 1,
      name: "Updated in transaction",
      active: false,
    });

    // Cleanup
    syncResult.unsubscribe();
  });

  it("handles must-refetch control message across multiple tables", async () => {
    // Second fixture table for the multi-shape tests — provisioned from its Drizzle schema.
    await createTablesFromSchema(pg, { project });

    // Setup mock for MultiShapeStream with refetch handling
    let feedMessages: (messages: MultiShapeMessage[]) => Promise<void> = async (_) => {};
    let mockShapeId: string | void = undefined;

    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
        feedMessages = (messages) => {
          mockShapeId ??= Math.random() + "";
          if (messages.find((m) => m.headers.control === "must-refetch")) {
            mockShapeId = undefined;
          }

          return cb([
            ...messages,
            {
              shape: "todo_shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: "0",
              },
            } as MultiShapeMessage,
            {
              shape: "project_shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: "0",
              },
            } as MultiShapeMessage,
          ]);
        };
      }),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        todo_shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
        project_shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
      },
    }));

    // Set up sync for both tables
    const syncResult = await pg.electric.syncShapesToTables({
      registry,
      key: "refetch_test",
      shapes: {
        todo_shape: {
          shape: {
            url: "http://localhost:3000/v1/shape",
            params: { table: "todo" },
          },
          tableKey: "todo",
        },
        project_shape: {
          shape: {
            url: "http://localhost:3000/v1/shape",
            params: { table: "project" },
          },
          tableKey: "project",
        },
      },
    });

    // Insert initial data
    await feedMessages([
      {
        headers: { operation: "insert" },
        key: "id1",
        value: {
          id: 1,
          task: "Initial task",
          done: false,
        },
        shape: "todo_shape",
      },
      {
        headers: { operation: "insert" },
        key: "id1",
        value: {
          id: 1,
          name: "Initial project",
          active: true,
        },
        shape: "project_shape",
      },
    ]);

    // Verify initial data was inserted
    const refetchTodoCount = await drizzleOver(pg).select({ count: count() }).from(todo);
    expect(refetchTodoCount[0]!.count).toBe(1);

    const refetchProjectCount = await drizzleOver(pg).select({ count: count() }).from(project);
    expect(refetchProjectCount[0]!.count).toBe(1);

    // Send must-refetch control message and new data
    await feedMessages([
      { headers: { control: "must-refetch" }, shape: "todo_shape" },
      { headers: { control: "must-refetch" }, shape: "project_shape" },
      {
        headers: { operation: "insert" },
        key: "id2",
        value: {
          id: 2,
          task: "New task after refetch",
          done: true,
        },
        shape: "todo_shape",
      },
      {
        headers: { operation: "insert" },
        key: "id2",
        value: {
          id: 2,
          name: "New project after refetch",
          active: false,
        },
        shape: "project_shape",
      },
    ]);

    // Verify tables were cleared and new data was inserted
    const todoResult = await drizzleOver(pg).select().from(todo).orderBy(todo.id);
    expect(todoResult).toEqual([
      {
        id: 2,
        task: "New task after refetch",
        done: true,
      },
    ]);

    const projectResult = await drizzleOver(pg).select().from(project).orderBy(project.id);
    expect(projectResult).toEqual([
      {
        id: 2,
        name: "New project after refetch",
        active: false,
      },
    ]);

    // Cleanup
    syncResult.unsubscribe();
  });

  it("case sensitivity: handles inserts/updates/deletes on case sensitive table names", async () => {
    let feedMessage: (lsn: number, message: MultiShapeMessage) => Promise<void> = async (_) => {};
    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
        feedMessage = (lsn, message) =>
          cb([
            message,
            {
              shape: "shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: lsn.toString(),
              },
            },
          ]);
      }),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
      },
    }));

    // Mixed-case identifier fixture — provisioned from its Drizzle schema (drizzle quotes it verbatim).
    await createTablesFromSchema(pg, { caseSensitive });

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "cAseSENSiTiVe" },
      },
      registry,
      tableKey: "cAseSENSiTiVe",
      shapeKey: null,
    });

    // insert
    await feedMessage(0, {
      headers: { operation: "insert", lsn: "0" },
      key: "id1",
      value: {
        id: 1,
        task: "task1",
        done: false,
      },
      shape: "shape",
    });
    expect(await drizzleOver(pg).select().from(caseSensitive)).toEqual([
      {
        id: 1,
        task: "task1",
        done: false,
      },
    ]);

    // update
    await feedMessage(1, {
      headers: { operation: "update", lsn: "1" },
      key: "id1",
      value: {
        id: 1,
        task: "task2",
        done: true,
      },
      shape: "shape",
    });
    expect(await drizzleOver(pg).select().from(caseSensitive)).toEqual([
      {
        id: 1,
        task: "task2",
        done: true,
      },
    ]);

    // delete
    await feedMessage(2, {
      headers: { operation: "delete", lsn: "2" },
      key: "id1",
      value: {
        id: 1,
        task: "task2",
        done: true,
      },
      shape: "shape",
    });
    expect(await drizzleOver(pg).select().from(caseSensitive)).toEqual([]);

    shape.unsubscribe();
  });

  it("ADR-0031: a busy shape's catch-up change commits despite a quiet shape's stale cached watermark", async () => {
    // The live board symptom: Electric's non-live catch-up responses are CDN-cacheable and carry the
    // `up-to-date` watermark inside the cached body, so a quiet shape (project) can deliver a STALE
    // watermark below a busy shape's (todo) freshly-delivered change. WITHOUT the commit-floor alignment
    // the busy shape's change is held below the group min-frontier until the quiet shape's first LIVE
    // long-poll returns a fresh watermark; WITH it the change commits at catch-up completion.
    await createTablesFromSchema(pg, { project });

    // A raw-feed mock: we craft the per-shape `up-to-date` watermarks ourselves (unlike the sugar mocks
    // above that append a single shared up-to-date), so we can model the two shapes' divergent cache
    // generations exactly.
    let feedRaw: (messages: MultiShapeMessage[]) => Promise<void> = async (_) => {};
    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
        feedRaw = (messages) => cb(messages);
      }),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        todo_shape: { subscribe: mock(), unsubscribeAll: mock() },
        project_shape: { subscribe: mock(), unsubscribeAll: mock() },
      },
    }));

    const syncResult = await pg.electric.syncShapesToTables({
      registry,
      key: null,
      shapes: {
        todo_shape: { shape: { url: "http://localhost:3000/v1/shape", params: { table: "todo" } }, tableKey: "todo" },
        project_shape: {
          shape: { url: "http://localhost:3000/v1/shape", params: { table: "project" } },
          tableKey: "project",
        },
      },
    });

    // Both shapes' catch-up chains in one delivered batch:
    //  - todo (busy): a snapshot insert (no lsn), then an UPDATE at LSN 5, then up-to-date at global head 5.
    //  - project (quiet): a snapshot insert, then a STALE up-to-date at global head 2 (its cached response
    //    predates todo's LSN-5 write).
    await feedRaw([
      {
        headers: { operation: "insert" },
        key: "id1",
        value: { id: 1, task: "orig", done: false },
        shape: "todo_shape",
      },
      {
        headers: { operation: "update", lsn: "5", last: true },
        key: "id1",
        value: { id: 1, task: "UPDATED", done: true },
        shape: "todo_shape",
      },
      { shape: "todo_shape", headers: { control: "up-to-date", global_last_seen_lsn: "5" } },
      {
        headers: { operation: "insert" },
        key: "id1",
        value: { id: 1, name: "p1", active: true },
        shape: "project_shape",
      },
      { shape: "project_shape", headers: { control: "up-to-date", global_last_seen_lsn: "2" } },
    ]);

    // The busy shape's LSN-5 update IS applied at catch-up completion — with NO further (live) up-to-date
    // fed from the quiet shape. Before ADR-0031 this row would read "orig" until project's first live poll.
    expect(await drizzleOver(pg).select().from(todo).where(eq(todo.id, 1))).toEqual([
      { id: 1, task: "UPDATED", done: true },
    ]);

    // A late entry for the quiet shape at LSN 3 — below the aligned floor (5) but above project's raw dedup
    // frontier (2), i.e. exactly the change a stale cached catch-up omitted. It is ingested (never
    // dedup-dropped) and committed on this next batch via the `hasLateArrivals` loop trigger, with no
    // frontier advance past the already-committed target.
    await feedRaw([
      {
        headers: { operation: "insert", lsn: "3", last: true },
        key: "id2",
        value: { id: 2, name: "p2-late", active: false },
        shape: "project_shape",
      },
    ]);

    expect(await drizzleOver(pg).select().from(project).orderBy(project.id)).toEqual([
      { id: 1, name: "p1", active: true },
      { id: 2, name: "p2-late", active: false },
    ]);

    syncResult.unsubscribe();
  });

  it("handles camelCase column names with json_to_recordset", async () => {
    // camelCase-column fixture — provisioned from its Drizzle schema (columns quoted verbatim).
    await createTablesFromSchema(pg, { camelTest });

    let feedMessages: (messages: MultiShapeMessage[]) => Promise<void> = async (_) => {};
    MockMultiShapeStream.mockImplementation(() => ({
      subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
        feedMessages = (messages) =>
          cb([
            ...messages,
            {
              shape: "shape",
              headers: {
                control: "up-to-date",
                global_last_seen_lsn: "0",
              },
            },
          ]);
      }),
      unsubscribeAll: mock(),
      isUpToDate: true,
      shapes: {
        shape: {
          subscribe: mock(),
          unsubscribeAll: mock(),
        },
      },
    }));

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "camel_test" },
      },
      registry,
      tableKey: "camel_test",
      initialInsertMethod: "json",
      shapeKey: null,
    });

    const messages: MultiShapeMessage[] = [
      {
        headers: { operation: "insert" as const },
        key: "id1",
        value: {
          id: 1,
          firstName: "Alice",
          lastName: "Smith",
        },
        shape: "shape",
      },
      {
        headers: { operation: "insert" as const },
        key: "id2",
        value: {
          id: 2,
          firstName: "Bob",
          lastName: "Jones",
        },
        shape: "shape",
      },
    ];

    await feedMessages(messages);

    await waitUntil(async () => {
      const result = await drizzleOver(pg).select({ count: count() }).from(camelTest);
      return result[0]!.count === 2;
    });

    const result = await drizzleOver(pg).select().from(camelTest).orderBy(camelTest.id);
    expect(result).toEqual([
      { id: 1, firstName: "Alice", lastName: "Smith" },
      { id: 2, firstName: "Bob", lastName: "Jones" },
    ]);

    shape.unsubscribe();
  });

  // ─── Fresh-store prefetch overlap (ADR-0032 S4 / backlog-0003) ──────────────────────────────────────
  // The engine starts the shape streams and buffers their catch-up into the memory inbox the moment
  // `syncShapesToTables` is called, gating every commit (the first PGlite write) on the caller's `dbReady`
  // promise. These drive that gate directly: a controllable `dbReady` deferred + the mock stream fed while
  // the gate is HELD, then released — asserting nothing touches PGlite before the gate lifts and the whole
  // buffered catch-up drains in one commit train on open.
  describe("fresh-store prefetch overlap (S4)", () => {
    /** Install a rail sink capturing every `syncDebug` line in order; returns the buffer + a restore fn. */
    function captureRail(): { lines: Array<{ event: string; data?: Record<string, unknown> }>; restore: () => void } {
      const lines: Array<{ event: string; data?: Record<string, unknown> }> = [];
      setSyncDebugSink((event, _stamp, data) => lines.push(data ? { event, data } : { event }));
      return { lines, restore: () => setSyncDebugSink(undefined) };
    }

    /** A single-shape mock stream whose subscribe callback is exposed via `feed` (returns the cb's promise). */
    function mockFeedStream(): { feed: (messages: MultiShapeMessage[]) => Promise<void> } {
      const box: { feed: (messages: MultiShapeMessage[]) => Promise<void> } = { feed: async () => {} };
      MockMultiShapeStream.mockImplementation(() => ({
        subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
          box.feed = (messages) => cb(messages);
        }),
        unsubscribeAll: mock(),
        isUpToDate: true,
        shapes: { shape: { subscribe: mock(), unsubscribeAll: mock() } },
      }));
      return box;
    }

    const insert = (id: number, task: string): MultiShapeMessage => ({
      headers: { operation: "insert", lsn: "0" },
      key: `id${id}`,
      value: { id, task, done: false },
      shape: "shape",
    });
    const upToDate = (lsn: number): MultiShapeMessage => ({
      shape: "shape",
      headers: { control: "up-to-date", global_last_seen_lsn: lsn.toString() },
    });

    it("buffers the full catch-up behind a held DB gate, then drains + signals ready on open", async () => {
      const rail = captureRail();
      const stream = mockFeedStream();
      let openGate!: () => void;
      const dbReady = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      let readyFired = false;

      const sub = await pg.electric.syncShapesToTables({
        key: "grp",
        registry,
        dbReady,
        shapes: {
          shape: { shape: { url: "http://localhost:3000/v1/shape", params: { table: "todo" } }, tableKey: "todo" },
        },
        onInitialSync: () => {
          readyFired = true;
        },
      });

      // Feed the ENTIRE catch-up (two inserts + the terminal up-to-date) while the gate is still HELD.
      await stream.feed([insert(1, "task1"), insert(2, "task2"), upToDate(0)]);

      // Gate closed: NOTHING is applied, `onInitialSync` has NOT fired, and `isUpToDate` reports false even
      // though the stream itself is up-to-date — the catch-up is buffered, unapplied, in the memory inbox.
      expect(await drizzleOver(pg).select().from(todo)).toEqual([]);
      expect(readyFired).toBe(false);
      expect(sub.isUpToDate).toBe(false);
      // The prefetch-start stamp was emitted; the commits-opened stamp has NOT been (gate still closed).
      expect(rail.lines.some((l) => l.event === "boot shape prefetch start")).toBe(true);
      expect(rail.lines.some((l) => l.event === "boot commits opened")).toBe(false);

      // Open the gate: the buffered catch-up drains in one commit train and `onInitialSync` fires.
      openGate();
      await waitUntil(async () => (await drizzleOver(pg).select({ count: count() }).from(todo))[0]!.count === 2);
      await waitUntil(() => readyFired);
      expect(sub.isUpToDate).toBe(true);
      expect(await drizzleOver(pg).select().from(todo).orderBy(todo.id)).toEqual([
        { id: 1, task: "task1", done: false },
        { id: 2, task: "task2", done: false },
      ]);
      // The commits-opened stamp lands, and AFTER the prefetch-start stamp (the measurable overlap window).
      const prefetchIdx = rail.lines.findIndex((l) => l.event === "boot shape prefetch start");
      const openedIdx = rail.lines.findIndex((l) => l.event === "boot commits opened");
      expect(prefetchIdx).toBeGreaterThanOrEqual(0);
      expect(openedIdx).toBeGreaterThan(prefetchIdx);

      sub.unsubscribe();
      rail.restore();
    });

    it("warm-store guard: without the dbReady hint, commits are NOT gated — a batch applies inline", async () => {
      const stream = mockFeedStream();

      const sub = await pg.electric.syncShapesToTables({
        key: "grp-warm",
        registry,
        // No `dbReady` — the sequential path: the callback awaits each commit, so the batch is already
        // applied by the time `feed` resolves (no held gate, no buffering window).
        shapes: {
          shape: { shape: { url: "http://localhost:3000/v1/shape", params: { table: "todo" } }, tableKey: "todo" },
        },
      });

      await stream.feed([insert(1, "task1"), upToDate(0)]);

      expect(await drizzleOver(pg).select().from(todo)).toEqual([{ id: 1, task: "task1", done: false }]);
      expect(sub.isUpToDate).toBe(true);

      sub.unsubscribe();
    });

    it("must-refetch during the overlap window: truncate + re-snapshot resolve once commits open", async () => {
      const stream = mockFeedStream();
      let openGate!: () => void;
      const dbReady = new Promise<void>((resolve) => {
        openGate = resolve;
      });

      const sub = await pg.electric.syncShapesToTables({
        key: "grp-refetch",
        registry,
        dbReady,
        shapes: {
          shape: { shape: { url: "http://localhost:3000/v1/shape", params: { table: "todo" } }, tableKey: "todo" },
        },
      });

      // A first snapshot, then a must-refetch, then a fresh re-snapshot — ALL while the gate is HELD. The
      // must-refetch resets the shape's buffer + queues a truncate; on open the truncate hits a table that
      // has nothing (nothing was applied yet) and must NOT crash or drop the re-snapshot.
      await stream.feed([insert(1, "stale"), upToDate(0)]);
      await stream.feed([{ shape: "shape", headers: { control: "must-refetch" } }]);
      await stream.feed([insert(2, "fresh"), upToDate(0)]);

      expect(await drizzleOver(pg).select().from(todo)).toEqual([]);

      openGate();
      // Only the post-refetch row survives: the stale pre-refetch insert was dropped by the shape reset, and
      // the empty-table truncate was a harmless no-op ahead of the re-snapshot insert.
      await waitUntil(async () => (await drizzleOver(pg).select({ count: count() }).from(todo))[0]!.count === 1);
      expect(await drizzleOver(pg).select().from(todo)).toEqual([{ id: 2, task: "fresh", done: false }]);

      sub.unsubscribe();
    });

    it("ADR-0031 ordering: all up-to-dates arrive pre-gate; one commit train drains to the aligned floor", async () => {
      const rail = captureRail();
      const stream = mockFeedStream();
      let openGate!: () => void;
      const dbReady = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      let readyFired = false;

      const sub = await pg.electric.syncShapesToTables({
        key: "grp-align",
        registry,
        dbReady,
        shapes: {
          shape: { shape: { url: "http://localhost:3000/v1/shape", params: { table: "todo" } }, tableKey: "todo" },
        },
        onInitialSync: () => {
          readyFired = true;
        },
      });

      // The complete catch-up — including the group-completing up-to-date that aligns the ADR-0031 commit
      // floor — is delivered BEFORE any commit can run. The floor is inbox state, so it aligns during the
      // buffering window (asserted via the rail), independent of the still-closed commit gate.
      await stream.feed([insert(1, "a"), insert(2, "b"), insert(3, "c"), upToDate(0)]);
      expect(rail.lines.some((l) => l.event === "catch-up watermark aligned")).toBe(true);
      expect(await drizzleOver(pg).select().from(todo)).toEqual([]);
      expect(readyFired).toBe(false);

      // Open the gate: a single commit train drains everything to the aligned floor, and ready fires — the
      // `boot client ready` semantics are unchanged from the sequential path (onInitialSync gates readiness).
      openGate();
      await waitUntil(() => readyFired);
      await waitUntil(async () => (await drizzleOver(pg).select({ count: count() }).from(todo))[0]!.count === 3);
      expect(sub.isUpToDate).toBe(true);

      sub.unsubscribe();
      rail.restore();
    });
  });

  // ─── Live-tail sibling nudge (ADR-0031 live-tail completion) ────────────────────────────────────────
  // On the LIVE tail, a change batch that lands on a busy shape at LSN L stays buffered until every quiet
  // sibling's PARKED long-poll returns a fresh watermark (~41s on Electric Cloud). The engine now (a) tells
  // the truth on the rail — "held" not "applied" — while a batch is gated, and (b) nudges each lagging
  // sibling (abort its poll → immediate non-live catch-up) to shorten that hold. Commits still fire only at
  // the group min frontier, so atomicity is untouched. Two shapes in one consistency group; each mocked
  // stream carries a `forceDisconnectAndRefresh` spy so the nudge is observable. The watchdog is
  // void-spawned, so these poll (waitUntil / small sleeps) rather than assume synchronous effects.
  describe("live-tail sibling nudge (ADR-0031 live-tail completion)", () => {
    /** Install a rail sink capturing every `syncDebug` line in order; returns the buffer + a restore fn. */
    function captureRail(): { lines: Array<{ event: string; data?: Record<string, unknown> }>; restore: () => void } {
      const lines: Array<{ event: string; data?: Record<string, unknown> }> = [];
      setSyncDebugSink((event, _stamp, data) => lines.push(data ? { event, data } : { event }));
      return { lines, restore: () => setSyncDebugSink(undefined) };
    }

    /**
     * A two-shape mock stream (todo + project in one group). The subscribe callback is exposed via `feedRaw`
     * (raw messages, no sugar), and each shape carries a `forceDisconnectAndRefresh` spy so a nudge is seen.
     */
    function setupTwoShapeStream(): {
      feedRaw: (messages: MultiShapeMessage[]) => Promise<void>;
      todoRefresh: ReturnType<typeof mock>;
      projectRefresh: ReturnType<typeof mock>;
    } {
      const box = { feedRaw: async (_: MultiShapeMessage[]) => {} };
      const todoRefresh = mock(() => Promise.resolve());
      const projectRefresh = mock(() => Promise.resolve());
      MockMultiShapeStream.mockImplementation(() => ({
        subscribe: mock((cb: (messages: MultiShapeMessage[]) => Promise<void>) => {
          box.feedRaw = (messages) => cb(messages);
        }),
        unsubscribeAll: mock(),
        isUpToDate: true,
        shapes: {
          todo_shape: { subscribe: mock(), unsubscribeAll: mock(), forceDisconnectAndRefresh: todoRefresh },
          project_shape: { subscribe: mock(), unsubscribeAll: mock(), forceDisconnectAndRefresh: projectRefresh },
        },
      }));
      return { feedRaw: (messages) => box.feedRaw(messages), todoRefresh, projectRefresh };
    }

    async function subscribeGroup() {
      return pg.electric.syncShapesToTables({
        registry,
        key: null,
        shapes: {
          todo_shape: { shape: { url: "http://localhost:3000/v1/shape", params: { table: "todo" } }, tableKey: "todo" },
          project_shape: {
            shape: { url: "http://localhost:3000/v1/shape", params: { table: "project" } },
            tableKey: "project",
          },
        },
      });
    }

    const todoInsert = (lsn: number, id: number, task: string): MultiShapeMessage => ({
      headers: { operation: "insert", lsn: String(lsn), last: true },
      key: `id${id}`,
      value: { id, task, done: false },
      shape: "todo_shape",
    });
    const upToDate = (shape: string, lsn: number): MultiShapeMessage => ({
      shape,
      headers: { control: "up-to-date", global_last_seen_lsn: String(lsn) },
    });

    it(
      "holds a gated batch, nudges only the lagging sibling, then commits when it advances",
      async () => {
        await createTablesFromSchema(pg, { project });
        const rail = captureRail();
        const { feedRaw, todoRefresh, projectRefresh } = setupTwoShapeStream();
        const sub = await subscribeGroup();

        // 1) Align the group at head 100 (both shapes report up-to-date) → committedLsn advances to 100.
        await feedRaw([upToDate("todo_shape", 100), upToDate("project_shape", 100)]);
        await waitUntil(() => rail.lines.some((l) => l.event === "catch-up watermark aligned"));

        // 2) A complete change batch lands on the busy shape (todo) at LSN 200; project stays quiet at 100.
        await feedRaw([todoInsert(200, 1, "held"), upToDate("todo_shape", 200)]);

        // The batch is HELD by the group min frontier (the quiet sibling), not applied — the rail says so, and
        // the row is not in PGlite.
        expect(rail.lines.some((l) => l.event === "sync change batch held by group frontier")).toBe(true);
        expect(rail.lines.some((l) => l.event === "sync applied change batch to local store")).toBe(false);
        expect(await drizzleOver(pg).select().from(todo)).toEqual([]);

        // Only the lagging sibling (project) is nudged; the busy shape (todo, already at the target) is not.
        await waitUntil(() => projectRefresh.mock.calls.length >= 1);
        expect(todoRefresh.mock.calls.length).toBe(0);

        // 3) The nudged sibling's forced catch-up returns a fresh watermark (200) → the group reaches 200 and
        // the held batch commits.
        await feedRaw([upToDate("project_shape", 200)]);
        await waitUntil(async () => (await drizzleOver(pg).select({ count: count() }).from(todo))[0]!.count === 1);
        expect(await drizzleOver(pg).select().from(todo)).toEqual([{ id: 1, task: "held", done: false }]);

        // 4) A subsequent batch where both shapes advance together logs the normal "applied" line.
        await feedRaw([todoInsert(300, 2, "live"), upToDate("todo_shape", 300), upToDate("project_shape", 300)]);
        await waitUntil(() => rail.lines.some((l) => l.event === "sync applied change batch to local store"));

        sub.unsubscribe();
        rail.restore();
        // The nudge fires only after the hold-persistence grace, so the full flow needs headroom over
        // bun's 5s default (a timed-out run also LEAKS the un-unsubscribed engine into later tests).
      },
      NUDGE_HOLD_GRACE_MS + 20_000,
    );

    it("never nudges a sibling that has not yet reported up-to-date; commits on its first up-to-date", async () => {
      await createTablesFromSchema(pg, { project });
      const rail = captureRail();
      const { feedRaw, projectRefresh } = setupTwoShapeStream();
      const sub = await subscribeGroup();

      // todo reaches its live tail (a change at 100 + up-to-date). project has NEVER reported up-to-date, so
      // the group is unaligned and the batch is held below project's raw (-1) frontier.
      await feedRaw([todoInsert(100, 1, "held"), upToDate("todo_shape", 100)]);
      expect(rail.lines.some((l) => l.event === "sync change batch held by group frontier")).toBe(true);
      expect(await drizzleOver(pg).select().from(todo)).toEqual([]);

      // A shape still catching up advances on its own — project is NEVER nudged (past a full round's grace).
      await new Promise((resolve) => setTimeout(resolve, NUDGE_HOLD_GRACE_MS + NUDGE_ROUND_GRACE_MS + 250));
      expect(projectRefresh.mock.calls.length).toBe(0);

      // project's FIRST up-to-date aligns the group and the held batch commits.
      await feedRaw([upToDate("project_shape", 100)]);
      await waitUntil(async () => (await drizzleOver(pg).select({ count: count() }).from(todo))[0]!.count === 1);

      sub.unsubscribe();
      rail.restore();
    });

    it(
      "bounds nudging at NUDGE_MAX_ROUNDS when a sibling never advances, then logs exhaustion",
      async () => {
        await createTablesFromSchema(pg, { project });
        const rail = captureRail();
        const { feedRaw, projectRefresh } = setupTwoShapeStream();
        const sub = await subscribeGroup();

        // Align at 100.
        await feedRaw([upToDate("todo_shape", 100), upToDate("project_shape", 100)]);
        await waitUntil(() => rail.lines.some((l) => l.event === "catch-up watermark aligned"));

        // A gated batch on todo at 200; project HAS reported up-to-date (so it is nudgeable) but never advances
        // — its mocked forced catch-ups resolve without a fresh watermark, so the frontier stays short.
        await feedRaw([todoInsert(200, 1, "held"), upToDate("todo_shape", 200)]);

        // The watchdog exhausts its bounded rounds and degrades to waiting on the sibling's live poll. Each
        // round waits up to NUDGE_ROUND_WAIT_MS for the frontier to advance, so the exhaustion line lands
        // after ~NUDGE_MAX_ROUNDS x that wait.
        await waitUntil(
          () => rail.lines.some((l) => l.event === "live-tail nudge exhausted; waiting on sibling live polls"),
          { timeout: NUDGE_HOLD_GRACE_MS + NUDGE_MAX_ROUNDS * NUDGE_ROUND_WAIT_MS + 3000 },
        );
        expect(projectRefresh.mock.calls.length).toBeGreaterThan(0);
        expect(projectRefresh.mock.calls.length).toBeLessThanOrEqual(NUDGE_MAX_ROUNDS);
        expect(await drizzleOver(pg).select().from(todo)).toEqual([]);

        sub.unsubscribe();
        rail.restore();
        // Exhaustion legitimately takes NUDGE_MAX_ROUNDS x NUDGE_ROUND_WAIT_MS before it can assert,
        // so this test carries its own bun timeout above the 5s default (third arg below).
      },
      NUDGE_HOLD_GRACE_MS + NUDGE_MAX_ROUNDS * NUDGE_ROUND_WAIT_MS + 10_000,
    );
  });
});
