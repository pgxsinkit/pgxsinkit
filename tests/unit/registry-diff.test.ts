import { describe, expect, it } from "bun:test";

import { boolean, integer, uuid, varchar } from "drizzle-orm/pg-core";

import {
  buildRegistryLock,
  compareRegistries,
  defineSyncRegistry,
  defineSyncTable,
  runRegistryCheck,
  summarizeRegistryDiff,
} from "@pgxsinkit/contracts";

// The authoring-time registry-diff gate (ADR-0006): classify a shape change so a
// breaking one is a conscious release decision, and catch silent column repurposing.

const single = (makeColumns: () => Record<string, unknown>) =>
  defineSyncRegistry({
    items: defineSyncTable({
      tableName: "items",
      makeColumns: makeColumns as never,
      clientProjection: { omitColumns: [] },
    }),
  });

const base = () => single(() => ({ id: uuid("id").primaryKey(), title: varchar("title", { length: 120 }).notNull() }));

describe("registry diff gate (ADR-0006)", () => {
  it("reports no changes for an identical shape", () => {
    const diff = compareRegistries(base(), base());
    expect(diff.severity).toBe("compatible");
    expect(diff.changes).toEqual([]);
  });

  it("classifies an added nullable column as compatible", () => {
    const next = single(() => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
      note: varchar("note", { length: 200 }),
    }));
    const diff = compareRegistries(base(), next);
    expect(diff.severity).toBe("compatible");
    expect(diff.changes.some((change) => /column added: note/.test(change.detail))).toBe(true);
  });

  it("classifies an added NOT NULL column without default as breaking", () => {
    const next = single(() => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
      rank: integer("rank").notNull(),
    }));
    expect(compareRegistries(base(), next).severity).toBe("breaking");
  });

  it("classifies an added NOT NULL column WITH default as compatible", () => {
    const next = single(() => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
      done: boolean("done").notNull().default(false),
    }));
    expect(compareRegistries(base(), next).severity).toBe("compatible");
  });

  it("classifies a removed column as breaking", () => {
    const next = single(() => ({ id: uuid("id").primaryKey() }));
    const diff = compareRegistries(base(), next);
    expect(diff.severity).toBe("breaking");
    expect(diff.changes.some((change) => /column removed: title/.test(change.detail))).toBe(true);
  });

  it("classifies a same-name type change as breaking (silent repurposing)", () => {
    const next = single(() => ({ id: uuid("id").primaryKey(), title: integer("title").notNull() }));
    const diff = compareRegistries(base(), next);
    expect(diff.severity).toBe("breaking");
    expect(diff.changes.some((change) => /column type changed: title/.test(change.detail))).toBe(true);
  });

  it("treats a removed table as breaking and an added table as compatible", () => {
    const withTwo = defineSyncRegistry({
      items: defineSyncTable({
        tableName: "items",
        makeColumns: () => ({ id: uuid("id").primaryKey() }),
        clientProjection: { omitColumns: [] },
      }),
      notes: defineSyncTable({
        tableName: "notes",
        makeColumns: () => ({ id: uuid("id").primaryKey() }),
        clientProjection: { omitColumns: [] },
      }),
    });
    const withOne = defineSyncRegistry({
      items: defineSyncTable({
        tableName: "items",
        makeColumns: () => ({ id: uuid("id").primaryKey() }),
        clientProjection: { omitColumns: [] },
      }),
    });

    expect(compareRegistries(withTwo, withOne).severity).toBe("breaking");
    expect(compareRegistries(withOne, withTwo).severity).toBe("compatible");
  });

  it("round-trips a lock and gates a breaking change", () => {
    const lock = buildRegistryLock(base());
    expect(runRegistryCheck({ registry: base(), lock }).ok).toBe(true);

    const breakingNext = single(() => ({ id: uuid("id").primaryKey() }));
    const result = runRegistryCheck({ registry: breakingNext, lock });
    expect(result.ok).toBe(false);
    expect(result.diff.severity).toBe("breaking");
    expect(summarizeRegistryDiff(result.diff)).toContain("[breaking]");
  });
});
