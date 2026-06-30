import { describe, expect, it } from "bun:test";

import { sql } from "drizzle-orm";
import { bigint, uuid, varchar } from "drizzle-orm/pg-core";
import { getTableConfig } from "drizzle-orm/pg-core";
import { getColumns } from "drizzle-orm/utils";

import {
  authoritativeWriteRequestSchema,
  buildRowFilterWhere,
  defineReadProjection,
  defineSyncRegistry,
  defineSyncTable,
  deriveSyncColumnTypes,
  getProjectedColumnNames,
  getSyncRegistrySchema,
  type JwtClaims,
  mutationAckSchema,
  mutationEnvelopeSchema,
  type SyncTableEntry,
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
        conflictPolicy: "last-write-wins",
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
        conflictPolicy: "last-write-wins",
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
        conflictPolicy: "last-write-wins",
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
      conflictPolicy: "last-write-wins",
      clientProjection: { omitColumns: ["ownerId", "modifiedBy"] },
      governance: {
        managedFields: [
          { column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
          { column: "modifiedBy", applyOn: ["create", "update"], strategy: "authClaim", claimPath: ["sub"] },
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

  it("requires a Conflict policy on writable tables, accepting both v1 values (ADR-0015)", () => {
    const makeConflictColumns = () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    });

    // No silent default: an undeclared policy on a writable table is rejected (the third hard-require).
    expect(() =>
      defineSyncTable({
        tableName: "no_conflict_policy_items",
        makeColumns: makeConflictColumns,
        mode: "readwrite",
        governance: {
          managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
        },
      }),
    ).toThrow(/must declare a Conflict policy/);

    // Both v1 values are accepted.
    for (const conflictPolicy of ["last-write-wins", "reject-if-stale"] as const) {
      expect(() =>
        defineSyncTable({
          tableName: "conflict_policy_items",
          makeColumns: makeConflictColumns,
          mode: "readwrite",
          conflictPolicy,
          governance: {
            managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
          },
        }),
      ).not.toThrow();
    }

    // A readonly table needs no policy (it has no write path).
    expect(() =>
      defineSyncTable({ tableName: "conflict_policy_readonly", makeColumns: makeConflictColumns, mode: "readonly" }),
    ).not.toThrow();
  });

  it("validates the authClaim managed-field strategy (ADR-0026)", () => {
    const makeColumns = () => ({
      id: uuid("id").primaryKey(),
      createdBy: uuid("created_by"),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    });
    // The dynamic managed field rides alongside a valid nowMicroseconds server version, so the writable
    // hard-requires pass and validation reaches the authClaim checks.
    const withManaged = (managed: Record<string, unknown>) =>
      defineSyncTable({
        tableName: "claim_items",
        makeColumns,
        mode: "readwrite",
        conflictPolicy: "last-write-wins",
        governance: {
          managedFields: [
            managed as never,
            { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
          ],
        },
      });

    // authClaim without a claimPath is rejected.
    expect(() => withManaged({ column: "createdBy", applyOn: ["create"], strategy: "authClaim" })).toThrow(
      /must declare a non-empty claimPath/,
    );
    // A claimPath segment that is not a plain identifier is rejected (it is emitted into the apply-fn DDL).
    expect(() =>
      withManaged({
        column: "createdBy",
        applyOn: ["create"],
        strategy: "authClaim",
        claimPath: ["app_metadata", "person-id"],
      }),
    ).toThrow(/invalid claimPath segment/);
    // An unsafe cast is rejected.
    expect(() =>
      withManaged({
        column: "createdBy",
        applyOn: ["create"],
        strategy: "authClaim",
        claimPath: ["sub"],
        cast: "uuid); drop",
      }),
    ).toThrow(/invalid cast/);
    // claimPath on a non-authClaim strategy is an authoring slip — rejected, not silently ignored.
    expect(() =>
      withManaged({ column: "createdBy", applyOn: ["create"], strategy: "nowMicroseconds", claimPath: ["sub"] }),
    ).toThrow(/apply only to "authClaim"/);
    // A valid nested claim path (the emergent app_metadata.person_id case) is accepted.
    expect(() =>
      withManaged({
        column: "createdBy",
        applyOn: ["create"],
        strategy: "authClaim",
        claimPath: ["app_metadata", "person_id"],
      }),
    ).not.toThrow();
  });

  it("rejects declaring the same local table twice, but allows a read projection over a shared physical table", () => {
    const makeRefColumns = () => ({
      id: uuid("id").primaryKey(),
      label: varchar("label", { length: 80 }).notNull(),
    });

    // Two entries resolving to the SAME local identity collide locally → rejected at module-eval.
    expect(() =>
      defineSyncRegistry({
        canonical: defineSyncTable({ tableName: "thing", makeColumns: makeRefColumns }),
        duplicate: defineSyncTable({ tableName: "thing", makeColumns: makeRefColumns }),
      }),
    ).toThrow(/declared by two registry entries/);

    // An owner + a read projection over it carry DISTINCT local identities (the projection's `as`), so
    // both can read one physical table — accepted.
    const owner = defineSyncTable({ tableName: "thing", makeColumns: makeRefColumns });
    expect(() =>
      defineSyncRegistry({
        owner,
        summary: defineReadProjection(owner, { as: "thing_summary", columns: ["label"] }),
      }),
    ).not.toThrow();
  });

  it("defineReadProjection derives a light readonly shape over the owner's physical table", () => {
    const makeColumns = () => ({
      id: uuid("id").primaryKey(),
      ownerId: uuid("owner_id").notNull(),
      title: varchar("title", { length: 120 }).notNull(),
      heavyBlob: varchar("heavy_blob", { length: 9000 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    });
    const owner = defineSyncTable({ tableName: "assessment_definition", makeColumns, mode: "readonly" });

    let callbackKeys: string[] = [];
    const projection = defineReadProjection(owner, {
      as: "assessment_definition_admin_summary",
      columns: ["title", "updatedAtUs"], // PK ("id") is always kept; ownerId/heavyBlob dropped locally
      rowFilter: (cols) => {
        callbackKeys = Object.keys(cols);
        return { customWhere: () => null, revision: "admin-summary-1" };
      },
    });

    // Owns NO new table — its `table` IS the owner's object (nothing new to migrate).
    expect(projection.table).toBe(owner.table);
    expect(projection.readProjection).toBe(true);
    expect(projection.mode).toBe("readonly");

    // Distinct local identity; the shape reads the owner's physical table on egress.
    expect(getTableConfig(projection.localTable).name).toBe("assessment_definition_admin_summary");
    expect(projection.shape?.tableName).toBe("assessment_definition_admin_summary");
    expect(projection.shape?.shapeKey).toBe("assessment_definition_admin_summary");
    expect(projection.shape?.electricTable).toBe("assessment_definition");

    // The local table + client metadata are the SUBSET (PK + requested), heavy column dropped. The
    // registry-facing helpers take a loose `SyncTableEntry`, so view the precisely-typed projection as
    // one (the runtime path in the proxy/config builder uses exactly this loose form).
    const entry = projection as SyncTableEntry;
    expect(Object.keys(getColumns(projection.localTable)).sort()).toEqual(["id", "title", "updatedAtUs"].sort());
    expect(getProjectedColumnNames(entry).sort()).toEqual(["id", "title", "updated_at_us"].sort());
    expect(
      deriveSyncColumnTypes(entry)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["id", "title", "updated_at_us"].sort());
    expect((entry.clientProjection?.omitColumns ?? []).slice().sort()).toEqual(["heavyBlob", "ownerId"].sort());

    // The Electric `columns` allow-list keeps the heavy column off the wire (not merely stripped after).
    expect(projection.shape?.rowFilter?.columns?.slice().sort()).toEqual(["id", "title", "updated_at_us"].sort());
    expect(projection.shape?.rowFilter?.revision).toBe("admin-summary-1");

    // The rowFilter callback receives the OWNER's FULL columns (customWhere runs in Electric on the
    // physical table) — including a column the local subset omits.
    expect(callbackKeys).toContain("ownerId");
    expect(callbackKeys).toContain("heavyBlob");
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

describe("buildRowFilterWhere (inline string view of customWhere)", () => {
  // The only filter mechanism is `customWhere` now (ownership/shared built-ins were removed). The
  // inline-string view returns a string `customWhere` verbatim (the raw escape hatch) and `null`
  // otherwise — a Drizzle SQL fragment is parameterized by buildRowFilterShape, not inlined here.
  it("returns a string customWhere verbatim", () => {
    const filter = { customWhere: (claims: JwtClaims) => (claims.sub ? `"owner_id" = '${claims.sub}'` : "1 = 0") };

    expect(buildRowFilterWhere(filter, { sub: "user-1" })).toBe(`"owner_id" = 'user-1'`);
    expect(buildRowFilterWhere(filter, null)).toBe("1 = 0");
  });

  it("returns null when there is no filter, or customWhere yields a SQL fragment / null / empty", () => {
    expect(buildRowFilterWhere({}, { sub: "user-1" })).toBeNull();
    expect(buildRowFilterWhere({ customWhere: () => null }, { sub: "user-1" })).toBeNull();
    expect(buildRowFilterWhere({ customWhere: () => "" }, { sub: "user-1" })).toBeNull();
    // A Drizzle SQL fragment is the parameterized path — not an inline string.
    expect(buildRowFilterWhere({ customWhere: () => sql`"owner_id" = ${"user-1"}` }, { sub: "user-1" })).toBeNull();
  });
});

describe("ADR-0021 sync lifecycle axes (subscription, retention)", () => {
  const makeRefColumns = () => ({
    id: uuid("id").primaryKey(),
    label: varchar("label", { length: 80 }).notNull(),
  });

  it("carries subscription/retention on the entry; absent → omitted (default eager/persistent)", () => {
    const lazyEphemeral = defineSyncTable({
      tableName: "ref_lazy",
      makeColumns: makeRefColumns,
      subscription: "lazy",
      retention: "ephemeral",
    });
    expect(lazyEphemeral.subscription).toBe("lazy");
    expect(lazyEphemeral.retention).toBe("ephemeral");

    const plain = defineSyncTable({ tableName: "ref_plain", makeColumns: makeRefColumns });
    expect(plain.subscription).toBeUndefined();
    expect(plain.retention).toBeUndefined();
  });

  it("rejects an invalid subscription or retention value", () => {
    expect(() =>
      defineSyncTable({ tableName: "ref_bad_sub", makeColumns: makeRefColumns, subscription: "sometimes" as never }),
    ).toThrow(/invalid subscription/);
    expect(() =>
      defineSyncTable({ tableName: "ref_bad_ret", makeColumns: makeRefColumns, retention: "forever" as never }),
    ).toThrow(/invalid retention/);
  });

  it("rejects a consistency group that mixes subscription OR retention (ADR-0021 §4)", () => {
    expect(() =>
      defineSyncRegistry({
        a: defineSyncTable({
          tableName: "grp_a",
          makeColumns: makeRefColumns,
          consistencyGroup: "g",
          subscription: "lazy",
        }),
        b: defineSyncTable({
          tableName: "grp_b",
          makeColumns: makeRefColumns,
          consistencyGroup: "g",
          subscription: "eager",
        }),
      }),
    ).toThrow(/mixes lifecycle/);

    expect(() =>
      defineSyncRegistry({
        a: defineSyncTable({
          tableName: "grp_ra",
          makeColumns: makeRefColumns,
          consistencyGroup: "gr",
          retention: "ephemeral",
        }),
        b: defineSyncTable({
          tableName: "grp_rb",
          makeColumns: makeRefColumns,
          consistencyGroup: "gr",
          retention: "persistent",
        }),
      }),
    ).toThrow(/mixes lifecycle/);
  });

  it("accepts a uniform group, and leaves ungrouped singletons unconstrained", () => {
    expect(() =>
      defineSyncRegistry({
        a: defineSyncTable({
          tableName: "grp2_a",
          makeColumns: makeRefColumns,
          consistencyGroup: "g2",
          subscription: "lazy",
          retention: "ephemeral",
        }),
        b: defineSyncTable({
          tableName: "grp2_b",
          makeColumns: makeRefColumns,
          consistencyGroup: "g2",
          subscription: "lazy",
          retention: "ephemeral",
        }),
      }),
    ).not.toThrow();

    // No consistencyGroup → each table is its own singleton group, so differing lifecycle is fine.
    expect(() =>
      defineSyncRegistry({
        a: defineSyncTable({ tableName: "solo_a", makeColumns: makeRefColumns, subscription: "lazy" }),
        b: defineSyncTable({ tableName: "solo_b", makeColumns: makeRefColumns, subscription: "eager" }),
      }),
    ).not.toThrow();
  });

  const writableWriteModeTable = (
    tableName: string,
    extra: { consistencyGroup?: string; writeMode?: "optimistic" | "pessimistic" },
  ) =>
    defineSyncTable({
      tableName,
      makeColumns: makeProjectedContractsColumns,
      mode: "readwrite",
      conflictPolicy: "last-write-wins",
      governance: {
        managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
      },
      ...extra,
    });

  it("carries writeMode on the entry; absent → omitted, invalid rejected, pessimistic-on-readonly rejected (ADR-0022)", () => {
    expect(writableWriteModeTable("wm_seats", { writeMode: "pessimistic" }).writeMode).toBe("pessimistic");

    // Absent → omitted (consumers default to optimistic).
    expect(defineSyncTable({ tableName: "wm_plain", makeColumns: makeRefColumns }).writeMode).toBeUndefined();

    // An invalid value is rejected regardless of mode.
    expect(() =>
      defineSyncTable({ tableName: "wm_bad", makeColumns: makeRefColumns, writeMode: "maybe" as never }),
    ).toThrow(/invalid writeMode/);

    // `pessimistic` on a readonly table is meaningless — it governs a write path the table does not have.
    expect(() =>
      defineSyncTable({ tableName: "wm_ro", makeColumns: makeRefColumns, writeMode: "pessimistic" }),
    ).toThrow(/cannot be pessimistic/);
  });

  it("rejects a consistency group that mixes write-mode, accepts a uniform pessimistic one (ADR-0022 §1)", () => {
    // A pessimistic consistency group IS a standing atomic write-unit, so a group cannot be partly pessimistic.
    expect(() =>
      defineSyncRegistry({
        a: writableWriteModeTable("wm_grp_a", { consistencyGroup: "wg", writeMode: "pessimistic" }),
        b: writableWriteModeTable("wm_grp_b", { consistencyGroup: "wg", writeMode: "optimistic" }),
      }),
    ).toThrow(/mixes lifecycle/);

    expect(() =>
      defineSyncRegistry({
        a: writableWriteModeTable("wm_grp2_a", { consistencyGroup: "wg2", writeMode: "pessimistic" }),
        b: writableWriteModeTable("wm_grp2_b", { consistencyGroup: "wg2", writeMode: "pessimistic" }),
      }),
    ).not.toThrow();
  });
});

describe("authoritative write protocol (ADR-0022)", () => {
  const envelope = {
    tableName: "seats",
    entityKey: { id: "01963227-d4c7-72db-b858-f89f6af8fc01" },
    mutationId: "01963227-d4c7-72db-b858-f89f6af8fc02",
    mutationSeq: 1,
    kind: "create" as const,
    payload: { label: "x" },
    clientTimestampUs: "1700000000000000",
  };

  it("validates an authoritative write request — one unit of mutations, optional unit id", () => {
    expect(() => authoritativeWriteRequestSchema.parse({ writeUnit: "u-1", mutations: [envelope] })).not.toThrow();
    // writeUnit is optional: a statically-pessimistic group derives its unit from the group key.
    expect(() => authoritativeWriteRequestSchema.parse({ mutations: [envelope] })).not.toThrow();
    // at least one mutation is required.
    expect(() => authoritativeWriteRequestSchema.parse({ mutations: [] })).toThrow();
  });

  it("accepts a `rejected` ack carrying a typed rejectionReason (ADR-0022 §4)", () => {
    const ack = {
      tableName: "seats",
      entityKey: { id: "01963227-d4c7-72db-b858-f89f6af8fc01" },
      mutationId: "01963227-d4c7-72db-b858-f89f6af8fc02",
      mutationSeq: 1,
      status: "rejected" as const,
      rejectionReason: "full: the cohort has no remaining seats",
      httpStatus: 409,
    };
    expect(mutationAckSchema.parse(ack).status).toBe("rejected");
    // The old transport statuses still validate.
    expect(mutationAckSchema.parse({ ...ack, status: "acked", rejectionReason: undefined }).status).toBe("acked");
  });
});
