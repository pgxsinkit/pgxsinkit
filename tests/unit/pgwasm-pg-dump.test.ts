// Began as a port of `@electric-sql/pglite-tools`' tests (`tests/pg_dump.test.ts`, taken under PGlite's
// PostgreSQL License option, © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with
// PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { pgDump } from "../../packages/pgwasm-pg-dump/src";
import { closeTestPgwasms, createTestPgwasm, scratchDir } from "./support/pgwasm";

// pg_dump's WebAssembly, run by `pgDump` over a pgwasm database on the C build.

afterEach(closeTestPgwasms);

const TWO_TABLES = `
  CREATE TABLE test1 (id SERIAL PRIMARY KEY, name TEXT);
  INSERT INTO test1 (name) VALUES ('test1-row1');
  CREATE TABLE test2 (id SERIAL PRIMARY KEY, value INTEGER);
  INSERT INTO test2 (value) VALUES (42);
`;

describe("pgDump", () => {
  it("dumps an empty database as a plain SQL file", async () => {
    const dump = await pgDump({ pg: await createTestPgwasm() });
    expect(dump).toBeInstanceOf(File);
    expect(dump.name).toBe("dump.sql");
    expect(dump.type).toStartWith("text/plain");
    const content = await dump.text();
    expect(content).toContain("PostgreSQL database dump");
    expect(content).toContain("Dumped by pg_dump version 18.6");
  });

  it("dumps the same database again and again", async () => {
    const pg = await createTestPgwasm();
    for (let i = 0; i < 3; i++) {
      const dump = await pgDump({ pg, fileName: `dump_${i}.sql` });
      expect(dump.name).toBe(`dump_${i}.sql`);
      expect(await dump.text()).toContain("PostgreSQL database dump");
    }
  });

  it("dumps tables and their rows as INSERT statements", async () => {
    const pg = await createTestPgwasm();
    await pg.exec(TWO_TABLES);
    const content = await (await pgDump({ pg })).text();
    expect(content).toContain("CREATE TABLE public.test1");
    expect(content).toContain("CREATE TABLE public.test2");
    expect(content).toContain("INSERT INTO public.test1 VALUES (1, 'test1-row1');");
    expect(content).toContain("INSERT INTO public.test2 VALUES (1, 42);");
    // psql's \restrict / \unrestrict lines are not SQL; exec() could not run the script with them.
    expect(content).not.toMatch(/^\\(un)?restrict /m);
  });

  it("passes pg_dump's own arguments on", async () => {
    const pg = await createTestPgwasm();
    await pg.exec(TWO_TABLES);
    const schemaOnly = await (await pgDump({ pg, args: ["--schema-only"] })).text();
    expect(schemaOnly).toContain("CREATE TABLE public.test1");
    expect(schemaOnly).not.toContain("INSERT INTO public.test1");
    const quoted = await (await pgDump({ pg, args: ["--quote-all-identifiers"] })).text();
    expect(quoted).toContain('CREATE TABLE "public"."test1"');
    expect(quoted).toContain('INSERT INTO "public"."test2" VALUES (1, 42);');
  });

  it("dumps a database on file storage", async () => {
    const dir = scratchDir("pgwasm-pg-dump");
    try {
      const pg = await createTestPgwasm({ dataDir: `file://${dir.path}/db` });
      await pg.exec(TWO_TABLES);
      const content = await (await pgDump({ pg })).text();
      expect(content).toContain("INSERT INTO public.test1 VALUES (1, 'test1-row1');");
      await pg.close();
    } finally {
      dir.cleanup();
    }
  });

  it("restores into a new database with the same rows, and its sequences where they were", async () => {
    const pg = await createTestPgwasm();
    await pg.exec(`
      CREATE TABLE kinds (
        id serial PRIMARY KEY, note text, amount numeric, doc jsonb, bytes bytea, tags int[],
        at timestamptz, flag boolean, nothing text
      );
      INSERT INTO kinds (note, amount, doc, bytes, tags, at, flag) VALUES
        ('it''s "quoted"' || E'\\nover two lines \\\\ with a backslash, and ünïcödé', 12345.6789,
         '{"a": [1, 2, {"b": null}]}', '\\x00ff10', '{1,2,3}', '2026-09-27 10:00:00+02', true),
        ('', -0.5, '[]', '\\x', '{}', '1970-01-01 00:00:00+00', false);
      CREATE VIEW kind_notes AS SELECT id, note FROM kinds;
    `);
    const rows = async (db: typeof pg) => (await db.query("SELECT * FROM public.kinds ORDER BY id")).rows;
    const original = await rows(pg);
    const script = await (await pgDump({ pg })).text();

    const restored = await createTestPgwasm();
    await restored.exec(script);
    expect(await rows(restored)).toEqual(original);
    expect((await restored.query("SELECT count(*)::int AS n FROM public.kind_notes")).rows).toEqual([{ n: 2 }]);
    await restored.exec("INSERT INTO public.kinds (note) VALUES ('next')");
    expect((await restored.query("SELECT max(id) AS id FROM public.kinds")).rows).toEqual([{ id: 3 }]);
  });

  it("keeps a row whose text holds lines that look like psql's \\restrict", async () => {
    const pg = await createTestPgwasm();
    const note = "first line\n\\restrict notakey\n\\unrestrict notakey\nlast line";
    await pg.query("CREATE TABLE notes (note text)");
    await pg.query("INSERT INTO notes VALUES ($1)", [note]);
    const script = await (await pgDump({ pg })).text();
    expect(script).not.toMatch(/^\\(un)?restrict [A-Za-z0-9]{32,}$/m);
    const restored = await createTestPgwasm();
    await restored.exec(script);
    expect((await restored.query("SELECT note FROM public.notes")).rows).toEqual([{ note }]);
  });

  it("dumps many tables, whose catalogue queries are longer than libpq's 8 KiB send blocks", async () => {
    // pg_dump lists every table's OID in one query; with a thousand tables it is over 8 KiB, which libpq
    // sends in pieces. Handed to the backend piece by piece, the first made it read past its input and
    // failed the database.
    const pg = await createTestPgwasm();
    await pg.exec(Array.from({ length: 1000 }, (_, i) => `CREATE TABLE many_${i} (id int);`).join("\n"));
    const content = await (await pgDump({ pg })).text();
    expect(content.match(/^CREATE TABLE public\.many_\d+ /gm)).toHaveLength(1000);
    expect((await pg.query("SELECT count(*)::int AS n FROM many_999")).rows).toEqual([{ n: 0 }]);
  });

  it("returns the custom archive format byte for byte", async () => {
    const pg = await createTestPgwasm();
    await pg.exec(TWO_TABLES);
    const archive = await pgDump({ pg, args: ["--format=custom"], fileName: "dump.pgdump" });
    expect(archive.name).toBe("dump.pgdump");
    expect(archive.type).toBe("application/octet-stream");
    expect(new TextDecoder().decode(new Uint8Array(await archive.arrayBuffer()).subarray(0, 5))).toBe("PGDMP");
  });
});
