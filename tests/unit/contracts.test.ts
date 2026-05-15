import { bigint, uuid, varchar } from "drizzle-orm/pg-core";
import { getColumns } from "drizzle-orm/utils";

import {
  defineSyncRegistry,
  defineSyncTable,
  getSyncRegistrySchema,
  mutationAckSchema,
  mutationEnvelopeSchema,
} from "@pgxsinkit/contracts";
import { buildDemoSyncConfig, buildSyntheticRegistry, buildSyntheticRegistrySchemaName } from "@pgxsinkit/schema";

const makeProjectedContractsColumns = () => ({
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  modifiedBy: uuid("modified_by"),
  title: varchar("title", { length: 120 }).notNull(),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
});

describe("sync config contracts", () => {
  it("attaches registry-level schema metadata without changing table enumeration", () => {
    const schemaName = buildSyntheticRegistrySchemaName({
      tableCount: 1,
      extraColumnCount: 4,
    });
    const { registry } = buildSyntheticRegistry({
      tableCount: 1,
      extraColumnCount: 4,
      schemaName,
    });

    expect(getSyncRegistrySchema(registry)).toBe(schemaName);
    expect(Object.keys(registry)).toEqual(["perf_items_000"]);
  });

  it("supports defineSyncRegistry with top-level schema metadata", () => {
    const schemaName = "perf_lab_contracts";
    const { registry } = buildSyntheticRegistry({
      tableCount: 1,
      extraColumnCount: 3,
      schemaName,
    });
    const wrapped = defineSyncRegistry({
      schema: schemaName,
      tables: registry,
    });

    expect(getSyncRegistrySchema(wrapped)).toBe(schemaName);
    expect(Object.keys(wrapped)).toEqual(["perf_items_000"]);
  });

  it("exports a shared todo table spec and demo sync config", () => {
    const config = buildDemoSyncConfig("http://localhost:3000/v1/shape");

    expect(config.tables.authors?.clientProjection?.syncedTable).toBe("authors");
    expect(config.tables.todos?.clientProjection?.journalTable).toBe("todos_mutations");
  });

  it("rejects omitting primary-key columns from the client projection", () => {
    expect(() =>
      defineSyncTable({
        tableName: "projected_contracts_items",
        makeColumns: makeProjectedContractsColumns,
        mode: "readwrite",
        clientProjection: { omitColumns: ["id"] },
      }),
    ).toThrow(/must not omit primary-key columns/);
  });

  it("rejects omitting required unmanaged create columns from writable tables", () => {
    expect(() =>
      defineSyncTable({
        tableName: "projected_contracts_items",
        makeColumns: makeProjectedContractsColumns,
        mode: "readwrite",
        clientProjection: { omitColumns: ["title"] },
      }),
    ).toThrow(/must only omit create-safe columns/);
  });

  it("builds projected local tables without omitted managed columns", () => {
    const projectedEntry = defineSyncTable({
      tableName: "projected_contracts_items",
      makeColumns: makeProjectedContractsColumns,
      mode: "readwrite",
      clientProjection: { omitColumns: ["ownerId", "modifiedBy"] },
      governance: {
        managedFields: [
          { column: "ownerId", applyOn: ["create"], strategy: "authUid" },
          { column: "modifiedBy", applyOn: ["create", "update"], strategy: "authUid" },
        ],
      },
    });

    const localColumns = getColumns(projectedEntry.localTable);

    expect(localColumns).not.toHaveProperty("ownerId");
    expect(localColumns).not.toHaveProperty("modifiedBy");
    expect(localColumns.id).toBeDefined();
    expect(localColumns.title).toBeDefined();
    expect(localColumns.createdAtUs).toBeDefined();
  });

  it("parses generic mutation envelopes and acks", () => {
    const envelope = mutationEnvelopeSchema.parse({
      tableName: "projects",
      entityKey: { id: "01963227-d4c7-72db-b858-f89f6af8f999" },
      mutationId: "01963227-d4c7-72db-b858-f89f6af8f998",
      mutationSeq: 2,
      kind: "update",
      payload: { archived: true },
      clientTimestampUs: "1713088800000000",
    });

    const ack = mutationAckSchema.parse({
      tableName: "projects",
      entityKey: { id: "01963227-d4c7-72db-b858-f89f6af8f999" },
      mutationId: "01963227-d4c7-72db-b858-f89f6af8f998",
      mutationSeq: 2,
      status: "acked",
      serverUpdatedAtUs: "1713088800000001",
      httpStatus: 200,
    });

    expect(envelope.kind).toBe("update");
    expect(ack.status).toBe("acked");
  });
});
