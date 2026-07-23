import { describe, expect, it } from "bun:test";

import { getTableConfig, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncTable } from "@pgxsinkit/contracts";

// defineSyncTable emits the `primaryKey` spec as the server table's physical PRIMARY KEY constraint —
// the spec is the single source of truth (see registry.ts). These pin the emission, the `_pkey`
// naming (no rename churn for existing consumers), and the column-level `.primaryKey()` interop.

describe("defineSyncTable primary-key emission", () => {
  it("emits a composite spec as a `${tableName}_pkey` constraint in spec order", () => {
    const entry = defineSyncTable({
      tableName: "memberships",
      makeColumns: () => ({
        id: uuid("id").notNull(),
        created_by_id: uuid("created_by_id").notNull(),
      }),
      primaryKey: ["id", "created_by_id"],
      clientProjection: { omitColumns: [] },
    });

    const pks = getTableConfig(entry.table).primaryKeys;
    expect(pks).toHaveLength(1);
    expect(pks[0]!.getName()).toBe("memberships_pkey");
    expect(pks[0]!.columns.map((c) => c.name)).toEqual(["id", "created_by_id"]);
  });

  it("uses the object form's custom constraint name", () => {
    const entry = defineSyncTable({
      tableName: "memberships",
      makeColumns: () => ({
        id: uuid("id").notNull(),
        created_by_id: uuid("created_by_id").notNull(),
      }),
      primaryKey: { name: "custom_pk", columns: ["id", "created_by_id"] },
      clientProjection: { omitColumns: [] },
    });

    const pks = getTableConfig(entry.table).primaryKeys;
    expect(pks).toHaveLength(1);
    expect(pks[0]!.getName()).toBe("custom_pk");
  });

  it("skips emission when the single-column key is declared idiomatically via .primaryKey()", () => {
    const entry = defineSyncTable({
      tableName: "items",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        title: varchar("title", { length: 120 }).notNull(),
      }),
      clientProjection: { omitColumns: [] },
    });

    const config = getTableConfig(entry.table);
    // No table-level constraint — existing consumers see byte-identical DDL.
    expect(config.primaryKeys).toHaveLength(0);
    expect(config.columns.find((c) => c.name === "id")!.primary).toBe(true);
  });

  it("throws when a column-level .primaryKey() does not match the spec", () => {
    expect(() =>
      defineSyncTable({
        tableName: "items",
        makeColumns: () => ({
          id: uuid("id").notNull(),
          slug: varchar("slug", { length: 64 }).primaryKey(),
        }),
        primaryKey: ["id"],
        clientProjection: { omitColumns: [] },
      }),
    ).toThrow(/declares \.primaryKey\(\) but the primaryKey spec is/);
  });

  it("throws when two columns declare .primaryKey()", () => {
    expect(() =>
      defineSyncTable({
        tableName: "items",
        makeColumns: () => ({
          id: uuid("id").primaryKey(),
          slug: varchar("slug", { length: 64 }).primaryKey(),
        }),
        primaryKey: ["id", "slug"],
        clientProjection: { omitColumns: [] },
      }),
    ).toThrow(/multiple columns declare \.primaryKey\(\)/);
  });

  it("throws when a primaryKey(...) is passed via extras", async () => {
    const { primaryKey: pgPrimaryKey } = await import("drizzle-orm/pg-core");
    expect(() =>
      defineSyncTable({
        tableName: "items",
        makeColumns: () => ({
          id: uuid("id").notNull(),
          slug: varchar("slug", { length: 64 }).notNull(),
        }),
        primaryKey: ["id"],
        extras: (self) => [pgPrimaryKey({ columns: [self.id, self.slug] })],
        clientProjection: { omitColumns: [] },
      }),
    ).toThrow(/not a primaryKey\(\.\.\.\) extra/);
  });

  it("throws when a custom name is combined with a column-level .primaryKey()", () => {
    expect(() =>
      defineSyncTable({
        tableName: "items",
        makeColumns: () => ({
          id: uuid("id").primaryKey(),
          title: varchar("title", { length: 120 }).notNull(),
        }),
        primaryKey: { name: "custom_pk", columns: ["id"] },
        clientProjection: { omitColumns: [] },
      }),
    ).toThrow(/requires defineSyncTable to emit the constraint/);
  });

  it("resolves a spec column given by its SQL column name when the property key differs", () => {
    const entry = defineSyncTable({
      tableName: "notes",
      makeColumns: () => ({
        id: uuid("id").notNull(),
        createdById: uuid("created_by_id").notNull(),
      }),
      primaryKey: ["id", "created_by_id"],
      clientProjection: { omitColumns: [] },
    });

    const pks = getTableConfig(entry.table).primaryKeys;
    expect(pks).toHaveLength(1);
    expect(pks[0]!.getName()).toBe("notes_pkey");
    expect(pks[0]!.columns.map((c) => c.name)).toEqual(["id", "created_by_id"]);
  });
});
