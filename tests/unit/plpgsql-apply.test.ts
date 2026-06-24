import { describe, expect, it } from "bun:test";

import { bigint, integer, uuid, varchar } from "drizzle-orm/pg-core";

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
    conflictPolicy: "last-write-wins",
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
    conflictPolicy: "last-write-wins",
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
    conflictPolicy: "last-write-wins",
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
  await db.query(`SELECT * FROM pgxsinkit_apply_mutations($1::jsonb, '/test'::text, false, false, '{}'::jsonb)`, [
    JSON.stringify(batch),
  ]);
}

describe("canonical entity identity — composite + renamed PK (ADR-0012)", () => {
  it("matches update and delete over the full server primary-key tuple", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(compositeThingsRegistry);

    // Set-based update (ADR-0014 Phase 4) joins each row's entity key (x.k jsonb) over the FULL
    // tuple; inside the format() template, so its single quotes are doubled.
    expect(ddl).toContain(`t."tenant_id" = (x.k->>''tenant_id'')::uuid AND t."id" = (x.k->>''id'')::uuid`);
    // Set-based delete matches the recordset's typed PK columns directly, over the FULL tuple.
    expect(ddl).toContain(`x("tenant_id" uuid, "id" uuid)`);
    expect(ddl).toContain(`t."tenant_id" = x."tenant_id" AND t."id" = x."id"`);
  });

  it("resolves a property≠column primary key by its column name, never the drizzle property", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(renamedPkRegistry);

    expect(ddl).toContain(`t."group_id" = (x.k->>''group_id'')::uuid`);
    expect(ddl).toContain(`x("group_id" uuid)`);
    expect(ddl).toContain(`t."group_id" = x."group_id"`);
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

// ADR-0014 Phase 4: the applier groups a batch by (table, kind, payload column-set) and applies each
// group with one set-based statement (json_to_recordset), instead of one EXECUTE per mutation.
const groupTodosRegistry = defineSyncRegistry({
  todos: defineSyncTable({
    tableName: "group_todos",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
      priority: integer("priority").notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    primaryKey: ["id"],
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

const ID_A = "30000000-0000-4000-8000-00000000000a";
const ID_B = "30000000-0000-4000-8000-00000000000b";
const ID_C = "30000000-0000-4000-8000-00000000000c";

function todoMutation(
  kind: "create" | "update" | "delete",
  seq: number,
  entityKey: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  return {
    tableName: "group_todos",
    kind,
    entityKey,
    payload,
    mutationId: `00000000-0000-4000-8000-00000000000${seq}`,
    mutationSeq: seq,
    clientTimestampUs: "1000",
  };
}

async function applyMutations(db: Awaited<ReturnType<typeof createFreshTestPGlite>>, mutations: unknown[]) {
  await db.query(`SELECT * FROM pgxsinkit_apply_mutations($1::jsonb, '/test'::text, false, false, '{}'::jsonb)`, [
    JSON.stringify({ mutations }),
  ]);
}

describe("set-based apply — (table, kind, column-set) grouping (ADR-0014 Phase 4)", () => {
  async function freshDb() {
    const db = await createFreshTestPGlite();
    await db.exec(`CREATE TABLE group_todos (
      id uuid PRIMARY KEY,
      title varchar(120) NOT NULL,
      priority integer NOT NULL,
      updated_at_us bigint NOT NULL DEFAULT 0
    )`);
    await db.exec(buildPlpgsqlBatchFunctionDdl(groupTodosRegistry));
    return db;
  }

  it("inserts many rows of one (table, kind, column-set) in a single grouped statement, stamping managed fields", async () => {
    const db = await freshDb();
    try {
      await applyMutations(db, [
        todoMutation("create", 1, { id: ID_A }, { id: ID_A, title: "A", priority: 1 }),
        todoMutation("create", 2, { id: ID_B }, { id: ID_B, title: "B", priority: 2 }),
      ]);

      const rows = await db.query<{ id: string; title: string; priority: number; stamped: boolean }>(
        `SELECT id, title, priority, (updated_at_us > 0) AS stamped FROM group_todos ORDER BY title`,
      );
      expect(rows.rows).toEqual([
        { id: ID_A, title: "A", priority: 1, stamped: true },
        { id: ID_B, title: "B", priority: 2, stamped: true },
      ]);
    } finally {
      await db.close();
    }
  });

  it("groups partial updates by column-set so each row's untouched columns survive, and bumps every Server version", async () => {
    const db = await freshDb();
    try {
      await db.query(`INSERT INTO group_todos (id, title, priority, updated_at_us) VALUES ($1,'A',1,5), ($2,'B',2,5)`, [
        ID_A,
        ID_B,
      ]);

      // Row A updates only title (column-set {title}); row B only priority (column-set {priority}) —
      // two distinct groups. A single uniform UPDATE..FROM would null the other column on each row.
      await applyMutations(db, [
        todoMutation("update", 1, { id: ID_A }, { title: "A2" }),
        todoMutation("update", 2, { id: ID_B }, { priority: 99 }),
      ]);

      const rows = await db.query<{ id: string; title: string; priority: number; bumped: boolean }>(
        `SELECT id, title, priority, (updated_at_us > 5) AS bumped FROM group_todos ORDER BY id`,
      );
      expect(rows.rows).toEqual([
        { id: ID_A, title: "A2", priority: 1, bumped: true }, // priority untouched
        { id: ID_B, title: "B", priority: 99, bumped: true }, // title untouched
      ]);
    } finally {
      await db.close();
    }
  });

  it("applies a mixed create/update/delete batch across groups in one call", async () => {
    const db = await freshDb();
    try {
      await db.query(
        `INSERT INTO group_todos (id, title, priority, updated_at_us) VALUES ($1,'old',1,5), ($2,'doomed',2,5)`,
        [ID_A, ID_B],
      );

      await applyMutations(db, [
        todoMutation("create", 1, { id: ID_C }, { id: ID_C, title: "C", priority: 3 }),
        todoMutation("update", 2, { id: ID_A }, { title: "new" }),
        todoMutation("delete", 3, { id: ID_B }, { id: ID_B }),
      ]);

      const rows = await db.query<{ id: string; title: string }>(`SELECT id, title FROM group_todos ORDER BY id`);
      expect(rows.rows).toEqual([
        { id: ID_A, title: "new" }, // updated
        { id: ID_C, title: "C" }, // created (ID_B deleted)
      ]);
    } finally {
      await db.close();
    }
  });
});

// ADR-0015 Phase 3: server-side stale-write detection. The applier compares each row's CURRENT
// Server version to the mutation's Base server version and acts per the table's Conflict policy.
const lwwConflictRegistry = defineSyncRegistry({
  things: defineSyncTable({
    tableName: "lww_things",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      label: varchar("label", { length: 120 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    primaryKey: ["id"],
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

const rejectConflictRegistry = defineSyncRegistry({
  things: defineSyncTable({
    tableName: "reject_things",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      label: varchar("label", { length: 120 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    primaryKey: ["id"],
    conflictPolicy: "reject-if-stale",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

const CONFLICT_ID = "40000000-0000-4000-8000-00000000000a";

function conflictMutation(
  tableName: string,
  kind: "update" | "delete",
  payload: Record<string, unknown>,
  baseServerVersion: string | null,
) {
  return {
    tableName,
    kind,
    entityKey: { id: CONFLICT_ID },
    payload,
    mutationId: "50000000-0000-4000-8000-00000000000a",
    mutationSeq: 1,
    clientTimestampUs: "1000",
    ...(baseServerVersion != null ? { baseServerVersion } : {}),
  };
}

/** Applies a batch and returns the conflicts the function reports (ADR-0015). */
async function applyForConflicts(
  db: Awaited<ReturnType<typeof createFreshTestPGlite>>,
  mutations: unknown[],
): Promise<Array<{ mutationId: string; tableName: string; currentServerVersion: string }>> {
  const result = await db.query<{ mutationId: string; tableName: string; currentServerVersion: string }>(
    `SELECT mutation_id::text AS "mutationId", table_name AS "tableName", current_server_version::text AS "currentServerVersion"
     FROM pgxsinkit_apply_mutations($1::jsonb, '/test'::text, false, false, '{}'::jsonb)`,
    [JSON.stringify({ mutations })],
  );
  return result.rows;
}

describe("stale-write conflict detection (ADR-0015 Phase 3)", () => {
  async function seedThing(table: string, registry: Parameters<typeof buildPlpgsqlBatchFunctionDdl>[0]) {
    const db = await createFreshTestPGlite();
    await db.exec(`CREATE TABLE ${table} (
      id uuid PRIMARY KEY,
      label varchar(120) NOT NULL,
      updated_at_us bigint NOT NULL DEFAULT 0
    )`);
    await db.exec(buildPlpgsqlBatchFunctionDdl(registry));
    // The row sits at version 100; an external writer then advances it to 200 (the interleave).
    await db.query(`INSERT INTO ${table} (id, label, updated_at_us) VALUES ($1, 'original', 200)`, [CONFLICT_ID]);
    return db;
  }

  it("last-write-wins applies a stale update anyway and reports no conflict", async () => {
    const db = await seedThing("lww_things", lwwConflictRegistry);
    try {
      // base 100 < current 200 → stale. last-write-wins applies it regardless.
      const conflicts = await applyForConflicts(db, [
        conflictMutation("lww_things", "update", { label: "clobbered" }, "100"),
      ]);

      expect(conflicts).toEqual([]);
      const row = await db.query<{ label: string }>(`SELECT label FROM lww_things WHERE id = $1`, [CONFLICT_ID]);
      expect(row.rows[0]?.label).toBe("clobbered");
    } finally {
      await db.close();
    }
  });

  it("reject-if-stale leaves the row untouched and reports the conflict with the current Server version", async () => {
    const db = await seedThing("reject_things", rejectConflictRegistry);
    try {
      // base 100 < current 200 → stale. reject-if-stale must NOT apply, and must report it.
      const conflicts = await applyForConflicts(db, [
        conflictMutation("reject_things", "update", { label: "rejected" }, "100"),
      ]);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.mutationId).toBe("50000000-0000-4000-8000-00000000000a");
      expect(conflicts[0]?.tableName).toBe("reject_things");
      expect(conflicts[0]?.currentServerVersion).toBe("200");

      // The row keeps the external writer's value — the stale write was not applied.
      const row = await db.query<{ label: string }>(`SELECT label FROM reject_things WHERE id = $1`, [CONFLICT_ID]);
      expect(row.rows[0]?.label).toBe("original");
    } finally {
      await db.close();
    }
  });

  it("reject-if-stale applies a non-stale update (base == current) and reports no conflict", async () => {
    const db = await seedThing("reject_things", rejectConflictRegistry);
    try {
      // base 200 == current 200 → not stale. The write applies and bumps the Server version.
      const conflicts = await applyForConflicts(db, [
        conflictMutation("reject_things", "update", { label: "fresh" }, "200"),
      ]);

      expect(conflicts).toEqual([]);
      const row = await db.query<{ label: string; bumped: boolean }>(
        `SELECT label, (updated_at_us > 200) AS bumped FROM reject_things WHERE id = $1`,
        [CONFLICT_ID],
      );
      expect(row.rows[0]?.label).toBe("fresh");
      expect(row.rows[0]?.bumped).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("reject-if-stale UPDATE of a MISSING row → conflict (target deleted), nothing applied (#6)", async () => {
    const db = await seedThing("reject_things", rejectConflictRegistry);
    try {
      // An external writer DELETED the row after the client authored its update.
      await db.query(`DELETE FROM reject_things WHERE id = $1`, [CONFLICT_ID]);

      const conflicts = await applyForConflicts(db, [
        conflictMutation("reject_things", "update", { label: "edit on a gone row" }, "100"),
      ]);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.mutationId).toBe("50000000-0000-4000-8000-00000000000a");
      // A NULL currentServerVersion is the discriminator: the target no longer exists (not a version
      // clash). Without this the edit would silently no-op and ack as success.
      expect(conflicts[0]?.currentServerVersion ?? null).toBeNull();

      // The update did NOT resurrect the row.
      const row = await db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM reject_things WHERE id = $1`, [
        CONFLICT_ID,
      ]);
      expect(row.rows[0]?.count).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("reject-if-stale DELETE of a missing row stays idempotent success — NOT a conflict (#6)", async () => {
    const db = await seedThing("reject_things", rejectConflictRegistry);
    try {
      await db.query(`DELETE FROM reject_things WHERE id = $1`, [CONFLICT_ID]);

      const conflicts = await applyForConflicts(db, [
        conflictMutation("reject_things", "delete", { id: CONFLICT_ID }, "100"),
      ]);

      // Deleting an already-gone row is idempotent success; surfacing it as a conflict would be wrong.
      expect(conflicts).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("reject-if-stale with no base (a create-like legacy write) skips the stale check and applies", async () => {
    const db = await seedThing("reject_things", rejectConflictRegistry);
    try {
      // No baseServerVersion ⇒ no stale check; the write applies (degrades to last-write-wins).
      const conflicts = await applyForConflicts(db, [
        conflictMutation("reject_things", "update", { label: "no-base" }, null),
      ]);

      expect(conflicts).toEqual([]);
      const row = await db.query<{ label: string }>(`SELECT label FROM reject_things WHERE id = $1`, [CONFLICT_ID]);
      expect(row.rows[0]?.label).toBe("no-base");
    } finally {
      await db.close();
    }
  });

  it("reject-if-stale rejects a stale delete and keeps the row", async () => {
    const db = await seedThing("reject_things", rejectConflictRegistry);
    try {
      const conflicts = await applyForConflicts(db, [
        conflictMutation("reject_things", "delete", { id: CONFLICT_ID }, "100"),
      ]);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.currentServerVersion).toBe("200");
      const row = await db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM reject_things WHERE id = $1`, [
        CONFLICT_ID,
      ]);
      expect(row.rows[0]?.count).toBe(1);
    } finally {
      await db.close();
    }
  });
});
