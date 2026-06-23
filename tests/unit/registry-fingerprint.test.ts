import { describe, expect, it } from "bun:test";

import { boolean, jsonb, uuid, varchar } from "drizzle-orm/pg-core";

import { canonicalizeRegistry, defineSyncRegistry, defineSyncTable, fingerprintRegistry } from "@pgxsinkit/contracts";

// The registry fingerprint (ADR-0004): the single "has the shape changed" signal,
// consumed by ADR-0006. Order-independent, shape-sensitive, function-free.

const items = () =>
  defineSyncTable({
    tableName: "items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
    }),
    clientProjection: { omitColumns: [] },
  });

const notes = () =>
  defineSyncTable({
    tableName: "notes",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      body: varchar("body", { length: 200 }).notNull(),
    }),
    clientProjection: { omitColumns: [] },
  });

describe("registry fingerprint (ADR-0004)", () => {
  it("is stable for the same shape", () => {
    expect(fingerprintRegistry(defineSyncRegistry({ items: items() }))).toBe(
      fingerprintRegistry(defineSyncRegistry({ items: items() })),
    );
  });

  it("is independent of table declaration order", () => {
    const ab = defineSyncRegistry({ items: items(), notes: notes() });
    const ba = defineSyncRegistry({ notes: notes(), items: items() });
    expect(fingerprintRegistry(ba)).toBe(fingerprintRegistry(ab));
  });

  it("changes when a table's consistency group changes (ADR-0009 decision 2)", () => {
    const ungrouped = defineSyncRegistry({ items: items() });
    const grouped = defineSyncRegistry({
      items: defineSyncTable({
        tableName: "items",
        makeColumns: () => ({
          id: uuid("id").primaryKey(),
          title: varchar("title", { length: 120 }).notNull(),
        }),
        clientProjection: { omitColumns: [] },
        consistencyGroup: "forum",
      }),
    });

    expect(fingerprintRegistry(grouped)).not.toBe(fingerprintRegistry(ungrouped));
    // The canonical form carries the group so the diff gate can see the move.
    expect(canonicalizeRegistry(grouped)[0]?.consistencyGroup).toBe("forum");
    expect(canonicalizeRegistry(ungrouped)[0]?.consistencyGroup).toBeNull();
  });

  it("changes when a column is added", () => {
    const base = defineSyncRegistry({ items: items() });
    const widened = defineSyncRegistry({
      items: defineSyncTable({
        tableName: "items",
        makeColumns: () => ({
          id: uuid("id").primaryKey(),
          title: varchar("title", { length: 120 }).notNull(),
          done: boolean("done").notNull().default(false),
        }),
        clientProjection: { omitColumns: [] },
      }),
    });

    expect(fingerprintRegistry(widened)).not.toBe(fingerprintRegistry(base));
  });

  it("excludes functions (rowTransform) from the fingerprint", () => {
    const withoutTransform = defineSyncRegistry({
      items: defineSyncTable({
        tableName: "items",
        makeColumns: () => ({ id: uuid("id").primaryKey(), data: jsonb("data").$type<Record<string, unknown>>() }),
        clientProjection: { omitColumns: [] },
      }),
    });
    const withTransform = defineSyncRegistry({
      items: defineSyncTable({
        tableName: "items",
        makeColumns: () => ({ id: uuid("id").primaryKey(), data: jsonb("data").$type<Record<string, unknown>>() }),
        clientProjection: { omitColumns: [] },
        serverProjection: { rowTransform: (row) => row },
      }),
    });

    expect(fingerprintRegistry(withTransform)).toBe(fingerprintRegistry(withoutTransform));
  });

  it("changes when a static row filter is swapped, but not when only customWhere differs", () => {
    const withOwnership = (ownerColumn: string) => {
      const entry = defineSyncTable({
        tableName: "items",
        makeColumns: () => ({
          id: uuid("id").primaryKey(),
          ownerId: uuid("owner_id"),
          teamId: uuid("team_id"),
        }),
        clientProjection: { omitColumns: [] },
      });
      return defineSyncRegistry({
        items: { ...entry, shape: { ...entry.shape!, rowFilter: { ownership: { column: ownerColumn } } } },
      });
    };

    // A static structural filter change (owner column) IS detected (review #5).
    expect(fingerprintRegistry(withOwnership("owner_id"))).not.toBe(fingerprintRegistry(withOwnership("team_id")));

    // A change confined to the customWhere function body is not (only its presence is recorded).
    const withCustom = (fn: () => string) => {
      const entry = defineSyncTable({
        tableName: "items",
        makeColumns: () => ({ id: uuid("id").primaryKey() }),
        clientProjection: { omitColumns: [] },
      });
      return defineSyncRegistry({ items: { ...entry, shape: { ...entry.shape!, rowFilter: { customWhere: fn } } } });
    };
    expect(fingerprintRegistry(withCustom(() => "owner_id = '1'"))).toBe(
      fingerprintRegistry(withCustom(() => "team_id = '2'")),
    );
  });

  it("changes when rowFilter.revision is bumped (the escape hatch for invisible customWhere logic)", () => {
    // The customWhere body is invisible to the fingerprint, so a consumer that changes its
    // *authorization logic* bumps `revision` to force a cache + subscription reset.
    const withRevision = (revision?: string | number) => {
      const entry = defineSyncTable({
        tableName: "items",
        makeColumns: () => ({ id: uuid("id").primaryKey(), ownerId: uuid("owner_id") }),
        clientProjection: { omitColumns: [] },
      });
      const rowFilter = {
        customWhere: () => "owner_id = '1'",
        ...(revision !== undefined ? { revision } : {}),
      };
      return defineSyncRegistry({ items: { ...entry, shape: { ...entry.shape!, rowFilter } } });
    };

    expect(fingerprintRegistry(withRevision("v2"))).not.toBe(fingerprintRegistry(withRevision("v1")));
    // Same revision → stable.
    expect(fingerprintRegistry(withRevision("v1"))).toBe(fingerprintRegistry(withRevision("v1")));
    // A bumped revision differs from no revision at all.
    expect(fingerprintRegistry(withRevision(2))).not.toBe(fingerprintRegistry(withRevision()));
  });

  it("canonicalizes to a sorted, shape-only structure", () => {
    const canon = canonicalizeRegistry(defineSyncRegistry({ items: items() }));
    expect(canon).toHaveLength(1);
    expect(canon[0]!.key).toBe("items");
    expect(canon[0]!.columns.map((column) => column.name)).toEqual(["id", "title"]);
  });
});
