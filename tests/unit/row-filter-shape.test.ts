import { describe, expect, it } from "bun:test";

import { sql } from "drizzle-orm";
import { PgDialect, pgTable, uuid } from "drizzle-orm/pg-core";

import {
  buildRowFilterShape,
  c,
  DENY_ALL,
  defineSyncTable,
  type JwtClaims,
  type RowFilterSpec,
} from "@pgxsinkit/contracts";

// A bare Drizzle table to author filters against (mirrors how a registry references real columns).
const items = pgTable("items", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id"),
});

const dialect = new PgDialect();
const claims: JwtClaims = { role: "authenticated", sub: "u-1" };

describe("c() — bare column identifier (ADR: Electric needs plain refs)", () => {
  it("emits a table-unqualified quoted identifier, not the Drizzle-default qualified one", () => {
    expect(dialect.sqlToQuery(c(items.ownerId)).sql).toBe(`"owner_id"`);
    // The Drizzle column itself would qualify — which Electric rejects.
    expect(dialect.sqlToQuery(sql`${items.ownerId}`).sql).toBe(`"items"."owner_id"`);
  });
});

describe("buildRowFilterShape", () => {
  it("parameterizes a Drizzle SQL customWhere — bare columns, $n params, no inlined value", () => {
    const filter: RowFilterSpec = { customWhere: (cl) => sql`${c(items.ownerId)} = ${cl.sub}` };
    expect(buildRowFilterShape(filter, claims)).toEqual({ where: `"owner_id" = $1`, params: ["u-1"] });
  });

  it("passes a raw string customWhere through unchanged, with no params (the escape hatch)", () => {
    const filter: RowFilterSpec = { customWhere: () => `"owner_id" = 'u-1'` };
    expect(buildRowFilterShape(filter, claims)).toEqual({ where: `"owner_id" = 'u-1'`, params: [] });
  });

  it("returns null when no filter applies", () => {
    expect(buildRowFilterShape({}, claims)).toBeNull();
  });

  it("blocks all rows for an unauthenticated subject via the DENY_ALL sentinel", () => {
    const filter: RowFilterSpec = { customWhere: (cl) => (cl.sub ? sql`${c(items.ownerId)} = ${cl.sub}` : DENY_ALL) };
    expect(buildRowFilterShape(filter, null)).toEqual({ where: "false", params: [] });
  });
});

describe("defineSyncTable — function-form rowFilter (all-in-one, typed columns)", () => {
  it("resolves shape.rowFilter against the built columns, so c(columns.x) targets the real identifier", () => {
    const entry = defineSyncTable({
      tableName: "widgets",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        ownerId: uuid("owner_id"),
      }),
      shape: {
        rowFilter: (columns) => ({
          customWhere: (cl) => (cl.sub ? sql`${c(columns.ownerId)} = ${cl.sub}` : DENY_ALL),
        }),
      },
    });

    const filter = entry.shape?.rowFilter;
    expect(filter).toBeDefined();
    // Authenticated → parameterized, bare-column predicate built from the real (typed) column object.
    expect(buildRowFilterShape(filter!, claims)).toEqual({ where: `"owner_id" = $1`, params: ["u-1"] });
    // Unauthenticated → deny sentinel.
    expect(buildRowFilterShape(filter!, null)).toEqual({ where: "false", params: [] });
  });

  it("keeps the raw string customWhere escape hatch inside the column callback", () => {
    const entry = defineSyncTable({
      tableName: "widgets_static",
      makeColumns: () => ({ id: uuid("id").primaryKey(), ownerId: uuid("owner_id") }),
      shape: { rowFilter: () => ({ customWhere: () => `"owner_id" = 'u-1'` }) },
    });
    expect(buildRowFilterShape(entry.shape!.rowFilter!, claims)).toEqual({ where: `"owner_id" = 'u-1'`, params: [] });
  });
});
