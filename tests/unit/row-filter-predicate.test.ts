import { describe, expect, it } from "bun:test";

import { pgTable, uuid } from "drizzle-orm/pg-core";

import {
  DENY_ALL_PREDICATE,
  defineSyncTable,
  isClaimsDependentRowFilter,
  p,
  type JwtClaims,
  type RowFilterSpec,
} from "@pgxsinkit/contracts";

// A bare Drizzle table to author filters against (mirrors how a registry references real columns).
const items = pgTable("items", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id"),
});

const claims: JwtClaims = { role: "authenticated", sub: "u-1" };

describe("p.* — predicates name columns by their real (unqualified) name", () => {
  it("reads the column's DB name off the Drizzle object, not its property key", () => {
    // `ownerId` is the property; `owner_id` is what the engine knows. Naming the column object is
    // what keeps the two from drifting — there is no string here to rename independently.
    expect(p.eq(items.ownerId, "u-1")).toEqual({ col: "owner_id", op: "eq", value: "u-1" });
  });

  it("derives a subquery's table from the projected column, so there is no table name to get wrong", () => {
    expect(p.subquery(items.id)).toEqual({ table: "items", project: "id" });
  });
});

describe("defineSyncTable — function-form rowFilter (all-in-one, typed columns)", () => {
  const entry = defineSyncTable({
    tableName: "widgets",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      ownerId: uuid("owner_id"),
    }),
    shape: {
      rowFilter: (columns) => ({
        customPredicate: (cl) => (cl.sub ? p.eq(columns.ownerId, cl.sub) : DENY_ALL_PREDICATE),
      }),
    },
  });

  it("resolves shape.rowFilter against the BUILT columns, so the predicate targets the real column", () => {
    const filter = entry.shape?.rowFilter;
    expect(filter).toBeDefined();
    expect(filter!.customPredicate!(claims)).toEqual({ col: "owner_id", op: "eq", value: "u-1" });
  });

  it("denies an unauthenticated subject with the sentinel, by reference", () => {
    // Reference identity is the contract: the control plane refuses to create the shape at all when it
    // sees THIS object, so a structurally-equal copy would cost an empty shape instead of a refusal.
    expect(entry.shape!.rowFilter!.customPredicate!({})).toBe(DENY_ALL_PREDICATE);
  });

  it("probes claims-dependent, which is what drives the ADR-0039 activation warning", () => {
    expect(isClaimsDependentRowFilter(entry.shape?.rowFilter)).toBe(true);
  });
});

describe("a rowFilter that cannot filter is refused at definition time", () => {
  it("throws when a rowFilter declares neither a predicate nor a column allow-list", () => {
    expect(() =>
      defineSyncTable({
        tableName: "leaky",
        makeColumns: () => ({ id: uuid("id").primaryKey() }),
        shape: { rowFilter: () => ({ revision: "v1" }) as RowFilterSpec },
      }),
    ).toThrow(/restricts nothing/);
  });

  it("allows a rowFilter that carries only a column allow-list (a projection narrowing its columns)", () => {
    expect(() =>
      defineSyncTable({
        tableName: "narrowed",
        makeColumns: () => ({ id: uuid("id").primaryKey(), body: uuid("body") }),
        shape: { rowFilter: () => ({ columns: ["id"] }) },
      }),
    ).not.toThrow();
  });
});
