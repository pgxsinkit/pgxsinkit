import { describe, expect, it } from "bun:test";

import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { demoSyncRegistry } from "@pgxsinkit/schema";

import { buildPlpgsqlBatchFunctionDdl } from "../../packages/server/src/mutations/plpgsql-apply";
import { createFreshTestPGlite } from "../support/pglite";

const projectedPlpgsqlRegistry = defineSyncRegistry({
  projectedItems: defineSyncTable({
    tableName: "projected_plpgsql_items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      ownerId: uuid("owner_id").notNull(),
      internalNote: varchar("internal_note", { length: 120 }),
      title: varchar("title", { length: 120 }).notNull(),
      createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    clientProjection: {
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
    // ADR-0010: the Server version's on-update stamp is floored at the prior value + 1 (strictly
    // monotonic), not a bare clock read — so an inverted wall clock can never lower it.
    expect(ddl).toContain(
      '"updated_at_us" = GREATEST(CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT), "updated_at_us" + 1)',
    );
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

  it("captures and restores the caller's role/claims so the RLS context does not leak", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(demoSyncRegistry);

    // The actor role/claims are snapshotted before switching into the RLS context...
    expect(ddl).toContain("_previous_role := current_setting('role', true)");
    expect(ddl).toContain("_previous_claims := current_setting('request.jwt.claims', true)");
    expect(ddl).toContain("_previous_claim_sub := current_setting('request.jwt.claim.sub', true)");

    // ...and restored after the batch, so in-transaction callers (which cannot RESET ROLE
    // around the call the way the HTTP route does) are left exactly as they were found.
    expect(ddl).toContain("set_config('role', COALESCE(NULLIF(_previous_role, ''), 'none'), true)");
    expect(ddl).toContain("set_config('request.jwt.claims', COALESCE(_previous_claims, ''), true)");
    expect(ddl).toContain("set_config('request.jwt.claim.sub', COALESCE(_previous_claim_sub, ''), true)");
  });
});

// ADR-0012: the applier matches update/delete over the FULL server primary-key tuple, by column
// name with per-column casts — not `primaryKey.columns[0]`.
const compositeThingsRegistry = defineSyncRegistry({
  compositeThings: defineSyncTable({
    tableName: "composite_things",
    makeColumns: () => ({
      tenantId: uuid("tenant_id").notNull(),
      id: uuid("id").notNull(),
      label: varchar("label", { length: 120 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    primaryKey: ["tenant_id", "id"],
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

// ADR-0012: a PK whose drizzle property name (`groupId`) differs from its column name (`group_id`)
// must resolve by the COLUMN name everywhere the canonical identity is read.
const renamedPkRegistry = defineSyncRegistry({
  renamedPk: defineSyncTable({
    tableName: "renamed_pk_items",
    makeColumns: () => ({
      groupId: uuid("group_id").primaryKey(),
      label: varchar("label", { length: 120 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    primaryKey: ["group_id"],
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

function compositeBatch(
  kind: "create" | "update" | "delete",
  entityKey: Record<string, string>,
  payload: Record<string, string>,
) {
  return {
    mutations: [
      {
        tableName: "composite_things",
        kind,
        entityKey,
        payload,
        mutationId: "00000000-0000-4000-8000-000000000001",
        mutationSeq: 1,
        clientTimestampUs: "1000",
      },
    ],
  };
}

async function applyBatch(db: Awaited<ReturnType<typeof createFreshTestPGlite>>, batch: unknown) {
  await db.query(`SELECT pgxsinkit_apply_mutations($1::jsonb, '/test'::text, false, false, '{}'::jsonb)`, [
    JSON.stringify(batch),
  ]);
}

describe("canonical entity identity — composite + renamed PK (ADR-0012)", () => {
  it("matches update and delete over the full server primary-key tuple", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(compositeThingsRegistry);

    // update WHERE — inside the format() template, so its single quotes are doubled.
    expect(ddl).toContain(`"tenant_id" = ($2->>''tenant_id'')::uuid AND "id" = ($2->>''id'')::uuid`);
    // delete WHERE — direct PL/pgSQL.
    expect(ddl).toContain(`"tenant_id" = (v_entity_key->>'tenant_id')::uuid AND "id" = (v_entity_key->>'id')::uuid`);
  });

  it("resolves a property≠column primary key by its column name, never the drizzle property", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(renamedPkRegistry);

    expect(ddl).toContain(`"group_id" = ($2->>''group_id'')::uuid`);
    expect(ddl).toContain(`"group_id" = (v_entity_key->>'group_id')::uuid`);
    expect(ddl).not.toContain("groupId");
  });

  it("applies update/delete to exactly the addressed row of a composite-PK table", async () => {
    const db = await createFreshTestPGlite();

    try {
      await db.exec(`CREATE TABLE composite_things (
        tenant_id uuid NOT NULL,
        id uuid NOT NULL,
        label varchar(120) NOT NULL,
        updated_at_us bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, id)
      )`);
      await db.exec(buildPlpgsqlBatchFunctionDdl(compositeThingsRegistry));

      const tenant = "10000000-0000-4000-8000-000000000001";
      const idA = "20000000-0000-4000-8000-00000000000a";
      const idB = "20000000-0000-4000-8000-00000000000b";

      // Two rows share tenant_id and differ only on id — the exact case where a `columns[0]`-only
      // WHERE would match (and clobber) BOTH.
      await db.query(`INSERT INTO composite_things (tenant_id, id, label) VALUES ($1, $2, 'A'), ($1, $3, 'B')`, [
        tenant,
        idA,
        idB,
      ]);

      await applyBatch(db, compositeBatch("update", { tenant_id: tenant, id: idA }, { label: "A2" }));

      const afterUpdate = await db.query<{ id: string; label: string }>(
        `SELECT id, label FROM composite_things ORDER BY label`,
      );
      expect(afterUpdate.rows).toEqual([
        { id: idA, label: "A2" },
        { id: idB, label: "B" },
      ]);

      await applyBatch(db, compositeBatch("delete", { tenant_id: tenant, id: idA }, { tenant_id: tenant, id: idA }));

      const afterDelete = await db.query<{ id: string }>(`SELECT id FROM composite_things`);
      expect(afterDelete.rows).toEqual([{ id: idB }]);
    } finally {
      await db.close();
    }
  });

  it("keeps the Server version strictly monotonic even when the wall clock is behind (GREATEST)", async () => {
    const db = await createFreshTestPGlite();

    try {
      await db.exec(`CREATE TABLE composite_things (
        tenant_id uuid NOT NULL,
        id uuid NOT NULL,
        label varchar(120) NOT NULL,
        updated_at_us bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, id)
      )`);
      await db.exec(buildPlpgsqlBatchFunctionDdl(compositeThingsRegistry));

      const tenant = "10000000-0000-4000-8000-000000000002";
      const id = "20000000-0000-4000-8000-00000000000c";

      // Seed the row's Server version far ahead of the wall clock — the exact inverted-clock case
      // where a bare `clock_timestamp()` stamp would step the version BACKWARDS.
      const future = "9999999999999999";
      await db.query(
        `INSERT INTO composite_things (tenant_id, id, label, updated_at_us) VALUES ($1, $2, 'A', $3::bigint)`,
        [tenant, id, future],
      );

      await applyBatch(db, compositeBatch("update", { tenant_id: tenant, id }, { label: "A2" }));

      // clock_us << 9999999999999999, so GREATEST picks current + 1 — strictly greater, never lower.
      const row = await db.query<{ updatedAtUs: string }>(
        `SELECT updated_at_us::text AS "updatedAtUs" FROM composite_things WHERE id = $1`,
        [id],
      );
      expect(row.rows[0]?.updatedAtUs).toBe("10000000000000000");
    } finally {
      await db.close();
    }
  });
});
