import { describe, expect, it } from "bun:test";

import { bigint, uuid, varchar } from "drizzle-orm/pg-core";
import { getColumns } from "drizzle-orm/utils";

import {
  buildRowFilterWhere,
  defineSyncRegistry,
  defineSyncTable,
  getSyncRegistrySchema,
  type JwtClaims,
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
  updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
});

// ADR-0010: every writable table must declare a Server version (a nowMicroseconds-on-update
// managed field). Inlined per fixture because `column` is typed to each table's own keys.

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
        governance: {
          managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
        },
      }),
    ).toThrow(/must not omit primary-key columns/);
  });

  it("rejects omitting a primary-key column from a writable composite-PK table (ADR-0012)", () => {
    // The writable projection must carry the full server PK identity, or the overlay↔synced join
    // and the applier's per-column WHERE break. Omitting either composite-PK column is rejected.
    expect(() =>
      defineSyncTable({
        tableName: "composite_pk_items",
        makeColumns: () => ({
          tenantId: uuid("tenant_id").notNull(),
          id: uuid("id").notNull(),
          title: varchar("title", { length: 120 }).notNull(),
          updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
        }),
        mode: "readwrite",
        primaryKey: ["tenant_id", "id"],
        clientProjection: { omitColumns: ["tenantId"] },
        governance: {
          managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
        },
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
        governance: {
          managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
        },
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
          { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
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

  it("rejects a writable table without a Server version, but allows a readonly one (ADR-0010)", () => {
    const makeVersionlessColumns = () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
    });

    expect(() =>
      defineSyncTable({ tableName: "no_server_version_items", makeColumns: makeVersionlessColumns, mode: "readwrite" }),
    ).toThrow(/must declare a Server version/);

    // A readonly table is a pure read cache — no optimistic convergence, so no Server version needed.
    expect(() =>
      defineSyncTable({
        tableName: "no_server_version_readonly",
        makeColumns: makeVersionlessColumns,
        mode: "readonly",
      }),
    ).not.toThrow();
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

describe("buildRowFilterWhere ownership claim selection", () => {
  it("defaults to the sub claim with deny-on-missing behavior", () => {
    const filter = { ownership: { column: "person_id" } };

    expect(buildRowFilterWhere(filter, { sub: "user-1" })).toBe(`"person_id" = 'user-1'`);
    expect(buildRowFilterWhere(filter, null)).toBe("1 = 0");
    expect(buildRowFilterWhere(filter, {})).toBe("1 = 0");
  });

  it("reads a dot-path claim when configured", () => {
    const filter = { ownership: { column: "person_id", claim: "app_metadata.person_id" } };
    const claims = { sub: "auth-uid", app_metadata: { person_id: "person-9" } };

    expect(buildRowFilterWhere(filter, claims)).toBe(`"person_id" = 'person-9'`);
  });

  it("denies all rows when the configured claim is missing or non-primitive", () => {
    const filter = { ownership: { column: "person_id", claim: "app_metadata.person_id" } };

    // Runtime defense: claims that violate the static JwtClaims shape must still deny.
    const malformedClaims = { sub: "auth-uid", app_metadata: "oops" } as unknown as JwtClaims;

    expect(buildRowFilterWhere(filter, { sub: "auth-uid" })).toBe("1 = 0");
    expect(buildRowFilterWhere(filter, malformedClaims)).toBe("1 = 0");
    expect(buildRowFilterWhere(filter, { sub: "auth-uid", app_metadata: { person_id: { nested: true } } })).toBe(
      "1 = 0",
    );
    expect(buildRowFilterWhere(filter, { sub: "auth-uid", app_metadata: { person_id: "" } })).toBe("1 = 0");
  });

  it("escapes quotes in claim-selected owner values", () => {
    const filter = { ownership: { column: "person_id", claim: "app_metadata.person_id" } };

    expect(buildRowFilterWhere(filter, { app_metadata: { person_id: "per'son" } })).toBe(`"person_id" = 'per''son'`);
  });

  it("composes shared OR clauses with claim-selected ownership", () => {
    const filter = {
      ownership: { column: "owner_id", claim: "app_metadata.person_id" },
      shared: { sharedColumn: "is_shared", sharedUserId: "shared-1" },
    };
    const claims = { app_metadata: { person_id: "person-9" } };

    expect(buildRowFilterWhere(filter, claims)).toBe(
      `("owner_id" = 'person-9' OR ("is_shared" = true AND "owner_id" = 'shared-1'))`,
    );
  });
});

describe("row filter injection resistance (ADR-0003)", () => {
  it("escapes single quotes in the ownership claim value so it cannot break out", () => {
    const filter = { ownership: { column: "owner_id" } };
    const claims: JwtClaims = { sub: "x' OR '1'='1" };

    // The quote is doubled, keeping the whole value inside the string literal.
    expect(buildRowFilterWhere(filter, claims)).toBe(`"owner_id" = 'x'' OR ''1''=''1'`);
  });

  it("escapes single quotes in a function-derived shared user id", () => {
    const filter = {
      ownership: { column: "owner_id" },
      shared: { sharedUserId: (params: Record<string, unknown>) => String(params["uid"]) },
    };
    const claims: JwtClaims = { sub: "owner-1" };

    const where = buildRowFilterWhere(filter, claims, { uid: "y'); DROP TABLE x;--" });

    // Both the owner claim and the injected param value stay quoted/escaped.
    expect(where).toBe(`("owner_id" = 'owner-1' OR "owner_id" = 'y''); DROP TABLE x;--')`);
  });
});
