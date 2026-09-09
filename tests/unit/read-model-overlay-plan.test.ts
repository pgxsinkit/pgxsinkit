import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { bigint, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { createFreshTestPGlite } from "../support/pglite";

// The read model's cost, pinned to a PLAN rather than a wall clock.
//
// `<t>_read_model` is `overlay UNION ALL (synced MINUS overlay)`, and the second branch is where a
// large synced table is read. Written as `NOT EXISTS`, the planner picks its shape — and in the
// overlay's NORMAL state it picks the wrong one: an overlay that is physically empty AND has been
// analysed reports `relpages = 0, reltuples = 0`, Postgres's never-vacuumed 10-page floor does not
// apply, and a scan of it costs 0.00. A free inner relation makes a `Nested Loop Anti Join` look
// cheapest, so the executor rescans the empty overlay once per synced row. A consumer measured 224 ms
// of a 270 ms selection in that node; the numbers this test logs are the same effect in miniature.
//
// The shipped shape is a `NOT IN` over the overlay's primary key: uncorrelated, so it is evaluated
// ONCE into a hashed SubPlan and each synced row is a hash probe. This test asserts that shape holds
// in the pathological statistics state, and keeps the rejected `NOT EXISTS` form alongside as a live
// demonstration (not folklore) of why it was rejected.

const ROW_COUNT = 100_000;

const cardsEntry = defineSyncTable({
  tableName: "plan_cards",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: text("title").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
  }),
  primaryKey: ["id"],
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  governance: {
    managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
  },
  clientProjection: {
    // The consumer's first case: a due-window scan on a large synced table.
    localIndexes: [{ name: "plan_cards_due_at_idx", columns: ["dueAt"] }],
  },
});

// A COMPOSITE key renders the membership test as a row constructor — `(t.a, t.b) NOT IN (SELECT o.a, o.b …)`
// — a different SQL shape from the single-column form, so it is executed here rather than assumed.
const seatsEntry = defineSyncTable({
  tableName: "plan_seats",
  makeColumns: () => ({
    orgId: uuid("org_id").notNull(),
    personId: uuid("person_id").notNull(),
    role: text("role").notNull(),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
  }),
  primaryKey: ["org_id", "person_id"],
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  governance: {
    managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
  },
});

const registry = defineSyncRegistry({ cards: cardsEntry, seats: seatsEntry });

async function explain(pg: PGlite, sql: string): Promise<string> {
  const result = await pg.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, TIMING) ${sql}`);
  return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
}

function executionMs(plan: string): number {
  const match = /Execution Time: ([\d.]+) ms/.exec(plan);
  return match ? Number(match[1]) : Number.NaN;
}

describe("read model overlay non-membership plan", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await createFreshTestPGlite();
    await pg.exec(generateLocalSchemaSql(registry));
    // Bulk fixture in ONE statement: 100k rows round-tripped through JS would dominate the test, and
    // nothing here depends on the values — only on the row count and the resulting plan.
    await pg.exec(`
      INSERT INTO plan_cards (id, title, due_at, updated_at_us)
      SELECT
        ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
        'card ' || g,
        now() + (g || ' seconds')::interval,
        g
      FROM generate_series(1, ${ROW_COUNT}) AS g;
    `);
    // The state that provokes the defect — and the state a consumer's own perf harness produces the
    // moment it runs `ANALYZE` to measure a query rather than the planner guessing.
    await pg.exec(`ANALYZE plan_cards; ANALYZE plan_cards_overlay;`);
  });

  afterAll(async () => {
    await pg.close();
  });

  it("reads the whole read model without a per-row rescan of the empty overlay", async () => {
    const shipped = await explain(pg, `SELECT * FROM plan_cards_read_model`);
    expect(shipped).not.toContain("Nested Loop Anti Join");
    // Uncorrelated: evaluated once, then probed. A bare `SubPlan` here (no `hashed`) would mean the
    // overlay grew past `hash_mem` and the probe became a per-row rescan.
    expect(shipped).toContain("hashed SubPlan");

    // The rejected form, on the same tables and the same statistics.
    await pg.exec(`
      CREATE OR REPLACE VIEW plan_cards_not_exists AS
      SELECT t.id, t.title, t.due_at, t.updated_at_us
      FROM plan_cards AS t
      WHERE NOT EXISTS (SELECT 1 FROM plan_cards_overlay AS o WHERE o.id = t.id);
    `);
    const rejected = await explain(pg, `SELECT * FROM plan_cards_not_exists`);
    expect(rejected).toContain("Nested Loop Anti Join");

    console.log(
      `[read model] ${ROW_COUNT.toLocaleString("en")} synced rows, empty analysed overlay — ` +
        `NOT IN (shipped): ${executionMs(shipped).toFixed(1)} ms; ` +
        `NOT EXISTS (rejected): ${executionMs(rejected).toFixed(1)} ms`,
    );
  });

  it("keeps the plan when the overlay actually holds rows", async () => {
    await pg.exec(`
      INSERT INTO plan_cards_overlay (id, title, due_at, updated_at_us, overlay_kind, local_updated_at_us)
      SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'local ' || g, now(), g, 'pending_update', g
      FROM generate_series(1, 500) AS g;
    `);
    await pg.exec(`ANALYZE plan_cards_overlay;`);

    const rows = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM plan_cards_read_model`);
    // Every synced row appears exactly once: 500 shadowed by the overlay, the rest straight through.
    expect(rows.rows[0]?.n).toBe(ROW_COUNT);
    const overlaid = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM plan_cards_read_model WHERE overlay_kind = 'pending_update'`,
    );
    expect(overlaid.rows[0]?.n).toBe(500);

    const plan = await explain(pg, `SELECT * FROM plan_cards_read_model`);
    expect(plan).toContain("hashed SubPlan");
    expect(plan).not.toContain("Nested Loop Anti Join");

    await pg.exec(`DELETE FROM plan_cards_overlay;`);
  });

  it("shadows a composite-key row through the row-constructor form", async () => {
    const orgA = "aaaaaaaa-0000-4000-8000-000000000001";
    await pg.exec(`
      INSERT INTO plan_seats (org_id, person_id, role, updated_at_us) VALUES
        ('${orgA}', 'bbbbbbbb-0000-4000-8000-000000000001', 'teacher', 1),
        ('${orgA}', 'bbbbbbbb-0000-4000-8000-000000000002', 'learner', 2);
      INSERT INTO plan_seats_overlay (org_id, person_id, role, updated_at_us, overlay_kind, local_updated_at_us)
      VALUES ('${orgA}', 'bbbbbbbb-0000-4000-8000-000000000001', 'admin', 3, 'pending_update', 3);
    `);

    const rows = await pg.query<{ person_id: string; role: string; overlay_kind: string }>(
      `SELECT person_id, role, overlay_kind FROM plan_seats_read_model ORDER BY person_id`,
    );
    // The overlaid seat comes from the overlay (once, with the local value); the other straight from synced.
    expect(rows.rows).toEqual([
      { person_id: "bbbbbbbb-0000-4000-8000-000000000001", role: "admin", overlay_kind: "pending_update" },
      { person_id: "bbbbbbbb-0000-4000-8000-000000000002", role: "learner", overlay_kind: "synced" },
    ]);
  });

  it("renders the declared local index and uses it for a due-window read", async () => {
    const sql = generateLocalSchemaSql(registry);
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS plan_cards_due_at_idx ON plan_cards (due_at);");

    const dueWindow = `SELECT * FROM plan_cards WHERE due_at < now() + interval '500 seconds' ORDER BY due_at LIMIT 50`;
    const indexed = await explain(pg, dueWindow);
    expect(indexed).toContain("plan_cards_due_at_idx");

    await pg.exec(`DROP INDEX plan_cards_due_at_idx;`);
    const scanned = await explain(pg, dueWindow);
    expect(scanned).toContain("Seq Scan on plan_cards");

    console.log(
      `[local index] due-window read over ${ROW_COUNT.toLocaleString("en")} rows — ` +
        `with plan_cards_due_at_idx: ${executionMs(indexed).toFixed(2)} ms; without: ${executionMs(scanned).toFixed(2)} ms`,
    );
  });
});
