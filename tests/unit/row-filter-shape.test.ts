import { describe, expect, it } from "bun:test";

import { sql } from "drizzle-orm";
import { PgDialect, pgTable, uuid } from "drizzle-orm/pg-core";

import { buildRowFilterShape, c, type JwtClaims, type RowFilterSpec } from "@pgxsinkit/contracts";

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

  it("passes a legacy string customWhere through unchanged, with no params", () => {
    const filter: RowFilterSpec = { customWhere: () => `"owner_id" = 'u-1'` };
    expect(buildRowFilterShape(filter, claims)).toEqual({ where: `"owner_id" = 'u-1'`, params: [] });
  });

  it("keeps ownership inline (no params), matching buildRowFilterWhere", () => {
    const filter: RowFilterSpec = { ownership: { column: "owner_id" } };
    expect(buildRowFilterShape(filter, claims)).toEqual({ where: `"owner_id" = 'u-1'`, params: [] });
  });

  it("composes inline ownership AND a parameterized SQL customWhere (the $n index the returned params)", () => {
    const filter: RowFilterSpec = {
      ownership: { column: "owner_id" },
      customWhere: () => sql`${c(items.id)} = ${"x"}`,
    };
    expect(buildRowFilterShape(filter, claims)).toEqual({
      where: `("owner_id" = 'u-1') AND ("id" = $1)`,
      params: ["x"],
    });
  });

  it("returns null when no filter applies", () => {
    expect(buildRowFilterShape({}, claims)).toBeNull();
  });

  it("blocks all rows for an unauthenticated subject via the filter's own sentinel", () => {
    const filter: RowFilterSpec = { customWhere: (cl) => (cl.sub ? sql`${c(items.ownerId)} = ${cl.sub}` : "1 = 0") };
    expect(buildRowFilterShape(filter, null)).toEqual({ where: "1 = 0", params: [] });
  });
});
