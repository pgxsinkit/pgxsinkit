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

  it("classifies a local primary key change as breaking (review #4)", () => {
    const mk = (cols: string[]) =>
      defineSyncRegistry({
        items: defineSyncTable({
          tableName: "items",
          makeColumns: () => ({ id: uuid("id").primaryKey(), title: varchar("title", { length: 120 }).notNull() }),
          clientProjection: { omitColumns: [], localPrimaryKey: { columns: cols } },
        }),
      });
    const diff = compareRegistries(mk(["id"]), mk(["title"]));
    expect(diff.severity).toBe("breaking");
    expect(diff.changes.some((change) => /local primary key changed/.test(change.detail))).toBe(true);
  });

  it("classifies a journal-table rename as breaking (orphans local data) (review #4)", () => {
    const mk = (journalTable: string) =>
      defineSyncRegistry({
        items: defineSyncTable({
          tableName: "items",
          makeColumns: () => ({ id: uuid("id").primaryKey() }),
          clientProjection: { omitColumns: [], journalTable },
        }),
      });
    const diff = compareRegistries(mk("items_mutations"), mk("items_journal"));
    expect(diff.severity).toBe("breaking");
    expect(diff.changes.some((change) => /projection journalTable changed/.test(change.detail))).toBe(true);
  });

  it("classifies an omitted-columns change as risky (review #4)", () => {
    const mk = (omit: string[]) =>
      defineSyncRegistry({
        items: defineSyncTable({
          tableName: "items",
          makeColumns: () => ({ id: uuid("id").primaryKey(), note: varchar("note", { length: 200 }) }),
          clientProjection: { omitColumns: omit as never },
        }),
      });
    const diff = compareRegistries(mk([]), mk(["note"]));
    expect(diff.severity).toBe("risky");
    expect(diff.changes.some((change) => /omitted columns changed/.test(change.detail))).toBe(true);
  });

  it("classifies a managed-fields change as risky (review #4)", () => {
    const mk = (strategy: string) =>
      defineSyncRegistry({
        items: defineSyncTable({
          tableName: "items",
          makeColumns: () => ({ id: uuid("id").primaryKey(), ownerId: uuid("owner_id") }),
          clientProjection: { omitColumns: [] },
          governance: { managedFields: [{ column: "ownerId", applyOn: ["create"], strategy: strategy as never }] },
        }),
      });
    const diff = compareRegistries(mk("authUid"), mk("nowMicroseconds"));
    expect(diff.severity).toBe("risky");
    expect(diff.changes.some((change) => /managed fields changed/.test(change.detail))).toBe(true);
  });

  it("classifies a static row-filter change as risky (review #4/#5)", () => {
    const mk = (ownerColumn: string) => {
      const entry = defineSyncTable({
        tableName: "items",
        makeColumns: () => ({ id: uuid("id").primaryKey(), ownerId: uuid("owner_id"), teamId: uuid("team_id") }),
        clientProjection: { omitColumns: [] },
      });
      return defineSyncRegistry({
        items: { ...entry, shape: { ...entry.shape!, rowFilter: { ownership: { column: ownerColumn } } } },
      });
    };
    const diff = compareRegistries(mk("owner_id"), mk("team_id"));
    expect(diff.severity).toBe("risky");
    expect(diff.changes.some((change) => /row filter changed/.test(change.detail))).toBe(true);
  });

  it("classifies a consistency-group change as risky (ADR-0009 decision 2)", () => {
    const mk = (consistencyGroup?: string) =>
      defineSyncRegistry({
        items: defineSyncTable({
          tableName: "items",
          makeColumns: () => ({ id: uuid("id").primaryKey() }),
          clientProjection: { omitColumns: [] },
          ...(consistencyGroup ? { consistencyGroup } : {}),
        }),
      });

    // Singleton -> named group, and named -> different named, are both risky re-syncs.
    const intoGroup = compareRegistries(mk(), mk("forum"));
    expect(intoGroup.severity).toBe("risky");
    expect(intoGroup.changes.some((change) => /consistency group changed/.test(change.detail))).toBe(true);

    expect(compareRegistries(mk("forum"), mk("roster")).severity).toBe("risky");
    // No change in group membership is not flagged.
    expect(compareRegistries(mk("forum"), mk("forum")).changes).toEqual([]);
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
