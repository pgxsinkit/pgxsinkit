import { afterEach, describe, expect, it } from "bun:test";

import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";

afterEach(closeTestPgwasms);

describe("domain parameter serialization", () => {
  it("preserves binary input for domains created after boot and keeps the caller's prepared statement", async () => {
    const pg = await createTestPgwasm();
    await pg.exec("CREATE DOMAIN payload AS bytea; CREATE TABLE payloads (data payload, label text)");
    const bytes = Uint8Array.of(222, 173, 190, 239);
    await pg.query("INSERT INTO payloads VALUES ($1, $2)", [bytes, "bound to the original statement"]);
    expect((await pg.query("SELECT encode(data, 'hex') AS hex, label FROM payloads")).rows).toEqual([
      { hex: "deadbeef", label: "bound to the original statement" },
    ]);
    expect((await pg.query("SELECT name FROM pg_prepared_statements")).rows).toEqual([]);
    expect((await pg.query("SELECT $1::payload IS NULL AS empty", [null])).rows).toEqual([{ empty: true }]);
    expect((await pg.query("SELECT encode($1::payload, 'hex') AS hex", ["\\x0001"])).rows).toEqual([{ hex: "0001" }]);
  });

  it("follows nested domains and domain arrays in the active transaction", async () => {
    const pg = await createTestPgwasm();
    await pg.transaction(async (tx) => {
      await tx.exec(`
        CREATE DOMAIN binary_value AS bytea;
        CREATE DOMAIN nested_binary AS binary_value;
        CREATE DOMAIN binary_list AS nested_binary[];
      `);
      const values = [Uint8Array.of(0, 128, 255), null, Uint8Array.of(1)];
      for (const type of ["nested_binary[]", "binary_list"]) {
        expect(
          (
            await tx.query(`SELECT encode(($1::${type})[1], 'hex') AS first, ($1::${type})[2] IS NULL AS empty`, [
              values,
            ])
          ).rows,
        ).toEqual([{ first: "0080ff", empty: true }]);
      }
    });
  });

  it("resolves arrays of domains that existed when the database opened", async () => {
    const original = await createTestPgwasm();
    await original.exec("CREATE DOMAIN payload AS bytea");
    const backup = await original.dumpDataDir();
    await original.close();
    const pg = await createTestPgwasm({ loadDataDir: backup });
    expect(
      (await pg.query("SELECT encode(($1::payload[])[1], 'hex') AS hex", [[Uint8Array.of(222, 173)]])).rows,
    ).toEqual([{ hex: "dead" }]);
  });

  it("honors instance and per-query serializers for domains and their base types", async () => {
    const pg = await createTestPgwasm({ serializers: { 17: () => "\\x0102" } });
    await pg.exec("CREATE DOMAIN payload AS bytea");
    const { rows } = await pg.query<{ oid: number }>("SELECT 'payload'::regtype::oid::int AS oid");
    const oid = rows[0]!.oid;
    const sql = "SELECT encode($1::payload, 'hex') AS hex";
    expect((await pg.query(sql, [Uint8Array.of(255)])).rows).toEqual([{ hex: "0102" }]);
    expect((await pg.query(sql, [Uint8Array.of(255)], { serializers: { 17: () => "\\x0304" } })).rows).toEqual([
      { hex: "0304" },
    ]);
    expect(
      (await pg.query(sql, [Uint8Array.of(255)], { serializers: { [oid]: () => "\\x0506", 17: () => "\\x0304" } }))
        .rows,
    ).toEqual([{ hex: "0506" }]);
    const reopened = await createTestPgwasm({
      loadDataDir: await pg.dumpDataDir(),
      serializers: { [oid]: () => "\\x0708" },
    });
    expect((await reopened.query(sql, [Uint8Array.of(255)])).rows).toEqual([{ hex: "0708" }]);
  });

  it("resolves JSON domains and discards transaction-local type metadata after rollback", async () => {
    const pg = await createTestPgwasm();
    await pg.transaction(async (tx) => {
      await tx.exec("CREATE DOMAIN temporary_payload AS bytea");
      expect((await tx.query("SELECT encode($1::temporary_payload, 'hex') AS hex", [Uint8Array.of(128)])).rows).toEqual(
        [{ hex: "80" }],
      );
      await tx.rollback();
    });
    await pg.exec("CREATE DOMAIN temporary_payload AS jsonb");
    expect((await pg.query("SELECT ($1::temporary_payload)->>'key' AS value", [{ key: "value" }])).rows).toEqual([
      { value: "value" },
    ]);
  });

  it("preserves caller-owned prepared statements and scalar types with an element type", async () => {
    const pg = await createTestPgwasm();
    await pg.exec("PREPARE pgwasm_resolve_param_types AS SELECT 42 AS value; CREATE DOMAIN payload AS bytea");
    expect((await pg.query("SELECT encode($1::payload, 'hex') AS hex", [Uint8Array.of(128)])).rows).toEqual([
      { hex: "80" },
    ]);
    expect((await pg.exec("EXECUTE pgwasm_resolve_param_types"))[0]!.rows).toEqual([{ value: 42 }]);
    expect((await pg.query("SELECT $1::point::text AS point", [[1, 2]])).rows).toEqual([{ point: "(1,2)" }]);
  });
});
