import { describe, expect, it } from "bun:test";

import { and, count, eq, sql } from "drizzle-orm";
import { index, pgTable, text } from "drizzle-orm/pg-core";

import { renderCreateTableSql } from "../../packages/client/src/schema";
import { drizzleOverPg } from "../../packages/client/src/sync/drizzle-executor";
import { getMetadataTables } from "../../packages/client/src/sync/metadata-tables";
import {
  getSubscriptionState,
  migrateSubscriptionMetadataTables,
  updateSubscriptionState,
} from "../../packages/client/src/sync/subscription-state";
import { createTablesFromSchema } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// ADR-0028 slice E — the internal Drizzle executor adapter (`drizzleOverPg`) that lets the sync engine's
// metadata-store DML run as tier-① Drizzle over BOTH a plain PGlite connection and an open PGlite
// `Transaction` (the commit boundary the engine owns). Plus the DDL/pgTable drift guard.

const META = "pgxsinkit";

// A throwaway synced fixture table for the plain-adapter and transaction proofs.
const widgets = pgTable("widgets", {
  id: text("id").primaryKey(),
  body: text("body"),
});

describe("drizzleOverPg adapter (ADR-0028)", () => {
  it("runs select/insert/delete over a plain PGlite connection", async () => {
    const pg = await createFreshTestPGlite();
    await createTablesFromSchema(pg, { widgets });
    const db = drizzleOverPg(pg);

    await db.insert(widgets).values([
      { id: "a", body: "x" },
      { id: "b", body: "y" },
    ]);
    const all = await db.select().from(widgets).orderBy(widgets.id);
    expect(all).toEqual([
      { id: "a", body: "x" },
      { id: "b", body: "y" },
    ]);

    await db.delete(widgets).where(eq(widgets.id, "a"));
    const rows = await db.select({ c: count() }).from(widgets);
    expect(rows[0]?.c).toBe(1);

    await pg.close();
  });

  it("memoizes one handle per connection object", async () => {
    const pg = await createFreshTestPGlite();
    expect(drizzleOverPg(pg)).toBe(drizzleOverPg(pg));
    await pg.close();
  });

  it("executes inside pg.transaction on THAT transaction — a rollback discards the write", async () => {
    const pg = await createFreshTestPGlite();
    await createTablesFromSchema(pg, { widgets });

    // A committed transaction persists the drizzle-issued write.
    await pg.transaction(async (tx) => {
      await drizzleOverPg(tx).insert(widgets).values({ id: "committed", body: "x" });
      // Visible WITHIN the same transaction (proves it ran on `tx`, not a separate connection).
      const inside = await drizzleOverPg(tx).select({ c: count() }).from(widgets);
      expect(inside[0]?.c).toBe(1);
    });
    expect((await drizzleOverPg(pg).select({ c: count() }).from(widgets))[0]?.c).toBe(1);

    // A rolled-back transaction discards the drizzle-issued write.
    await pg.transaction(async (tx) => {
      await drizzleOverPg(tx).insert(widgets).values({ id: "rolledback", body: "y" });
      await tx.rollback();
    });
    const after = await drizzleOverPg(pg).select().from(widgets);
    expect(after).toEqual([{ id: "committed", body: "x" }]);

    await pg.close();
  });

  it("hands a DISTINCT handle to a transaction vs its parent connection", async () => {
    const pg = await createFreshTestPGlite();
    const parentHandle = drizzleOverPg(pg);
    await pg.transaction(async (tx) => {
      expect(drizzleOverPg(tx)).not.toBe(parentHandle);
    });
    await pg.close();
  });
});

// ADR-0029 D3: `migrateSubscriptionMetadataTables` now RENDERS its DDL from the `metadata-tables.ts`
// pgTables (via `renderCreateTableSql`), so the DDL and the pgTable are one source and can no longer
// diverge. What was a DDL/pgTable drift guard demotes to a plain provisioning round-trip: provision via
// that rendered path, then exercise the same pgTables through the executor against the live schema.
describe("metadata provisioning round-trip (ADR-0029)", () => {
  it("the ③-provisioned relations accept insert/select through the pgTables", async () => {
    const pg = await createFreshTestPGlite();
    await migrateSubscriptionMetadataTables({ pg, metadataSchema: META });
    const { subscriptionsMetadata, shapeRowTags } = getMetadataTables(META);
    const db = drizzleOverPg(pg);

    // subscriptions_metadata round-trip (key TEXT PK, shape_metadata JSONB NOT NULL, last_lsn TEXT NOT NULL).
    await db.insert(subscriptionsMetadata).values({
      key: "k1",
      shape_metadata: { shapeA: { handle: "h1", offset: "0_0" } },
      last_lsn: "42",
    });
    const subs = await db.select().from(subscriptionsMetadata).where(eq(subscriptionsMetadata.key, "k1"));
    expect(subs[0]?.shape_metadata).toEqual({ shapeA: { handle: "h1", offset: "0_0" } });
    expect(subs[0]?.last_lsn).toBe("42");

    // shape_row_tags round-trip (composite PK, so ON CONFLICT DO NOTHING is a no-op on a dup).
    await db
      .insert(shapeRowTags)
      .values({ shape_table: "public.items", pk_json: '{"id":"1"}', tag: "g1" })
      .onConflictDoNothing();
    await db
      .insert(shapeRowTags)
      .values({ shape_table: "public.items", pk_json: '{"id":"1"}', tag: "g1" })
      .onConflictDoNothing();
    const tagRows = await db
      .select({ c: count() })
      .from(shapeRowTags)
      .where(and(eq(shapeRowTags.shape_table, "public.items"), eq(shapeRowTags.pk_json, '{"id":"1"}')));
    expect(tagRows[0]?.c).toBe(1);

    await pg.close();
  });

  it("the subscription-state helpers round-trip against the ③-provisioned schema", async () => {
    const pg = await createFreshTestPGlite();
    await migrateSubscriptionMetadataTables({ pg, metadataSchema: META });

    await updateSubscriptionState({
      pg,
      metadataSchema: META,
      subscriptionKey: "sub1",
      shapeMetadata: { s: { handle: "h", offset: "1_2" } },
      lastLsn: 7n,
    });
    const state = await getSubscriptionState({ pg, metadataSchema: META, subscriptionKey: "sub1" });
    expect(state).toEqual({
      key: "sub1",
      shape_metadata: { s: { handle: "h", offset: "1_2" } },
      last_lsn: 7n,
    });

    // Upsert path (ON CONFLICT DO UPDATE) overwrites the same key.
    await updateSubscriptionState({
      pg,
      metadataSchema: META,
      subscriptionKey: "sub1",
      shapeMetadata: { s: { handle: "h2", offset: "3_4" } },
      lastLsn: 9n,
    });
    const updated = await getSubscriptionState({ pg, metadataSchema: META, subscriptionKey: "sub1" });
    expect(updated?.last_lsn).toBe(9n);
    expect(updated?.shape_metadata).toEqual({ s: { handle: "h2", offset: "3_4" } });

    await pg.close();
  });
});

// The in-house index renderer (schema.ts) emits only a plain ascending btree over bare columns. A
// modifier it cannot render must throw rather than silently produce an index that differs from the
// pgTable — otherwise the DDL/model single-source invariant (ADR-0029 D3) is quietly broken.
describe("renderCreateTableSql index guards", () => {
  it("renders a plain btree index", () => {
    const t = pgTable("plain", { a: text("a"), b: text("b") }, (cols) => [index("plain_ab_idx").on(cols.a, cols.b)]);
    const stmts = renderCreateTableSql(t);
    expect(stmts.some((s) => s.includes("CREATE INDEX IF NOT EXISTS plain_ab_idx"))).toBe(true);
  });

  it("throws on a descending index column (.desc()) it does not render", () => {
    const t = pgTable("guarded", { a: text("a") }, (cols) => [index("guarded_a_idx").on(cols.a.desc())]);
    expect(() => renderCreateTableSql(t)).toThrow(/descending index columns/);
  });

  it("throws on NULLS FIRST ordering (.nullsFirst()) it does not render", () => {
    const t = pgTable("nulled", { a: text("a") }, (cols) => [index("nulled_a_idx").on(cols.a.nullsFirst())]);
    expect(() => renderCreateTableSql(t)).toThrow(/NULLS FIRST/);
  });

  it("throws on a partial index (.where) it does not render", () => {
    const t = pgTable("partial", { a: text("a") }, (cols) => [
      index("partial_a_idx")
        .on(cols.a)
        .where(sql`${cols.a} IS NOT NULL`),
    ]);
    expect(() => renderCreateTableSql(t)).toThrow(/partial indexes/);
  });

  it("throws on a non-btree index method (.using) it does not render", () => {
    const t = pgTable("hashed", { a: text("a") }, (cols) => [index("hashed_a_idx").using("hash", cols.a)]);
    expect(() => renderCreateTableSql(t)).toThrow(/non-btree index methods/);
  });

  it("throws on an index operator class (.op) it does not render", () => {
    const t = pgTable("opclassed", { a: text("a") }, (cols) => [
      index("opclassed_a_idx").on(cols.a.op("text_pattern_ops")),
    ]);
    expect(() => renderCreateTableSql(t)).toThrow(/index operator classes/);
  });
});
