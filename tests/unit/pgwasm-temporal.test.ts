import { afterEach, describe, expect, it } from "bun:test";

import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";

afterEach(closeTestPgwasms);

describe("default temporal codecs", () => {
  it("preserves early timestamp years from PostgreSQL output", async () => {
    const pg = await createTestPgwasm();
    const { rows } = await pg.query<{ first: Date; second: Date; date: Date }>(`
      SELECT '0050-06-15 12:30:00+00'::timestamptz AS first,
             '0099-06-15 12:30:00+05:30'::timestamptz AS second,
             '0001-01-01'::date AS date
    `);
    expect(rows).toEqual([
      {
        first: new Date("0050-06-15T12:30:00Z"),
        second: new Date("0099-06-15T07:00:00Z"),
        date: new Date("0001-01-01T00:00:00Z"),
      },
    ]);
  });

  it("round-trips infinite temporal parameters and array elements", async () => {
    const pg = await createTestPgwasm();
    const { rows } = await pg.query(
      `SELECT $1::date AS date, $2::timestamp AS timestamp, $3::timestamptz AS timestamptz,
              $4::timestamptz[] AS dates`,
      [Infinity, -Infinity, Infinity, [Infinity, null, -Infinity]],
    );
    expect(rows).toEqual([
      { date: Infinity, timestamp: -Infinity, timestamptz: Infinity, dates: [Infinity, null, -Infinity] },
    ]);
    expect(
      (await pg.query("SELECT 'infinity'::date AS value", [], { parsers: { 1082: (value) => value } })).rows,
    ).toEqual([{ value: "infinity" }]);
  });
});
