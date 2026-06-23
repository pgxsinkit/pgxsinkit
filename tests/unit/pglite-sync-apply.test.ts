import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { performance } from "node:perf_hooks";

import type { PGlite } from "@electric-sql/pglite";

import { applyInsertsToTable, applyMessageToTable } from "../../packages/client/src/sync/apply";
import { createFreshTestPGlite } from "../support/pglite";

interface TestInsertMessage {
  headers: { operation: "insert" };
  key: string;
  value: Record<string, unknown>;
}

const debugTimings = process.env["PGXSINKIT_DEBUG_PGLITE_SYNC_APPLY_TIMINGS"] === "true";

async function measureTiming<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();

  try {
    return await operation();
  } finally {
    if (debugTimings) {
      console.log("[pglite-sync-apply timing]", {
        label,
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
      });
    }
  }
}

describe("pglite-sync apply", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await measureTiming("suite:PGlite.create", () => createFreshTestPGlite());
  });

  afterAll(async () => {
    await pg.close();
  });

  it("applies bulk inserts operation-faithfully; a replayed primary key fails instead of upserting", async () => {
    await pg.exec(`
      CREATE TABLE public.authors (
        id text PRIMARY KEY,
        name text NOT NULL,
        updated_at_us bigint NOT NULL
      );
    `);

    await measureTiming("bulk:applyInserts:first", () =>
      applyInsertsToTable({
        pg,
        table: "authors",
        messages: [
          {
            headers: { operation: "insert" },
            key: "author-1",
            value: { id: "author-1", name: "First name", updated_at_us: 1 },
          } as TestInsertMessage,
        ],
        primaryKey: ["id"],
        debug: false,
      }),
    );

    // An Electric `insert` is a new row (post-truncate or first send). Replaying an existing key is a
    // protocol/truncate violation that must surface, not be silently swallowed by an upsert.
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      applyInsertsToTable({
        pg,
        table: "authors",
        messages: [
          {
            headers: { operation: "insert" },
            key: "author-1",
            value: { id: "author-1", name: "Updated name", updated_at_us: 2 },
          } as TestInsertMessage,
        ],
        primaryKey: ["id"],
        debug: false,
      }),
    ).rejects.toThrow();

    const result = await pg.query<{ id: string; name: string; updated_at_us: number }>(
      `SELECT id, name, updated_at_us FROM public.authors`,
    );

    // The original row is untouched — no silent overwrite.
    expect(result.rows).toEqual([{ id: "author-1", name: "First name", updated_at_us: 1 }]);
  });

  it("applies single insert messages operation-faithfully; a replayed primary key fails", async () => {
    await pg.exec(`
      CREATE TABLE public.todos (
        id text PRIMARY KEY,
        title text NOT NULL,
        completed boolean NOT NULL
      );
    `);

    await measureTiming("single:applyMessage:first", () =>
      applyMessageToTable({
        pg,
        table: "todos",
        message: {
          headers: { operation: "insert" },
          key: "todo-1",
          value: { id: "todo-1", title: "First title", completed: false },
        } as TestInsertMessage,
        primaryKey: ["id"],
        debug: false,
      }),
    );

    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      applyMessageToTable({
        pg,
        table: "todos",
        message: {
          headers: { operation: "insert" },
          key: "todo-1",
          value: { id: "todo-1", title: "Updated title", completed: true },
        } as TestInsertMessage,
        primaryKey: ["id"],
        debug: false,
      }),
    ).rejects.toThrow();

    const result = await pg.query<{ id: string; title: string; completed: boolean }>(
      `SELECT id, title, completed FROM public.todos`,
    );

    expect(result.rows).toEqual([{ id: "todo-1", title: "First title", completed: false }]);
  });
});
