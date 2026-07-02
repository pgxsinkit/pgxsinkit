import { describe, expect, it } from "bun:test";

import { count as countRows, eq, inArray } from "drizzle-orm";
import { bigint, uuid, varchar, type AnyPgTable } from "drizzle-orm/pg-core";

import { getOverlayTable } from "@pgxsinkit/client";
import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { authorsSyncEntry } from "@pgxsinkit/schema";

import { buildDesyncTableSql, generateLocalSchemaSql } from "../../packages/client/src/schema";
import { pgClass, pgNamespace } from "../support/catalog-tables";
import { drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// ADR-0021 §3: an `ephemeral` table's whole local cluster is emitted as TEMP / pg_temp.
const examEntry = defineSyncTable({
  tableName: "exam_answer",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    answer: varchar("answer", { length: 200 }),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
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

    const ns = await drizzleOver(db)
      .select({ relname: pgClass.relname, nspname: pgNamespace.nspname })
      .from(pgClass)
      .innerJoin(pgNamespace, eq(pgNamespace.oid, pgClass.relnamespace))
      .where(
        inArray(pgClass.relname, [
          "exam_answer",
          "exam_answer_overlay",
          "exam_answer_read_model",
          "authors",
          "authors_read_model",
        ]),
      );
    const nsByRel = new Map(ns.map((row) => [row.relname, row.nspname]));
    expect(nsByRel.get("exam_answer")).toMatch(/^pg_temp/);
    expect(nsByRel.get("exam_answer_overlay")).toMatch(/^pg_temp/);
    expect(nsByRel.get("exam_answer_read_model")).toMatch(/^pg_temp/);
    expect(nsByRel.get("authors")).toBe("public");
    expect(nsByRel.get("authors_read_model")).toBe("public");

    // The ephemeral read model is functional: a synced row fires the (pg_temp) reconcile trigger,
    // clearing the optimistic overlay, and the temp read-model view returns the converged row.
    const examOverlay = getOverlayTable(registry, "exam");
    await drizzleOver(db)
      .insert(examOverlay)
      .values({
        id: "00000000-0000-0000-0000-0000000000aa",
        answer: "optimistic",
        updatedAtUs: 1n,
        overlayKind: "update",
        localUpdatedAtUs: "1",
      } as typeof examOverlay.$inferInsert);
    await drizzleOver(db)
      .insert(registry.exam.localTable)
      .values({ id: "00000000-0000-0000-0000-0000000000aa", answer: "synced", updatedAtUs: 2n });
    const overlay = await drizzleOver(db).select({ c: countRows() }).from(examOverlay);
    const examView = registry.exam.view!;
    const model = await drizzleOver(db).select({ answer: examView.answer }).from(examView);
    expect(overlay[0]?.c).toBe(0); // trigger fired → overlay cleared
    expect(model[0]?.answer).toBe("synced");
  });

  it("buildDesyncTableSql clean-truncates a cluster's read cache for both retentions (ADR-0021 §2 desync)", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(ddl);

    // Seed a synced row + an optimistic overlay row in each cluster (persistent authors, ephemeral exam).
    const authorsOverlay = getOverlayTable(registry, "authors");
    const examOverlay = getOverlayTable(registry, "exam");
    await drizzleOver(db)
      .insert(registry.authors.localTable)
      .values({ id: "00000000-0000-0000-0000-0000000000a1", name: "synced", createdAtUs: 1n, updatedAtUs: 1n });
    await drizzleOver(db)
      .insert(authorsOverlay)
      .values({
        id: "00000000-0000-0000-0000-0000000000a2",
        name: "optimistic",
        createdAtUs: 1n,
        updatedAtUs: 1n,
        overlayKind: "create",
        localUpdatedAtUs: "1",
      } as typeof authorsOverlay.$inferInsert);
    await drizzleOver(db)
      .insert(registry.exam.localTable)
      .values({ id: "00000000-0000-0000-0000-0000000000b1", answer: "synced", updatedAtUs: 1n });
    await drizzleOver(db)
      .insert(examOverlay)
      .values({
        id: "00000000-0000-0000-0000-0000000000b2",
        answer: "optimistic",
        updatedAtUs: 1n,
        overlayKind: "update",
        localUpdatedAtUs: "1",
      } as typeof examOverlay.$inferInsert);

    // Desync each: the synced table AND its overlay are emptied; the cluster itself stays usable.
    await db.exec(buildDesyncTableSql(registry, "authors"));
    await db.exec(buildDesyncTableSql(registry, "exam"));

    const count = async (relation: AnyPgTable) =>
      (await drizzleOver(db).select({ c: countRows() }).from(relation))[0]?.c;

    expect(await count(registry.authors.localTable)).toBe(0);
    expect(await count(authorsOverlay)).toBe(0);
    expect(await count(registry.exam.localTable)).toBe(0); // bare name resolved to the pg_temp cluster
    expect(await count(examOverlay)).toBe(0);

    // The cluster is intact (not dropped): a fresh insert still lands and reads back.
    await drizzleOver(db)
      .insert(registry.exam.localTable)
      .values({ id: "00000000-0000-0000-0000-0000000000b3", answer: "again", updatedAtUs: 2n });
    expect(await count(registry.exam.localTable)).toBe(1);
  });
});
