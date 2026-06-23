/* oxlint-disable -- vendored upstream test; preserved faithfully, not style-audited. */
// @ts-nocheck -- vendored upstream test; run as a behavioural oracle (the value is its runtime
// behaviour), deliberately NOT type-audited under this repo's strict tsgo config. See header.
/**
 * Conformance baseline — VENDORED from electric-sql/pglite, packages/pglite-sync/test/sync.test.ts
 * Source:  https://github.com/electric-sql/pglite/tree/2eba679f64c4a9ddef57d25c052ec4f0287cc497/packages/pglite-sync
 * License: Apache-2.0 (upstream © ElectricSQL; see NOTICE). Ported from Vitest to bun:test;
 *          the test bodies are preserved so they remain a faithful behavioural oracle for the
 *          read-path engine now internalized into client/src/sync (ADR-0009). It is intentionally
 *          @ts-nocheck + oxlint-disable: we hold upstream's tests to upstream's standards, run
 *          them as a runtime oracle, and keep refresh cheap (re-pull + re-apply the framework
 *          shim below). Only the shim and the bun `.rejects`-takes-a-promise form are changed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import type { ShapeStreamOptions } from "@electric-sql/client";
import type { MultiShapeMessages } from "@electric-sql/experimental";
import { PGlite, type PGliteInterfaceExtensions } from "@electric-sql/pglite";

// The vendored engine imports `MultiShapeStream` from @electric-sql/experimental; we replace it
// with a controllable mock BEFORE importing the engine. bun's `mock.module` is process-global, so
// this file runs in its own `bun test` invocation (see package.json `test:unit`) to avoid bleeding
// the mock into suites that use the real stream.
const MockMultiShapeStream = mock(() => ({
  subscribe: mock(),
  unsubscribeAll: mock(),
  isUpToDate: true,
  shapes: {},
}));
await mock.module("@electric-sql/experimental", () => ({ MultiShapeStream: MockMultiShapeStream }));

const { electricSync } = await import("../../packages/client/src/sync/index");

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

type MultiShapeMessage = MultiShapeMessages<Record<string, unknown>>;

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

describe("pglite-sync", () => {
  let pg: PGlite & PGliteInterfaceExtensions<{ electric: ReturnType<typeof electricSync> }>;

  beforeEach(async () => {
    pg = await PGlite.create({
      extensions: {
        electric: electricSync({ debug: false }),
      },
    });
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS todo (
        id SERIAL PRIMARY KEY,
        task TEXT,
        done BOOLEAN
      );
    `);
    await pg.exec(`TRUNCATE todo;`);
  });

  // Ported addition: upstream (Vitest) never closes the per-test PGlite; bun force-exits (code 99)
  // on the leaked WASM handles, so close it here. Behaviour-preserving — assertions run in the body.
  afterEach(async () => {
    try {
      await pg.close();
    } catch {
      // already closed/unsubscribed by the test
    }
  });

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
      shapes: {
        todos: {
          shape: {
            url: "http://localhost:3000/v1/shape",
            params: { table: "todo" },
          },
          table: "todo",
          primaryKey: ["id"],
        },
      },
      key: null,
      onError,
    });

    expect(subscribe).toHaveBeenCalled();
    const [, passedOnError] = subscribe.mock.calls[0];
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
      table: "todo",
      primaryKey: ["id"],
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
    expect((await pg.sql`SELECT* FROM todo;`).rows).toEqual([
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
    expect((await pg.sql`SELECT* FROM todo;`).rows).toEqual([
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
    expect((await pg.sql`SELECT* FROM todo;`).rows).toEqual([]);

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
      table: "todo",
      primaryKey: ["id"],
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
      numItemsInserted =
        (
          await pg.sql<{
            count: number;
          }>`SELECT COUNT(*) as count FROM todo;`
        ).rows[0]?.["count"] ?? 0;

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

    await shape.unsubscribe();
  });

  it("persists shape stream state and automatically resumes", async () => {
    let feedMessages: (lsn: number, messages: MultiShapeMessage[]) => Promise<void> = async (_) => {};
    const shapeStreamInits = mock();
    let mockShapeId: string | void = undefined;
    MockMultiShapeStream.mockImplementation((initOpts: ShapeStreamOptions) => {
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
        table: "todo",
        primaryKey: ["id"],
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
        const result = await pg.sql<{
          count: number;
        }>`SELECT COUNT(*) as count FROM todo;`;

        if (result.rows[0]?.count > totalRowCount) {
          totalRowCount = result.rows[0]!.count;
          return true;
        }
        return false;
      });
      shapeIds.push(mockShapeId!);

      expect(shapeStreamInits).toHaveBeenCalledTimes(i + 1);
      if (i === 0) {
        expect(shapeStreamInits.mock.calls[i][0]).not.toHaveProperty("shapeId");
        expect(shapeStreamInits.mock.calls[i][0]).not.toHaveProperty("offset");
      }

      shape.unsubscribe();
    }
  });

  it("clears and restarts persisted shape stream state on refetch", async () => {
    let feedMessages: (messages: MultiShapeMessage[]) => Promise<void> = async (_) => {};
    const shapeStreamInits = mock();
    let mockShapeId: string | void = undefined;
    MockMultiShapeStream.mockImplementation((initOpts: ShapeStreamOptions) => {
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
      table: "todo",
      primaryKey: ["id"],
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

    const result = await pg.query(`SELECT * FROM todo;`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({
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
      table: "todo",
      primaryKey: ["id"],
      shapeKey: "foo",
    });
    resumedShape.unsubscribe();

    expect(shapeStreamInits).toHaveBeenCalledTimes(2);

    expect(shapeStreamInits.mock.calls[1][0]).not.toHaveProperty("shapeId");
    expect(shapeStreamInits.mock.calls[1][0]).not.toHaveProperty("offset");
  });

  it("uses the specified metadata schema for subscription metadata", async () => {
    const metadataSchema = "foobar";
    const db = await PGlite.create({
      extensions: {
        electric: electricSync({
          metadataSchema,
        }),
      },
    });
    await db.electric.initMetadataTables();

    const result = await db.query(`SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`, [
      metadataSchema,
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({ schema_name: metadataSchema });
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
      table: table,
      primaryKey: ["id"],
      shapeKey: null,
    });

    // should throw if syncing more shapes into same table
    // (ported: bun's `.rejects` unwraps a promise, so pass the call's promise directly
    // rather than a function — the upstream Vitest form wrapped it in `async () => …`.)
    await expect(
      pg.electric.syncShapeToTable({
        shape: {
          url: "http://localhost:3000/v1/shape",
          params: { table: "todo_alt" },
        },
        table: table,
        primaryKey: ["id"],
        shapeKey: null,
      }),
    ).rejects.toThrow(`Already syncing shape for table ${table}`);

    // should be able to sync shape into other table
    const altShape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "bar" },
      },
      table: altTable,
      primaryKey: ["id"],
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
      table: table,
      primaryKey: ["id"],
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
      table: "todo",
      primaryKey: ["id"],
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
    expect((await pg.sql`SELECT* FROM todo;`).rows).toEqual([
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
    expect((await pg.sql`SELECT* FROM todo;`).rows).toEqual([
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

    await pg.exec(`
      CREATE TABLE test_syncing (
        id TEXT PRIMARY KEY,
        value TEXT,
        is_syncing BOOLEAN
      );

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

    // Check the flag is not set outside of a sync
    const result0 = await pg.sql`SELECT current_setting('pgxsinkit.syncing', true)`;
    expect(result0.rows[0]).toEqual({ current_setting: null }); // not set yet as syncShapeToTable hasn't been called

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "test_syncing" },
      },
      table: "test_syncing",
      primaryKey: ["id"],
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
    const result = await pg.sql`SELECT * FROM test_syncing WHERE id = 'id1'`;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({
      id: "id1",
      value: "test value",
      is_syncing: true,
    });

    // Check the flag is not set outside of a sync
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
      table: "todo",
      primaryKey: ["id"],
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
      const result = await pg.sql<{ count: number }>`
        SELECT COUNT(*) as count FROM todo;
      `;
      return result.rows[0]!.count === numInserts;
    });

    // Verify the data was inserted correctly
    const result = await pg.sql`
      SELECT * FROM todo ORDER BY id LIMIT 5;
    `;
    expect(result.rows).toEqual([
      { id: 0, task: "updated task", done: true },
      { id: 1, task: "task1", done: false },
      { id: 2, task: "task2", done: true },
      { id: 3, task: "task3", done: false },
      { id: 4, task: "task4", done: true },
    ]);

    // Verify total count
    const countResult = await pg.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM todo;
    `;
    expect(countResult.rows[0]!.count).toBe(numInserts);

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
      table: "todo",
      primaryKey: ["id"],
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
      const result = await pg.sql<{ count: number }>`
        SELECT COUNT(*) as count FROM todo;
      `;
      return result.rows[0]!.count === specialCharMessages.length;
    });

    // Verify the data was inserted correctly with special characters preserved
    const result = await pg.sql`
      SELECT * FROM todo ORDER BY id;
    `;
    expect(result.rows).toEqual([
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
      table: "todo",
      primaryKey: ["id"],
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
    expect((await pg.sql<{ count: number }>`SELECT COUNT(*) as count FROM todo;`).rows[0]!.count).toBe(3);

    shape.unsubscribe();
  });

  it("syncs multiple shapes to multiple tables simultaneously", async () => {
    // Create a second table for testing multi-shape sync
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS project (
        id SERIAL PRIMARY KEY,
        name TEXT,
        active BOOLEAN
      );
    `);
    await pg.exec(`TRUNCATE project;`);

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
      key: "multi_sync_test",
      shapes: {
        todo_shape: {
          shape: {
            url: "http://localhost:3000/v1/shape",
            params: { table: "todo" },
          },
          table: "todo",
          primaryKey: ["id"],
        },
        project_shape: {
          shape: {
            url: "http://localhost:3000/v1/shape",
            params: { table: "project" },
          },
          table: "project",
          primaryKey: ["id"],
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
    const todoResult = await pg.sql`SELECT * FROM todo ORDER BY id;`;
    expect(todoResult.rows).toEqual([
      { id: 1, task: "task1", done: false },
      { id: 2, task: "task2", done: true },
    ]);

    const projectResult = await pg.sql`SELECT * FROM project ORDER BY id;`;
    expect(projectResult.rows).toEqual([
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
    const updatedTodoResult = await pg.sql`SELECT * FROM todo WHERE id = 1;`;
    expect(updatedTodoResult.rows[0]).toEqual({
      id: 1,
      task: "Updated task 1",
      done: true,
    });

    const updatedProjectResult = await pg.sql`SELECT * FROM project WHERE id = 2;`;
    expect(updatedProjectResult.rows[0]).toEqual({
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
    const todoCountAfterDelete = await pg.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM todo;
    `;
    expect(todoCountAfterDelete.rows[0]!.count).toBe(1);

    const projectCountAfterDelete = await pg.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM project;
    `;
    expect(projectCountAfterDelete.rows[0]!.count).toBe(1);

    // Cleanup
    syncResult.unsubscribe();
  });

  it("handles transactions across multiple tables with syncShapesToTables", async () => {
    // Create a second table for testing multi-shape sync
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS project (
        id SERIAL PRIMARY KEY,
        name TEXT,
        active BOOLEAN
      );
    `);
    await pg.exec(`TRUNCATE project;`);

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
      key: "transaction_test",
      shapes: {
        todo_shape: {
          shape: {
            url: "http://localhost:3000/v1/shape",
            params: { table: "todo" },
          },
          table: "todo",
          primaryKey: ["id"],
        },
        project_shape: {
          shape: {
            url: "http://localhost:3000/v1/shape",
            params: { table: "project" },
          },
          table: "project",
          primaryKey: ["id"],
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
    const initialTodoCount = await pg.sql<{
      count: number;
    }>`SELECT COUNT(*) as count FROM todo;`;
    expect(initialTodoCount.rows[0]!.count).toBe(1);

    const initialProjectCount = await pg.sql<{
      count: number;
    }>`SELECT COUNT(*) as count FROM project;`;
    expect(initialProjectCount.rows[0]!.count).toBe(1);

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
    const todoResult = await pg.sql`SELECT * FROM todo WHERE id = 1;`;
    expect(todoResult.rows[0]).toEqual({
      id: 1,
      task: "Updated in transaction",
      done: true,
    });

    const projectResult = await pg.sql`SELECT * FROM project WHERE id = 1;`;
    expect(projectResult.rows[0]).toEqual({
      id: 1,
      name: "Updated in transaction",
      active: false,
    });

    // Cleanup
    syncResult.unsubscribe();
  });

  it("handles must-refetch control message across multiple tables", async () => {
    // Create a second table for testing multi-shape sync
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS project (
        id SERIAL PRIMARY KEY,
        name TEXT,
        active BOOLEAN
      );
    `);
    await pg.exec(`TRUNCATE project;`);

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
      key: "refetch_test",
      shapes: {
        todo_shape: {
          shape: {
            url: "http://localhost:3000/v1/shape",
            params: { table: "todo" },
          },
          table: "todo",
          primaryKey: ["id"],
        },
        project_shape: {
          shape: {
            url: "http://localhost:3000/v1/shape",
            params: { table: "project" },
          },
          table: "project",
          primaryKey: ["id"],
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
    const refetchTodoCount = await pg.sql<{
      count: number;
    }>`SELECT COUNT(*) as count FROM todo;`;
    expect(refetchTodoCount.rows[0]!.count).toBe(1);

    const refetchProjectCount = await pg.sql<{
      count: number;
    }>`SELECT COUNT(*) as count FROM project;`;
    expect(refetchProjectCount.rows[0]!.count).toBe(1);

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
    const todoResult = await pg.sql`SELECT * FROM todo ORDER BY id;`;
    expect(todoResult.rows).toEqual([
      {
        id: 2,
        task: "New task after refetch",
        done: true,
      },
    ]);

    const projectResult = await pg.sql`SELECT * FROM project ORDER BY id;`;
    expect(projectResult.rows).toEqual([
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

    await pg.exec(`
      CREATE TABLE IF NOT EXISTS "cAseSENSiTiVe" (
        id SERIAL PRIMARY KEY,
        task TEXT,
        done BOOLEAN
      );
    `);
    await pg.exec(`TRUNCATE "cAseSENSiTiVe";`);

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: "http://localhost:3000/v1/shape",
        params: { table: "cAseSENSiTiVe" },
      },
      table: "cAseSENSiTiVe",
      primaryKey: ["id"],
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
    expect((await pg.sql`SELECT* FROM "cAseSENSiTiVe";`).rows).toEqual([
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
    expect((await pg.sql`SELECT* FROM "cAseSENSiTiVe";`).rows).toEqual([
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
    expect((await pg.sql`SELECT* FROM "cAseSENSiTiVe";`).rows).toEqual([]);

    shape.unsubscribe();
  });

  it("handles camelCase column names with json_to_recordset", async () => {
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS camel_test (
        id SERIAL PRIMARY KEY,
        "firstName" TEXT,
        "lastName" TEXT
      );
    `);
    await pg.exec(`TRUNCATE camel_test;`);

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
      table: "camel_test",
      primaryKey: ["id"],
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
      const result = await pg.sql<{ count: number }>`
        SELECT COUNT(*) as count FROM camel_test;
      `;
      return result.rows[0]!.count === 2;
    });

    const result = await pg.sql`
      SELECT * FROM camel_test ORDER BY id;
    `;
    expect(result.rows).toEqual([
      { id: 1, firstName: "Alice", lastName: "Smith" },
      { id: 2, firstName: "Bob", lastName: "Jones" },
    ]);

    shape.unsubscribe();
  });
});
