import { afterEach, describe, expect, it } from "bun:test";

import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";
import { buildPlpgsqlBatchFunctionDdl, createSyncServer, expectedApplyFingerprint } from "@pgxsinkit/server";

import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { closeOpenTestPGlites, createFreshTestPGlite } from "../support/pglite";

// `pgxsinkit-generate --function-schema <schema>` installs the apply function into a schema of the
// deployment's choosing. The generate path always honoured it; the RUNTIME did not — the server both
// recomputed the fingerprint WITHOUT the schema (so the self-check could never match) and invoked the
// function UNQUALIFIED (so `search_path` decided what, if anything, it called). `applyFunctionSchema`
// on createSyncServer is the missing half: one option feeding both the fingerprint and the call.
const schemaRegistry = defineSyncRegistry({
  schema_items: defineSyncTable({
    tableName: "schema_items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(0n),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});

const APPLY_FUNCTION_SCHEMA = "app_fns";

/**
 * A PGlite-backed server whose apply artifact was generated (and installed) into `app_fns`, exactly as
 * `--function-schema app_fns` would. The startup posture is the zero-query one so the test exercises the
 * apply call itself and nothing else.
 */
async function createSchemaQualifiedServer(options: { applyFunctionSchema?: string }) {
  const pg = await createFreshTestPGlite();
  const schemaItems = schemaRegistry.schema_items.table;
  await createTablesFromSchema(pg, { schemaItems });
  await pg.exec(`CREATE SCHEMA ${APPLY_FUNCTION_SCHEMA};`);
  await pg.exec(buildPlpgsqlBatchFunctionDdl(schemaRegistry, { functionSchema: APPLY_FUNCTION_SCHEMA }));

  const server = createSyncServer({
    registry: schemaRegistry,
    db: drizzleOver(pg) as never,
    deployment: { startupVerification: "deploy-time", operationsLog: "disabled" },
    ...(options.applyFunctionSchema ? { applyFunctionSchema: options.applyFunctionSchema } : {}),
  });

  return { pg, server };
}

function createBatch(id: string, title: string, mutationId: string) {
  return JSON.stringify({
    mutations: [
      {
        tableName: "schema_items",
        entityKey: { id },
        mutationId,
        mutationSeq: 1,
        kind: "create",
        payload: { id, title },
        clientTimestampUs: String(Date.now() * 1000),
      },
    ],
  });
}

afterEach(async () => {
  await closeOpenTestPGlites();
});

describe("--function-schema end to end (generate flag ⇄ server option)", () => {
  it("qualifies the emitted DDL, the fingerprint, and the runtime call with the same schema", async () => {
    const { pg, server } = await createSchemaQualifiedServer({ applyFunctionSchema: APPLY_FUNCTION_SCHEMA });

    // The install really is in the custom schema, and nothing was left in `public`.
    const installed = await pg.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.proname = 'pgxsinkit_apply_mutations'`,
    );
    expect(installed.rows.map((row) => row.nspname)).toEqual([APPLY_FUNCTION_SCHEMA]);

    const id = "70000000-0000-4000-8000-000000000001";
    const response = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: createBatch(id, "qualified", "8f3c2d51-4c1c-4a2f-9a25-4a4f4f3f0001"),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ acks: [{ status: "acked" }] });

    const rows = await pg.query<{ title: string }>(`SELECT title FROM schema_items WHERE id = $1`, [id]);
    expect(rows.rows).toEqual([{ title: "qualified" }]);
  });

  it("fails loudly when the artifact was generated with a schema the server was not told about", async () => {
    // The pre-fix behaviour, now a clean failure instead of a silent mismatch: the call goes out
    // unqualified, `search_path` has no such function, and the write fails as a whole.
    const { server } = await createSchemaQualifiedServer({});

    const id = "70000000-0000-4000-8000-000000000002";
    const response = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: createBatch(id, "unqualified", "8f3c2d51-4c1c-4a2f-9a25-4a4f4f3f0002"),
    });

    expect(response.status).toBe(500);
  });

  it("puts the schema in the fingerprint, so the two halves cannot disagree silently", () => {
    // The server's expected fingerprint is computed from the SAME render options the generate command
    // used; a schema on one side only is a different artifact identity (PXS01), not a working install.
    expect(expectedApplyFingerprint(schemaRegistry, { functionSchema: APPLY_FUNCTION_SCHEMA })).not.toBe(
      expectedApplyFingerprint(schemaRegistry),
    );
    expect(buildPlpgsqlBatchFunctionDdl(schemaRegistry, { functionSchema: APPLY_FUNCTION_SCHEMA })).toContain(
      `"${APPLY_FUNCTION_SCHEMA}"."pgxsinkit_apply_mutations"`,
    );
  });

  it("refuses an unusable schema name at server construction, not at the first write", () => {
    // The same validator the renderer runs — the server cannot be configured with a name the artifact
    // could never have been generated with.
    expect(() =>
      createSyncServer({
        registry: schemaRegistry,
        db: {} as never,
        deployment: { startupVerification: "deploy-time", operationsLog: "disabled" },
        applyFunctionSchema: "app fns",
      }),
    ).toThrow(/functionSchema/);
  });
});
