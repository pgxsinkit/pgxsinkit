import { describe, expect, it } from "bun:test";

import { bigint, integer, jsonb, pgEnum, pgSchema, real, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { buildSyntheticRegistry, buildSyntheticRegistrySchemaName, demoSyncRegistry } from "@pgxsinkit/schema";

import {
  buildDropReadCacheSql,
  generateDurableLocalSchemaSql,
  generateEphemeralLocalSchemaSql,
  generateLocalSchemaSql,
} from "../../packages/client/src/schema";
import { createFreshTestPGlite } from "../support/pglite";

const projectedClientRegistry = defineSyncRegistry({
  projectedItems: defineSyncTable({
    tableName: "projected_client_items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      ownerId: uuid("owner_id").notNull(),
      modifiedBy: uuid("modified_by"),
      title: varchar("title", { length: 120 }).notNull(),
      notes: varchar("notes", { length: 255 }),
      createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    clientProjection: {
      omitColumns: ["ownerId", "modifiedBy", "notes"],
    },
    governance: {
      managedFields: [
        { column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
        { column: "modifiedBy", applyOn: ["create", "update"], strategy: "authClaim", claimPath: ["sub"] },
        { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
        { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
      ],
    },
  }),
});

const readonlyStatusEnum = pgEnum("readonly_status", ["queued", "done"]);

const compositeReadonlyRegistry = defineSyncRegistry({
  compositeReadonlyItems: defineSyncTable({
    tableName: "composite_readonly_items",
    makeColumns: () => ({
      id: uuid("id").notNull(),
      ownerId: uuid("owner_id").notNull(),
      status: readonlyStatusEnum("status").notNull(),
      words: integer("words").array(),
      payload: jsonb("payload"),
      efactor: real("efactor").notNull(),
    }),
    primaryKey: ["id", "owner_id"],
  }),
});

const workspaceLocalSchema = pgSchema("workspace_local");
const workspaceReadonlyStatusEnum = workspaceLocalSchema.enum("workspace_readonly_status", ["queued", "done"]);

const fallbackReadModelRegistry = defineSyncRegistry({
  fallbackReadModelItems: defineSyncTable({
    tableName: "fallback_read_model_items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

const workspaceReadonlyRegistry = defineSyncRegistry({
  schema: "workspace_local",
  tables: {
    workspaceReadonlyItems: defineSyncTable({
      tableName: "workspace_readonly_items",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        status: workspaceReadonlyStatusEnum("status").notNull(),
      }),
      schema: workspaceLocalSchema,
    }),
  },
});

describe("client local schema generation", () => {
  it("generates local synced, overlay, journal, and read-model SQL from the registry", () => {
    const sql = generateLocalSchemaSql(demoSyncRegistry);

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS authors");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS authors_overlay");
    expect(sql).toContain(
      "CREATE SEQUENCE IF NOT EXISTS authors_mutations_mutation_seq AS integer START WITH 1 INCREMENT BY 1;",
    );
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS authors_mutations");
    expect(sql).toContain("CREATE OR REPLACE VIEW authors_read_model AS");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS todos");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS todos_overlay");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS todos_mutations");
    expect(sql).toContain("CREATE OR REPLACE VIEW todos_read_model AS");
    expect(sql).toContain("entity_key_json TEXT NOT NULL");
    expect(sql).toContain(
      "mutation_seq INTEGER NOT NULL UNIQUE DEFAULT nextval('authors_mutations_mutation_seq')::integer",
    );
    expect(sql).not.toContain("UNIQUE (entity_key_json, mutation_seq)");
    expect(sql).toContain("authors_mutations_status_retry_idx");
    expect(sql).toContain("authors_mutations_entity_status_seq_idx");
  });

  it("qualifies local tables and views when the registry schema is non-public", () => {
    const schemaName = buildSyntheticRegistrySchemaName({
      tableCount: 2,
      extraColumnCount: 8,
    });
    const { registry } = buildSyntheticRegistry({
      tableCount: 2,
      extraColumnCount: 8,
      schemaName,
    });
    const sql = generateLocalSchemaSql(registry);

    expect(sql).toContain(`CREATE SCHEMA IF NOT EXISTS "${schemaName}";`);
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${schemaName}"."perf_items_000"`);
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${schemaName}"."perf_items_000_overlay"`);
    expect(sql).toContain(
      `CREATE SEQUENCE IF NOT EXISTS "${schemaName}"."perf_items_000_mutations_mutation_seq" AS integer START WITH 1 INCREMENT BY 1;`,
    );
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${schemaName}"."perf_items_000_mutations"`);
    expect(sql).toContain(`CREATE OR REPLACE VIEW "${schemaName}"."perf_items_000_read_model" AS`);
  });

  // Regression: the test above only asserts the generated SQL *string*. A schema-qualified writable
  // registry also emits the reconcile trigger/function — whose name was built by suffixing the
  // already-qualified table name (`"s"."t"_reconcile_on_sync`), invalid SQL no string assertion
  // caught. Generated DDL must be *executed*, not just pattern-matched.
  it("executes a non-public writable registry's generated schema (trigger/function/views) in PGlite", async () => {
    const schemaName = buildSyntheticRegistrySchemaName({ tableCount: 1, extraColumnCount: 4 });
    const { registry } = buildSyntheticRegistry({ tableCount: 1, extraColumnCount: 4, schemaName });

    const db = await createFreshTestPGlite();
    try {
      // generate → drop the read cache → regenerate: exercises both the CREATE and DROP paths for the
      // schema-qualified function (qualified) and trigger (unqualified).
      await db.exec(generateLocalSchemaSql(registry));
      await db.exec(buildDropReadCacheSql(registry));
      await db.exec(generateLocalSchemaSql(registry));

      const view = await db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "${schemaName}"."perf_items_000_sync_state"`,
      );
      expect(view.rows[0]?.count).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("omits projected-away columns from synced, overlay, and read-model SQL", () => {
    const sql = generateLocalSchemaSql(projectedClientRegistry);

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS projected_client_items");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS projected_client_items_overlay");
    expect(sql).toContain("CREATE OR REPLACE VIEW projected_client_items_read_model AS");
    expect(sql).toContain("title varchar(120) NOT NULL");
    expect(sql).not.toContain("owner_id uuid");
    expect(sql).not.toContain("modified_by uuid");
    expect(sql).not.toContain("notes varchar(255)");
  });

  it("preserves SQL column types and composite readonly primary keys", () => {
    const sql = generateLocalSchemaSql(compositeReadonlyRegistry);
    const enumTypeSql = "CREATE TYPE readonly_status AS ENUM ('queued', 'done');";
    const enumTypeSqlIndex = sql.indexOf(enumTypeSql);
    const tableSqlIndex = sql.indexOf("CREATE TABLE IF NOT EXISTS composite_readonly_items");

    expect(enumTypeSqlIndex).toBeGreaterThanOrEqual(0);
    expect(tableSqlIndex).toBeGreaterThan(enumTypeSqlIndex);
    expect(sql).toContain("n.nspname = 'public'");
    expect(sql).toContain("status readonly_status NOT NULL");
    expect(sql).toContain("words integer[]");
    expect(sql).toContain("payload jsonb");
    expect(sql).toContain("efactor real NOT NULL");
    expect(sql).toContain("PRIMARY KEY (id, owner_id)");
    expect(sql).not.toContain("id uuid NOT NULL PRIMARY KEY,");
    expect(sql).not.toContain("owner_id uuid NOT NULL PRIMARY KEY");
  });

  it("derives the read-model local timestamp from the Server version column", () => {
    // ADR-0010 guarantees a writable table carries updated_at_us, so the read model's synced
    // branch always sources local_updated_at_us from t.updated_at_us — the prior CAST(0) fallback
    // is unreachable for a conventionally-named Server version.
    const sql = generateLocalSchemaSql(fallbackReadModelRegistry);

    expect(sql).toContain("t.updated_at_us AS local_updated_at_us");
    expect(sql).not.toContain("CAST(0 AS BIGINT) AS local_updated_at_us");
  });

  it("creates and qualifies enum types for non-public local schemas", () => {
    const sql = generateLocalSchemaSql(workspaceReadonlyRegistry);

    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "workspace_local";');
    expect(sql).toContain("WHERE t.typname = 'workspace_readonly_status'");
    expect(sql).toContain("AND n.nspname = 'workspace_local'");
    expect(sql).toContain("CREATE TYPE \"workspace_local\".\"workspace_readonly_status\" AS ENUM ('queued', 'done');");
    expect(sql).toContain('status "workspace_local"."workspace_readonly_status" NOT NULL');
  });

  it("quotes a public-schema table name that collides with a reserved SQL keyword", () => {
    // `group` is a valid Postgres identifier but a reserved keyword, so it must be quoted in the
    // generated DDL or it fails to parse. Simple non-reserved names stay bare (output stays stable).
    const reservedWordRegistry = defineSyncRegistry({
      group: defineSyncTable({
        tableName: "group",
        makeColumns: () => ({
          id: uuid("id").primaryKey(),
          ownerId: uuid("owner_id").notNull(),
        }),
        primaryKey: ["id"],
      }),
    });

    const sql = generateLocalSchemaSql(reservedWordRegistry);

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "group" (');
    // The bare reserved word is never emitted unquoted as a table reference.
    expect(sql).not.toContain("CREATE TABLE IF NOT EXISTS group ");
    expect(sql).not.toContain("CREATE TABLE IF NOT EXISTS group(");
  });

  // Slice 3 (durable-schema fingerprint fast path): the generator is partitioned on the `retention`
  // axis. The full `generateLocalSchemaSql` output must equal the durable + ephemeral concatenation.
  describe("durable/ephemeral generator split (slice 3)", () => {
    const mixedRegistry = defineSyncRegistry({
      // Persistent writable entry.
      persistentNotes: defineSyncTable({
        tableName: "persistent_notes",
        makeColumns: () => ({
          id: uuid("id").primaryKey(),
          body: varchar("body", { length: 200 }).notNull(),
          updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
        }),
        mode: "readwrite",
        conflictPolicy: "last-write-wins",
        governance: {
          managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
        },
      }),
      // Ephemeral (ADR-0021 §3) writable entry — its whole cluster is TEMP / pg_temp.
      ephemeralScratch: defineSyncTable({
        tableName: "ephemeral_scratch",
        retention: "ephemeral",
        makeColumns: () => ({
          id: uuid("id").primaryKey(),
          note: varchar("note", { length: 200 }),
          updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
        }),
        mode: "readwrite",
        conflictPolicy: "last-write-wins",
        governance: {
          managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
        },
      }),
    });

    it("generateLocalSchemaSql equals the durable + ephemeral concatenation for a mixed registry", () => {
      const durable = generateDurableLocalSchemaSql(mixedRegistry);
      const ephemeral = generateEphemeralLocalSchemaSql(mixedRegistry);

      // Documented equivalent ordering: durable clusters first, then the ephemeral portion, joined by the
      // generator's `\n\n` statement separator (the durable script's trailing newline is the seam).
      expect(ephemeral).not.toBe("");
      expect(generateLocalSchemaSql(mixedRegistry)).toBe(`${durable.trimEnd()}\n\n${ephemeral}`);

      // The durable half carries the persistent cluster + meta bootstrap; the ephemeral half the TEMP cluster.
      expect(durable).toContain("CREATE TABLE IF NOT EXISTS pgxsinkit_local_meta");
      expect(durable).toContain("CREATE TABLE IF NOT EXISTS persistent_notes (");
      expect(durable).not.toContain("ephemeral_scratch");
      expect(ephemeral).toContain("CREATE TEMP TABLE IF NOT EXISTS ephemeral_scratch (");
      // The durable portion carries no all-mutations view — it is TEMP (slice 4), so it lives in the ephemeral
      // portion, which now also references the PERSISTENT journal in the view's UNION ALL.
      expect(durable).not.toContain("pgxsinkit_all_mutations");
      expect(ephemeral).toContain("CREATE OR REPLACE TEMP VIEW pgxsinkit_all_mutations AS");
      expect(ephemeral).toContain("FROM persistent_notes_mutations");
      expect(ephemeral).toContain("FROM ephemeral_scratch_mutations");
    });

    it("generateLocalSchemaSql keeps the durable script byte-for-byte, then the ephemeral all-mutations view", () => {
      // No ephemeral ENTRY, but a writable table → the ephemeral portion carries the always-applied
      // `pgxsinkit_all_mutations` TEMP VIEW (slice 4). The durable script is unchanged (fingerprint stable);
      // the full script is the durable script followed by that view.
      const durable = generateDurableLocalSchemaSql(demoSyncRegistry);
      const ephemeral = generateEphemeralLocalSchemaSql(demoSyncRegistry);
      expect(ephemeral).toContain("CREATE OR REPLACE TEMP VIEW pgxsinkit_all_mutations AS");
      expect(durable).not.toContain("pgxsinkit_all_mutations");
      expect(generateLocalSchemaSql(demoSyncRegistry)).toBe(`${durable.trimEnd()}\n\n${ephemeral}`);
    });
  });
});
