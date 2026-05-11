import { bigint, pgTable, uuid, varchar } from "drizzle-orm/pg-core";

import {
  defineSyncRegistry,
  defineSyncTable,
  getSyncRegistrySchema,
  mutationAckSchema,
  mutationEnvelopeSchema,
  syncConfigSchema,
} from "@pgxsinkit/contracts";
import {
  authorRecordSchema,
  authorTableSpec,
  buildDemoSyncConfig,
  buildSyntheticRegistry,
  buildSyntheticRegistrySchemaName,
  createTodoInputSchema,
  todoRecordSchema,
  todoTableSpec,
  updateTodoInputSchema,
} from "@pgxsinkit/schema";

const projectedContractsTable = pgTable("projected_contracts_items", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  modifiedBy: uuid("modified_by"),
  title: varchar("title", { length: 120 }).notNull(),
  createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
});

describe("todo contracts", () => {
  it("parses a serialized author row", () => {
    const result = authorRecordSchema.parse({
      id: "01963227-d4c7-72db-b858-f89f6af8f920",
      name: "Ada Lovelace",
      createdAtUs: "1713088800000000",
      updatedAtUs: "1713088800000000",
    });

    expect(result.name).toBe("Ada Lovelace");
  });

  it("accepts a valid create payload", () => {
    const result = createTodoInputSchema.parse({
      id: "01963227-d4c7-72db-b858-f89f6af8f999",
      title: "Ship hardened sync repo",
      description: "Capture the baseline shape sync example and test it thoroughly.",
      authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
      status: "todo",
      priority: "high",
    });

    expect(result.title).toBe("Ship hardened sync repo");
  });

  it("rejects blank titles", () => {
    expect(() =>
      createTodoInputSchema.parse({
        id: "01963227-d4c7-72db-b858-f89f6af8f999",
        title: "   ",
        description: null,
        authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
        status: "todo",
        priority: "medium",
      }),
    ).toThrow(/Too small/);
  });

  it("rejects empty updates", () => {
    expect(() => updateTodoInputSchema.parse({})).toThrow(/At least one field must be provided/);
  });

  it("parses a serialized todo row", () => {
    const result = todoRecordSchema.parse({
      id: "01963227-d4c7-72db-b858-f89f6af8f999",
      title: "Validate shape sync",
      description: null,
      authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
      status: "done",
      priority: "low",
      createdAtUs: "1713088800000000",
      updatedAtUs: "1713088800000000",
    });

    expect(result.status).toBe("done");
  });

  it("accepts a generic sync config", () => {
    const result = syncConfigSchema.parse({
      electricUrl: "http://localhost:3000/v1/shape",
      localSchema: "workspace_local",
      tables: {
        projects: {
          name: "projects",
          mode: "readwrite",
          primaryKey: {
            columns: ["id"],
          },
          shape: {
            tableName: "projects",
            shapeKey: "projects-shape",
          },
          routes: {
            basePath: "/api/projects",
            allowBatch: true,
          },
          clientProjection: {
            syncedTable: "projects",
            overlayTable: "projects_overlay",
            journalTable: "projects_mutations",
            readModel: "projects_read_model",
            omitColumns: ["ownerId"],
          },
          governance: {
            managedFields: [
              {
                column: "ownerId",
                applyOn: ["create"],
                strategy: "authUid",
              },
              {
                column: "updatedAtUs",
                applyOn: ["create", "update"],
                strategy: "nowMicroseconds",
              },
            ],
          },
        },
      },
    });

    expect(result.tables.projects?.mode).toBe("readwrite");
    expect(result.tables.projects?.governance?.managedFields?.[0]?.column).toBe("ownerId");
    expect(result.localSchema).toBe("workspace_local");
    expect(result.tables.projects?.clientProjection?.omitColumns).toEqual(["ownerId"]);
  });

  it("accepts rowFilter on shape specs without rejecting unrecognized keys", () => {
    const result = syncConfigSchema.parse({
      electricUrl: "http://localhost:3000/v1/shape",
      tables: {
        projects: {
          name: "projects",
          mode: "readwrite",
          primaryKey: {
            columns: ["id"],
          },
          shape: {
            tableName: "projects",
            shapeKey: "projects-shape",
            rowFilter: {
              ownership: { column: "owner_id" },
              shared: {
                sharedColumn: "shared",
                sharedUserId: "00000000-0000-0000-0000-000000000001",
              },
              columns: ["id", "title"],
            },
          },
          clientProjection: {
            syncedTable: "projects",
            overlayTable: "projects_overlay",
            journalTable: "projects_mutations",
            readModel: "projects_read_model",
          },
        },
      },
    });

    expect(result.tables.projects?.mode).toBe("readwrite");
    // rowFilter is an unknown passthrough — stored as unknown, but present
    const shape = result.tables.projects?.shape;
    expect(shape).toBeDefined();
    // rowFilter is a z.unknown() passthrough — verify it survived Zod parsing
    const raw = shape as unknown as { rowFilter?: { ownership?: { column: string } } };
    expect(raw.rowFilter?.ownership?.column).toBe("owner_id");
  });

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
    expect(authorTableSpec.routes?.basePath).toBe("/api/authors");
    expect(todoTableSpec.routes?.basePath).toBe("/api/todos");

    const result = syncConfigSchema.parse(buildDemoSyncConfig("http://localhost:3000/v1/shape"));

    expect(result.tables.authors?.clientProjection?.syncedTable).toBe("authors");
    expect(result.tables.todos?.clientProjection?.journalTable).toBe("todo_mutations");
  });

  it("rejects invalid readwrite config missing client projection", () => {
    expect(() =>
      syncConfigSchema.parse({
        electricUrl: "http://localhost:3000/v1/shape",
        tables: {
          projects: {
            name: "projects",
            mode: "readwrite",
            primaryKey: {
              columns: ["id"],
            },
            shape: {
              tableName: "projects",
              shapeKey: "projects-shape",
            },
            routes: {
              basePath: "/api/projects",
              allowBatch: true,
            },
          },
        },
      }),
    ).toThrow(/clientProjection is required/);
  });

  it("rejects omitting primary-key columns from the client projection", () => {
    expect(() =>
      defineSyncTable({
        table: projectedContractsTable,
        mode: "readwrite",
        primaryKey: { columns: ["id"] },
        shape: { tableName: "projected_contracts_items", shapeKey: "projected_contracts_items" },
        routes: { basePath: "/api/projected-contracts-items", allowBatch: false },
        clientProjection: {
          syncedTable: "projected_contracts_items",
          overlayTable: "projected_contracts_items_overlay",
          journalTable: "projected_contracts_items_mutations",
          readModel: "projected_contracts_items_read_model",
          omitColumns: ["id"],
        },
      }),
    ).toThrow(/must not omit primary-key columns/);
  });

  it("rejects omitting required unmanaged create columns from writable tables", () => {
    expect(() =>
      defineSyncTable({
        table: projectedContractsTable,
        mode: "readwrite",
        primaryKey: { columns: ["id"] },
        shape: { tableName: "projected_contracts_items", shapeKey: "projected_contracts_items" },
        routes: { basePath: "/api/projected-contracts-items", allowBatch: false },
        clientProjection: {
          syncedTable: "projected_contracts_items",
          overlayTable: "projected_contracts_items_overlay",
          journalTable: "projected_contracts_items_mutations",
          readModel: "projected_contracts_items_read_model",
          omitColumns: ["title"],
        },
      }),
    ).toThrow(/must only omit create-safe columns/);
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
