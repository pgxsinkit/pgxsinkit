import { describe, expect, it } from "bun:test";

import { sql } from "drizzle-orm";
import { QueryBuilder, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { authorsSyncEntry, authorsView, todosSyncEntry, todosView } from "@pgxsinkit/schema";

import {
  assertLazyRefsActivated,
  buildLazyGuardIndex,
  createRecordingClient,
  detectKeysFromBuilder,
  findReferencedLazyKeysInSql,
  LazyRelationNotActivatedError,
} from "../../packages/client/src/lazy-guard";

// A registry exercising every read shape (ADR-0021):
//  - authors  → readwrite, EAGER, read via the `authors_read_model` view
//  - todos    → readwrite, LAZY,  read via the `todos_read_model` view
//  - archive  → readonly,  LAZY,  read via the directly-imported synced `archive` table (no view)
const archiveEntry = defineSyncTable({
  tableName: "archive",
  makeColumns: () => ({ id: uuid("id").primaryKey(), label: varchar("label", { length: 80 }) }),
  mode: "readonly",
  subscription: "lazy",
});
const archiveTable = archiveEntry.table;

const registry = defineSyncRegistry({
  authors: authorsSyncEntry,
  todos: { ...todosSyncEntry, subscription: "lazy" },
  archive: archiveEntry,
});

const index = buildLazyGuardIndex(registry);
const qb = () => new QueryBuilder();

describe("lazy-guard index (ADR-0021)", () => {
  it("indexes only the lazy keys, mapping both table and read-model view names back to the key", () => {
    expect([...index.lazyKeys].sort()).toEqual(["archive", "todos"]);
    // eager authors is mapped (so (C) can resolve it) but is not lazy.
    expect(index.nameToKey.get("authors_read_model")).toBe("authors");
    expect(index.nameToKey.get("authors")).toBe("authors");
    // a lazy readwrite table is reachable by both its view and its base table name.
    expect(index.nameToKey.get("todos_read_model")).toBe("todos");
    expect(index.nameToKey.get("todos")).toBe("todos");
    // a lazy readonly table has no view — only the base table name.
    expect(index.nameToKey.get("archive")).toBe("archive");
    expect(index.lazyNames.get("todos")).toEqual(["todos", "todos_read_model"]);
    expect(index.lazyNames.get("archive")).toEqual(["archive"]);
  });
});

describe("(C) structural detection from a Drizzle builder (ADR-0021)", () => {
  it("detects FROM and JOIN relations, resolving views and tables to registry keys", () => {
    expect([...detectKeysFromBuilder(qb().select().from(todosView), index)]).toEqual(["todos"]);

    const joined = qb()
      .select()
      .from(todosView)
      .leftJoin(authorsView, sql`true`);
    expect([...detectKeysFromBuilder(joined, index)].sort()).toEqual(["authors", "todos"]);

    // a directly-imported synced table (the readonly read path) is detected in FROM position.
    expect([...detectKeysFromBuilder(qb().select().from(archiveTable), index)]).toEqual(["archive"]);
  });

  it("is BLIND to a relation referenced only inside a subquery/WHERE (the gap the tripwire covers)", () => {
    const withSubquery = qb()
      .select()
      .from(todosView)
      .where(sql`id in (select id from ${archiveTable})`);
    // structurally only `todos` (the FROM) is seen — `archive` hides in the subquery.
    expect([...detectKeysFromBuilder(withSubquery, index)]).toEqual(["todos"]);
  });

  it("never throws on an unrecognised or malformed builder shape (internal-shape resilience)", () => {
    expect([...detectKeysFromBuilder(null, index)]).toEqual([]);
    expect([...detectKeysFromBuilder(undefined, index)]).toEqual([]);
    expect([...detectKeysFromBuilder({}, index)]).toEqual([]);
    expect([...detectKeysFromBuilder({ config: null }, index)]).toEqual([]);
    expect([...detectKeysFromBuilder({ config: { table: { not: "a relation" } } }, index)]).toEqual([]);
  });
});

describe("(A) build-time detection via the recording client (ADR-0021)", () => {
  it("records every registry key reached through the client's views/tables accessors", () => {
    const fakeClient = {
      views: { todos: todosView, authors: authorsView },
      tables: { todos: {}, authors: {}, archive: {} },
      drizzle: {},
    };
    const { client, accessed } = createRecordingClient(fakeClient);

    // simulate a build callback reaching relations through the client (any position).
    void client.views.todos;
    void client.tables.archive;

    expect([...accessed].sort()).toEqual(["archive", "todos"]);
  });

  it("ignores inherited / non-relation property reads", () => {
    const { client, accessed } = createRecordingClient({ views: { todos: todosView }, tables: {} });
    void (client.views as Record<string, unknown>)["toString"];
    void (client.views as Record<string, unknown>)["nope"];
    expect([...accessed]).toEqual([]);
  });
});

describe("the SQL tripwire (ADR-0021)", () => {
  it("finds lazy relations by their physical name in compiled SQL, including subquery references", () => {
    const sqlText = qb()
      .select()
      .from(todosView)
      .where(sql`id in (select id from ${archiveTable})`)
      .toSQL().sql;
    // both the lazy FROM view (todos_read_model) and the lazy subquery table (archive) are caught.
    expect([...findReferencedLazyKeysInSql(sqlText, index)].sort()).toEqual(["archive", "todos"]);
  });

  it("ignores eager relations and matches whole identifiers only", () => {
    expect([...findReferencedLazyKeysInSql(`select * from "authors_read_model"`, index)]).toEqual([]);
    // `archived_at` must not match the lazy `archive` table.
    expect([...findReferencedLazyKeysInSql(`select archived_at from "authors_read_model"`, index)]).toEqual([]);
  });

  it("throws a LazyRelationNotActivatedError when a referenced lazy relation is not active", () => {
    const sqlText = qb().select().from(todosView).toSQL().sql;
    const inactive = { sql: sqlText, index, isActive: () => false };
    expect(() => assertLazyRefsActivated(inactive)).toThrow(LazyRelationNotActivatedError);
    try {
      assertLazyRefsActivated(inactive);
    } catch (error) {
      expect(error).toBeInstanceOf(LazyRelationNotActivatedError);
      expect((error as LazyRelationNotActivatedError).relations).toEqual(["todos"]);
    }
  });

  it("does not throw once the referenced lazy relation is active, or when only eager relations are read", () => {
    const lazySql = qb().select().from(todosView).toSQL().sql;
    expect(() => assertLazyRefsActivated({ sql: lazySql, index, isActive: () => true })).not.toThrow();

    const eagerSql = qb().select().from(authorsView).toSQL().sql;
    expect(() => assertLazyRefsActivated({ sql: eagerSql, index, isActive: () => false })).not.toThrow();
  });
});
