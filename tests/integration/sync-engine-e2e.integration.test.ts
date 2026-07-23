/**
 * End-to-end behavioural test of the sync engine (`client/src/sync`) against real Electric+Postgres.
 *
 * Started life as a copy of @electric-sql/pglite-sync (Apache-2.0, © ElectricSQL — see NOTICE).
 * Fully internalized (ADR-0009); upstream compatibility is an explicit anti-goal (ADR-0028) — this is
 * an OWNED test of our engine, held to repo standards (typecheck + lint clean, the raw-SQL→Drizzle
 * tier hierarchy). Server-side Postgres writes drive Electric replication into PGlite, where Drizzle
 * reads assert convergence. The server handle is a Drizzle-over-Bun.SQL database pinned to a single
 * physical connection (`max: 1`) so the transaction tests run on one connection instead of tripping
 * Bun.SQL's pooled-transaction guard. Runs on the repo's Podman Electric+Postgres lane
 * (DATABASE_URL/ELECTRIC_URL are set by scripts/run-integration-suite.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { and, between, count, eq, gt, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import {
  boolean,
  doublePrecision,
  integer,
  json,
  jsonb,
  numeric,
  pgEnum,
  pgSchema,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { createSyncEngine, type InitialInsertMethod } from "../../packages/client/src/sync/index";
import { informationSchemaSchemata, informationSchemaTables } from "../support/catalog-tables";
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";

// Create a PGlite and attach the pgxsinkit sync engine as its `.electric` namespace (ADR-0032 S1): the
// engine is a plain module over an already-created instance, not a create-time extension — so the store
// is created first, then the engine attached explicitly (as `createSyncClient` does in production). This
// is the setup-only replacement for `PGlite.create({ extensions: { electric: electricSync(...) } })`.
type SyncEnginePGlite = PGlite & { electric: Awaited<ReturnType<typeof createSyncEngine>>["namespace"] };
async function createSyncEnginePGlite(
  createOptions?: PGliteOptions,
  engineOptions?: Parameters<typeof createSyncEngine>[1],
): Promise<SyncEnginePGlite> {
  const pg = await PGlite.create(createOptions);
  const engine = await createSyncEngine(pg, engineOptions);
  (pg as unknown as { electric: SyncEnginePGlite["electric"] }).electric = engine.namespace;
  return pg as unknown as SyncEnginePGlite;
}

// Fixture Drizzle schema — defined ONCE and serving BOTH sides: server-side Postgres provisioning +
// writes AND PGlite mirror provisioning + assertion reads. Column types reproduce the original DDL
// exactly (serial PKs, text/int/bool, TIMESTAMP without tz, NUMERIC(10,2), FLOAT/double, JSONB vs
// JSON, INTEGER[], and the data_types enum). TS property keys deliberately match the wire-shaped
// (snake_case) keys the assertions compare against — Drizzle `select()` returns the property names.
// Each fixture is defined via the production registry-definition API (ADR-0029 D1): the engine resolves
// each shape's apply target from `(registry, tableKey)`, and the entries' local tables serve both the
// (server + PGlite) provisioning and the assertion reads. Column shapes reproduce the original DDL
// exactly (serial PKs, TIMESTAMP without tz, NUMERIC(10,2), FLOAT/double, JSONB vs JSON, INTEGER[], enum).
const dataTypesEnum = pgEnum("data_types_enum", ["one", "two", "three"]);

const todoEntry = defineSyncTable({
  tableName: "todo",
  makeColumns: () => ({ id: integer("id").primaryKey(), task: text("task"), done: boolean("done") }),
});
const projectEntry = defineSyncTable({
  tableName: "project",
  makeColumns: () => ({ id: integer("id").primaryKey(), name: text("name"), active: boolean("active") }),
});
const altTodoEntry = defineSyncTable({
  tableName: "alt_todo",
  makeColumns: () => ({ id: integer("id").primaryKey(), task: text("task"), done: boolean("done") }),
});
const testSyncingEntry = defineSyncTable({
  tableName: "test_syncing",
  makeColumns: () => ({ id: text("id").primaryKey(), value: text("value"), is_syncing: boolean("is_syncing") }),
});
const todoAltEntry = defineSyncTable({
  tableName: "todo_alt",
  makeColumns: () => ({ id: integer("id").primaryKey(), task: text("task"), done: boolean("done") }),
});
const largeTableEntry = defineSyncTable({
  tableName: "large_table",
  makeColumns: () => ({
    id: integer("id").primaryKey(),
    col1: text("col1"),
    col2: integer("col2"),
    col3: boolean("col3"),
    col4: timestamp("col4"),
    col5: numeric("col5", { precision: 10, scale: 2 }),
    col6: text("col6"),
    col7: integer("col7"),
    col8: boolean("col8"),
    col9: text("col9"),
  }),
});
const largeOpsTableEntry = defineSyncTable({
  tableName: "large_ops_table",
  makeColumns: () => ({
    id: integer("id").primaryKey(),
    value: text("value"),
    number: integer("number"),
    flag: boolean("flag"),
  }),
});
const dataTypesTableEntry = defineSyncTable({
  tableName: "data_types_table",
  makeColumns: () => ({
    id: integer("id").primaryKey(),
    int_col: integer("int_col"),
    float_col: doublePrecision("float_col"),
    boolean_col: boolean("boolean_col"),
    string_col: text("string_col"),
    json_col: jsonb("json_col").$type<unknown>(),
    json_plain_col: json("json_plain_col").$type<unknown>(),
    int_array_col: integer("int_array_col").array(),
    enum_col: dataTypesEnum("enum_col"),
  }),
});

const registry = defineSyncRegistry({
  todo: todoEntry,
  project: projectEntry,
  alt_todo: altTodoEntry,
  test_syncing: testSyncingEntry,
  todo_alt: todoAltEntry,
  large_table: largeTableEntry,
  large_ops_table: largeOpsTableEntry,
  data_types_table: dataTypesTableEntry,
});

const todo = todoEntry.localTable;
const project = projectEntry.localTable;
const altTodo = altTodoEntry.localTable;
const testSyncing = testSyncingEntry.localTable;
const todoAlt = todoAltEntry.localTable;
const largeTable = largeTableEntry.localTable;
const largeOpsTable = largeOpsTableEntry.localTable;
const dataTypesTable = dataTypesTableEntry.localTable;

// Whole-fixture schema record for `createTablesFromSchema` (offline empty→schema migration → executed
// on both server Postgres and the PGlite mirror). The enum is included so its CREATE TYPE is emitted
// before the table that uses it.
const fixtureSchema = {
  todo,
  project,
  altTodo,
  testSyncing,
  todoAlt,
  largeTable,
  largeOpsTable,
  dataTypesEnum,
  dataTypesTable,
};

// Tier ③ (permanent, allow-listed): PL/pgSQL function body + trigger, and its `current_setting` probe.
// Installed verbatim on BOTH the server Postgres and the PGlite mirror.
const CHECK_SYNCING_FUNCTION = `
  CREATE OR REPLACE FUNCTION check_syncing()
  RETURNS TRIGGER AS $$
  DECLARE
    is_syncing BOOLEAN;
  BEGIN
    is_syncing := COALESCE(current_setting('pgxsinkit.syncing', true)::boolean, false);
    IF is_syncing THEN
      NEW.is_syncing := TRUE;
    ELSE
      NEW.is_syncing := FALSE;
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
`;
const DROP_SYNCING_TRIGGER = `DROP TRIGGER IF EXISTS test_syncing_trigger ON test_syncing;`;
const CREATE_SYNCING_TRIGGER = `
  CREATE TRIGGER test_syncing_trigger
  BEFORE INSERT ON test_syncing
  FOR EACH ROW EXECUTE FUNCTION check_syncing();
`;

/** vitest's `vi.waitFor`: retry the callback until it stops throwing (or the timeout elapses). */
async function waitFor<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const timeout = options.timeout ?? 10_000;
  const interval = options.interval ?? 100;
  const start = Date.now();
  let lastError: unknown;
  for (;;) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - start > timeout) {
      throw lastError ?? new Error("waitFor: timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

const DATABASE_URL =
  process.env["DATABASE_URL"] || "postgresql://postgres:password@localhost:54321/electric?sslmode=disable";
const ELECTRIC_URL = process.env["ELECTRIC_URL"] || "http://localhost:3000/v1/shape";

/** Drizzle-over-Bun.SQL server handle, pinned to one physical connection for the transaction tests. */
function createServerDb() {
  return drizzle({ connection: { url: DATABASE_URL, max: 1 } });
}

const shapeHandles: Map<string, string> = new Map();

const DEBUG = false;
const LOG_FETCH = DEBUG;

let fetchCount = 0;

// Electric's `fetchClient` option is typed `typeof fetch`, which now carries a `preconnect` member a
// plain wrapping function can't supply (a Bun/undici extension). The single-expression cast scopes the
// gap to the declaration; the value is a faithful `fetch` proxy for every call the suite makes.
const fetchClient = (async (url: string | Request | URL, options: RequestInit = {}): Promise<Response> => {
  const thisFetchCount = fetchCount++;
  if (LOG_FETCH) {
    console.log(">> fetch", thisFetchCount, url, options);
  }
  let table: string | null = null;
  if (typeof url === "string") {
    table = new URL(url).searchParams.get("table");
  } else if (url instanceof Request) {
    table = new URL(url.url).searchParams.get("table");
  } else if (url instanceof URL) {
    table = url.searchParams.get("table");
  }
  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (e) {
    if (LOG_FETCH) {
      console.log(">> fetch error", thisFetchCount, e);
    }
    throw e;
  }
  if (table) {
    shapeHandles.set(res.headers.get("electric-handle")!, table);
  }
  if (LOG_FETCH) {
    console.log(">> fetch res", thisFetchCount, res.status, res.statusText, res.headers);
  }
  return res;
}) as typeof fetch;

const deleteShape = async (table: string, handle: string) => {
  const deleteUrl = new URL(ELECTRIC_URL);
  deleteUrl.searchParams.set("table", table);
  deleteUrl.searchParams.set("handle", handle);
  const res = await fetch(deleteUrl, {
    method: "DELETE",
  });
  if (res.status === 404 || res.status === 400) {
    // Nothing (meaningful) to delete. Upstream only saw 404; Electric 1.7.3 (our pinned image)
    // answers 400 for a stale/superseded handle (e.g. after a must-refetch), which is still a
    // best-effort cleanup no-op — the shape behaviour under test already asserted in the body.
    return;
  }
  if (!res.ok) {
    throw new Error(`Error deleting shape: ${res.statusText}`);
  }
};

const deleteAllShapes = async () => {
  for (const [handle, table] of shapeHandles.entries()) {
    await deleteShape(table, handle);
  }
  shapeHandles.clear();
};

const deleteAllShapesForTable = async (targetTable: string) => {
  for (const [handle, table] of shapeHandles.entries()) {
    if (table === targetTable) {
      await deleteShape(table, handle);
    }
  }
};

describe("sync-e2e", () => {
  let serverDb!: ReturnType<typeof createServerDb>;
  let pg: SyncEnginePGlite;

  // Tier ②: TRUNCATE has no Drizzle query builder; a typed `sql` template interpolating the table
  // objects (`${table}`) is the ceiling. Kept over DELETE because truncate speed matters at 300k rows.
  const truncateAllFixtures = () =>
    serverDb.execute(
      sql`TRUNCATE ${todo}, ${project}, ${altTodo}, ${testSyncing}, ${todoAlt}, ${largeTable}, ${largeOpsTable}, ${dataTypesTable}`,
    );

  // Setup PostgreSQL client and tables
  beforeAll(async () => {
    // Connect to PostgreSQL (Drizzle over Bun.SQL, single physical connection)
    serverDb = createServerDb();

    // Create the fixture tables + enum. The container database is fresh per run (scripts/
    // run-integration-suite.ts launches and tears down isolated containers each invocation), so plain
    // creates are safe — mirroring the original CREATE TABLE IF NOT EXISTS / bare CREATE TYPE lifecycle.
    await createTablesFromSchema(serverDb, fixtureSchema);

    // Tier ③: the check_syncing PL/pgSQL function + trigger (the sync-origin flag probe under test).
    await serverDb.execute(sql.raw(CHECK_SYNCING_FUNCTION));
    await serverDb.execute(sql.raw(DROP_SYNCING_TRIGGER));
    await serverDb.execute(sql.raw(CREATE_SYNCING_TRIGGER));

    // Clean up any existing data
    await truncateAllFixtures();
  });

  afterAll(async () => {
    // Truncate all tables
    await truncateAllFixtures();

    await serverDb.$client.close();
    await deleteAllShapes();
  });

  beforeEach(async () => {
    await truncateAllFixtures();

    // Create PGlite instance with the sync engine attached
    pg = await createSyncEnginePGlite(undefined, { debug: DEBUG });

    // Create the same fixture tables + enum in PGlite.
    await createTablesFromSchema(pg, fixtureSchema);

    // Tier ③: install the check_syncing PL/pgSQL function + trigger on the mirror (raw PGlite handle).
    await pg.exec(CHECK_SYNCING_FUNCTION);
    await pg.exec(CREATE_SYNCING_TRIGGER);
  });

  afterEach(async () => {
    try {
      await pg.close();
    } catch {
      // ignore as we may have already closed it in the test
    }
    await deleteAllShapes();

    // Truncate all tables
    await truncateAllFixtures();
  });

  it("handles inserts/updates/deletes", async () => {
    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      shapeKey: null,
    });

    const db = drizzleOver(pg);

    // Insert data into PostgreSQL
    await serverDb.insert(todo).values({ id: 1, task: "task1", done: false });

    // Wait for sync to complete
    await waitFor(
      async () => {
        const rows = await db.select().from(todo);
        expect(rows).toEqual([
          {
            id: 1,
            task: "task1",
            done: false,
          },
        ]);
      },
      { timeout: 10000 },
    );

    // Update data in PostgreSQL
    await serverDb.update(todo).set({ task: "task2", done: true }).where(eq(todo.id, 1));

    // Wait for sync to complete
    await waitFor(
      async () => {
        const rows = await db.select().from(todo);
        expect(rows).toEqual([
          {
            id: 1,
            task: "task2",
            done: true,
          },
        ]);
      },
      { timeout: 5000 },
    );

    // Delete data in PostgreSQL
    await serverDb.delete(todo).where(eq(todo.id, 1));

    // Wait for sync to complete
    await waitFor(
      async () => {
        const rows = await db.select().from(todo);
        expect(rows).toEqual([]);
      },
      { timeout: 5000 },
    );

    shape.unsubscribe();
  });

  it("performs operations within a transaction", async () => {
    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
      },
      registry,
      tableKey: "todo",
      shapeKey: null,
    });

    const db = drizzleOver(pg);

    // Insert a large batch of records to test transaction behavior
    const numInserts = 1000; // Reduced from 10000 in the mock test for practical e2e testing
    const numBatches = 5;
    const batchSize = Math.floor(numInserts / numBatches);

    for (let i = 0; i < numBatches; i++) {
      const values = Array.from({ length: batchSize }, (_, idx) => {
        const itemIdx = i * batchSize + idx;
        return { id: itemIdx, task: `task${itemIdx}`, done: false };
      });

      await serverDb.insert(todo).values(values);
    }

    // Wait for all inserts to be synced
    await waitFor(
      async () => {
        const result = await db.select({ count: count() }).from(todo);
        expect(result[0]!.count).toBe(numInserts);
      },
      { timeout: 10000 }, // Increase timeout for larger batch
    );

    // Verify some sample data
    const firstItem = await db.select().from(todo).where(eq(todo.id, 0));
    expect(firstItem[0]).toEqual({
      id: 0,
      task: "task0",
      done: false,
    });

    const lastItem = await db
      .select()
      .from(todo)
      .where(eq(todo.id, numInserts - 1));
    expect(lastItem[0]).toEqual({
      id: numInserts - 1,
      task: `task${numInserts - 1}`,
      done: false,
    });

    shape.unsubscribe();
  });

  it("syncs multiple shapes to multiple tables simultaneously", async () => {
    const db = drizzleOver(pg);

    // Clean up any existing data in the project table (tier ②: TRUNCATE on a table object).
    await serverDb.execute(sql`TRUNCATE ${project}`);
    await db.execute(sql`TRUNCATE ${project}`);

    // Set up sync for both tables
    const todoShape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
      },
      registry,
      tableKey: "todo",
      shapeKey: null,
    });

    const projectShape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "project" },
      },
      registry,
      tableKey: "project",
      shapeKey: null,
    });

    // Insert data into both tables in PostgreSQL
    await serverDb.insert(todo).values([
      { id: 1, task: "task1", done: false },
      { id: 2, task: "task2", done: true },
    ]);

    await serverDb.insert(project).values([
      { id: 1, name: "Project 1", active: true },
      { id: 2, name: "Project 2", active: false },
    ]);

    // Wait for todo table sync to complete
    await waitFor(async () => {
      const result = await db.select({ count: count() }).from(todo);
      expect(result[0]!.count).toBe(2);
    });

    // Wait for project table sync to complete
    await waitFor(async () => {
      const result = await db.select({ count: count() }).from(project);
      expect(result[0]!.count).toBe(2);
    });

    // Verify data was inserted into both tables
    const todoResult = await db.select().from(todo).orderBy(todo.id);
    expect(todoResult).toEqual([
      { id: 1, task: "task1", done: false },
      { id: 2, task: "task2", done: true },
    ]);

    const projectResult = await db.select().from(project).orderBy(project.id);
    expect(projectResult).toEqual([
      { id: 1, name: "Project 1", active: true },
      { id: 2, name: "Project 2", active: false },
    ]);

    // Clean up
    todoShape.unsubscribe();
    projectShape.unsubscribe();
  });

  it("handles an update message with no columns to update", async () => {
    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      shapeKey: null,
    });

    const db = drizzleOver(pg);

    // Insert data into PostgreSQL
    await serverDb.insert(todo).values({ id: 1, task: "task1", done: false });

    // Wait for sync to complete
    await waitFor(async () => {
      const rows = await db.select().from(todo);
      expect(rows).toEqual([
        {
          id: 1,
          task: "task1",
          done: false,
        },
      ]);
    });

    // Update data in PostgreSQL with only the primary key (no other columns)
    await serverDb.update(todo).set({ id: 1 }).where(eq(todo.id, 1));

    // Wait a moment to ensure sync has time to process
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify data remains unchanged
    const rows = await db.select().from(todo);
    expect(rows).toEqual([
      {
        id: 1,
        task: "task1",
        done: false,
      },
    ]);

    shape.unsubscribe();
  });

  it("sets the syncing flag to true when syncing begins", async () => {
    const db = drizzleOver(pg);

    // Tier ③: `current_setting` probe (allow-listed) — via the raw PGlite handle.
    // Check the flag is not set outside of a sync
    const result0 = await pg.sql`SELECT current_setting('pgxsinkit.syncing', true)`;
    expect(result0.rows[0]).toEqual({ current_setting: null }); // not set yet as syncShapeToTable hasn't been called

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "test_syncing" },
        fetchClient,
      },
      registry,
      tableKey: "test_syncing",
      shapeKey: null,
    });

    // Insert data into PostgreSQL
    await serverDb.insert(testSyncing).values({ id: "id1", value: "test value" });

    // Wait for sync to complete
    await waitFor(async () => {
      const rows = await db.select().from(testSyncing).where(eq(testSyncing.id, "id1"));
      expect(rows).toHaveLength(1);
    });

    // Check the syncing flag was set during sync
    const rows = await db.select().from(testSyncing).where(eq(testSyncing.id, "id1"));
    expect(rows[0]).toEqual({
      id: "id1",
      value: "test value",
      is_syncing: true,
    });

    // Tier ③: `current_setting` probe (allow-listed). Check the flag is not set outside of a sync
    const result2 = await pg.sql`SELECT current_setting('pgxsinkit.syncing', true)`;
    expect(result2.rows[0]).toEqual({ current_setting: "false" });

    // Clean up
    shape.unsubscribe();
  });

  it("forbids multiple subscriptions to the same table", async () => {
    const table = "todo";
    const altTable = "alt_todo";

    // First subscription
    const shape1 = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table },
        fetchClient,
      },
      registry,
      tableKey: table,
      shapeKey: null,
    });

    // Should throw if syncing more shapes into same table. (Asserted via try/catch rather than
    // `.rejects.toThrow(msg)` so the rejection is plainly typed through the dynamically-imported
    // engine namespace — the matcher chain isn't seen as thenable by the type-lint.)
    const conflictingSync: Promise<unknown> = pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo_alt" },
        fetchClient,
      },
      registry,
      tableKey: table,
      shapeKey: null,
    });
    let conflictError: Error | undefined;
    try {
      await conflictingSync;
    } catch (error) {
      conflictError = error as Error;
    }
    expect(conflictError?.message).toBe(`Already syncing shape for table ${table}`);

    // Should be able to sync shape into other table
    const altShape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: altTable },
        fetchClient,
      },
      registry,
      tableKey: altTable,
      shapeKey: null,
    });

    // Clean up first subscription
    shape1.unsubscribe();

    // Should be able to sync different shape if previous is unsubscribed
    const shape2 = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo_alt" },
        fetchClient,
      },
      registry,
      tableKey: table,
      shapeKey: null,
    });

    // Clean up
    altShape.unsubscribe();
    shape2.unsubscribe();
  });

  it("uses COPY FROM for initial batch of inserts", async () => {
    const db = drizzleOver(pg);

    // Insert a large batch of records to test COPY FROM behavior
    const numInserts = 1000;
    const rows = Array.from({ length: numInserts }, (_, idx) => ({
      id: idx,
      task: `task${idx}`,
      done: idx % 2 === 0,
    }));
    await serverDb.insert(todo).values(rows);

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      initialInsertMethod: "copy",
      shapeKey: null,
    });

    // Wait for all inserts to be synced
    await waitFor(
      async () => {
        const result = await db.select({ count: count() }).from(todo);
        expect(result[0]!.count).toBe(numInserts);
      },
      { timeout: 20000 }, // Increase timeout for larger batch
    );

    // Verify some sample data
    const sampleResult = await db.select().from(todo).orderBy(todo.id).limit(5);
    expect(sampleResult).toEqual([
      { id: 0, task: "task0", done: true },
      { id: 1, task: "task1", done: false },
      { id: 2, task: "task2", done: true },
      { id: 3, task: "task3", done: false },
      { id: 4, task: "task4", done: true },
    ]);

    // Update one record to verify updates still work after COPY
    await serverDb.update(todo).set({ task: "updated task" }).where(eq(todo.id, 0));

    // Wait for update to sync
    await waitFor(
      async () => {
        const rows = await db.select().from(todo).where(eq(todo.id, 0));
        expect(rows[0]).toEqual({
          id: 0,
          task: "updated task",
          done: true,
        });
      },
      { timeout: 5000 },
    );

    shape.unsubscribe();
  });

  it("handles special characters in COPY FROM data", async () => {
    const db = drizzleOver(pg);

    // Insert records with special characters
    await serverDb.insert(todo).values([
      { id: 1, task: "task with, comma", done: false },
      { id: 2, task: 'task with "quotes"', done: true },
      { id: 3, task: "task with\nnewline", done: false },
    ]);

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      initialInsertMethod: "copy",
      shapeKey: null,
    });

    // Wait for inserts to complete
    await waitFor(
      async () => {
        const result = await db.select({ count: count() }).from(todo);
        expect(result[0]!.count).toBe(3);
      },
      { timeout: 5000 },
    );

    // Verify the data was inserted correctly with special characters preserved
    const result = await db.select().from(todo).orderBy(todo.id);
    expect(result).toEqual([
      { id: 1, task: "task with, comma", done: false },
      { id: 2, task: 'task with "quotes"', done: true },
      { id: 3, task: "task with\nnewline", done: false },
    ]);

    shape.unsubscribe();
  });

  it("calls onInitialSync callback after initial sync", async () => {
    const db = drizzleOver(pg);

    let callbackCalled = false;
    const onInitialSync = () => {
      callbackCalled = true;
    };

    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      onInitialSync,
      shapeKey: null,
    });

    // Insert some initial data
    await serverDb.insert(todo).values([
      { id: 1, task: "task1", done: false },
      { id: 2, task: "task2", done: true },
    ]);

    // Wait for initial sync to complete
    await waitFor(
      async () => {
        const result = await db.select({ count: count() }).from(todo);
        return result[0]!.count === 2;
      },
      { timeout: 5000 },
    );

    // Verify callback was called
    await waitFor(
      () => {
        expect(callbackCalled).toBe(true);
        return callbackCalled === true;
      },
      { timeout: 5000 },
    );

    // Insert more data - callback should not be called again
    callbackCalled = false;
    await serverDb.insert(todo).values({ id: 3, task: "task3", done: false });

    // Wait for sync to complete
    await waitFor(
      async () => {
        const result = await db.select({ count: count() }).from(todo);
        return result[0]!.count === 3;
      },
      { timeout: 5000 },
    );

    // Verify callback was not called again
    expect(callbackCalled).toBe(false);

    shape.unsubscribe();
  });

  it("uses the specified metadata schema for subscription metadata", async () => {
    // Close the default PGlite instance
    await pg.close();

    // Create a new PGlite instance with a custom metadata schema
    const metadataSchema = "custom_metadata";
    pg = await createSyncEnginePGlite(undefined, { metadataSchema });

    // Initialize metadata tables
    await pg.electric.initMetadataTables();

    const db = drizzleOver(pg);

    // Create the todo table
    await createTablesFromSchema(pg, { todo });

    // Verify the custom schema was created (information_schema stub — house-style catalog read).
    const schemaResult = await db
      .select({ schema_name: informationSchemaSchemata.schemaName })
      .from(informationSchemaSchemata)
      .where(eq(informationSchemaSchemata.schemaName, metadataSchema));
    expect(schemaResult).toHaveLength(1);
    expect(schemaResult[0]).toEqual({ schema_name: metadataSchema });

    // Verify the subscription table exists in the custom schema
    const tableResult = await db
      .select({ table_name: informationSchemaTables.tableName })
      .from(informationSchemaTables)
      .where(
        and(
          eq(informationSchemaTables.tableSchema, metadataSchema),
          eq(informationSchemaTables.tableName, "subscriptions_metadata"),
        ),
      );
    expect(tableResult).toHaveLength(1);
    expect(tableResult[0]).toEqual({
      table_name: "subscriptions_metadata",
    });

    // Test that we can create a subscription with the custom schema
    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      shapeKey: "custom_schema_test",
    });

    // We don't persist any metadata until some data has been synced
    await serverDb.insert(todo).values({ id: 1, task: "task1", done: false });
    await waitFor(
      async () => {
        const result = await db.select({ count: count() }).from(todo);
        expect(result[0]!.count).toBe(1);
      },
      { timeout: 5000 },
    );

    // Check the data was inserted into the todo table
    const todoResult = await db.select().from(todo).where(eq(todo.id, 1));
    expect(todoResult[0]).toEqual({
      id: 1,
      task: "task1",
      done: false,
    });

    // Verify the subscription was stored in the custom schema. The metadata schema name is a runtime
    // value, so the relation is built at runtime with `pgSchema(...).table(...)` — a tier-① read over
    // real column/table objects (no raw string needed for the dynamic schema name).
    const subscriptionsMetadata = pgSchema(metadataSchema).table("subscriptions_metadata", {
      key: text("key"),
    });
    const subscriptionResult = await db
      .select({ key: subscriptionsMetadata.key })
      .from(subscriptionsMetadata)
      .where(eq(subscriptionsMetadata.key, "custom_schema_test"));
    expect(subscriptionResult).toHaveLength(1);

    // Clean up
    shape.unsubscribe();
    await pg.electric.deleteSubscription("custom_schema_test");
  });

  it("handles transactions across multiple tables with syncShapesToTables", async () => {
    const db = drizzleOver(pg);

    // Clean up any existing data in the project table (tier ②: TRUNCATE on a table object).
    await serverDb.execute(sql`TRUNCATE ${project}`);
    await db.execute(sql`TRUNCATE ${project}`);

    // Set up sync for both tables using syncShapesToTables
    const syncResult = await pg.electric.syncShapesToTables({
      registry,
      key: "transaction_test",
      shapes: {
        todo_shape: {
          shape: {
            url: ELECTRIC_URL,
            params: { table: "todo" },
            fetchClient,
          },
          tableKey: "todo",
        },
        project_shape: {
          shape: {
            url: ELECTRIC_URL,
            params: { table: "project" },
            fetchClient,
          },
          tableKey: "project",
        },
      },
    });

    // Insert initial data in a transaction (one server transaction → one LSN)
    await serverDb.transaction(async (tx) => {
      await tx.insert(todo).values({ id: 1, task: "Initial task", done: false });
      await tx.insert(project).values({ id: 1, name: "Initial project", active: true });
    });

    // Wait for both inserts to be synced
    await waitFor(
      async () => {
        const todoCount = await db.select({ count: count() }).from(todo);
        const projectCount = await db.select({ count: count() }).from(project);
        expect(todoCount[0]!.count).toBe(1);
        expect(projectCount[0]!.count).toBe(1);
      },
      { timeout: 5000 },
    );

    // Verify initial data was inserted
    const todoResult = await db.select().from(todo).where(eq(todo.id, 1));
    expect(todoResult[0]).toEqual({
      id: 1,
      task: "Initial task",
      done: false,
    });

    const projectResult = await db.select().from(project).where(eq(project.id, 1));
    expect(projectResult[0]).toEqual({
      id: 1,
      name: "Initial project",
      active: true,
    });

    // Update both tables in a transaction
    await serverDb.transaction(async (tx) => {
      await tx.update(todo).set({ task: "Updated in transaction", done: true }).where(eq(todo.id, 1));
      await tx.update(project).set({ name: "Updated in transaction", active: false }).where(eq(project.id, 1));
    });

    // Wait for both updates to be synced
    await waitFor(
      async () => {
        const todoRows = await db.select().from(todo).where(eq(todo.id, 1));
        const projectRows = await db.select().from(project).where(eq(project.id, 1));
        expect(todoRows[0]!.task).toBe("Updated in transaction");
        expect(projectRows[0]!.name).toBe("Updated in transaction");
      },
      { timeout: 5000 },
    );

    // Verify both updates were applied
    const updatedTodoResult = await db.select().from(todo).where(eq(todo.id, 1));
    expect(updatedTodoResult[0]).toEqual({
      id: 1,
      task: "Updated in transaction",
      done: true,
    });

    const updatedProjectResult = await db.select().from(project).where(eq(project.id, 1));
    expect(updatedProjectResult[0]).toEqual({
      id: 1,
      name: "Updated in transaction",
      active: false,
    });

    // Clean up
    syncResult.unsubscribe();
  });

  it("stops sync after unsubscribe", async () => {
    const db = drizzleOver(pg);

    // First sync session with a persistent key
    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      shapeKey: "refetch_test",
    });

    // Insert initial batch of data
    await serverDb.insert(todo).values({ id: 1, task: "Initial task", done: false });

    // Wait 3 seconds to make sure the data is synced
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Wait for initial sync to complete
    await waitFor(async () => {
      const result = await db.select({ count: count() }).from(todo);
      expect(result[0]!.count).toBe(1);
    });

    // Check the data was inserted into the todo table
    const todoResult = await db.select().from(todo).where(eq(todo.id, 1));
    expect(todoResult[0]).toEqual({
      id: 1,
      task: "Initial task",
      done: false,
    });

    // Unsubscribe from first sync session
    shape.unsubscribe();

    // Insert new data before we resume the sync
    await serverDb.insert(todo).values({ id: 2, task: "New task after refetch", done: true });

    // Wait for sync to complete
    await waitFor(
      async () => {
        const result = await db.select({ count: count() }).from(todo);
        expect(result[0]!.count).not.toBe(2);
      },
      { timeout: 5000 },
    );

    // Verify only the new data is present (old data was cleared)
    const result = await db.select().from(todo).orderBy(todo.id);
    expect(result).toEqual([
      {
        id: 1,
        task: "Initial task",
        done: false,
      },
    ]);

    // Clean up
    shape.unsubscribe();
    await pg.electric.deleteSubscription("refetch_test");
  });

  it("resumes sync after unsubscribe", async () => {
    const db = drizzleOver(pg);

    // First sync session with a persistent key
    let shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      shapeKey: "refetch_test",
    });

    // Insert initial batch of data
    await serverDb.insert(todo).values({ id: 1, task: "Initial task", done: false });

    // Wait for initial sync to complete
    await waitFor(async () => {
      const result = await db.select({ count: count() }).from(todo);
      expect(result[0]!.count).toBe(1);
    });

    // Check the data was inserted into the todo table
    const todoResult = await db.select().from(todo).where(eq(todo.id, 1));
    expect(todoResult[0]).toEqual({
      id: 1,
      task: "Initial task",
      done: false,
    });

    // Unsubscribe from first sync session
    shape.unsubscribe();

    // Insert new data before we resume the sync
    await serverDb.insert(todo).values({ id: 2, task: "New task after refetch", done: true });

    // Start a new sync session with the same key
    shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      shapeKey: "refetch_test",
    });

    // Wait for sync to complete
    await waitFor(
      async () => {
        const result = await db.select({ count: count() }).from(todo);
        expect(result[0]!.count).toBe(2);
      },
      { timeout: 5000 },
    );

    // Verify only the new data is present (old data was cleared)
    const result = await db.select().from(todo).orderBy(todo.id);
    expect(result).toEqual([
      {
        id: 1,
        task: "Initial task",
        done: false,
      },
      {
        id: 2,
        task: "New task after refetch",
        done: true,
      },
    ]);

    // Clean up
    shape.unsubscribe();
    await pg.electric.deleteSubscription("refetch_test");
  });

  it("resumes sync after pglite restart", async () => {
    const db = drizzleOver(pg);

    // First sync session with a persistent key
    let shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      shapeKey: "refetch_test",
    });

    // Insert initial batch of data
    await serverDb.insert(todo).values({ id: 1, task: "Initial task", done: false });

    // Wait for initial sync to complete
    await waitFor(async () => {
      const result = await db.select({ count: count() }).from(todo);
      expect(result[0]!.count).toBe(1);
    });

    // Check the data was inserted into the todo table
    const todoResult = await db.select().from(todo).where(eq(todo.id, 1));
    expect(todoResult[0]).toEqual({
      id: 1,
      task: "Initial task",
      done: false,
    });

    // Unsubscribe from first sync session
    shape.unsubscribe();

    // Dump datadir and restart pglite
    const datadir = await pg.dumpDataDir();
    await pg.close();
    const pg2 = await createSyncEnginePGlite({ loadDataDir: datadir });
    const db2 = drizzleOver(pg2);

    // Insert new data before we resume the sync
    await serverDb.insert(todo).values({ id: 2, task: "New task after refetch", done: true });

    // Start a new sync session with the same key
    shape = await pg2.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      shapeKey: "refetch_test",
    });

    // Wait for sync to complete
    await waitFor(
      async () => {
        const result = await db2.select({ count: count() }).from(todo);
        expect(result[0]!.count).toBe(2);
      },
      { timeout: 5000 },
    );

    // Verify only the new data is present (old data was cleared)
    const result = await db2.select().from(todo).orderBy(todo.id);
    expect(result).toEqual([
      {
        id: 1,
        task: "Initial task",
        done: false,
      },
      {
        id: 2,
        task: "New task after refetch",
        done: true,
      },
    ]);

    // Clean up
    shape.unsubscribe();
  });

  it("clears and restarts persisted shape stream state on refetch", async () => {
    const db = drizzleOver(pg);

    // First sync session with a persistent key
    let shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      shapeKey: "refetch_test",
    });

    // Insert initial batch of data
    await serverDb.insert(todo).values({ id: 1, task: "Initial task", done: false });

    // Wait for initial sync to complete
    await waitFor(async () => {
      const result = await db.select({ count: count() }).from(todo);
      expect(result[0]!.count).toBe(1);
    });

    // Check the data was inserted into the todo table
    const todoResult = await db.select().from(todo).where(eq(todo.id, 1));
    expect(todoResult[0]).toEqual({
      id: 1,
      task: "Initial task",
      done: false,
    });

    // Unsubscribe from first sync session
    shape.unsubscribe();

    // Delete the shape on the server to force a refetch
    await deleteAllShapes();

    // Insert new data before we resume the sync
    await serverDb.insert(todo).values({ id: 2, task: "New task after refetch", done: true });

    // Start a new sync session with the same key
    shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      shapeKey: "refetch_test",
    });

    // Wait for sync to complete
    await waitFor(
      async () => {
        const result = await db.select({ count: count() }).from(todo);
        expect(result[0]!.count).toBe(2);
      },
      { timeout: 5000 },
    );

    // Verify only the new data is present (old data was cleared)
    const result = await db.select().from(todo).orderBy(todo.id);
    expect(result).toEqual([
      {
        id: 1,
        task: "Initial task",
        done: false,
      },
      {
        id: 2,
        task: "New task after refetch",
        done: true,
      },
    ]);

    // Clean up
    shape.unsubscribe();
    await pg.electric.deleteSubscription("refetch_test");
  });

  it("handles must-refetch control message across multiple tables", async () => {
    const db = drizzleOver(pg);

    // Set up sync for both tables using syncShapesToTables
    const syncResult = await pg.electric.syncShapesToTables({
      registry,
      key: "refetch_multi_test",
      shapes: {
        todo_shape: {
          shape: {
            url: ELECTRIC_URL,
            params: { table: "todo" },
            fetchClient,
          },
          tableKey: "todo",
        },
        project_shape: {
          shape: {
            url: ELECTRIC_URL,
            params: { table: "project" },
            fetchClient,
          },
          tableKey: "project",
        },
      },
    });

    // Insert initial data
    await serverDb.insert(todo).values({ id: 1, task: "Initial todo", done: false });
    await serverDb.insert(project).values({ id: 1, name: "Initial project", active: true });

    // Wait for initial sync to complete
    await waitFor(
      async () => {
        const todoCount = await db.select({ count: count() }).from(todo);
        const projectCount = await db.select({ count: count() }).from(project);
        return todoCount[0]!.count === 1 && projectCount[0]!.count === 1;
      },
      { timeout: 5000 },
    );

    // Unsubscribe from sync
    syncResult.unsubscribe();

    // Delete the shapes on the server to force a refetch
    await deleteAllShapesForTable("todo");
    // we don't need to delete the project shape so we can test a must-refetch on
    // just one of the tables

    // Insert new data after refetch
    await serverDb.insert(todo).values({ id: 2, task: "New todo after refetch", done: true });
    await serverDb.insert(project).values({ id: 2, name: "New project after refetch", active: false });

    // Start a new sync session with the same key
    const newSyncResult = await pg.electric.syncShapesToTables({
      registry,
      key: "refetch_multi_test",
      shapes: {
        todo_shape: {
          shape: {
            url: ELECTRIC_URL,
            params: { table: "todo" },
            fetchClient,
          },
          tableKey: "todo",
        },
        project_shape: {
          shape: {
            url: ELECTRIC_URL,
            params: { table: "project" },
            fetchClient,
          },
          tableKey: "project",
        },
      },
    });

    // Wait for sync to complete
    await waitFor(
      async () => {
        const todoCount = await db.select({ count: count() }).from(todo);
        const projectCount = await db.select({ count: count() }).from(project);
        expect(todoCount[0]!.count).toBe(2);
        expect(projectCount[0]!.count).toBe(2);
      },
      { timeout: 5000 },
    );

    // Verify only the new data is present (old data was cleared)
    const todoResult = await db.select().from(todo).orderBy(todo.id);
    expect(todoResult).toEqual([
      {
        id: 1,
        task: "Initial todo",
        done: false,
      },
      {
        id: 2,
        task: "New todo after refetch",
        done: true,
      },
    ]);

    const projectResult = await db.select().from(project).orderBy(project.id);
    expect(projectResult).toEqual([
      {
        id: 1,
        name: "Initial project",
        active: true,
      },
      {
        id: 2,
        name: "New project after refetch",
        active: false,
      },
    ]);

    // Clean up
    newSyncResult.unsubscribe();
    await pg.electric.deleteSubscription("refetch_multi_test");
  });

  it("handles onMustRefetch with local data", async () => {
    const db = drizzleOver(pg);

    // Insert initial data
    await serverDb.insert(todo).values([
      { id: 1, task: "Todo 1", done: false },
      { id: 2, task: "Todo 2", done: false },
      { id: 3, task: "Todo 3", done: false },
      { id: 4, task: "Todo 4", done: false },
      { id: 5, task: "Todo 5", done: false },
      { id: 6, task: "Todo 6", done: false },
      { id: 7, task: "Todo 7", done: false },
      { id: 8, task: "Todo 8", done: false },
      { id: 9, task: "Todo 9", done: false },
      { id: 10, task: "Todo 10", done: false },
    ]);

    // Set up sync for both tables using syncShapesToTables
    const shape1 = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo", where: "id > 5" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      shapeKey: "todo_shape1",
      // Tier ③: the raw PGlite Transaction handle is the public contract under test (until a later
      // slice changes it), so the refetch cleanup runs on it directly.
      onMustRefetch: async (db) => {
        await db.delete(todo).where(gt(todo.id, 5));
      },
    });

    const shape2 = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo", where: "id <= 5" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      shapeKey: "todo_shape2",
      // Tier ③: raw PGlite Transaction handle (public contract under test).
      onMustRefetch: async (db) => {
        await db.delete(todo).where(lte(todo.id, 5));
      },
    });

    // Wait for initial sync to complete
    await waitFor(
      async () => {
        const todoCount = await db.select({ count: count() }).from(todo);
        expect(todoCount[0]!.count).toBe(10);
      },
      { timeout: 5000 },
    );

    // Insert some local data (a LOCAL PGlite write, tier ①)
    await db.insert(todo).values([
      { id: 11, task: "Todo 11", done: false },
      { id: 12, task: "Todo 12", done: false },
      { id: 13, task: "Todo 13", done: false },
    ]);

    // Delete the shapes on the server to force a must-refetch on it
    await deleteShape("todo", shape1.stream.shapeHandle!);

    // Update all to done
    await serverDb.update(todo).set({ done: true });

    // Wait for sync to complete
    await waitFor(
      async () => {
        const todoCount = await db.select({ count: count() }).from(todo).where(eq(todo.done, true));
        expect(todoCount[0]!.count).toBe(10);
      },
      { timeout: 5000 },
    );

    // Verify that the local data is still present
    const localTodoCount = await db
      .select({ count: count() })
      .from(todo)
      .where(and(gt(todo.id, 10), eq(todo.done, false)));
    expect(localTodoCount[0]!.count).toBe(3);

    // Clean up
    shape1.unsubscribe();
    shape2.unsubscribe();
    await pg.electric.deleteSubscription("todo_shape1");
    await pg.electric.deleteSubscription("todo_shape2");
  });

  it("handles large initial load with multiple columns", async () => {
    const db = drizzleOver(pg);

    // Generate data in batches
    const numRows = 5000; // Reduced from 10k to 5k for faster test execution
    const batchSize = 500;
    const batches = Math.ceil(numRows / batchSize);

    for (let batch = 0; batch < batches; batch++) {
      const start = batch * batchSize;
      const end = Math.min(start + batchSize, numRows);

      // Build a batch of INSERT statements
      for (let i = start; i < end; i++) {
        await serverDb.insert(largeTable).values({
          id: i,
          col1: `text-${i}`,
          col2: i * 10,
          col3: i % 2 === 0,
          col4: new Date(2023, 0, 1, 12 + i), // 2023-01-01 12:00:00 + i hours
          // NUMERIC(10,2) via the string mode; Postgres coerces `String(i * 1.5)` to the identical
          // stored value the original numeric param produced (e.g. "7498.5" → 7498.50).
          col5: String(i * 1.5),
          col6: `long-text-value-${i}-with-some-additional-content`,
          col7: i * 5,
          col8: i % 3 === 0,
          col9: `another-text-value-${i}`,
        });
      }
    }

    // Set up sync with COPY enabled for efficiency
    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "large_table" },
        fetchClient,
      },
      registry,
      tableKey: "large_table",
      initialInsertMethod: "copy",
      shapeKey: null,
    });

    // Wait for all data to be synced - increase timeout for large dataset
    await waitFor(
      async () => {
        const result = await db.select({ count: count() }).from(largeTable);
        expect(result[0]!.count).toBe(numRows);
      },
      { timeout: 60000 }, // 60 second timeout for large dataset
    );

    // Verify some sample data points
    const firstRow = await db.select().from(largeTable).where(eq(largeTable.id, 0));
    expect(firstRow[0]).toMatchObject({
      id: 0,
      col1: "text-0",
      col2: 0,
      col3: true,
      // Skip timestamp comparison as it might have timezone differences
      col5: "0.00",
      col6: "long-text-value-0-with-some-additional-content",
      col7: 0,
      col8: true,
      col9: "another-text-value-0",
    });

    const middleRow = await db.select().from(largeTable).where(eq(largeTable.id, 2500));
    expect(middleRow[0]).toMatchObject({
      id: 2500,
      col1: "text-2500",
      col2: 25000,
      col3: true,
      // Skip timestamp comparison
      col5: "3750.00",
      col6: "long-text-value-2500-with-some-additional-content",
      col7: 12500,
      col8: false,
      col9: "another-text-value-2500",
    });

    const lastRow = await db
      .select()
      .from(largeTable)
      .where(eq(largeTable.id, numRows - 1));
    expect(lastRow[0]).toMatchObject({
      id: numRows - 1,
      col1: `text-${numRows - 1}`,
      col2: (numRows - 1) * 10,
      col3: (numRows - 1) % 2 === 0,
      // Skip timestamp comparison
      col5: ((numRows - 1) * 1.5).toFixed(2),
      col6: `long-text-value-${numRows - 1}-with-some-additional-content`,
      col7: (numRows - 1) * 5,
      col8: (numRows - 1) % 3 === 0,
      col9: `another-text-value-${numRows - 1}`,
    });

    // Clean up
    shape.unsubscribe();
  }, 60000);

  it("handles large update with inserts, deletes, and updates", async () => {
    const db = drizzleOver(pg);

    // Insert initial rows (some will be updated, some deleted, some unchanged)
    const totalRows = 3000;
    const batchSize = 500;
    const batches = Math.ceil(totalRows / batchSize);

    for (let batch = 0; batch < batches; batch++) {
      const start = batch * batchSize;
      const end = Math.min(start + batchSize, totalRows);

      for (let i = start; i < end; i++) {
        await serverDb.insert(largeOpsTable).values({
          id: i,
          value: `initial-value-${i}`,
          number: i,
          flag: i % 2 === 0,
        });
      }
    }

    // Set up sync
    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "large_ops_table" },
        fetchClient,
      },
      registry,
      tableKey: "large_ops_table",
      initialInsertMethod: "copy",
      shapeKey: null,
    });

    // Wait for initial sync to complete
    await waitFor(
      async () => {
        const result = await db.select({ count: count() }).from(largeOpsTable);
        expect(result[0]!.count).toBe(totalRows);
      },
      { timeout: 30000 },
    );

    // One server transaction (delete + update + inserts) → one LSN.
    await serverDb.transaction(async (tx) => {
      // 1. Delete rows (ids 1-999) - leave id=1 in the table
      await tx.delete(largeOpsTable).where(between(largeOpsTable.id, 1, 999));

      // 2. Update rows (ids 1000-1999). Tier ②: `number = number * 10` and `flag = NOT flag` reference
      //    the column's own value, which tier ① cannot express — typed `sql` interpolation is the ceiling.
      await tx
        .update(largeOpsTable)
        .set({
          value: "updated-value",
          number: sql`${largeOpsTable.number} * 10`,
          flag: sql`NOT ${largeOpsTable.flag}`,
        })
        .where(between(largeOpsTable.id, 1000, 1999));

      // 3. Insert new rows
      for (let i = totalRows; i < totalRows + 1000; i++) {
        await tx.insert(largeOpsTable).values({
          id: i,
          value: `new-value-${i}`,
          number: i * 2,
          flag: i % 3 === 0,
        });
      }
    });

    // Wait for all changes to sync
    await waitFor(
      async () => {
        const result = await db.select({ count: count() }).from(largeOpsTable);
        expect(result[0]!.count).toBe(3001); // 3000 original - 999 deleted + 1000 new = 3001
      },
      { timeout: 30000 },
    );

    // Verify deleted rows are gone
    const deletedCount = await db
      .select({ count: count() })
      .from(largeOpsTable)
      .where(between(largeOpsTable.id, 1, 999));
    expect(deletedCount[0]!.count).toBe(0);

    // Verify updated rows have new values
    const updatedRow = await db.select().from(largeOpsTable).where(eq(largeOpsTable.id, 1500));
    expect(updatedRow[0]).toEqual({
      id: 1500,
      value: "updated-value",
      number: 15000, // 1500 * 10
      flag: 1500 % 2 !== 0, // NOT the original flag
    });

    // Verify new rows were inserted
    const newRow = await db.select().from(largeOpsTable).where(eq(largeOpsTable.id, 3500));
    expect(newRow[0]).toEqual({
      id: 3500,
      value: "new-value-3500",
      number: 7000, // 3500 * 2
      flag: 3500 % 3 === 0,
    });

    // Verify unchanged rows remain the same
    const unchangedRow = await db.select().from(largeOpsTable).where(eq(largeOpsTable.id, 2500));
    expect(unchangedRow[0]).toEqual({
      id: 2500,
      value: "initial-value-2500",
      number: 2500,
      flag: 2500 % 2 === 0,
    });

    // Clean up
    shape.unsubscribe();
  });

  it("will perform initial sync for multi-shape subscriptions when only one table has data", async () => {
    const db = drizzleOver(pg);

    const syncResult = await pg.electric.syncShapesToTables({
      registry,
      key: "cycle_test",
      shapes: {
        todo_shape: {
          shape: {
            url: ELECTRIC_URL,
            params: { table: "todo" },
            fetchClient,
          },
          tableKey: "todo",
        },
        project_shape: {
          shape: {
            url: ELECTRIC_URL,
            params: { table: "project" },
            fetchClient,
          },
          tableKey: "project",
        },
      },
    });

    await serverDb.insert(todo).values({ id: 1, task: "Todo 1", done: false });

    // Wait for todo insert to sync
    await waitFor(
      async () => {
        const todoResult = await db.select().from(todo).where(eq(todo.id, 1));
        expect(todoResult.length).toBe(1);
        expect(todoResult[0]).toEqual({
          id: 1,
          task: `Todo 1`,
          done: false,
        });
      },
      { timeout: 5000 },
    );

    syncResult.unsubscribe();
  });

  it("cycles through operations with todo and project tables", async () => {
    const db = drizzleOver(pg);

    // Set up sync for both tables using syncShapesToTables
    const syncResult = await pg.electric.syncShapesToTables({
      registry,
      key: "cycle_test",
      shapes: {
        todo_shape: {
          shape: {
            url: ELECTRIC_URL,
            params: { table: "todo" },
            fetchClient,
          },
          tableKey: "todo",
        },
        project_shape: {
          shape: {
            url: ELECTRIC_URL,
            params: { table: "project" },
            fetchClient,
          },
          tableKey: "project",
        },
      },
    });

    // Run multiple iterations of the cycle
    const iterations = 20;
    for (let i = 1; i <= iterations; i++) {
      // 1. Insert into todo, check
      await serverDb.insert(todo).values({ id: i * 6 - 5, task: `Todo ${i}.1`, done: false });

      // Wait for todo insert to sync
      await waitFor(
        async () => {
          const todoResult = await db
            .select()
            .from(todo)
            .where(eq(todo.id, i * 6 - 5));
          expect(todoResult.length).toBe(1);
          expect(todoResult[0]).toEqual({
            id: i * 6 - 5,
            task: `Todo ${i}.1`,
            done: false,
          });
        },
        { timeout: 5000 },
      );

      // 2. Insert into todo and project in transaction, check
      await serverDb.transaction(async (tx) => {
        await tx.insert(todo).values({ id: i * 6 - 4, task: `Todo ${i}.2`, done: true });
        await tx.insert(project).values({ id: i, name: `Project ${i}`, active: true });
      });

      // Wait for transaction to sync
      await waitFor(
        async () => {
          const todoResult = await db
            .select()
            .from(todo)
            .where(eq(todo.id, i * 6 - 4));
          const projectResult = await db.select().from(project).where(eq(project.id, i));
          expect(todoResult).toHaveLength(1);
          expect(projectResult).toHaveLength(1);
        },
        { timeout: 5000 },
      );

      // 3. Update todo, check
      await serverDb.insert(todo).values({ id: i * 6 - 3, task: `Todo ${i}.3`, done: false });
      await serverDb
        .update(todo)
        .set({ task: `Updated Todo ${i}.1`, done: true })
        .where(eq(todo.id, i * 6 - 5));

      // Wait for update to sync
      await waitFor(
        async () => {
          const todoResult = await db
            .select()
            .from(todo)
            .where(eq(todo.id, i * 6 - 5));
          expect(todoResult[0]).toEqual({
            id: i * 6 - 5,
            task: `Updated Todo ${i}.1`,
            done: true,
          });
        },
        { timeout: 5000 },
      );

      // 4. Update project and todo, check
      await serverDb.transaction(async (tx) => {
        await tx.insert(todo).values({ id: i * 6 - 2, task: `Todo ${i}.4`, done: true });
        await tx
          .update(todo)
          .set({ task: `Updated Todo ${i}.2`, done: false })
          .where(eq(todo.id, i * 6 - 4));
        await tx
          .update(project)
          .set({ name: `Updated Project ${i}`, active: false })
          .where(eq(project.id, i));
      });

      // Wait for updates to sync
      await waitFor(
        async () => {
          const todoResult = await db
            .select()
            .from(todo)
            .where(eq(todo.id, i * 6 - 4));
          const projectResult = await db.select().from(project).where(eq(project.id, i));
          expect(todoResult[0]!.task).toBe(`Updated Todo ${i}.2`);
          expect(projectResult[0]!.name).toBe(`Updated Project ${i}`);
        },
        { timeout: 5000 },
      );

      // 5. Delete a todo, check
      await serverDb.insert(todo).values({ id: i * 6 - 1, task: `Todo ${i}.5`, done: false });
      await serverDb.delete(todo).where(eq(todo.id, i * 6 - 3));

      // Wait for delete to sync
      await waitFor(
        async () => {
          const todoResult = await db
            .select()
            .from(todo)
            .where(eq(todo.id, i * 6 - 3));
          expect(todoResult).toHaveLength(0);
        },
        { timeout: 5000 },
      );

      // 6. Delete the project, check
      await serverDb.insert(todo).values({ id: i * 6, task: `Todo ${i}.6`, done: true });
      await serverDb.delete(project).where(eq(project.id, i));

      // Wait for delete to sync
      await waitFor(
        async () => {
          const projectResult = await db.select().from(project).where(eq(project.id, i));
          expect(projectResult).toHaveLength(0);
        },
        { timeout: 5000 },
      );

      // Verify that after each iteration:
      // - project count is 0
      // - todo count increases by 1 (we add 6 todos and delete 1 per iteration)
      const projectCount = await db.select({ count: count() }).from(project);
      const todoCount = await db.select({ count: count() }).from(todo);

      expect(projectCount[0]!.count).toBe(0);
      expect(todoCount[0]!.count).toBe(i * 5); // 6 inserts - 1 delete per iteration
    }

    // Clean up
    syncResult.unsubscribe();
    await pg.electric.deleteSubscription("cycle_test");
  }, 30000); // allow 30 seconds to run this test as it is long

  const types_syncer = async (initialInsertMethod: InitialInsertMethod) => {
    const db = drizzleOver(pg);

    // Test data for different data types
    const testData: Array<{
      id: number;
      int_col: number;
      float_col: number;
      boolean_col: boolean;
      string_col: string;
      json_col: unknown;
      json_plain_col: unknown;
      int_array_col: number[];
      enum_col: "one" | "two" | "three";
    }> = [
      {
        id: 1,
        int_col: 42,
        float_col: 3.14159,
        boolean_col: true,
        string_col: "Hello, world!",
        json_col: { name: "Test", nested: { value: 123 }, array: [1, 2, 3] },
        json_plain_col: {
          type: "JSON",
          different: "from JSONB",
          nums: [42, 43],
        },
        int_array_col: [1, 2, 3],
        enum_col: "one",
      },
      {
        id: 2,
        int_col: -100,
        float_col: -0.5,
        boolean_col: false,
        string_col: "Special chars: \n\t\"'\\",
        json_col: { empty: {}, list: [] },
        json_plain_col: { empty_arr: [], value: null },
        int_array_col: [4, 5, 6],
        enum_col: "two",
      },
      {
        id: 3,
        int_col: 0,
        float_col: 0.0,
        boolean_col: true,
        string_col: "",
        json_col: null,
        json_plain_col: null,
        int_array_col: [7, 8, 9],
        enum_col: "three",
      },
    ];

    // Insert data into PostgreSQL (Drizzle serializes jsonb/json objects and INTEGER[] arrays to the
    // same wire values the original hand-rendered params produced).
    for (const row of testData) {
      await serverDb.insert(dataTypesTable).values({
        id: row.id,
        int_col: row.int_col,
        float_col: row.float_col,
        boolean_col: row.boolean_col,
        string_col: row.string_col,
        json_col: row.json_col,
        json_plain_col: row.json_plain_col,
        int_array_col: row.int_array_col,
        enum_col: row.enum_col,
      });
    }

    // Set up sync
    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "data_types_table" },
        fetchClient,
      },
      registry,
      tableKey: "data_types_table",
      initialInsertMethod,
      shapeKey: "data_types_test",
    });

    // Wait for sync to complete
    await waitFor(
      async () => {
        const result = await db.select({ count: count() }).from(dataTypesTable);
        expect(result[0]!.count).toBe(testData.length);
      },
      { timeout: 5000 },
    );

    // Verify data was synced correctly
    for (const expected of testData) {
      // The inferred select type is honest now: `float_col` is a JS number (float8 / doublePrecision),
      // jsonb/json parse to values — so the read rows need no cast and no `parseFloat` coercion.
      const result = await db.select().from(dataTypesTable).where(eq(dataTypesTable.id, expected.id));

      const row = result[0]!;
      expect(row.id).toBe(expected.id);
      expect(row.int_col).toBe(expected.int_col);

      // Float comparison needs to account for potential precision differences
      expect(row.float_col).toBeCloseTo(expected.float_col, 5);

      expect(row.boolean_col).toBe(expected.boolean_col);
      expect(row.string_col).toBe(expected.string_col);

      // JSON data might be serialized differently but should be equivalent
      if (expected.json_col === null) {
        expect(row.json_col).toBeNull();
      } else {
        expect(row.json_col).toStrictEqual(expected.json_col);
      }

      // Plain JSON data should also be properly synced
      if (expected.json_plain_col === null) {
        expect(row.json_plain_col).toBeNull();
      } else {
        expect(row.json_plain_col).toStrictEqual(expected.json_plain_col);
      }

      expect(row.int_array_col).toStrictEqual(expected.int_array_col);
      expect(row.enum_col).toBe(expected.enum_col);
    }

    // Update a row with new values for all columns
    await serverDb
      .update(dataTypesTable)
      .set({
        int_col: 99999,
        float_col: 1234.5678,
        boolean_col: false,
        string_col: "Updated text value",
        json_col: { updated: true, values: [4, 5, 6] },
        json_plain_col: { updated: "plainJSON", order: { might: "matter" } },
        int_array_col: [3, 4, 5],
        enum_col: "two",
      })
      .where(eq(dataTypesTable.id, 1));

    // Wait for update to sync
    await waitFor(
      async () => {
        const result = await db
          .select({ int_col: dataTypesTable.int_col })
          .from(dataTypesTable)
          .where(eq(dataTypesTable.id, 1));
        expect(result[0]!.int_col).toBe(99999);
      },
      { timeout: 5000 },
    );

    // Verify updated data (inferred select type, no cast — as above)
    const updatedResult = await db.select().from(dataTypesTable).where(eq(dataTypesTable.id, 1));
    const updated = updatedResult[0]!;
    expect(updated.int_col).toBe(99999);
    expect(updated.float_col).toBeCloseTo(1234.5678, 5);
    expect(updated.boolean_col).toBe(false);
    expect(updated.string_col).toBe("Updated text value");
    expect(updated.json_col).toStrictEqual({ updated: true, values: [4, 5, 6] });
    expect(updated.json_plain_col).toStrictEqual({
      updated: "plainJSON",
      order: { might: "matter" },
    });
    expect(updated.int_array_col).toStrictEqual([3, 4, 5]);
    expect(updated.enum_col).toBe("two");

    // Clean up
    shape.unsubscribe();
    await pg.electric.deleteSubscription("data_types_test");
  };

  it("syncs data with various column types initial COPY", async () => {
    await types_syncer("copy");
  }, 60000);

  it("syncs data with various column types initial json_to_recordset", async () => {
    await types_syncer("json");
  }, 60000);

  it("syncs data with various column types", async () => {
    await types_syncer("insert");
  }, 60000);

  const many_syncer = async (method: InitialInsertMethod, numTodos: number = 150000, rowSize: number = 100) => {
    const db = drizzleOver(pg);

    // Batch the inserts to Postgres
    const batchSize = 1000;
    const batches = Math.ceil(numTodos / batchSize);
    const rowBytesValue = "a".repeat(rowSize);
    for (let batch = 0; batch < batches; batch++) {
      const start = batch * batchSize;
      const end = Math.min(start + batchSize, numTodos);

      // Build a batch of rows and insert them in one statement (batchSize=1000 × 3 cols = 3000 bound
      // params, well under Postgres' 65534-param limit) — one INSERT per iteration batch, as before.
      const rows = Array.from({ length: end - start }, (_, idx) => {
        const i = start + idx;
        return { id: i, task: `Todo ${i} ${rowBytesValue}`, done: i % 3 === 0 };
      });

      await serverDb.insert(todo).values(rows);
    }

    // Set up sync with the requested initial-backfill method
    const shape = await pg.electric.syncShapeToTable({
      shape: {
        url: ELECTRIC_URL,
        params: { table: "todo" },
        fetchClient,
      },
      registry,
      tableKey: "todo",
      initialInsertMethod: method,
      shapeKey: "large_todo_sync_test",
    });

    // Wait for all data to be synced - increase timeout for large dataset
    await waitFor(
      async () => {
        const result = await db.select({ count: count() }).from(todo);
        expect(result[0]!.count).toBe(numTodos);
      },
      { timeout: 30000 },
    );

    // Verify some sample data points
    const firstRow = await db.select().from(todo).where(eq(todo.id, 0));
    expect(firstRow[0]).toEqual({
      id: 0,
      task: `Todo 0 ${rowBytesValue}`,
      done: true, // 0 % 3 === 0
    });

    const middleRowId = Math.floor(numTodos / 2);
    const middleRow = await db.select().from(todo).where(eq(todo.id, middleRowId));
    expect(middleRow[0]).toEqual({
      id: middleRowId,
      task: `Todo ${middleRowId} ${rowBytesValue}`,
      done: middleRowId % 3 === 0,
    });

    const lastRow = await db
      .select()
      .from(todo)
      .where(eq(todo.id, numTodos - 1));
    expect(lastRow[0]).toEqual({
      id: numTodos - 1,
      task: `Todo ${numTodos - 1} ${rowBytesValue}`,
      done: (numTodos - 1) % 3 === 0,
    });

    // Test that we can still perform operations after the large sync
    await serverDb.update(todo).set({ task: "Updated after sync" }).where(eq(todo.id, 0));

    // Wait for update to sync
    await waitFor(
      async () => {
        const result = await db.select({ task: todo.task }).from(todo).where(eq(todo.id, 0));
        expect(result[0]!.task).toBe("Updated after sync");
      },
      { timeout: 5000 },
    );

    // Clean up
    shape.unsubscribe();
    await pg.electric.deleteSubscription("large_todo_sync_test");
  };

  for (const numTodos of [20_000, 150_000, 300_000]) {
    const rowSizeOptions = numTodos <= 20_000 ? [100, 10000] : [100];
    // 20_000 row of 100000 bytes triggers the batching by size for inserts
    for (const rowSize of rowSizeOptions) {
      describe(`handles initial sync of ${numTodos} rows`, () => {
        describe(`with row size ${rowSize} bytes`, () => {
          it(`with insert`, async () => {
            await many_syncer("insert", numTodos, rowSize);
          }, 360000);

          if (numTodos <= 150_000) {
            it(`with COPY`, async () => {
              await many_syncer("copy", numTodos, rowSize);
            }, 60000);

            it(`with json_to_recordset`, async () => {
              await many_syncer("json", numTodos, rowSize);
            }, 60000);
          }
        });
      });
    }
  }
});
