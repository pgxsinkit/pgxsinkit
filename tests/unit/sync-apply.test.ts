import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { performance } from "node:perf_hooks";

import type { PGlite } from "@electric-sql/pglite";
import { bigint, boolean, text } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { resolveApplyTarget } from "../../packages/client/src/local-tables";
import { applyInsertsToTable, applyMessageToTable } from "../../packages/client/src/sync/apply";
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// Small REAL registry built through the production registry-definition API (ADR-0029 D1): the appliers
// resolve their target from `(registry, tableKey)`, exactly as the engine does. The entries' local
// tables serve both fixture provisioning and the assertion reads.
const authorsEntry = defineSyncTable({
  tableName: "authors",
  makeColumns: () => ({
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    updatedAtUs: bigint("updated_at_us", { mode: "number" }).notNull(),
  }),
});

const todosEntry = defineSyncTable({
  tableName: "todos",
  makeColumns: () => ({
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    completed: boolean("completed").notNull(),
  }),
});

const registry = defineSyncRegistry({ authors: authorsEntry, todos: todosEntry });
const authors = authorsEntry.localTable;
const todos = todosEntry.localTable;

interface TestInsertMessage {
  headers: { operation: "insert" };
  key: string;
  value: Record<string, unknown>;
}

const debugTimings = process.env["PGXSINKIT_DEBUG_SYNC_APPLY_TIMINGS"] === "true";

async function measureTiming<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();

  try {
    return await operation();
  } finally {
    if (debugTimings) {
      console.log("[sync-apply timing]", {
        label,
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
      });
    }
  }
}

describe("sync apply", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await measureTiming("suite:PGlite.create", () => createFreshTestPGlite());
    await measureTiming("suite:createTablesFromSchema", () => createTablesFromSchema(pg, { authors, todos }));
  });

  afterAll(async () => {
    await pg.close();
  });

  it("applies bulk inserts operation-faithfully; a replayed primary key fails instead of upserting", async () => {
    const target = resolveApplyTarget(registry, "authors");
    await measureTiming("bulk:applyInserts:first", () =>
      applyInsertsToTable({
        pg,
        target,
        messages: [
          {
            headers: { operation: "insert" },
            key: "author-1",
            value: { id: "author-1", name: "First name", updated_at_us: 1 },
          } as TestInsertMessage,
        ],
        debug: false,
      }),
    );

    // An Electric `insert` is a new row (post-truncate or first send). Replaying an existing key is a
    // protocol/truncate violation that must surface, not be silently swallowed by an upsert.
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      applyInsertsToTable({
        pg,
        target,
        messages: [
          {
            headers: { operation: "insert" },
            key: "author-1",
            value: { id: "author-1", name: "Updated name", updated_at_us: 2 },
          } as TestInsertMessage,
        ],
        debug: false,
      }),
    ).rejects.toThrow();

    const rows = await drizzleOver(pg)
      .select({ id: authors.id, name: authors.name, updated_at_us: authors.updatedAtUs })
      .from(authors);

    // The original row is untouched — no silent overwrite.
    expect(rows).toEqual([{ id: "author-1", name: "First name", updated_at_us: 1 }]);
  });

  it("applies single insert messages operation-faithfully; a replayed primary key fails", async () => {
    const target = resolveApplyTarget(registry, "todos");
    await measureTiming("single:applyMessage:first", () =>
      applyMessageToTable({
        pg,
        target,
        message: {
          headers: { operation: "insert" },
          key: "todo-1",
          value: { id: "todo-1", title: "First title", completed: false },
        } as TestInsertMessage,
        debug: false,
      }),
    );

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      applyMessageToTable({
        pg,
        target,
        message: {
          headers: { operation: "insert" },
          key: "todo-1",
          value: { id: "todo-1", title: "Updated title", completed: true },
        } as TestInsertMessage,
        debug: false,
      }),
    ).rejects.toThrow();

    const rows = await drizzleOver(pg)
      .select({ id: todos.id, title: todos.title, completed: todos.completed })
      .from(todos);

    expect(rows).toEqual([{ id: "todo-1", title: "First title", completed: false }]);
  });
});
