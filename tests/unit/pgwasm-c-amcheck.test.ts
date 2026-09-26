// Began as a copy of `@electric-sql/pglite`'s tests (taken under its PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { afterEach, describe, expect, it } from "bun:test";

import { amcheck } from "../../packages/pgwasm-c/src/contrib/amcheck";
import { closeTestPgwasms, createTestPgwasm } from "./support/pgwasm";

afterEach(closeTestPgwasms);

describe("the amcheck extension", () => {
  it("installs from its bundle and checks the catalog's btree indexes", async () => {
    const pg = await createTestPgwasm({ extensions: { amcheck } });
    await pg.exec("CREATE EXTENSION IF NOT EXISTS amcheck;");
    // The example from https://www.postgresql.org/docs/current/amcheck.html
    const result = await pg.query<{ bt_index_check: string; relname: string }>(`
      SELECT bt_index_check(index => c.oid, heapallindexed => i.indisunique), c.relname, c.relpages
      FROM pg_index i
      JOIN pg_opclass op ON i.indclass[0] = op.oid
      JOIN pg_am am ON op.opcmethod = am.oid
      JOIN pg_class c ON i.indexrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE am.amname = 'btree' AND n.nspname = 'pg_catalog'
      AND c.relpersistence != 't'
      AND c.relkind = 'i' AND i.indisready AND i.indisvalid
      ORDER BY c.relpages DESC LIMIT 10;
    `);
    expect(result.rows).toHaveLength(10);
    expect(result.rows.every((row) => row.bt_index_check === "")).toBe(true);
    expect(result.rows.map((row) => row.relname)).toContain("pg_proc_proname_args_nsp_index");
  });

  it("is refused by another build", () => {
    expect(amcheck.build).toBe("c");
    expect(amcheck.kind).toBe("server");
  });
});
