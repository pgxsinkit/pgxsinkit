// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { identifier, PgwasmClosedError, type Pgwasm, type Transaction } from "../../packages/pgwasm/src";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { rejectionOf } from "./support/rejection";

afterEach(closeTestPgwasms);

const idName = [
  { name: "id", dataTypeID: 23 },
  { name: "name", dataTypeID: 25 },
];

async function withTestTable(db: Pgwasm): Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS test (id SERIAL PRIMARY KEY, name TEXT);`);
}

describe("queries", () => {
  it("runs several statements through exec", async () => {
    const db = await createTestPgwasm();
    await withTestTable(db);
    const results = await db.exec(`
      INSERT INTO test (name) VALUES ('test');
      UPDATE test SET name = 'test2';
      SELECT * FROM test;
    `);
    expect(results).toEqual([
      { affectedRows: 1, command: "INSERT", rowCount: 1, rows: [], fields: [] },
      { affectedRows: 2, command: "UPDATE", rowCount: 1, rows: [], fields: [] },
      { rows: [{ id: 1, name: "test2" }], fields: idName, affectedRows: 2, command: "SELECT", rowCount: 1 },
    ]);
  });

  it("runs one statement through query", async () => {
    const db = await createTestPgwasm();
    await withTestTable(db);
    await db.query("INSERT INTO test (name) VALUES ('test');");
    expect(await db.query("SELECT * FROM test;")).toEqual({
      rows: [{ id: 1, name: "test" }],
      fields: idName,
      affectedRows: 0,
      command: "SELECT",
      rowCount: 1,
    });
    expect(await db.query("UPDATE test SET name = 'test2';")).toEqual({
      rows: [],
      fields: [],
      affectedRows: 1,
      command: "UPDATE",
      rowCount: 1,
    });
  });

  it("runs templated statements, parameters and identifiers apart", async () => {
    const db = await createTestPgwasm();
    const tableName = identifier`test`;
    await db.sql`CREATE TABLE IF NOT EXISTS ${tableName} (id SERIAL PRIMARY KEY, name TEXT);`;
    await db.sql`INSERT INTO ${tableName} (name) VALUES (${"test"});`;
    expect(await db.sql`SELECT * FROM ${tableName};`).toEqual({
      rows: [{ id: 1, name: "test" }],
      fields: idName,
      affectedRows: 0,
      command: "SELECT",
      rowCount: 1,
    });
    expect(await db.sql`UPDATE ${tableName} SET name = ${"test2"};`).toEqual({
      rows: [],
      fields: [],
      affectedRows: 1,
      command: "UPDATE",
      rowCount: 1,
    });
  });

  it("round-trips the built-in types", async () => {
    const db = await createTestPgwasm();
    await db.query(`
      CREATE TABLE IF NOT EXISTS test (
        id SERIAL PRIMARY KEY, text TEXT, number INT, float FLOAT, bigint BIGINT, bool BOOLEAN, date DATE,
        timestamp TIMESTAMP, json JSONB, blob BYTEA, array_text TEXT[], array_number INT[],
        nested_array_float FLOAT[][], test_null INT, test_undefined INT
      );
    `);
    await db.query(
      `INSERT INTO test (text, number, float, bigint, bool, date, timestamp, json, blob, array_text, array_number,
         nested_array_float, test_null, test_undefined)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14);`,
      [
        "test",
        1,
        1.5,
        9223372036854775807n,
        true,
        new Date("2021-01-01"),
        new Date("2021-01-01T12:00:00"),
        { test: "test" },
        Uint8Array.from([1, 2, 3]),
        ["test1", "test2", "test,3"],
        [1, 2, 3],
        [
          [1.1, 2.2],
          [3.3, 4.4],
        ],
        null,
        undefined,
      ],
    );
    const result = await db.query<{ timestamp: Date }>("SELECT * FROM test;");
    expect(result).toMatchObject({
      rows: [
        {
          id: 1,
          text: "test",
          number: 1,
          float: 1.5,
          bigint: 9223372036854775807n,
          bool: true,
          date: new Date("2021-01-01T00:00:00.000Z"),
          json: { test: "test" },
          blob: Uint8Array.from([1, 2, 3]),
          array_text: ["test1", "test2", "test,3"],
          array_number: [1, 2, 3],
          nested_array_float: [
            [1.1, 2.2],
            [3.3, 4.4],
          ],
          test_null: null,
          test_undefined: null,
        },
      ],
      fields: [
        { name: "id", dataTypeID: 23 },
        { name: "text", dataTypeID: 25 },
        { name: "number", dataTypeID: 23 },
        { name: "float", dataTypeID: 701 },
        { name: "bigint", dataTypeID: 20 },
        { name: "bool", dataTypeID: 16 },
        { name: "date", dataTypeID: 1082 },
        { name: "timestamp", dataTypeID: 1114 },
        { name: "json", dataTypeID: 3802 },
        { name: "blob", dataTypeID: 17 },
        { name: "array_text", dataTypeID: 1009 },
        { name: "array_number", dataTypeID: 1007 },
        { name: "nested_array_float", dataTypeID: 1022 },
        { name: "test_null", dataTypeID: 23 },
        { name: "test_undefined", dataTypeID: 23 },
      ],
      affectedRows: 0,
    });
    // Compared in UTC milliseconds, whatever the machine's timezone.
    expect(result.rows[0]?.timestamp.getUTCMilliseconds()).toBe(
      new Date("2021-01-01T12:00:00.000Z").getUTCMilliseconds(),
    );
  });

  it("uses custom parsers and serializers", async () => {
    const db = await createTestPgwasm({
      serializers: { 1700: (x) => String(x as bigint) },
      parsers: { 1700: (x) => BigInt(x) },
    });
    await db.query("CREATE TABLE IF NOT EXISTS test (id SERIAL PRIMARY KEY, numeric NUMERIC);");
    await db.query("INSERT INTO test (numeric) VALUES ($1);", [100n]);
    expect(await db.query("SELECT * FROM test;")).toEqual({
      rows: [{ id: 1, numeric: 100n }],
      fields: [
        { name: "id", dataTypeID: 23 },
        { name: "numeric", dataTypeID: 1700 },
      ],
      affectedRows: 0,
      command: "SELECT",
      rowCount: 1,
    });
  });

  it("binds parameters, arrays included", async () => {
    const db = await createTestPgwasm();
    await db.query("CREATE TABLE IF NOT EXISTS test (id SERIAL PRIMARY KEY, json JSONB, array_text TEXT[]);");
    await db.query("INSERT INTO test (json, array_text) VALUES ($1, $2);", [
      ["hello", "world"],
      ["yolo", "fam"],
    ]);
    expect(await db.query("SELECT * FROM test WHERE id = ANY($1);", [[0, 1, 2, 3]])).toEqual({
      rows: [{ id: 1, json: ["hello", "world"], array_text: ["yolo", "fam"] }],
      fields: [
        { name: "id", dataTypeID: 23 },
        { name: "json", dataTypeID: 3802 },
        { name: "array_text", dataTypeID: 1009 },
      ],
      affectedRows: 0,
      command: "SELECT",
      rowCount: 1,
    });
  });

  it("uses one parameter several times", async () => {
    const db = await createTestPgwasm();
    await db.exec("CREATE TABLE IF NOT EXISTS test (id SERIAL PRIMARY KEY, first_name TEXT, last_name TEXT);");
    await db.query("INSERT INTO test (first_name, last_name) VALUES ($1, $1);", ["Duck"]);
    expect(
      await db.query("SELECT first_name, last_name FROM test WHERE first_name = $1 AND last_name = $1", ["Duck"]),
    ).toEqual({
      rows: [{ first_name: "Duck", last_name: "Duck" }],
      fields: [
        { name: "first_name", dataTypeID: 25 },
        { name: "last_name", dataTypeID: 25 },
      ],
      affectedRows: 0,
      command: "SELECT",
      rowCount: 1,
    });
  });

  it("raises the SQL error with the query attached", async () => {
    const db = await createTestPgwasm();
    const error = await rejectionOf(db.query("SELECT * FROM test;"));
    expect(error.message).toBe('relation "test" does not exist');
    expect((error as Error & { query?: string; code?: string }).query).toBe("SELECT * FROM test;");
    expect((error as Error & { code?: string }).code).toBe("42P01");
    // The session is usable after the error.
    expect((await db.query<{ one: number }>("SELECT 1 AS one")).rows).toEqual([{ one: 1 }]);
  });

  it("counts MERGE … DELETE as affected rows", async () => {
    const db = await createTestPgwasm();
    await db.exec(`
      CREATE TABLE employees (id SERIAL PRIMARY KEY, name TEXT, department TEXT, salary NUMERIC);
      INSERT INTO employees (id, name, department, salary) VALUES
        (1, 'Alice', 'Engineering', 75000), (2, 'Bob', 'Sales', 50000), (3, 'Charlie', 'Engineering', 80000);
      CREATE TEMP TABLE employees_updates (id INT, name TEXT, department TEXT, salary NUMERIC);
      INSERT INTO employees_updates VALUES
        (2, 'Bob', 'Sales', 55000), (3, 'Charlie', 'Product', 80000), (4, 'Diana', 'Engineering', 70000);
    `);
    const result = await db.exec(`MERGE INTO employees AS target
      USING employees_updates AS source ON target.id = source.id
      WHEN MATCHED THEN DELETE`);
    expect(result[0]?.affectedRows).toEqual(2);
  });

  it("copies to and from /dev/blob", async () => {
    const db = await createTestPgwasm();
    await db.exec(`
      CREATE TABLE IF NOT EXISTS test (id SERIAL PRIMARY KEY, test TEXT);
      INSERT INTO test (test) VALUES ('test'), ('test2');
    `);
    const copyTo = await db.query("COPY test TO '/dev/blob' WITH (FORMAT csv);");
    expect(copyTo.affectedRows).toBe(2);
    const csv = (await copyTo.blob?.text()) ?? "";
    expect(csv).toBe("1,test\n2,test2\n");

    await db.exec("CREATE TABLE IF NOT EXISTS test2 (id SERIAL PRIMARY KEY, test TEXT);");
    const copyFrom = await db.query("COPY test2 FROM '/dev/blob' WITH (FORMAT csv);", [], { blob: new Blob([csv]) });
    expect(copyFrom.affectedRows).toBe(2);
    expect((await db.query("SELECT * FROM test2;")).rows).toEqual([
      { id: 1, test: "test" },
      { id: 2, test: "test2" },
    ]);
  });

  it("runs as the postgres role in the postgres database, in UTC", async () => {
    const db = await createTestPgwasm();
    const [result] = await db.exec("SELECT current_database(), current_user, current_role;");
    expect(result?.rows[0]).toEqual({
      current_database: "postgres",
      current_user: "postgres",
      current_role: "postgres",
    });
    const zone = await db.query("SELECT now(), * FROM pg_timezone_names WHERE name = current_setting('TIMEZONE')");
    expect(zone.rows.length).toEqual(1);
  });

  it("does not plan parallel workers", async () => {
    const db = await createTestPgwasm();
    await db.exec(`
      CREATE TABLE t (id SERIAL PRIMARY KEY, val TEXT);
      INSERT INTO t (val) SELECT md5(i::text) FROM generate_series(1, 400000) AS i;
    `);
    const plan = await db.query<{ "QUERY PLAN": string }>("EXPLAIN SELECT COUNT(*) FROM t");
    expect(plan.rows.some((row) => row["QUERY PLAN"].includes("Gather"))).toBe(false);
    expect((await db.query<{ count: number }>("SELECT COUNT(*) FROM t")).rows[0]?.count).toEqual(400000);
  });

  it("passes settings to the server", async () => {
    const db = await createTestPgwasm({ settings: { application_name: "my awesome app" } });
    expect((await db.query("SHOW application_name;")).rows).toEqual([{ application_name: "my awesome app" }]);
  });

  it("reports PostgreSQL 18 on wasm", async () => {
    const db = await createTestPgwasm();
    const version = (await db.query<{ version: string }>("select version();")).rows[0]?.version ?? "";
    expect(version).toMatch(/^PostgreSQL 18\.\d+ .*wasm32/);
  });

  it("parses NULL array elements as null, never the string 'NULL'", async () => {
    const db = await createTestPgwasm();
    await db.exec("CREATE TEMP TABLE t (str_val text, arr_val text[])");
    for (const values of [
      [null, "hello", "NULL"],
      ["NULL", null, "NULL"],
      ["NULL", "hello", null],
      [null, null, null],
    ]) {
      await db.query("INSERT INTO t (str_val, arr_val) VALUES ($1, $2)", [null, values]);
    }
    const result = await db.query<{ str_val: string | null; arr_val: (string | null)[] }>(
      "SELECT str_val, arr_val FROM t",
    );
    expect(result.rows[0]?.str_val).toEqual(null);
    expect(result.rows.map((row) => row.arr_val)).toEqual([
      [null, "hello", "NULL"],
      ["NULL", null, "NULL"],
      ["NULL", "hello", null],
      [null, null, null],
    ]);
    await db.exec("CREATE TEMP TABLE v (arr_int int[])");
    await db.query("INSERT INTO v (arr_int) VALUES ($1)", [[null, 123, 0]]);
    expect((await db.query<{ arr_int: (number | null)[] }>("SELECT arr_int FROM v")).rows[0]?.arr_int).toEqual([
      null,
      123,
      0,
    ]);
  });

  it("serializes int and bigint arrays through json", async () => {
    const db = await createTestPgwasm();
    const mybigint = [{ id: 9007199254740992n }, { id: 9007199254740993n }];
    await db.exec(`CREATE TABLE IF NOT EXISTS "myint" ("id" int NOT NULL);`);
    await db.exec(`CREATE TABLE IF NOT EXISTS "mybigint" ("id" bigint NOT NULL);`);
    await db.query(`INSERT INTO myint (id) SELECT x.* from json_to_recordset($1) as x(id int);`, [
      [{ id: 1 }, { id: 2 }],
    ]);
    await db.query(`INSERT INTO mybigint (id) SELECT x.* from json_to_recordset($1) as x(id bigint);`, [mybigint]);
    expect((await db.query("SELECT * FROM mybigint")).rows).toEqual(mybigint);
  });

  it("sends values of no concrete type as text", async () => {
    const db = await createTestPgwasm();
    const theDate = "2024-01-15T12:34:56.000Z";
    expect(await db.query("select $1 as number, $2 as date, $3 as bool", [42, new Date(theDate), true])).toEqual({
      rows: [{ number: "42", date: theDate, bool: "true" }],
      fields: [
        { name: "number", dataTypeID: 25 },
        { name: "date", dataTypeID: 25 },
        { name: "bool", dataTypeID: 25 },
      ],
      affectedRows: 0,
      command: "SELECT",
      rowCount: 1,
    });
    const before = await db.exec("SELECT 1");
    expect(await db.exec(`SELECT convert_to('abc', 'LATIN1')`)).toEqual([
      {
        rows: [{ convert_to: new Uint8Array([97, 98, 99]) }],
        fields: [{ name: "convert_to", dataTypeID: 17 }],
        command: "SELECT",
        affectedRows: 0,
        rowCount: 1,
      },
    ]);
    expect(await db.exec("SELECT 1")).toEqual(before);
  });
});

describe("transactions", () => {
  it("rolls back what an explicit rollback covers", async () => {
    const db = await createTestPgwasm();
    await withTestTable(db);
    await db.query("INSERT INTO test (name) VALUES ('test');");
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO test (name) VALUES ('test2');");
      expect(await tx.query("SELECT * FROM test;")).toEqual({
        rows: [
          { id: 1, name: "test" },
          { id: 2, name: "test2" },
        ],
        fields: idName,
        affectedRows: 0,
        command: "SELECT",
        rowCount: 2,
      });
      await tx.rollback();
    });
    expect((await db.query("SELECT * FROM test;")).rows).toEqual([{ id: 1, name: "test" }]);
  });

  it("refuses statements on an ended transaction's handle", async () => {
    const db = await createTestPgwasm();
    await db.exec("CREATE TABLE closed_transaction_test (id INT PRIMARY KEY)");
    let committed: Transaction | undefined;
    await db.transaction(async (tx) => {
      committed = tx;
    });
    expect(committed?.closed).toBe(true);
    expect((await rejectionOf(committed!.sql`INSERT INTO closed_transaction_test VALUES (1)`)).message).toBe(
      "Transaction is closed",
    );
    let rolledBack: Transaction | undefined;
    await db.transaction(async (tx) => {
      rolledBack = tx;
      await tx.rollback();
    });
    expect(rolledBack?.closed).toBe(true);
    expect((await rejectionOf(rolledBack!.sql`INSERT INTO closed_transaction_test VALUES (2)`)).message).toBe(
      "Transaction is closed",
    );
    expect((await db.query("SELECT id FROM closed_transaction_test")).rows).toEqual([]);
  });

  it("closes the handle when the callback rejects", async () => {
    const db = await createTestPgwasm();
    await db.exec("CREATE TABLE closed_transaction_test (id INT PRIMARY KEY)");
    let failed: Transaction | undefined;
    const error = await rejectionOf(
      db.transaction(async (tx) => {
        failed = tx;
        throw new Error("boom");
      }),
    );
    expect(error.message).toBe("boom");
    expect(failed?.closed).toBe(true);
    for (const attempt of [
      failed!.query("INSERT INTO closed_transaction_test VALUES (1)"),
      failed!.exec("INSERT INTO closed_transaction_test VALUES (2)"),
      failed!.sql`INSERT INTO closed_transaction_test VALUES (3)`,
    ]) {
      expect((await rejectionOf(attempt)).message).toBe("Transaction is closed");
    }
    expect((await db.query("SELECT id FROM closed_transaction_test")).rows).toEqual([]);
  });
});

describe("close", () => {
  it("closes, and refuses statements afterwards with a typed error", async () => {
    const db = await createTestPgwasm();
    await withTestTable(db);
    await db.query("INSERT INTO test (name) VALUES ('test');");
    await db.close();
    expect(db.closed).toBe(true);
    expect(db.ready).toBe(false);
    const error = await rejectionOf(db.query("SELECT * FROM test;"));
    expect(error).toBeInstanceOf(PgwasmClosedError);
    expect(error.message).toBe("pgwasm is closed");
  });

  it("closes through `await using`", async () => {
    let kept: Pgwasm | undefined;
    {
      await using db = await createTestPgwasm();
      kept = db;
      expect(db.ready).toBe(true);
    }
    expect(kept?.closed).toBe(true);
  });
});
