import { describe, expect, it } from "bun:test";

import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { defineReadProjection, defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { buildPlpgsqlBatchFunctionDdl } from "../../packages/server/src/mutations/plpgsql-apply";

// ADR-0027: a read projection reads an owner's physical table under a distinct local identity. It must be
// invisible to the WRITE path (the apply function) — its `table` IS the owner's, so a write branch for it
// would duplicate the owner's — while still getting a readonly LOCAL table on the client (the subset).

// An owner that USES omitColumns, so its `table` and `localTable` types differ — exercises the
// two-table-param `defineReadProjection` owner signature (no cast needed).
const owner = defineSyncTable({
  tableName: "papers",
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    body: varchar("body", { length: 9000 }).notNull(),
    ownerId: uuid("owner_id"),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    lastOpId: uuid("last_op_id"),
  }),
  clientProjection: { omitColumns: ["lastOpId"] },
  governance: {
    managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
  },
});

const summary = defineReadProjection(owner, {
  as: "papers_admin_summary",
  columns: ["title", "updatedAtUs"],
});

describe("read projections through the generators (ADR-0027)", () => {
  it("adds NOTHING to the apply function — the write path ignores read projections", () => {
    const ownerOnly = buildPlpgsqlBatchFunctionDdl(defineSyncRegistry({ papers: owner }));
    const withProjection = buildPlpgsqlBatchFunctionDdl(defineSyncRegistry({ papers: owner, papersSummary: summary }));

    // Byte-identical: a read projection emits no write branch (would otherwise DUPLICATE the owner's
    // `papers` branch, since its `table` is the owner's). This is what keeps a consumer's apply-fn
    // migration drift-free when a read projection is added.
    expect(withProjection).toBe(ownerOnly);
    expect(withProjection).not.toContain("papers_admin_summary");
    expect(withProjection).toContain("papers"); // the owner's branch is still there
  });

  it("gives the read projection a readonly LOCAL table (the subset) — no overlay/journal", () => {
    const schemaSql = generateLocalSchemaSql(defineSyncRegistry({ papers: owner, papersSummary: summary }));

    // The projection's own local table is created (distinct from the owner's `papers`).
    expect(schemaSql).toContain("papers_admin_summary");
    // Readonly → no optimistic write machinery for it.
    expect(schemaSql).not.toContain("papers_admin_summary_overlay");
    expect(schemaSql).not.toContain("papers_admin_summary_mutations");
    // The heavy/unselected columns are absent from the projection (it syncs only the subset). `body`
    // still exists on the owner's own `papers` table, so scope the check to the projection's CREATE
    // TABLE statement (from its name to the next `;`).
    const start = schemaSql.indexOf("CREATE TABLE IF NOT EXISTS papers_admin_summary");
    expect(start).toBeGreaterThanOrEqual(0);
    const summaryCreate = schemaSql.slice(start, schemaSql.indexOf(";", start) + 1);
    expect(summaryCreate).toContain("title");
    expect(summaryCreate).toContain("updated_at_us");
    expect(summaryCreate).not.toContain("body");
    expect(summaryCreate).not.toContain("owner_id");
  });
});
