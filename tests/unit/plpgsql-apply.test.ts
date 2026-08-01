import { describe, expect, it } from "bun:test";

import { asc, count, eq, sql } from "drizzle-orm";
import { bigint, integer, uuid, varchar, type AnyPgTable } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { demoSyncRegistry } from "@pgxsinkit/schema";
import { operationsLogTable } from "@pgxsinkit/server";

import {
  buildPlpgsqlBatchFunctionDdl,
  expectedApplyFingerprint,
} from "../../packages/server/src/mutations/plpgsql-apply";
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

// ADR-0030: the apply function now takes a trailing p_expected_fingerprint and verifies itself against
// its stamped comment before touching any table. For the behavioural tests below (which are NOT testing
// drift), read back the fingerprint the installed function was stamped with, so the self-check passes and
// the apply runs. The dedicated self-verification suite exercises the mismatch/absent-comment paths.
async function installedApplyFingerprint(db: Awaited<ReturnType<typeof createFreshTestPGlite>>): Promise<string> {
  const res = await db.query<{ fp: string | null }>(
    `SELECT obj_description(to_regprocedure('public.pgxsinkit_apply_mutations(jsonb,text,boolean,boolean,jsonb,text)')::oid, 'pg_proc') AS fp`,
  );
  return res.rows[0]?.fp ?? "";
}

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
        { column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
        { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
        { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
      ],
    },
  }),
});

/** One table branch of the generated DDL, sliced out by its `ELSIF v_table = '<name>'` guard. */
function tableBranch(ddl: string, tableName: string): string {
  const branchStart = ddl.indexOf(`ELSIF v_table = '${tableName}' THEN`);
  expect(branchStart).toBeGreaterThan(-1);
  const nextBranch = ddl.indexOf("ELSIF v_table = '", branchStart + 1);
  return ddl.slice(branchStart, nextBranch === -1 ? undefined : nextBranch);
}

/**
 * The `(column name, payload value expression)` candidate rows a table branch offers for one of its two
 * runtime column lists: the INSERT list (`INTO v_cols, v_vals`) or the UPDATE SET list (`INTO v_set`).
 * Each is a `(VALUES ('col','<expr>'), …) AS col_types(col_name, col_value)` block the generated
 * function intersects with the group's payload signature — so a column absent here can never be written
 * by a payload key. Rows are one per line, and only a row STARTS a line, so the value expression (which
 * carries doubled single quotes of its own) cannot confuse the split.
 */
function candidateRows(ddl: string, tableName: string, into: "v_cols, v_vals" | "v_set"): Array<[string, string]> {
  const branch = tableBranch(ddl, tableName);

  const intoAt = branch.indexOf(`INTO ${into}`);
  if (intoAt === -1) {
    // The generator emits `v_set := NULL;` / `v_cols := NULL; v_vals := NULL;` when no column qualifies.
    return [];
  }
  const valuesAt = branch.indexOf("FROM (VALUES", intoAt);
  const valuesEnd = branch.indexOf(") AS col_types", valuesAt);
  return branch
    .slice(valuesAt, valuesEnd)
    .split("\n")
    .flatMap((line) => {
      const match = /^\('([^']*)', '(.*)'\),?$/.exec(line.trim());
      return match ? [[match[1]!, match[2]!] as [string, string]] : [];
    });
}

/** Just the candidate column NAMES of one runtime column list. */
function candidateColumns(ddl: string, tableName: string, into: "v_cols, v_vals" | "v_set"): string[] {
  return candidateRows(ddl, tableName, into).map(([name]) => name);
}

/** The payload value expression a branch reads one column with, in one of its two column lists. */
function candidateExpression(
  ddl: string,
  tableName: string,
  into: "v_cols, v_vals" | "v_set",
  columnName: string,
): string | undefined {
  return candidateRows(ddl, tableName, into).find(([name]) => name === columnName)?.[1];
}

describe("plpgsql batch function generator", () => {
  it("preserves submitted group order when table-local mutation sequences overlap", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(demoSyncRegistry);

    expect(ddl).toContain("WITH ORDINALITY AS entries(m, batch_position)");
    expect(ddl).toContain("jsonb_agg(grouped.mutation ORDER BY grouped.batch_position)");
    expect(ddl).toContain("ORDER BY MIN(grouped.batch_position)");
    expect(ddl).not.toContain("ORDER BY MIN(grouped.mutation_seq)");
  });

  it("stamps managed fields instead of reading them from payload", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(demoSyncRegistry);

    expect(ddl).toContain('"owner_id", "modified_by", "created_at_us", "updated_at_us"');
    // ADR-0026: owner_id/modified_by are stamped from the verified `sub` claim (the single authClaim
    // strategy — `auth.uid()` is just `claimPath: ["sub"]`), cast to the uuid column type. The value
    // expression is embedded as a PL/pgSQL string literal, so its single quotes are doubled.
    expect(ddl).not.toContain("auth.uid()");
    expect(ddl).toContain("#>> ''{sub}''");
    expect(ddl).toContain(
      `"modified_by" = (NULLIF(current_setting(''request.jwt.claims'', true), '''')::jsonb #>> ''{sub}'')::uuid`,
    );
    // ADR-0010: the Server version's on-update stamp is floored at the prior value + 1 (strictly
    // monotonic), not a bare clock read — so an inverted wall clock can never lower it. The clock is the
    // canonical `public.pgxsinkit_clock_us()` DB function (one home for the clock_timestamp() semantics).
    expect(ddl).toContain('"updated_at_us" = GREATEST(public.pgxsinkit_clock_us(), "updated_at_us" + 1)');
    // The consolidation is both-directions pinned: the apply render CALLS the function and NEVER inlines
    // the microsecond-clock expression (the utilities migration owns that body).
    expect(ddl).toContain("public.pgxsinkit_clock_us()");
    expect(ddl).not.toContain("FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)");
    expect(ddl).not.toContain("($1->>'owner_id')::uuid");
    expect(ddl).not.toContain("($1->>'modified_by')::uuid");
    expect(ddl).not.toContain("($1->>'created_at_us')::bigint");
    expect(ddl).not.toContain("($1->>'updated_at_us')::bigint");
  });

  it("stamps an authClaim field from a nested claim path, defaulting the cast to the column type (ADR-0026)", () => {
    const nestedClaimRegistry = defineSyncRegistry({
      claimItems: defineSyncTable({
        tableName: "claim_items",
        makeColumns: () => ({
          id: uuid("id").primaryKey(),
          // A uuid column with no explicit cast: the stamp must default to the column's own SQL type.
          createdByPersonId: uuid("created_by_person_id"),
          title: varchar("title", { length: 120 }).notNull(),
          updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
        }),
        mode: "readwrite",
        conflictPolicy: "last-write-wins",
        governance: {
          managedFields: [
            // The emergent case: an app-minted identity at a nested path, no `auth.uid()` involved.
            {
              column: "createdByPersonId",
              applyOn: ["create"],
              strategy: "authClaim",
              claimPath: ["app_metadata", "person_id"],
            },
            { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
          ],
        },
      }),
    });

    const ddl = buildPlpgsqlBatchFunctionDdl(nestedClaimRegistry);

    // The nested path becomes a `jsonb #>>` text-array path; the cast defaults to the uuid column type.
    // (Single quotes are doubled because the expression is embedded as a PL/pgSQL string literal.)
    expect(ddl).toContain(
      `(NULLIF(current_setting(''request.jwt.claims'', true), '''')::jsonb #>> ''{app_metadata,person_id}'')::uuid`,
    );
    // Server-stamped, never read from the client payload.
    expect(ddl).not.toContain("($1->>'created_by_person_id')::uuid");
    expect(ddl).not.toContain("auth.uid()");
  });

  // A create-only managed field is stamped at birth and INERT thereafter: it must not appear among the
  // UPDATE SET candidates (the `(col_name, col_value)` VALUES list `v_set` is built from), exactly as
  // create-managed columns are absent from the INSERT candidate list.
  it("omits create-only managed columns from the UPDATE SET candidate list", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(demoSyncRegistry);
    const updateCandidates = candidateColumns(ddl, "authors", "v_set");

    // `owner_id` (authClaim, applyOn: ["create"]) and `created_at_us` (nowMicroseconds, applyOn:
    // ["create"]) are stamped once, at insert — never settable by an update payload.
    expect(updateCandidates).not.toContain("owner_id");
    expect(updateCandidates).not.toContain("created_at_us");
    // Update-managed columns stay excluded as before (they are assigned by the static managed fragment).
    expect(updateCandidates).not.toContain("updated_at_us");
    expect(updateCandidates).not.toContain("modified_by");
    // Ordinary columns are still settable.
    expect(updateCandidates).toContain("name");
  });

  it("keeps create-managed columns out of the UPDATE SET list while leaving the INSERT list intact", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(projectedPlpgsqlRegistry);

    // The INSERT candidates are unchanged by this rule: the PK plus the ordinary column (`owner_id`,
    // `created_at_us` and `updated_at_us` are stamped statically; `internal_note` is projected away).
    expect(candidateColumns(ddl, "projected_plpgsql_items", "v_cols, v_vals")).toEqual(["id", "title"]);
    // The UPDATE candidates drop the PK as before, and now also the create-only managed columns.
    expect(candidateColumns(ddl, "projected_plpgsql_items", "v_set")).toEqual(["title"]);
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

// ADR-0054: the artifact is deny-by-default. It DROPs the function on every install, so Postgres's
// PUBLIC default (and Supabase's default-privilege grants to the anon/authenticated/service_role trio)
// come back every time — which is why the revokes are unconditional rather than a one-off hardening.
const APPLY_SIGNATURE = `"pgxsinkit_apply_mutations"(jsonb, text, boolean, boolean, jsonb, text)`;

/** The ADR-0054 ACL block: everything the body emits after the function's closing `$$;`. */
function aclBlock(ddl: string): string {
  const at = ddl.indexOf("-- ADR-0054");
  expect(at).toBeGreaterThan(-1);
  return ddl.slice(at, ddl.indexOf("COMMENT ON FUNCTION"));
}

/** A guarded statement exactly as the shared `buildRoleGuardedStatement` idiom renders it. */
function guarded(roleName: string, statement: string): string {
  return [
    "DO $$",
    "BEGIN",
    `  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${roleName}') THEN`,
    `    EXECUTE '${statement}';`,
    "  END IF;",
    "END;",
    "$$;",
  ].join("\n");
}

describe("deny-by-default apply-function ACL (ADR-0054)", () => {
  it("revokes PUBLIC unconditionally and the Supabase trio through the role-existence guard, granting nobody", () => {
    const acl = aclBlock(buildPlpgsqlBatchFunctionDdl(demoSyncRegistry));

    // Unconditional: PUBLIC always exists, and every install recreates the exposure.
    expect(acl).toContain(`REVOKE ALL ON FUNCTION ${APPLY_SIGNATURE} FROM PUBLIC;`);
    // Guarded: PGlite lanes and non-Supabase clusters have no such roles, and a bare REVOKE would error.
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(acl).toContain(guarded(role, `REVOKE ALL ON FUNCTION ${APPLY_SIGNATURE} FROM "${role}"`));
    }
    // Default is owner-only: no GRANT of any kind.
    expect(acl).not.toContain("GRANT");
  });

  it("emits the ACL INSIDE the fingerprinted body, before the COMMENT that stamps it", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(demoSyncRegistry);

    // ADR-0054 decision 3: grants outside the hashed body would let a stale, PUBLIC-executable install
    // run forever while `--check` stays green. Order pins that: revokes precede the fingerprint stamp.
    expect(ddl.indexOf("REVOKE ALL ON FUNCTION")).toBeGreaterThan(ddl.indexOf("CREATE OR REPLACE FUNCTION"));
    expect(ddl.indexOf("REVOKE ALL ON FUNCTION")).toBeLessThan(ddl.indexOf("COMMENT ON FUNCTION"));
  });

  it("grants EXECUTE to each configured role, guarded, and after the revokes", () => {
    const acl = aclBlock(
      buildPlpgsqlBatchFunctionDdl(demoSyncRegistry, { grantExecuteTo: ["app_writer", "reporter"] }),
    );

    for (const role of ["app_writer", "reporter"]) {
      expect(acl).toContain(guarded(role, `GRANT EXECUTE ON FUNCTION ${APPLY_SIGNATURE} TO "${role}"`));
    }
    // Revoke-then-grant: naming a revoked role in grantExecuteTo must end as a grant, not a revoke.
    expect(acl.indexOf("GRANT EXECUTE")).toBeGreaterThan(acl.lastIndexOf("REVOKE ALL"));
  });

  it("lets a deployment deliberately re-grant one of the revoked roles (the grant wins)", () => {
    const acl = aclBlock(buildPlpgsqlBatchFunctionDdl(demoSyncRegistry, { grantExecuteTo: ["authenticated"] }));

    expect(acl).toContain(guarded("authenticated", `REVOKE ALL ON FUNCTION ${APPLY_SIGNATURE} FROM "authenticated"`));
    expect(acl).toContain(guarded("authenticated", `GRANT EXECUTE ON FUNCTION ${APPLY_SIGNATURE} TO "authenticated"`));
    expect(acl.indexOf("GRANT EXECUTE")).toBeGreaterThan(acl.indexOf("REVOKE ALL ON FUNCTION"));
  });

  it("refuses a role name that is not a plain SQL identifier, empty, over-long, or duplicated", () => {
    // Fail-closed at GENERATE time: a role name reaches the DDL as an identifier AND as a pg_roles
    // literal, so anything that would need quoting/escaping games is refused instead of emitted.
    for (const role of ['app"; DROP TABLE x --', "app writer", "app-writer", "", "   ", "1writer"]) {
      expect(() => buildPlpgsqlBatchFunctionDdl(demoSyncRegistry, { grantExecuteTo: [role] })).toThrow(
        /grantExecuteTo/,
      );
    }
    expect(() => buildPlpgsqlBatchFunctionDdl(demoSyncRegistry, { grantExecuteTo: ["a".repeat(64)] })).toThrow(
      /63-byte/,
    );
    expect(() => buildPlpgsqlBatchFunctionDdl(demoSyncRegistry, { grantExecuteTo: ["writer", "writer"] })).toThrow(
      /more than once/,
    );
  });

  it("installs with the ACL applied — owner-only, PUBLIC stripped", async () => {
    const db = await createFreshTestPGlite();
    const composite = compositeThingsRegistry.compositeThings.table;
    await createTablesFromSchema(db, { composite });
    await db.exec(buildPlpgsqlBatchFunctionDdl(compositeThingsRegistry));

    const result = await db.query<{ acl: string | null }>(
      `SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'pgxsinkit_apply_mutations'`,
    );
    const acl = result.rows[0]?.acl ?? "";
    // A non-null ACL with no `=X/` entry for PUBLIC (which renders as a bare `=X/owner` grantee).
    expect(acl).not.toBe("");
    expect(acl).not.toContain("{=X/");
    expect(acl).not.toContain(",=X/");
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
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
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
  const fp = await installedApplyFingerprint(db);
  await db.query(
    `SELECT * FROM pgxsinkit_apply_mutations($1::jsonb, '/test'::text, false, false, '{}'::jsonb, $2::text)`,
    [JSON.stringify(batch), fp],
  );
}

// Array columns: Drizzle carries dimensionality SEPARATELY from `getSQLType()` (which returns the
// ELEMENT type), so reading only the type string emitted `(x.p->>'source_ids')::uuid` for a `uuid[]`
// — every non-null array write died with 22P02, `[]` included.
const arrayItemsRegistry = defineSyncRegistry({
  arrayItems: defineSyncTable({
    tableName: "array_items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      label: varchar("label", { length: 120 }).notNull(),
      sourceIds: uuid("source_ids").array(),
      tags: varchar("tags", { length: 40 }).array(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

function arrayExpression(columnName: string, elementType: string): string {
  return (
    `CASE WHEN jsonb_typeof(x.p->''${columnName}'') = ''array'' THEN ` +
    `ARRAY(SELECT e FROM jsonb_array_elements_text(x.p->''${columnName}'') WITH ORDINALITY AS a(e, ord) ORDER BY ord)` +
    `::${elementType}[] END`
  );
}

function arrayItemsBatch(
  kind: "create" | "update",
  entityKey: Record<string, string>,
  payload: Record<string, unknown>,
  mutationId: string,
) {
  return {
    mutations: [{ tableName: "array_items", kind, entityKey, payload, mutationId, mutationSeq: 1 }],
  };
}

describe("array columns in the write path", () => {
  it("expands a one-dimensional array element-wise with a terminal typed cast, in both column lists", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(arrayItemsRegistry);

    for (const into of ["v_cols, v_vals", "v_set"] as const) {
      expect(candidateExpression(ddl, "array_items", into, "source_ids")).toBe(arrayExpression("source_ids", "uuid"));
      // The element type carries its type arguments; the terminal cast IS the type check (no allowlist).
      expect(candidateExpression(ddl, "array_items", into, "tags")).toBe(arrayExpression("tags", "varchar(40)"));
      // Scalar columns keep the long-standing `->>` form byte-for-byte.
      expect(candidateExpression(ddl, "array_items", into, "label")).toBe(`(x.p->>''label'')::varchar(120)`);
    }
    // Never the silently-wrong scalar cast that killed every array write.
    expect(ddl).not.toContain(`(x.p->>''source_ids'')::uuid`);
  });

  it("round-trips empty, non-empty and null arrays through create and update", async () => {
    const db = await createFreshTestPGlite();
    const arrayItems = arrayItemsRegistry.arrayItems.table;
    await createTablesFromSchema(db, { arrayItems });
    await db.exec(buildPlpgsqlBatchFunctionDdl(arrayItemsRegistry));

    const idEmpty = "40000000-0000-4000-8000-00000000000e";
    const idFull = "40000000-0000-4000-8000-00000000000f";
    const idNull = "40000000-0000-4000-8000-00000000000d";
    const first = "50000000-0000-4000-8000-000000000001";
    const second = "50000000-0000-4000-8000-000000000002";

    await applyBatch(db, arrayItemsBatch("create", { id: idEmpty }, { id: idEmpty, label: "e", source_ids: [] }, "m1"));
    await applyBatch(
      db,
      // Element order must survive: the emitted expansion orders by the JSON array's ordinality.
      arrayItemsBatch("create", { id: idFull }, { id: idFull, label: "f", source_ids: [second, first] }, "m2"),
    );
    await applyBatch(
      db,
      // A JSON null is SQL NULL, NOT an empty array — mirroring the scalar `(x.p->>'col')::type` case.
      arrayItemsBatch("create", { id: idNull }, { id: idNull, label: "n", source_ids: null }, "m3"),
    );

    const created = await db.query<{ id: string; source_ids: string[] | null }>(
      `SELECT id, source_ids FROM array_items ORDER BY label`,
    );
    expect(created.rows).toEqual([
      { id: idEmpty, source_ids: [] },
      { id: idFull, source_ids: [second, first] },
      { id: idNull, source_ids: null },
    ]);

    await applyBatch(db, arrayItemsBatch("update", { id: idEmpty }, { source_ids: [first] }, "m4"));
    await applyBatch(db, arrayItemsBatch("update", { id: idFull }, { source_ids: [] }, "m5"));
    await applyBatch(db, arrayItemsBatch("update", { id: idNull }, { source_ids: null }, "m6"));

    const updated = await db.query<{ id: string; source_ids: string[] | null }>(
      `SELECT id, source_ids FROM array_items ORDER BY label`,
    );
    expect(updated.rows).toEqual([
      { id: idEmpty, source_ids: [first] },
      { id: idFull, source_ids: [] },
      { id: idNull, source_ids: null },
    ]);
  });

  it("leaves an array column untouched when its key is absent from the payload", async () => {
    const db = await createFreshTestPGlite();
    const arrayItems = arrayItemsRegistry.arrayItems.table;
    await createTablesFromSchema(db, { arrayItems });
    await db.exec(buildPlpgsqlBatchFunctionDdl(arrayItemsRegistry));

    const id = "40000000-0000-4000-8000-0000000000aa";
    const first = "50000000-0000-4000-8000-000000000001";
    await applyBatch(db, arrayItemsBatch("create", { id }, { id, label: "a", source_ids: [first] }, "m1"));
    // Absent key ⇒ the column is not in the group's signature, so the statement never mentions it —
    // exactly the scalar semantics.
    await applyBatch(db, arrayItemsBatch("update", { id }, { label: "b" }, "m2"));

    const rows = await db.query<{ label: string; source_ids: string[] | null }>(
      `SELECT label, source_ids FROM array_items`,
    );
    expect(rows.rows).toEqual([{ label: "b", source_ids: [first] }]);
  });

  it("refuses a multi-dimensional array at generate time, naming the table and column", () => {
    const multiDimensional = defineSyncRegistry({
      grids: defineSyncTable({
        tableName: "grid_items",
        makeColumns: () => ({
          id: uuid("id").primaryKey(),
          matrix: integer("matrix").array("[][]"),
          updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
        }),
        mode: "readwrite",
        conflictPolicy: "last-write-wins",
        governance: {
          managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
        },
      }),
    });

    expect(() => buildPlpgsqlBatchFunctionDdl(multiDimensional)).toThrow(
      /grid_items\.matrix is a 2-dimensional array; multi-dimensional arrays are not supported/,
    );
  });

  it("refuses an array primary-key column at generate time", () => {
    const arrayPk = defineSyncRegistry({
      keyedByArray: defineSyncTable({
        tableName: "array_pk_items",
        makeColumns: () => ({
          memberIds: uuid("member_ids").array().notNull(),
          label: varchar("label", { length: 120 }).notNull(),
          updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
        }),
        mode: "readwrite",
        conflictPolicy: "last-write-wins",
        primaryKey: ["member_ids"],
        governance: {
          managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
        },
      }),
    });

    expect(() => buildPlpgsqlBatchFunctionDdl(arrayPk)).toThrow(
      /array_pk_items\.member_ids is an array column; array columns are not supported as primary keys/,
    );
  });

  it("refuses a managed field on an array column at generate time", () => {
    const arrayManaged = defineSyncRegistry({
      stamped: defineSyncTable({
        tableName: "array_managed_items",
        makeColumns: () => ({
          id: uuid("id").primaryKey(),
          owners: uuid("owners").array(),
          updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
        }),
        mode: "readwrite",
        conflictPolicy: "last-write-wins",
        governance: {
          managedFields: [
            // Both strategies stamp ONE scalar, so an array target could only ever be a type error.
            { column: "owners", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
            { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
          ],
        },
      }),
    });

    expect(() => buildPlpgsqlBatchFunctionDdl(arrayManaged)).toThrow(
      /managed field array_managed_items\.owners is an array column/,
    );
  });
});

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

    const composite = compositeThingsRegistry.compositeThings.table;
    try {
      await createTablesFromSchema(db, { composite });
      await db.exec(buildPlpgsqlBatchFunctionDdl(compositeThingsRegistry));

      const tenant = "10000000-0000-4000-8000-000000000001";
      const idA = "20000000-0000-4000-8000-00000000000a";
      const idB = "20000000-0000-4000-8000-00000000000b";

      // Two rows share tenant_id and differ only on id — the exact case where a `columns[0]`-only
      // WHERE would match (and clobber) BOTH.
      await drizzleOver(db)
        .insert(composite)
        .values([
          { tenantId: tenant, id: idA, label: "A" },
          { tenantId: tenant, id: idB, label: "B" },
        ]);

      await applyBatch(db, compositeBatch("update", { tenant_id: tenant, id: idA }, { label: "A2" }));

      const afterUpdate = await drizzleOver(db)
        .select({ id: composite.id, label: composite.label })
        .from(composite)
        .orderBy(asc(composite.label));
      expect(afterUpdate).toEqual([
        { id: idA, label: "A2" },
        { id: idB, label: "B" },
      ]);

      await applyBatch(db, compositeBatch("delete", { tenant_id: tenant, id: idA }, { tenant_id: tenant, id: idA }));

      const afterDelete = await drizzleOver(db).select({ id: composite.id }).from(composite);
      expect(afterDelete).toEqual([{ id: idB }]);
    } finally {
      await db.close();
    }
  });

  it("keeps the Server version strictly monotonic even when the wall clock is behind (GREATEST)", async () => {
    const db = await createFreshTestPGlite();

    const composite = compositeThingsRegistry.compositeThings.table;
    try {
      await createTablesFromSchema(db, { composite });
      await db.exec(buildPlpgsqlBatchFunctionDdl(compositeThingsRegistry));

      const tenant = "10000000-0000-4000-8000-000000000002";
      const id = "20000000-0000-4000-8000-00000000000c";

      // Seed the row's Server version far ahead of the wall clock — the exact inverted-clock case
      // where a bare `clock_timestamp()` stamp would step the version BACKWARDS.
      const future = "9999999999999999";
      await drizzleOver(db)
        .insert(composite)
        .values({ tenantId: tenant, id, label: "A", updatedAtUs: BigInt(future) });

      await applyBatch(db, compositeBatch("update", { tenant_id: tenant, id }, { label: "A2" }));

      // clock_us << 9999999999999999, so GREATEST picks current + 1 — strictly greater, never lower.
      const row = await drizzleOver(db)
        .select({ updatedAtUs: sql<string>`${composite.updatedAtUs}::text`.as("updatedAtUs") })
        .from(composite)
        .where(eq(composite.id, id));
      expect(row[0]?.updatedAtUs).toBe("10000000000000000");
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
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
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
  const fp = await installedApplyFingerprint(db);
  await db.query(
    `SELECT * FROM pgxsinkit_apply_mutations($1::jsonb, '/test'::text, false, false, '{}'::jsonb, $2::text)`,
    [JSON.stringify({ mutations }), fp],
  );
}

describe("set-based apply — (table, kind, column-set) grouping (ADR-0014 Phase 4)", () => {
  async function freshDb() {
    const db = await createFreshTestPGlite();
    await createTablesFromSchema(db, { groupTodos: groupTodosRegistry.todos.table });
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

      const g = groupTodosRegistry.todos.table;
      const rows = await drizzleOver(db)
        .select({
          id: g.id,
          title: g.title,
          priority: g.priority,
          stamped: sql<boolean>`(${g.updatedAtUs} > 0)`.as("stamped"),
        })
        .from(g)
        .orderBy(asc(g.title));
      expect(rows).toEqual([
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
      const g = groupTodosRegistry.todos.table;
      await drizzleOver(db)
        .insert(g)
        .values([
          { id: ID_A, title: "A", priority: 1, updatedAtUs: 5n },
          { id: ID_B, title: "B", priority: 2, updatedAtUs: 5n },
        ]);

      // Row A updates only title (column-set {title}); row B only priority (column-set {priority}) —
      // two distinct groups. A single uniform UPDATE..FROM would null the other column on each row.
      await applyMutations(db, [
        todoMutation("update", 1, { id: ID_A }, { title: "A2" }),
        todoMutation("update", 2, { id: ID_B }, { priority: 99 }),
      ]);

      const rows = await drizzleOver(db)
        .select({
          id: g.id,
          title: g.title,
          priority: g.priority,
          bumped: sql<boolean>`(${g.updatedAtUs} > 5)`.as("bumped"),
        })
        .from(g)
        .orderBy(asc(g.id));
      expect(rows).toEqual([
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
      const g = groupTodosRegistry.todos.table;
      await drizzleOver(db)
        .insert(g)
        .values([
          { id: ID_A, title: "old", priority: 1, updatedAtUs: 5n },
          { id: ID_B, title: "doomed", priority: 2, updatedAtUs: 5n },
        ]);

      await applyMutations(db, [
        todoMutation("create", 1, { id: ID_C }, { id: ID_C, title: "C", priority: 3 }),
        todoMutation("update", 2, { id: ID_A }, { title: "new" }),
        todoMutation("delete", 3, { id: ID_B }, { id: ID_B }),
      ]);

      const rows = await drizzleOver(db).select({ id: g.id, title: g.title }).from(g).orderBy(asc(g.id));
      expect(rows).toEqual([
        { id: ID_A, title: "new" }, // updated
        { id: ID_C, title: "C" }, // created (ID_B deleted)
      ]);
    } finally {
      await db.close();
    }
  });
});

// A create-only managed field (`applyOn: ["create"]`) is stamped by the server at birth and is INERT
// thereafter: the generated UPDATE offers no SET candidate for it, so a payload key carrying one cannot
// move the stored value (the HTTP route additionally 400-rejects and strips it — this is the DB-level leg).
const createOnlyManagedRegistry = defineSyncRegistry({
  notes: defineSyncTable({
    tableName: "create_only_managed_notes",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      label: varchar("label", { length: 120 }).notNull(),
      ownerId: uuid("owner_id"),
      createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(0n),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    primaryKey: ["id"],
    governance: {
      managedFields: [
        { column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
        { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
        { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
      ],
    },
  }),
});

describe("create-only managed fields are inert on update", () => {
  it("applies the ordinary columns and leaves the create-only managed columns at their stored values", async () => {
    const db = await createFreshTestPGlite();
    const notes = createOnlyManagedRegistry.notes.table;

    try {
      await createTablesFromSchema(db, { notes });
      await db.exec(buildPlpgsqlBatchFunctionDdl(createOnlyManagedRegistry));

      const id = "80000000-0000-4000-8000-00000000000a";
      const owner = "80000000-0000-4000-8000-00000000000b";
      const intruder = "80000000-0000-4000-8000-00000000000c";
      await drizzleOver(db)
        .insert(notes)
        .values({ id, label: "A", ownerId: owner, createdAtUs: 111n, updatedAtUs: 5n });

      // The payload asserts values for BOTH create-only managed columns alongside a legitimate edit.
      await applyBatch(db, {
        mutations: [
          {
            tableName: "create_only_managed_notes",
            kind: "update",
            entityKey: { id },
            payload: { label: "B", owner_id: intruder, created_at_us: "999" },
            mutationId: "00000000-0000-4000-8000-00000000000a",
            mutationSeq: 1,
            clientTimestampUs: "1000",
          },
        ],
      });

      const rows = await drizzleOver(db)
        .select({
          label: notes.label,
          ownerId: notes.ownerId,
          createdAtUs: sql<string>`${notes.createdAtUs}::text`.as("createdAtUs"),
          bumped: sql<boolean>`(${notes.updatedAtUs} > 5)`.as("bumped"),
        })
        .from(notes)
        .where(eq(notes.id, id));

      // Ownership and birth timestamp are untouched; the ordinary edit landed and the Server version bumped.
      expect(rows[0]).toEqual({ label: "B", ownerId: owner, createdAtUs: "111", bumped: true });
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
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
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
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
    }),
    mode: "readwrite",
    primaryKey: ["id"],
    conflictPolicy: "reject-if-stale",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

const rejectThings = rejectConflictRegistry.things.table;

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
  const fp = await installedApplyFingerprint(db);
  const result = await db.query<{ mutationId: string; tableName: string; currentServerVersion: string }>(
    `SELECT mutation_id::text AS "mutationId", table_name AS "tableName", current_server_version::text AS "currentServerVersion"
     FROM pgxsinkit_apply_mutations($1::jsonb, '/test'::text, false, false, '{}'::jsonb, $2::text)`,
    [JSON.stringify({ mutations }), fp],
  );
  return result.rows;
}

describe("stale-write conflict detection (ADR-0015 Phase 3)", () => {
  async function seedThing(table: AnyPgTable, registry: Parameters<typeof buildPlpgsqlBatchFunctionDdl>[0]) {
    const db = await createFreshTestPGlite();
    await createTablesFromSchema(db, { table });
    await db.exec(buildPlpgsqlBatchFunctionDdl(registry));
    // The row sits at version 100; an external writer then advances it to 200 (the interleave).
    await drizzleOver(db).insert(table).values({ id: CONFLICT_ID, label: "original", updatedAtUs: 200n });
    return db;
  }

  it("last-write-wins applies a stale update anyway and reports no conflict", async () => {
    const things = lwwConflictRegistry.things.table;
    const db = await seedThing(things, lwwConflictRegistry);
    try {
      // base 100 < current 200 → stale. last-write-wins applies it regardless.
      const conflicts = await applyForConflicts(db, [
        conflictMutation("lww_things", "update", { label: "clobbered" }, "100"),
      ]);

      expect(conflicts).toEqual([]);
      const row = await drizzleOver(db).select({ label: things.label }).from(things).where(eq(things.id, CONFLICT_ID));
      expect(row[0]?.label).toBe("clobbered");
    } finally {
      await db.close();
    }
  });

  it("reject-if-stale leaves the row untouched and reports the conflict with the current Server version", async () => {
    const db = await seedThing(rejectThings, rejectConflictRegistry);
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
      const row = await drizzleOver(db)
        .select({ label: rejectThings.label })
        .from(rejectThings)
        .where(eq(rejectThings.id, CONFLICT_ID));
      expect(row[0]?.label).toBe("original");
    } finally {
      await db.close();
    }
  });

  it("reject-if-stale applies a non-stale update (base == current) and reports no conflict", async () => {
    const db = await seedThing(rejectThings, rejectConflictRegistry);
    try {
      // base 200 == current 200 → not stale. The write applies and bumps the Server version.
      const conflicts = await applyForConflicts(db, [
        conflictMutation("reject_things", "update", { label: "fresh" }, "200"),
      ]);

      expect(conflicts).toEqual([]);
      const row = await drizzleOver(db)
        .select({
          label: rejectThings.label,
          bumped: sql<boolean>`(${rejectThings.updatedAtUs} > 200)`.as("bumped"),
        })
        .from(rejectThings)
        .where(eq(rejectThings.id, CONFLICT_ID));
      expect(row[0]?.label).toBe("fresh");
      expect(row[0]?.bumped).toBe(true);
    } finally {
      await db.close();
    }
  });

  it("reject-if-stale UPDATE of a MISSING row → conflict (target deleted), nothing applied (#6)", async () => {
    const db = await seedThing(rejectThings, rejectConflictRegistry);
    try {
      // An external writer DELETED the row after the client authored its update.
      await drizzleOver(db).delete(rejectThings).where(eq(rejectThings.id, CONFLICT_ID));

      const conflicts = await applyForConflicts(db, [
        conflictMutation("reject_things", "update", { label: "edit on a gone row" }, "100"),
      ]);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.mutationId).toBe("50000000-0000-4000-8000-00000000000a");
      // A NULL currentServerVersion is the discriminator: the target no longer exists (not a version
      // clash). Without this the edit would silently no-op and ack as success.
      expect(conflicts[0]?.currentServerVersion ?? null).toBeNull();

      // The update did NOT resurrect the row.
      const row = await drizzleOver(db)
        .select({ count: count() })
        .from(rejectThings)
        .where(eq(rejectThings.id, CONFLICT_ID));
      expect(row[0]?.count).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("reject-if-stale DELETE of a missing row stays idempotent success — NOT a conflict (#6)", async () => {
    const db = await seedThing(rejectThings, rejectConflictRegistry);
    try {
      await drizzleOver(db).delete(rejectThings).where(eq(rejectThings.id, CONFLICT_ID));

      const conflicts = await applyForConflicts(db, [
        conflictMutation("reject_things", "delete", { id: CONFLICT_ID }, "100"),
      ]);

      // Deleting an already-gone row is idempotent success; surfacing it as a conflict would be wrong.
      expect(conflicts).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it("reject-if-stale with no base (a create-like write) skips the stale check and applies", async () => {
    const db = await seedThing(rejectThings, rejectConflictRegistry);
    try {
      // No baseServerVersion ⇒ no stale check; the write applies (degrades to last-write-wins).
      const conflicts = await applyForConflicts(db, [
        conflictMutation("reject_things", "update", { label: "no-base" }, null),
      ]);

      expect(conflicts).toEqual([]);
      const row = await drizzleOver(db)
        .select({ label: rejectThings.label })
        .from(rejectThings)
        .where(eq(rejectThings.id, CONFLICT_ID));
      expect(row[0]?.label).toBe("no-base");
    } finally {
      await db.close();
    }
  });

  it("reject-if-stale rejects a stale delete and keeps the row", async () => {
    const db = await seedThing(rejectThings, rejectConflictRegistry);
    try {
      const conflicts = await applyForConflicts(db, [
        conflictMutation("reject_things", "delete", { id: CONFLICT_ID }, "100"),
      ]);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.currentServerVersion).toBe("200");
      const row = await drizzleOver(db)
        .select({ count: count() })
        .from(rejectThings)
        .where(eq(rejectThings.id, CONFLICT_ID));
      expect(row[0]?.count).toBe(1);
    } finally {
      await db.close();
    }
  });
});

// The ops-log `mutation_id` column and the apply function's conflict RETURN are `text`, not `uuid`: the
// expander tier derives child envelopes with composite non-UUID ids (`${parentMutationId}:<tag>:<n>`).
// A `::uuid` cast on either path raised 22P02 (invalid_text_representation) and aborted the batch the
// moment such a derived write was logged or conflicted. These prove both paths carry the id intact.
describe("derived (non-UUID) mutation ids flow through text, not uuid", () => {
  const DERIVED_ID = "50000000-0000-4000-8000-00000000000a:membership:2";

  it("records a non-UUID mutation id in operations_log when p_log_enabled = true", async () => {
    const db = await createFreshTestPGlite();
    try {
      const things = lwwConflictRegistry.things.table;
      await createTablesFromSchema(db, { things, operationsLogTable });
      await db.exec(buildPlpgsqlBatchFunctionDdl(lwwConflictRegistry));

      const rowId = "60000000-0000-4000-8000-00000000000a";
      const fp = await installedApplyFingerprint(db);
      // p_log_enabled = true → the batched log insert fires; its (m->>'mutationId') is no longer cast to
      // uuid, so a derived composite id lands verbatim instead of raising 22P02.
      await db.query(
        `SELECT * FROM pgxsinkit_apply_mutations($1::jsonb, '/test'::text, true, false, '{}'::jsonb, $2::text)`,
        [
          JSON.stringify({
            mutations: [
              {
                tableName: "lww_things",
                kind: "create",
                entityKey: { id: rowId },
                payload: { id: rowId, label: "derived" },
                mutationId: DERIVED_ID,
                mutationSeq: 1,
                clientTimestampUs: "1000",
              },
            ],
          }),
          fp,
        ],
      );

      const logged = await drizzleOver(db)
        .select({ mutationId: operationsLogTable.mutationId, status: operationsLogTable.status })
        .from(operationsLogTable);
      expect(logged).toHaveLength(1);
      expect(logged[0]?.mutationId).toBe(DERIVED_ID);
      expect(logged[0]?.status).toBe("succeeded");
    } finally {
      await db.close();
    }
  });

  it("returns a non-UUID mutation id verbatim on a reject-if-stale conflict", async () => {
    const db = await createFreshTestPGlite();
    try {
      await createTablesFromSchema(db, { table: rejectThings });
      await db.exec(buildPlpgsqlBatchFunctionDdl(rejectConflictRegistry));
      // Seed at version 200; the derived write bases off 100 → stale → reported (not applied).
      await drizzleOver(db).insert(rejectThings).values({ id: CONFLICT_ID, label: "original", updatedAtUs: 200n });

      const conflicts = await applyForConflicts(db, [
        {
          tableName: "reject_things",
          kind: "update",
          entityKey: { id: CONFLICT_ID },
          payload: { label: "stale derived" },
          mutationId: DERIVED_ID,
          mutationSeq: 1,
          clientTimestampUs: "1000",
          baseServerVersion: "100",
        },
      ]);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]?.mutationId).toBe(DERIVED_ID);
      expect(conflicts[0]?.currentServerVersion).toBe("200");
    } finally {
      await db.close();
    }
  });
});

// ADR-0030: the apply function verifies ITSELF against its ADR-0018 fingerprint comment before touching
// any table. The runtime passes the fingerprint it expects; the installed function compares it to its own
// stamped comment (obj_description of its own oid) and raises SQLSTATE 'PXS01' on a mismatch — including
// an ABSENT comment (an unstamped hand-installed function). This replaces the deleted startup verify.
describe("self-verifying apply function (ADR-0030)", () => {
  const SELF_VERIFY_ID = "70000000-0000-4000-8000-00000000000a";

  async function freshSelfVerifyDb() {
    const db = await createFreshTestPGlite();
    await createTablesFromSchema(db, { things: lwwConflictRegistry.things.table });
    await db.exec(buildPlpgsqlBatchFunctionDdl(lwwConflictRegistry));
    return db;
  }

  function createBatchJson() {
    return JSON.stringify({
      mutations: [
        {
          tableName: "lww_things",
          kind: "create",
          entityKey: { id: SELF_VERIFY_ID },
          payload: { id: SELF_VERIFY_ID, label: "self-verify" },
          mutationId: "00000000-0000-4000-8000-00000000000a",
          mutationSeq: 1,
          clientTimestampUs: "1000",
        },
      ],
    });
  }

  async function rowCount(db: Awaited<ReturnType<typeof createFreshTestPGlite>>): Promise<number> {
    const things = lwwConflictRegistry.things.table;
    const rows = await drizzleOver(db).select({ n: count() }).from(things);
    return Number(rows[0]?.n ?? 0);
  }

  it("applies when the expected fingerprint matches the stamped comment", async () => {
    const db = await freshSelfVerifyDb();
    try {
      const expected = expectedApplyFingerprint(lwwConflictRegistry);
      // The install stamps this exact fingerprint, so the in-body self-check passes and the row lands.
      await db.query(
        `SELECT * FROM pgxsinkit_apply_mutations($1::jsonb, '/test'::text, false, false, '{}'::jsonb, $2::text)`,
        [createBatchJson(), expected],
      );
      expect(await rowCount(db)).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("raises PXS01 and writes NO rows when the expected fingerprint is wrong", async () => {
    const db = await freshSelfVerifyDb();
    try {
      let caught: unknown;
      try {
        await db.query(
          `SELECT * FROM pgxsinkit_apply_mutations($1::jsonb, '/test'::text, false, false, '{}'::jsonb, $2::text)`,
          [createBatchJson(), "pgxsinkit:fp1:deadbeefdeadbeef"],
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect((caught as { code?: string }).code).toBe("PXS01");
      expect((caught as Error).message).toMatch(/is stale/);
      // The gate fires before any table change — the create must not have landed.
      expect(await rowCount(db)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it("refuses (PXS01) when the fingerprint COMMENT is removed (a hand-installed function)", async () => {
    const db = await freshSelfVerifyDb();
    try {
      // Simulate an unstamped hand-installed function: strip the stamped comment so
      // obj_description returns NULL. A non-null expected fingerprint IS DISTINCT FROM NULL → refuse.
      await db.exec(
        `COMMENT ON FUNCTION pgxsinkit_apply_mutations(jsonb, text, boolean, boolean, jsonb, text) IS NULL`,
      );
      const expected = expectedApplyFingerprint(lwwConflictRegistry);

      let caught: unknown;
      try {
        await db.query(
          `SELECT * FROM pgxsinkit_apply_mutations($1::jsonb, '/test'::text, false, false, '{}'::jsonb, $2::text)`,
          [createBatchJson(), expected],
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expect((caught as { code?: string }).code).toBe("PXS01");
      expect(await rowCount(db)).toBe(0);
    } finally {
      await db.close();
    }
  });
});
