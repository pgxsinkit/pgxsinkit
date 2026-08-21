import { describe, expect, it } from "bun:test";

import { uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncTable } from "@pgxsinkit/contracts";

// ADR-0045: `applyMode` declares how a table's INITIAL LOAD is applied. Default `"insert"` takes the
// fast path (COPY / plain multi-row INSERT) on the assumption the table is empty; an explicit
// `"upsert"` opts a table into a conflict-tolerant backfill because it legitimately receives
// locally-derived provisional rows a snapshot could land on top of. Steady-state changes are not
// affected either way — the engine emits `upsert`, so they always apply through ON CONFLICT.

describe("defineSyncTable applyMode (ADR-0045)", () => {
  it('resolves applyMode to the default "insert" when omitted', () => {
    const entry = defineSyncTable({
      tableName: "userword",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        note: varchar("note", { length: 120 }),
      }),
      clientProjection: { omitColumns: [] },
    });

    expect(entry.applyMode).toBe("insert");
  });

  it('carries an explicit applyMode: "upsert" onto the entry', () => {
    const entry = defineSyncTable({
      tableName: "userword",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        note: varchar("note", { length: 120 }),
      }),
      applyMode: "upsert",
      clientProjection: { omitColumns: [] },
    });

    expect(entry.applyMode).toBe("upsert");
  });
});
