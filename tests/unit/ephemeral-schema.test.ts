import { describe, expect, it } from "bun:test";

import { sql } from "drizzle-orm";
import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { authorsSyncEntry } from "@pgxsinkit/schema";

import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { createFreshTestPGlite } from "../support/pglite";

// ADR-0021 §3: an `ephemeral` table's whole local cluster is emitted as TEMP / pg_temp.
const examEntry = defineSyncTable({
  tableName: "exam_answer",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    answer: varchar("answer", { length: 200 }),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
  }),
  mode: "readwrite",
  retention: "ephemeral",
  conflictPolicy: "last-write-wins",
  governance: {
    managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
  },
});

// authors is persistent readwrite; exam_answer is ephemeral readwrite — same registry.
const registry = defineSyncRegistry({ authors: authorsSyncEntry, exam: examEntry });
const ddl = generateLocalSchemaSql(registry);

describe("ephemeral cluster DDL (ADR-0021 §3)", () => {
  it("emits the ephemeral table's whole cluster as TEMP / pg_temp, the persistent one normally", () => {
    // ephemeral: synced table, overlay, journal, sequence, and both views are TEMP; the reconcile
    // function lives in pg_temp.
    expect(ddl).toContain(`CREATE TEMP TABLE IF NOT EXISTS exam_answer (`);
    expect(ddl).toContain(`CREATE TEMP TABLE IF NOT EXISTS exam_answer_overlay (`);
    expect(ddl).toContain(`CREATE TEMP TABLE IF NOT EXISTS exam_answer_mutations (`);
    expect(ddl).toContain(`CREATE TEMP SEQUENCE IF NOT EXISTS exam_answer_mutations_mutation_seq`);
    expect(ddl).toContain(`CREATE OR REPLACE TEMP VIEW exam_answer_read_model`);
    expect(ddl).toContain(`CREATE OR REPLACE TEMP VIEW exam_answer_sync_state`);
    expect(ddl).toContain(`CREATE OR REPLACE FUNCTION pg_temp.exam_answer_reconcile_on_sync()`);
    expect(ddl).toContain(`EXECUTE FUNCTION pg_temp.exam_answer_reconcile_on_sync()`);

    // persistent: no TEMP, no pg_temp.
    expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS authors (`);
    expect(ddl).toContain(`CREATE OR REPLACE VIEW authors_read_model`);
    expect(ddl).not.toContain(`CREATE TEMP TABLE IF NOT EXISTS authors (`);
    expect(ddl).not.toContain(`pg_temp.authors_reconcile_on_sync`);
  });

  it("executes: the ephemeral cluster lands in pg_temp, the persistent one in the schema, and both work", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(ddl);

    const ns = await db.query<{ relname: string; nspname: string }>(
      `SELECT c.relname, n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname IN ('exam_answer','exam_answer_overlay','exam_answer_read_model','authors','authors_read_model')`,
    );
    const nsByRel = new Map(ns.rows.map((row) => [row.relname, row.nspname]));
    expect(nsByRel.get("exam_answer")).toMatch(/^pg_temp/);
    expect(nsByRel.get("exam_answer_overlay")).toMatch(/^pg_temp/);
    expect(nsByRel.get("exam_answer_read_model")).toMatch(/^pg_temp/);
    expect(nsByRel.get("authors")).toBe("public");
    expect(nsByRel.get("authors_read_model")).toBe("public");

    // The ephemeral read model is functional: a synced row fires the (pg_temp) reconcile trigger,
    // clearing the optimistic overlay, and the temp read-model view returns the converged row.
    await db.exec(
      `INSERT INTO exam_answer_overlay (id, answer, updated_at_us, overlay_kind, local_updated_at_us)
       VALUES ('00000000-0000-0000-0000-0000000000aa', 'optimistic', 1, 'update', 1);`,
    );
    await db.exec(
      `INSERT INTO exam_answer (id, answer, updated_at_us) VALUES ('00000000-0000-0000-0000-0000000000aa', 'synced', 2);`,
    );
    const overlay = await db.query<{ c: number }>(`SELECT count(*)::int AS c FROM exam_answer_overlay`);
    const model = await db.query<{ answer: string }>(`SELECT answer FROM exam_answer_read_model`);
    expect(overlay.rows[0]?.c).toBe(0); // trigger fired → overlay cleared
    expect(model.rows[0]?.answer).toBe("synced");
  });
});
