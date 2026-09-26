// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import type { Results, Transaction } from "../../packages/pgwasm/src";
import { live, type Change, type LiveQueryResults, type PgwasmWithLive } from "../../packages/pgwasm/src/live";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { deliveriesReach, quietFor, Recorder } from "./support/pgwasm-live";
import { rejectionOf } from "./support/rejection";

afterEach(closeTestPgwasms);

type NumberRow = { id: number; number: number };

const fiveRows: NumberRow[] = [
  { id: 1, number: 10 },
  { id: 2, number: 20 },
  { id: 3, number: 30 },
  { id: 4, number: 40 },
  { id: 5, number: 50 },
];

async function liveDb(): Promise<PgwasmWithLive> {
  return await createTestPgwasm({ extensions: { live } });
}

async function withNumbers(db: PgwasmWithLive, table = "testTable"): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, number INT);
    INSERT INTO ${table} (number) SELECT i*10 FROM generate_series(1, 5) i;
  `);
}

/** Run a change and wait for the delivery it causes. */
async function after<T>(recorder: Recorder<T>, change: () => Promise<unknown>): Promise<T> {
  const next = recorder.next();
  await change();
  return await next;
}

/** The insert, delete and update every ordered live query of `testTable` goes through. */
async function expectFollowsNumbers(
  db: PgwasmWithLive,
  recorder: Recorder<Results<NumberRow>>,
  unsubscribe: () => Promise<void>,
  table = "testTable",
): Promise<void> {
  expect((await after(recorder, () => db.exec(`INSERT INTO ${table} (number) VALUES (25);`))).rows).toEqual([
    { id: 1, number: 10 },
    { id: 2, number: 20 },
    { id: 6, number: 25 },
    { id: 3, number: 30 },
    { id: 4, number: 40 },
    { id: 5, number: 50 },
  ]);
  expect((await after(recorder, () => db.exec(`DELETE FROM ${table} WHERE id = 6;`))).rows).toEqual(fiveRows);
  const updated = [
    { id: 1, number: 10 },
    { id: 3, number: 15 },
    { id: 2, number: 20 },
    { id: 4, number: 40 },
    { id: 5, number: 50 },
  ];
  expect((await after(recorder, () => db.exec(`UPDATE ${table} SET number = 15 WHERE id = 3;`))).rows).toEqual(updated);
  await unsubscribe();
  await db.exec(`INSERT INTO ${table} (number) VALUES (35);`);
  await quietFor(100);
  expect(recorder.latest?.rows).toEqual(updated);
}

describe("live.query", () => {
  it("follows inserts, deletes and updates until unsubscribed", async () => {
    const db = await liveDb();
    await withNumbers(db);
    const recorder = new Recorder<Results<NumberRow>>();
    const { initialResults, unsubscribe } = await db.live.query<NumberRow>(
      "SELECT * FROM testTable ORDER BY number;",
      [],
      recorder.callback,
    );
    expect(initialResults.rows).toEqual(fiveRows);
    await expectFollowsNumbers(db, recorder, unsubscribe);
  });

  it("follows a query on a view of views", async () => {
    const db = await liveDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS testTable (id SERIAL PRIMARY KEY, number INT);
      CREATE OR REPLACE VIEW testView2 AS SELECT * FROM testTable;
      CREATE OR REPLACE VIEW testView1 AS SELECT * FROM testView2;
      CREATE OR REPLACE VIEW testView AS SELECT * FROM testView1;
      INSERT INTO testTable (number) SELECT i*10 FROM generate_series(1, 5) i;
    `);
    const recorder = new Recorder<Results<NumberRow>>();
    const { initialResults, unsubscribe } = await db.live.query<NumberRow>(
      "SELECT * FROM testView ORDER BY number;",
      [],
      recorder.callback,
    );
    expect(initialResults.rows).toEqual(fiveRows);
    await expectFollowsNumbers(db, recorder, unsubscribe);
  });

  it("follows a query with parameters", async () => {
    const db = await liveDb();
    await withNumbers(db);
    const recorder = new Recorder<Results<NumberRow>>();
    const { initialResults, unsubscribe } = await db.live.query<NumberRow>(
      "SELECT * FROM testTable WHERE number < $1 ORDER BY number;",
      [40],
      recorder.callback,
    );
    expect(initialResults.rows).toEqual(fiveRows.slice(0, 3));
    expect((await after(recorder, () => db.exec("INSERT INTO testTable (number) VALUES (25);"))).rows).toEqual([
      { id: 1, number: 10 },
      { id: 2, number: 20 },
      { id: 6, number: 25 },
      { id: 3, number: 30 },
    ]);
    expect((await after(recorder, () => db.exec("DELETE FROM testTable WHERE id = 6;"))).rows).toEqual(
      fiveRows.slice(0, 3),
    );
    const updated = [
      { id: 1, number: 10 },
      { id: 3, number: 15 },
      { id: 2, number: 20 },
    ];
    expect((await after(recorder, () => db.exec("UPDATE testTable SET number = 15 WHERE id = 3;"))).rows).toEqual(
      updated,
    );
    await unsubscribe();
    await db.exec("INSERT INTO testTable (number) VALUES (35);");
    await quietFor(100);
    expect(recorder.latest?.rows).toEqual(updated);
  });

  it("delivers to a subscriber added after creation", async () => {
    const db = await liveDb();
    await withNumbers(db);
    const { initialResults, subscribe, unsubscribe } = await db.live.query<NumberRow>(
      "SELECT * FROM testTable ORDER BY number;",
    );
    expect(initialResults.rows).toEqual(fiveRows);
    const recorder = new Recorder<LiveQueryResults<NumberRow>>();
    subscribe(recorder.callback);
    expect((await after(recorder, () => db.exec("INSERT INTO testTable (number) VALUES (25);"))).rows).toEqual([
      { id: 1, number: 10 },
      { id: 2, number: 20 },
      { id: 6, number: 25 },
      { id: 3, number: 30 },
      { id: 4, number: 40 },
      { id: 5, number: 50 },
    ]);
    await unsubscribe();
  });

  it("windows a query, updating the total count after the rows", async () => {
    const db = await liveDb();
    await withNumbers(db);
    const recorder = new Recorder<Results<NumberRow>>();
    const { initialResults, unsubscribe, refresh } = await db.live.query<NumberRow>({
      query: "SELECT * FROM testTable ORDER BY number",
      offset: 1,
      limit: 2,
      callback: recorder.callback,
    });
    expect(initialResults.rows).toEqual([
      { id: 2, number: 20 },
      { id: 3, number: 30 },
    ]);
    expect(initialResults).toMatchObject({ offset: 1, limit: 2, totalCount: 5 });

    const rowsFirst = recorder.next();
    const countAfter = rowsFirst.then(() => recorder.next());
    await db.exec("INSERT INTO testTable (number) VALUES (25);");
    const withRows = (await rowsFirst) as LiveQueryResults<NumberRow>;
    expect(withRows.rows).toEqual([
      { id: 2, number: 20 },
      { id: 6, number: 25 },
    ]);
    expect(withRows.totalCount).toBe(5);
    expect(((await countAfter) as LiveQueryResults<NumberRow>).totalCount).toBe(6);

    await refresh({ offset: 3, limit: 2 });
    expect(recorder.latest?.rows).toEqual([
      { id: 3, number: 30 },
      { id: 4, number: 40 },
    ]);
    expect(recorder.latest).toMatchObject({ offset: 3, limit: 2, totalCount: 6 });

    const rowsAgain = recorder.next();
    const countAgain = rowsAgain.then(() => recorder.next());
    await db.exec("DELETE FROM testTable WHERE number > 30;");
    const afterDelete = (await rowsAgain) as LiveQueryResults<NumberRow>;
    expect(afterDelete.rows).toEqual([{ id: 3, number: 30 }]);
    expect(afterDelete.totalCount).toBe(6);
    expect(((await countAgain) as LiveQueryResults<NumberRow>).totalCount).toBe(4);
    await unsubscribe();
  });

  it("requires offset and limit together, as numbers", async () => {
    const db = await liveDb();
    const query = "SELECT * FROM (VALUES (1)) t";
    for (const options of [
      { query, offset: 0 },
      { query, limit: 10 },
    ]) {
      expect((await rejectionOf(db.live.query(options))).message).toBe("offset and limit must be provided together");
    }
    for (const options of [
      { query, offset: "0" as unknown as number, limit: 10 },
      { query, offset: 0, limit: "10" as unknown as number },
    ]) {
      expect((await rejectionOf(db.live.query(options))).message).toBe("offset and limit must be numbers");
    }
  });

  it("keeps a second query on the same tables live when the first unsubscribes", async () => {
    const db = await liveDb();
    await db.exec("CREATE TABLE IF NOT EXISTS testTable (id SERIAL PRIMARY KEY, number INT);");
    const { unsubscribe } = await db.live.query({ query: "SELECT * FROM testTable WHERE number > 1" });
    const recorder = new Recorder<Results<NumberRow>>();
    await db.live.query<NumberRow>({ query: "SELECT * FROM testTable WHERE number > 2", callback: recorder.callback });
    await unsubscribe();
    expect((await after(recorder, () => db.exec("INSERT INTO testTable (number) VALUES (3);"))).rows).toEqual([
      { id: 1, number: 3 },
    ]);
  });

  it("follows a query with pattern matching", async () => {
    const db = await liveDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS testTable (id SERIAL PRIMARY KEY, statement VARCHAR(100));
      INSERT INTO testTable (statement) VALUES ('i love pglite!');
    `);
    const recorder = new Recorder<Results<{ id: number; statement: string }>>();
    const { initialResults, unsubscribe } = await db.live.query<{ id: number; statement: string }>(
      "SELECT id, statement FROM testTable WHERE statement ILIKE '%pglite%' ORDER BY id;",
      [],
      recorder.callback,
    );
    expect(initialResults.rows).toEqual([{ id: 1, statement: "i love pglite!" }]);
    const next = recorder.next();
    await db.exec(`INSERT INTO testTable (statement) VALUES ('This should not be in the results!');`);
    await db.exec(`INSERT INTO testTable (statement) VALUES ('PGlite is da best!');`);
    await next;
    await quietFor(50);
    await unsubscribe();
    expect(recorder.latest?.rows).toEqual([
      { id: 1, statement: "i love pglite!" },
      { id: 3, statement: "PGlite is da best!" },
    ]);
  });

  it("replays a notification that arrives while the query initialises", async () => {
    const db = await liveDb();
    // The query itself inserts a row, firing the notify trigger the same initialising transaction just
    // added: the listener runs before the query has its refresh function.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS testTable (id SERIAL PRIMARY KEY, number INT);
      INSERT INTO testTable (number) SELECT i*10 FROM generate_series(1, 5) i;
      CREATE OR REPLACE FUNCTION notify_during_init() RETURNS INT AS $$
      BEGIN
        IF current_setting('live_test.notified', true) IS DISTINCT FROM 'yes' THEN
          PERFORM set_config('live_test.notified', 'yes', false);
          INSERT INTO testTable (number) VALUES (25);
        END IF;
        RETURN -1;
      END;
      $$ LANGUAGE plpgsql;
    `);
    const rejections: unknown[] = [];
    const onUnhandledRejection = (error: unknown) => rejections.push(error);
    process.on("unhandledRejection", onUnhandledRejection);
    const recorder = new Recorder<Results<NumberRow>>();
    try {
      const { initialResults, unsubscribe } = await db.live.query<NumberRow>(
        "SELECT * FROM testTable WHERE id <> notify_during_init() ORDER BY number;",
        [],
        recorder.callback,
      );
      // The row inserted during initialisation is not in the snapshot the initial results came from.
      expect(initialResults.rows).toEqual(fiveRows);
      // The initial results, then the replayed refresh.
      await deliveriesReach(recorder, 2);
      await unsubscribe();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
    expect(rejections).toEqual([]);
    expect(recorder.latest?.rows).toEqual([
      { id: 1, number: 10 },
      { id: 2, number: 20 },
      { id: 6, number: 25 },
      { id: 3, number: 30 },
      { id: 4, number: 40 },
      { id: 5, number: 50 },
    ]);
  });

  it("follows a table with a case-sensitive name", async () => {
    const db = await liveDb();
    await withNumbers(db, '"cAseSENSiTYVE"');
    const recorder = new Recorder<Results<NumberRow>>();
    const { initialResults, unsubscribe } = await db.live.query<NumberRow>(
      'SELECT * FROM "cAseSENSiTYVE" ORDER BY number;',
      [],
      recorder.callback,
    );
    expect(initialResults.rows).toEqual(fiveRows);
    await expectFollowsNumbers(db, recorder, unsubscribe, '"cAseSENSiTYVE"');
  });
});

describe("live.incrementalQuery", () => {
  it("follows inserts, deletes and updates until unsubscribed", async () => {
    const db = await liveDb();
    await withNumbers(db);
    const recorder = new Recorder<Results<NumberRow>>();
    const { initialResults, unsubscribe } = await db.live.incrementalQuery<NumberRow>(
      "SELECT * FROM testTable ORDER BY number;",
      [],
      "id",
      recorder.callback,
    );
    expect(initialResults.rows).toEqual(fiveRows);
    await expectFollowsNumbers(db, recorder, unsubscribe);
  });

  it("keeps an unordered query's order as rows change", async () => {
    const db = await liveDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS testTable (id SERIAL PRIMARY KEY, number INT);
      INSERT INTO testTable (number) VALUES (1), (2);
    `);
    const recorder = new Recorder<Results<NumberRow>>();
    const { initialResults, unsubscribe } = await db.live.incrementalQuery<NumberRow>(
      "SELECT * FROM testTable;",
      [],
      "id",
      recorder.callback,
    );
    expect(initialResults.rows).toEqual([
      { id: 1, number: 1 },
      { id: 2, number: 2 },
    ]);
    expect((await after(recorder, () => db.exec("UPDATE testTable SET number = 10 WHERE id = 1;"))).rows).toEqual([
      { id: 2, number: 2 },
      { id: 1, number: 10 },
    ]);
    await unsubscribe();
  });

  it("keys on a text column", async () => {
    const db = await liveDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS testTable (id TEXT PRIMARY KEY, number INT);
      INSERT INTO testTable (id, number) VALUES ('potato', 1), ('banana', 2);
    `);
    const recorder = new Recorder<Results<{ id: string; number: number }>>();
    const { initialResults, unsubscribe } = await db.live.incrementalQuery<{ id: string; number: number }>(
      "SELECT * FROM testTable;",
      [],
      "id",
      recorder.callback,
    );
    expect(initialResults.rows).toEqual([
      { id: "potato", number: 1 },
      { id: "banana", number: 2 },
    ]);
    expect(
      (await after(recorder, () => db.exec(`UPDATE testTable SET number = 10 WHERE id = 'potato';`))).rows,
    ).toEqual([
      { id: "banana", number: 2 },
      { id: "potato", number: 10 },
    ]);
    await unsubscribe();
  });

  it("follows a LIMIT 1 query", async () => {
    const db = await liveDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS testTable (id SERIAL PRIMARY KEY, number INT);
      INSERT INTO testTable (number) VALUES (10);
    `);
    const recorder = new Recorder<Results<NumberRow>>();
    const { initialResults, unsubscribe } = await db.live.incrementalQuery<NumberRow>(
      "SELECT * FROM testTable ORDER BY number ASC LIMIT 1;",
      [],
      "id",
      recorder.callback,
    );
    expect(initialResults.rows).toEqual([{ id: 1, number: 10 }]);
    expect((await after(recorder, () => db.exec("INSERT INTO testTable (number) VALUES (5);"))).rows).toEqual([
      { id: 2, number: 5 },
    ]);
    await unsubscribe();
  });

  it("follows a query on a table behind views", async () => {
    const db = await liveDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS testTable (id SERIAL PRIMARY KEY, number INT);
      CREATE OR REPLACE VIEW testView2 AS SELECT * FROM testTable;
      CREATE OR REPLACE VIEW testView1 AS SELECT * FROM testView2;
      CREATE OR REPLACE VIEW testView AS SELECT * FROM testView1;
      INSERT INTO testTable (number) SELECT i*10 FROM generate_series(1, 5) i;
    `);
    const recorder = new Recorder<Results<NumberRow>>();
    const { initialResults, unsubscribe } = await db.live.incrementalQuery<NumberRow>(
      "SELECT * FROM testView ORDER BY number;",
      [],
      "id",
      recorder.callback,
    );
    expect(initialResults.rows).toEqual(fiveRows);
    await expectFollowsNumbers(db, recorder, unsubscribe);
  });

  it("follows a query with parameters", async () => {
    const db = await liveDb();
    await withNumbers(db);
    const recorder = new Recorder<Results<NumberRow>>();
    const { initialResults, unsubscribe } = await db.live.incrementalQuery<NumberRow>(
      "SELECT * FROM testTable WHERE number < $1 ORDER BY number;",
      [40],
      "id",
      recorder.callback,
    );
    expect(initialResults.rows).toEqual(fiveRows.slice(0, 3));
    expect((await after(recorder, () => db.exec("INSERT INTO testTable (number) VALUES (25);"))).rows).toEqual([
      { id: 1, number: 10 },
      { id: 2, number: 20 },
      { id: 6, number: 25 },
      { id: 3, number: 30 },
    ]);
    await unsubscribe();
  });

  it("keys on a camelCase column", async () => {
    const db = await liveDb();
    await db.exec(`CREATE TABLE IF NOT EXISTS "camel" ("lexemeId" TEXT PRIMARY KEY, "aidsOff" BOOLEAN NOT NULL);`);
    type Camel = { lexemeId: string; aidsOff: boolean };
    const recorder = new Recorder<Results<Camel>>();
    const { initialResults, unsubscribe } = await db.live.incrementalQuery<Camel>(
      'SELECT "lexemeId", "aidsOff" FROM "camel" ORDER BY "lexemeId";',
      [],
      "lexemeId",
      recorder.callback,
    );
    expect(initialResults.rows).toEqual([]);
    expect(
      (
        await after(recorder, () =>
          db.exec(`INSERT INTO "camel" ("lexemeId", "aidsOff") VALUES ('alpha', true), ('beta', false);`),
        )
      ).rows,
    ).toEqual([
      { lexemeId: "alpha", aidsOff: true },
      { lexemeId: "beta", aidsOff: false },
    ]);
    expect(
      (await after(recorder, () => db.exec(`UPDATE "camel" SET "aidsOff" = false WHERE "lexemeId" = 'alpha';`))).rows,
    ).toEqual([
      { lexemeId: "alpha", aidsOff: false },
      { lexemeId: "beta", aidsOff: false },
    ]);
    expect((await after(recorder, () => db.exec(`DELETE FROM "camel" WHERE "lexemeId" = 'beta';`))).rows).toEqual([
      { lexemeId: "alpha", aidsOff: false },
    ]);
    await unsubscribe();
  });

  it("delivers to a subscriber added after creation", async () => {
    const db = await liveDb();
    await withNumbers(db);
    const { initialResults, subscribe, unsubscribe } = await db.live.incrementalQuery<NumberRow>(
      "SELECT * FROM testTable ORDER BY number;",
      [],
      "id",
    );
    expect(initialResults.rows).toEqual(fiveRows);
    const recorder = new Recorder<Results<NumberRow>>();
    subscribe(recorder.callback);
    expect((await after(recorder, () => db.exec("INSERT INTO testTable (number) VALUES (25);"))).rows).toEqual([
      { id: 1, number: 10 },
      { id: 2, number: 20 },
      { id: 6, number: 25 },
      { id: 3, number: 30 },
      { id: 4, number: 40 },
      { id: 5, number: 50 },
    ]);
    await unsubscribe();
  });
});

describe("live.changes", () => {
  const insert = (id: number, number: number, after: number | null) => ({
    __op__: "INSERT",
    id,
    number,
    __after__: after,
    __changed_columns__: [],
  });
  const moved = (id: number, after: number) => ({
    __op__: "UPDATE",
    id,
    number: null,
    __after__: after,
    __changed_columns__: ["__after__"],
  });

  it("reports inserts, deletes and updates as changes", async () => {
    const db = await liveDb();
    await withNumbers(db);
    const recorder = new Recorder<Change<NumberRow>[]>();
    const { initialChanges, unsubscribe } = await db.live.changes<NumberRow>(
      "SELECT * FROM testTable ORDER BY number;",
      [],
      "id",
      recorder.callback,
    );
    expect(initialChanges).toEqual([
      insert(1, 10, null),
      insert(2, 20, 1),
      insert(3, 30, 2),
      insert(4, 40, 3),
      insert(5, 50, 4),
    ] as never);
    expect(await after(recorder, () => db.exec("INSERT INTO testTable (number) VALUES (25);"))).toEqual([
      insert(6, 25, 2),
      moved(3, 6),
    ] as never);
    expect(await after(recorder, () => db.exec("DELETE FROM testTable WHERE id = 6;"))).toEqual([
      { __op__: "DELETE", id: 6, number: null, __after__: null, __changed_columns__: [] },
      moved(3, 2),
    ] as never);
    const updates = [
      moved(2, 3),
      { id: 3, __after__: 1, __changed_columns__: ["number", "__after__"], __op__: "UPDATE", number: 15 },
      moved(4, 2),
    ];
    expect(await after(recorder, () => db.exec("UPDATE testTable SET number = 15 WHERE id = 3;"))).toEqual(
      updates as never,
    );
    await unsubscribe();
    await db.exec("INSERT INTO testTable (number) VALUES (35);");
    await quietFor(100);
    expect(recorder.latest).toEqual(updates as never);
  });

  it("keys on a camelCase column", async () => {
    const db = await liveDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS "camel" ("lexemeId" TEXT PRIMARY KEY, "aidsOff" BOOLEAN NOT NULL);
      INSERT INTO "camel" ("lexemeId", "aidsOff") VALUES ('alpha', true);
    `);
    const { initialChanges, unsubscribe } = await db.live.changes(
      'SELECT "lexemeId", "aidsOff" FROM "camel" ORDER BY "lexemeId";',
      [],
      "lexemeId",
      () => undefined,
    );
    expect(initialChanges).toEqual([
      { __op__: "INSERT", lexemeId: "alpha", aidsOff: true, __after__: null, __changed_columns__: [] },
    ] as never);
    await unsubscribe();
  });

  it("follows a LIMIT 1 query, through the options form", async () => {
    const db = await liveDb();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS testTable (id SERIAL PRIMARY KEY, number INT);
      INSERT INTO testTable (number) VALUES (10);
    `);
    const { initialChanges, subscribe, unsubscribe } = await db.live.changes<NumberRow>({
      query: "SELECT * FROM testTable ORDER BY number ASC LIMIT 1;",
      params: [],
      key: "id",
    });
    expect(initialChanges).toEqual([insert(1, 10, null)] as never);
    const recorder = new Recorder<Change<NumberRow>[]>();
    subscribe(recorder.callback);
    expect(await after(recorder, () => db.exec("INSERT INTO testTable (number) VALUES (5);"))).toEqual([
      insert(2, 5, null),
      { __op__: "DELETE", id: 1, number: null, __after__: null, __changed_columns__: [] },
    ] as never);
    await unsubscribe();
  });

  it("replays a notification that arrives while it initialises, after the initial changes", async () => {
    const db = await liveDb();
    await withNumbers(db);
    // A notification arriving during initialisation is simulated by invoking the listener as soon as it
    // is registered, which is what dispatch does for one that rides on a reply in that transaction.
    const rejections: unknown[] = [];
    const originalListen = db.listen.bind(db);
    db.listen = async (channel: string, callback: (payload: string) => void, tx?: Transaction) => {
      const unlisten = await originalListen(channel, callback, tx);
      try {
        callback("");
      } catch (error) {
        rejections.push(error);
      }
      return unlisten;
    };
    const recorder = new Recorder<Change<NumberRow>[]>();
    const { initialChanges, unsubscribe } = await db.live.changes<NumberRow>(
      "SELECT * FROM testTable ORDER BY number;",
      [],
      "id",
      recorder.callback,
    );
    db.listen = originalListen;
    expect(rejections).toEqual([]);
    expect(initialChanges).toEqual([
      insert(1, 10, null),
      insert(2, 20, 1),
      insert(3, 30, 2),
      insert(4, 40, 3),
      insert(5, 50, 4),
    ] as never);
    // Let the replayed refresh settle.
    await quietFor(100);
    expect(await after(recorder, () => db.exec("INSERT INTO testTable (number) VALUES (25);"))).toEqual([
      insert(6, 25, 2),
      moved(3, 6),
    ] as never);
    await unsubscribe();
  });
});
