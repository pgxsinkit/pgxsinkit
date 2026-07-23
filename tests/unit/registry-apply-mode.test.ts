import { describe, expect, it } from "bun:test";

import { uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncTable } from "@pgxsinkit/contracts";

// ADR-0045: `applyMode` declares how a table's CDC inserts are applied. Default `"insert"` keeps the
// ADR-0014 collision-surfacing invariant (a plain INSERT — a genuine PK collision must surface); an
// explicit `"upsert"` opts a table into idempotent CDC-insert apply because it legitimately receives
// locally-derived provisional rows.

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
