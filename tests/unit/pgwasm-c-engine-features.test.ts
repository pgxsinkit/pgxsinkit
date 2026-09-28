// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { C_BUILD_IDENTITY } from "../../packages/pgwasm-c/src";
import type { Pgwasm } from "../../packages/pgwasm/src";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";
import { rejectionOf } from "./support/rejection";

// What the C build's artefacts must provide beyond the core: text search dictionaries, PL/pgSQL, triggers
// and event triggers, large objects, XML, databases. These guard the artefacts when they are rebuilt.

afterEach(closeTestPgwasms);

async function one(db: Pgwasm, sql: string): Promise<unknown> {
  return (await db.query<{ value: unknown }>(sql)).rows[0]?.value;
}

describe("full text search", () => {
  it("parses and stems with the english configuration", async () => {
    const db = await createTestPgwasm();
    expect(
      await one(db, "SELECT 'a fat cat sat on a mat and ate a fat rat'::tsvector @@ 'cat & rat'::tsquery AS value"),
    ).toBe(true);
    expect(
      await one(
        db,
        "SELECT to_tsvector('english', 'fat cats ate fat rats') @@ to_tsquery('english', 'fat & rat') AS value",
      ),
    ).toBe(true);
    expect(await one(db, "SELECT to_tsquery('english', 'The & Fat & Rats') AS value")).toBe("'fat' & 'rat'");
    expect(await one(db, "SELECT phraseto_tsquery('english', 'The Fat Rats') AS value")).toBe("'fat' <-> 'rat'");
    expect(await one(db, `SELECT websearch_to_tsquery('english', '"supernovae stars" -crab') AS value`)).toBe(
      "'supernova' <-> 'star' & !'crab'",
    );
    expect(await one(db, `SELECT websearch_to_tsquery('english', 'signal -"segmentation fault"') AS value`)).toBe(
      "'signal' & !( 'segment' <-> 'fault' )",
    );
  });

  it("keeps words whole with the simple configuration", async () => {
    const db = await createTestPgwasm();
    expect(
      await one(
        db,
        "SELECT to_tsvector('simple', 'fat cats ate fat rats') @@ to_tsquery('simple', 'fat & rat') AS value",
      ),
    ).toBe(false);
    expect(await one(db, "SELECT to_tsquery('simple', 'The & Fat & Rats') AS value")).toBe("'the' & 'fat' & 'rats'");
  });

  it("ranks documents", async () => {
    const db = await createTestPgwasm();
    await db.exec(`
      CREATE TABLE docs (id int, body text);
      INSERT INTO docs VALUES (1, 'the quick brown fox'), (2, 'a fox, another fox and a fox');
    `);
    const ranked = await db.query<{ id: number }>(`
      SELECT id FROM docs ORDER BY ts_rank(to_tsvector('english', body), to_tsquery('english', 'fox')) DESC
    `);
    expect(ranked.rows.map((row) => row.id)).toEqual([2, 1]);
  });
});

describe("PL/pgSQL", () => {
  it("creates and calls functions, and survives an exception", async () => {
    const db = await createTestPgwasm();
    await db.exec(`
      CREATE OR REPLACE FUNCTION calculate_factorial(n INT) RETURNS INT AS $$
      DECLARE result INT := 1;
      BEGIN
        IF n < 0 THEN RAISE EXCEPTION 'The input cannot be negative.';
        ELSIF n = 0 OR n = 1 THEN RETURN result;
        ELSE FOR i IN 2..n LOOP result := result * i; END LOOP; RETURN result;
        END IF;
      END;
      $$ LANGUAGE plpgsql;
      CREATE OR REPLACE PROCEDURE raise_exception() LANGUAGE plpgsql AS $$ BEGIN RAISE 'exception'; END; $$;
    `);
    expect(await one(db, "SELECT calculate_factorial(5) AS value")).toBe(120);
    expect((await rejectionOf(db.exec("CALL raise_exception();"))).message).toBe("exception");
    expect(await one(db, "SELECT calculate_factorial(3) AS value")).toBe(6);
  });
});

describe("triggers", () => {
  async function listening(db: Pgwasm) {
    const events: string[] = [];
    await db.listen("messages", (payload) => events.push(payload));
    const until = async (count: number) => {
      const deadline = Date.now() + 2000;
      while (events.length < count) {
        if (Date.now() > deadline) throw new Error(`expected ${count} notifications, saw ${events.length}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    return { events, until };
  }

  it("fires a row trigger", async () => {
    const db = await createTestPgwasm();
    const { events, until } = await listening(db);
    await db.exec(`
      CREATE TABLE foo_table (id TEXT, value TEXT);
      CREATE OR REPLACE FUNCTION foo() RETURNS trigger AS $$
      BEGIN PERFORM pg_notify('messages', 'table changed'); RETURN NULL; END;
      $$ LANGUAGE plpgsql;
      CREATE OR REPLACE TRIGGER table_trigger AFTER INSERT OR UPDATE OR DELETE ON foo_table EXECUTE FUNCTION foo();
    `);
    await db.query(`INSERT INTO foo_table (id, value) VALUES ('foo', 'bar');`);
    await until(1);
    expect(events).toEqual(["table changed"]);
  });

  it("fires event triggers on DDL, and sql_drop only on a drop", async () => {
    const db = await createTestPgwasm();
    const { events, until } = await listening(db);
    await db.exec(`
      CREATE OR REPLACE FUNCTION on_ddl() RETURNS event_trigger AS $$
      BEGIN PERFORM pg_notify('messages', 'ddl ' || tg_event); END;
      $$ LANGUAGE plpgsql;
      CREATE EVENT TRIGGER ddl_end ON ddl_command_end EXECUTE FUNCTION on_ddl();
      CREATE EVENT TRIGGER ddl_start ON ddl_command_start EXECUTE FUNCTION on_ddl();
      CREATE EVENT TRIGGER drops ON sql_drop EXECUTE FUNCTION on_ddl();
    `);
    events.length = 0;
    await db.exec("CREATE TABLE foo_table (id TEXT, value TEXT);");
    await until(2);
    expect(events.sort()).toEqual(["ddl ddl_command_end", "ddl ddl_command_start"]);
    events.length = 0;
    await db.exec("DROP TABLE foo_table;");
    await until(3);
    expect(events.sort()).toEqual(["ddl ddl_command_end", "ddl ddl_command_start", "ddl sql_drop"]);
  });
});

describe("large objects and XML", () => {
  it("imports and exports a large object through /dev/blob", async () => {
    const db = await createTestPgwasm();
    await db.exec("CREATE TABLE test (id SERIAL PRIMARY KEY, data OID);");
    await db.query("INSERT INTO test (data) VALUES (lo_import('/dev/blob'));", [], {
      blob: new Blob(["hello world"], { type: "text/plain" }),
    });
    const exported = await db.query("SELECT lo_export(data, '/dev/blob') AS data FROM test;");
    expect(await exported.blob?.text()).toBe("hello world");
  });

  it("stores, queries and aggregates XML", async () => {
    const db = await createTestPgwasm();
    await db.exec(`
      CREATE TABLE xml_test (id SERIAL PRIMARY KEY, data XML);
      INSERT INTO xml_test (data) VALUES
        ('<root><element>value1</element></root>'), ('<root><element>value2</element></root>');
    `);
    expect((await db.query("SELECT * FROM xml_test;")).rows).toEqual([
      { id: 1, data: "<root><element>value1</element></root>" },
      { id: 2, data: "<root><element>value2</element></root>" },
    ]);
    expect((await db.query("SELECT xpath('/root/element/text()', data) AS elements FROM xml_test;")).rows).toEqual([
      { elements: ["value1"] },
      { elements: ["value2"] },
    ]);
    expect(await one(db, `SELECT xmlelement(name "aggregated", xmlagg(data)) AS value FROM xml_test;`)).toBe(
      "<aggregated><root><element>value1</element></root><root><element>value2</element></root></aggregated>",
    );
  });
});

describe("databases and memory", () => {
  it("creates and drops a database", async () => {
    const db = await createTestPgwasm();
    await db.exec("CREATE DATABASE mypostgres TEMPLATE template1;");
    await db.exec("DROP DATABASE mypostgres;");
  });

  it("resets MessageContext between statements instead of accumulating", async () => {
    const db = await createTestPgwasm();
    await db.exec("CREATE TABLE IF NOT EXISTS leak_test (id SERIAL PRIMARY KEY, blob jsonb NOT NULL);");
    const blob = JSON.stringify({ padding: "x".repeat(100 * 1024) });
    for (let i = 0; i < 300; i++) {
      await db.exec(`INSERT INTO leak_test (blob) VALUES ('${blob}')`);
    }
    const used = await db.query<{ used_bytes: number }>(`
      SELECT used_bytes FROM pg_backend_memory_contexts WHERE name = 'MessageContext' ORDER BY level LIMIT 1
    `);
    expect(used.rows).toHaveLength(1);
    // ~30 MB of literals went through; a resetting context stays far below that.
    expect(Number(used.rows[0]?.used_bytes)).toBeLessThan(5 * 1024 * 1024);
  });
});

describe("encoding conversions", () => {
  // Every loadable module the build ships must resolve every symbol it imports from the server; the
  // conversion modules once did not, and the first conversion crashed the backend.
  it("converts to and from LATIN1", async () => {
    const db = await createTestPgwasm();
    expect(await one(db, "SELECT convert_to('é', 'LATIN1') AS value")).toEqual(new Uint8Array([0xe9]));
    expect(await one(db, String.raw`SELECT convert_from('\xe9'::bytea, 'LATIN1') AS value`)).toBe("é");
  });

  it("runs every default conversion", async () => {
    const db = await createTestPgwasm();
    const { rows } = await db.query<{ total: number; converted: number }>(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE convert('a'::bytea, pg_encoding_to_char(conforencoding),
                                            pg_encoding_to_char(contoencoding)) = 'a'::bytea)::int AS converted
        FROM pg_conversion WHERE condefault
    `);
    expect(rows[0]?.total).toBeGreaterThan(100);
    expect(rows[0]?.converted).toBe(rows[0]?.total);
    expect(await one(db, "SELECT 1 AS value")).toBe(1);
  });

  it("LOADs a conversion module", async () => {
    const db = await createTestPgwasm();
    await db.exec("LOAD 'utf8_and_iso8859_1'");
    expect(await one(db, "SELECT convert_to('ü', 'LATIN1') AS value")).toEqual(new Uint8Array([0xfc]));
  });
});

describe("the release", () => {
  it("is named in version(), as the build identity names it", async () => {
    const db = await createTestPgwasm();
    const version = String(await one(db, "SELECT version() AS value"));
    expect(version).toStartWith(`PostgreSQL 18.6 (${C_BUILD_IDENTITY.release}) on wasm32-unknown-emscripten`);
  });
});
