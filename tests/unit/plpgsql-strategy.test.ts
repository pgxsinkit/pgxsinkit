import { bigint, pgTable, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { demoSyncRegistry } from "@pgxsinkit/schema";

import { buildPlpgsqlBatchFunctionDdl } from "../../packages/server/src/mutations/bulk/plpgsql-strategy";

const projectedPlpgsqlTable = pgTable("projected_plpgsql_items", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  internalNote: varchar("internal_note", { length: 120 }),
  title: varchar("title", { length: 120 }).notNull(),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
});

const projectedPlpgsqlRegistry = defineSyncRegistry({
  projectedItems: defineSyncTable({
    table: projectedPlpgsqlTable,
    mode: "readwrite",
    primaryKey: { columns: ["id"] },
    shape: { tableName: "projected_plpgsql_items", shapeKey: "projected_plpgsql_items" },
    clientProjection: {
      syncedTable: "projected_plpgsql_items",
      overlayTable: "projected_plpgsql_items_overlay",
      journalTable: "projected_plpgsql_items_mutations",
      readModel: "projected_plpgsql_items_read_model",
      omitColumns: ["ownerId", "internalNote"],
    },
    governance: {
      managedFields: [
        { column: "ownerId", applyOn: ["create"], strategy: "authUid" },
        { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
        { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
      ],
    },
  }),
});

describe("plpgsql batch function generator", () => {
  it("stamps managed fields instead of reading them from payload", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(demoSyncRegistry);

    expect(ddl).toContain('"owner_id", "modified_by", "created_at_us", "updated_at_us"');
    expect(ddl).toContain(
      "auth.uid(), auth.uid(), CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)",
    );
    expect(ddl).toContain('"modified_by" = auth.uid()');
    expect(ddl).toContain('"updated_at_us" = CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)');
    expect(ddl).not.toContain("($1->>'owner_id')::uuid");
    expect(ddl).not.toContain("($1->>'modified_by')::uuid");
    expect(ddl).not.toContain("($1->>'created_at_us')::bigint");
    expect(ddl).not.toContain("($1->>'updated_at_us')::bigint");
  });

  it("does not build DML branches from client-omitted columns", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(projectedPlpgsqlRegistry);

    expect(ddl).toContain("projected_plpgsql_items");
    expect(ddl).not.toContain("internal_note");
    expect(ddl).not.toContain("($1->>'owner_id')::uuid");
  });
});
