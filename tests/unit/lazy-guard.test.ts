import { describe, expect, it } from "bun:test";

import { sql } from "drizzle-orm";
import { pgSchema, QueryBuilder, uuid, varchar } from "drizzle-orm/pg-core";

import { defineReadProjection, defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { todosSyncEntry, todosView } from "@pgxsinkit/schema";

import {
  assertLazyRefsActivated,
  buildLazyGuardIndex,
  findReferencedLazyKeysInSql,
  findReferencedSyncedKeysInSql,
  LazyRelationNotActivatedError,
} from "../../packages/client/src/lazy-guard";

// Every read shape a lazy relation can take (ADR-0021):
//  - todos  → readwrite, schema-less → read via the bare `todos_read_model` view (+ base `todos`)
//  - archive → readonly, schema-less → read via the bare `archive` table
//  - events → readonly, SCHEMA-QUALIFIED (appserver) → read via `"appserver"."events"`
const archiveEntry = defineSyncTable({
  tableName: "archive",
  makeColumns: () => ({ id: uuid("id").primaryKey(), label: varchar("label", { length: 80 }) }),
  mode: "readonly",
  subscription: "lazy",
});
const eventsEntry = defineSyncTable({
  tableName: "events",
  makeColumns: () => ({ id: uuid("id").primaryKey(), label: varchar("label", { length: 80 }) }),
  mode: "readonly",
  subscription: "lazy",
  schema: pgSchema("appserver"),
});
const archiveTable = archiveEntry.table;
const eventsTable = eventsEntry.table;

const registry = defineSyncRegistry({
  todos: { ...todosSyncEntry, subscription: "lazy" },
  archive: archiveEntry,
  events: eventsEntry,
});

const index = buildLazyGuardIndex(registry);
const qb = () => new QueryBuilder();
const keys = (s: string) => [...findReferencedLazyKeysInSql(s, index)].sort();

describe("lazy-guard index (ADR-0021)", () => {
  it("indexes only the lazy keys, with the exact quoted tokens their reads compile to", () => {
    expect([...index.lazyKeys].sort()).toEqual(["archive", "events", "todos"]);
    // readwrite: bare base table + bare read-model view.
    expect(index.lazyTokens.get("todos")).toEqual([`"todos"`, `"todos_read_model"`]);
    // readonly, schema-less: just the bare table.
    expect(index.lazyTokens.get("archive")).toEqual([`"archive"`]);
    // readonly, schema-qualified: the SCHEMA-QUALIFIED token — never a bare `"events"`.
    expect(index.lazyTokens.get("events")).toEqual([`"appserver"."events"`]);
  });
});

describe("the compiled-SQL scan (ADR-0021)", () => {
  it("matches a lazy relation by the real token its read compiles to, including from a subquery", () => {
    expect(keys(qb().select().from(todosView).toSQL().sql)).toEqual(["todos"]);
    expect(keys(qb().select().from(eventsTable).toSQL().sql)).toEqual(["events"]);

    // a directly-imported table nested only in a subquery is still caught (it is in the compiled SQL).
    const withSubquery = qb()
      .select()
      .from(todosView)
      .where(sql`id in (select id from ${archiveTable})`)
      .toSQL().sql;
    expect(keys(withSubquery)).toEqual(["archive", "todos"]);
  });

  it("matches whole quoted tokens only — never a longer identifier", () => {
    // `"archive"` must not match inside `"archive_old"` (the closing quote delimits it).
    expect(keys(`select * from "archive_old"`)).toEqual([]);
    expect(keys(`select * from "todos_read_model"`)).toEqual(["todos"]);
  });
});

describe("cross-schema matching (ADR-0021)", () => {
  it("matches a schema-qualified relation only via its qualified token, not a bare same-named ref", () => {
    // The real, schema-qualified read → matches.
    expect(keys(`select * from "appserver"."events"`)).toEqual(["events"]);
    expect(
      keys(
        qb()
          .select()
          .from(eventsTable)
          .where(sql`x in (select id from ${eventsTable})`)
          .toSQL().sql,
      ),
    ).toEqual(["events"]);

    // A BARE "events" (a different schema's table, a column, an alias) must NOT match the appserver one —
    // this is the cross-schema disambiguation: the qualifier is part of the token.
    expect(keys(`select * from "events"`)).toEqual([]);
    expect(keys(`select "t"."events" from "t"`)).toEqual([]);
  });

  it("real compiled join across schema-qualified and bare relations resolves each to its own key", () => {
    const joined = qb()
      .select()
      .from(eventsTable)
      .leftJoin(todosView, sql`true`)
      .toSQL().sql;
    expect(keys(joined)).toEqual(["events", "todos"]);
  });
});

describe("pathological-case resilience (ADR-0021)", () => {
  it("ignores a column alias that collides with a schema-less lazy table name", () => {
    // `select 1 as "archive" …` — Drizzle emits the alias in `as "archive"` position; not a real read.
    const aliased = qb()
      .select({ archive: sql`1`.as("archive") })
      .from(todosView)
      .toSQL().sql;
    expect(aliased).toContain(`as "archive"`);
    expect(keys(aliased)).toEqual(["todos"]); // todos (the real FROM) yes; archive (the alias) no
  });

  it("is immune to alias/CTE collisions on a schema-qualified relation for free (the qualifier disambiguates)", () => {
    // A CTE named "events" shadows nothing: the real read is the qualified `"appserver"."events"` in the
    // CTE body; the bare CTE name never matches the qualified token.
    const cte = qb()
      .$with("events")
      .as(qb().select({ id: eventsTable.id }).from(eventsTable));
    const withCte = qb().with(cte).select().from(cte).toSQL().sql;
    expect(withCte).toContain(`"events" as`); // the bare CTE definition
    expect(withCte).toContain(`from "appserver"."events"`); // the real qualified read
    expect(keys(withCte)).toEqual(["events"]);

    // A column aliased `as "events"` against the qualified relation: the alias is bare, the read is
    // qualified — only the read matches.
    const aliasedQualified = qb()
      .select({ events: sql`1`.as("events") })
      .from(eventsTable)
      .toSQL().sql;
    expect(keys(aliasedQualified)).toEqual(["events"]);
  });
});

// A read PROJECTION (defineReadProjection, ADR-0025) reads the OWNER's physical rows under a DISTINCT
// local identity (`as`). `entry.table` is the OWNER's physical table, but a consumer imports and queries
// the projection ONLY through `entry.localTable` (the `as` name — where Electric syncs its rows). So the
// guard must token the localTable identity, not the owner's physical name.
const authoringOwner = defineSyncTable({
  tableName: "authoring_item",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 200 }),
    body: varchar("body", { length: 4000 }),
  }),
  mode: "readonly",
  subscription: "lazy",
});
const authoringAdmin = defineReadProjection(authoringOwner, {
  as: "authoring_item_admin",
  columns: ["title"],
  subscription: "lazy",
});
const projectionRegistry = defineSyncRegistry({
  authoring_item: authoringOwner,
  authoring_item_admin: authoringAdmin,
});
const projectionIndex = buildLazyGuardIndex(projectionRegistry);
const projectionKeys = (s: string) => [...findReferencedLazyKeysInSql(s, projectionIndex)].sort();

describe("read-projection lazy activation (ADR-0025 / ADR-0021)", () => {
  it("activates a lazy read projection via its own localTable identity, not the owner's physical name", () => {
    // The projection's token is its DISTINCT local identity — the `as` name it syncs into.
    expect(projectionIndex.lazyTokens.get("authoring_item_admin")).toEqual([`"authoring_item_admin"`]);

    // A consumer reads the projection through its localTable object → the projection activates.
    const readProjection = qb().select().from(authoringAdmin.localTable).toSQL().sql;
    expect(projectionKeys(readProjection)).toEqual(["authoring_item_admin"]);
  });

  it("resolves an owner-table read to the owner entry, never falsely to its projection", () => {
    const readOwner = qb().select().from(authoringOwner.localTable).toSQL().sql;
    expect(projectionKeys(readOwner)).toEqual(["authoring_item"]);
  });

  it("throws the backstop for an unactivated projection read, and clears once it is active", () => {
    const sqlText = qb().select().from(authoringAdmin.localTable).toSQL().sql;
    expect(() => assertLazyRefsActivated({ sql: sqlText, index: projectionIndex, isActive: () => false })).toThrow(
      LazyRelationNotActivatedError,
    );
    expect(() => assertLazyRefsActivated({ sql: sqlText, index: projectionIndex, isActive: () => true })).not.toThrow();
  });
});

// The hydration guarantee (ADR-0021/0032) gates a live subscription's `hydrating` on EVERY consistency
// group the query reads — eager AND lazy — so the guard index must resolve all synced relations, not only
// lazy ones (activation stays lazy-only). A mixed registry: `todos` readwrite EAGER (base + read-model
// view), `events` readonly EAGER schema-qualified, `archive` readonly LAZY.
const eagerTodos = defineSyncRegistry({
  todos: todosSyncEntry, // eager (default)
  events: { ...eventsEntry, subscription: "eager" as const },
  archive: archiveEntry, // lazy
});
const allIndex = buildLazyGuardIndex(eagerTodos);
const syncedKeys = (s: string) => [...findReferencedSyncedKeysInSql(s, allIndex)].sort();
const lazyKeysOf = (s: string) => [...findReferencedLazyKeysInSql(s, allIndex)].sort();

describe("all-synced-relations index (hydration guarantee, ADR-0021/0032)", () => {
  it("indexes EVERY synced relation (eager + lazy) with the tokens their reads compile to", () => {
    expect([...allIndex.allKeys].sort()).toEqual(["archive", "events", "todos"]);
    // eager readwrite: base table + read-model view; eager schema-qualified; lazy readonly table.
    expect(allIndex.allTokens.get("todos")).toEqual([`"todos"`, `"todos_read_model"`]);
    expect(allIndex.allTokens.get("events")).toEqual([`"appserver"."events"`]);
    expect(allIndex.allTokens.get("archive")).toEqual([`"archive"`]);
    // The lazy-only maps stay a strict subset — only the lazy key, unchanged semantics.
    expect([...allIndex.lazyKeys].sort()).toEqual(["archive"]);
    expect(allIndex.lazyTokens.get("todos")).toBeUndefined();
    expect(allIndex.lazyTokens.get("events")).toBeUndefined();
  });

  it("resolves an EAGER relation the compiled SQL reads by table / view / schema-qualified token", () => {
    expect(syncedKeys(qb().select().from(todosView).toSQL().sql)).toEqual(["todos"]);
    expect(syncedKeys(qb().select().from(eventsTable).toSQL().sql)).toEqual(["events"]);
    // A read that touches an eager and a lazy relation resolves each — hydration must gate on both groups.
    const joined = qb()
      .select()
      .from(todosView)
      .leftJoin(archiveTable, sql`true`)
      .toSQL().sql;
    expect(syncedKeys(joined)).toEqual(["archive", "todos"]);
    // Lazy-only scan over the same SQL still sees ONLY the lazy relation (activation stays lazy-only).
    expect(lazyKeysOf(joined)).toEqual(["archive"]);
  });

  it("applies the same exact-token and alias-exclusion rules to eager relations", () => {
    expect(syncedKeys(`select * from "todos_read_model"`)).toEqual(["todos"]);
    expect(syncedKeys(`select * from "events"`)).toEqual([]); // bare != schema-qualified
    const aliased = qb()
      .select({ events: sql`1`.as("events") })
      .from(todosView)
      .toSQL().sql;
    expect(syncedKeys(aliased)).toEqual(["todos"]); // the `as "events"` alias is not a read
  });
});

describe("the activation backstop (ADR-0021)", () => {
  it("throws a LazyRelationNotActivatedError when a referenced lazy relation is not active", () => {
    const sqlText = qb().select().from(todosView).toSQL().sql;
    const inactive = { sql: sqlText, index, isActive: () => false };
    expect(() => assertLazyRefsActivated(inactive)).toThrow(LazyRelationNotActivatedError);
    try {
      assertLazyRefsActivated(inactive);
    } catch (error) {
      expect((error as LazyRelationNotActivatedError).relations).toEqual(["todos"]);
    }
  });

  it("does not throw once the referenced relation is active, or when no lazy relation is read", () => {
    const lazySql = qb().select().from(todosView).toSQL().sql;
    expect(() => assertLazyRefsActivated({ sql: lazySql, index, isActive: () => true })).not.toThrow();
    expect(() => assertLazyRefsActivated({ sql: `select 1`, index, isActive: () => false })).not.toThrow();
  });
});
