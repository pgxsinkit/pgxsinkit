import { describe, expect, it } from "bun:test";

import { projectsSyncRegistry } from "@pgxsinkit/schema";

import { createMutationRuntime } from "../../packages/client/src/mutation";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { createFreshTestPGlite } from "../support/pglite";

// ADR-0022-B — the durable write-unit tag substrate. A `batch(items, unit)` stamps every journal row of
// the batch with one shared `write_unit` id + `write_mode` (what a dynamic `transaction({ mode })` block
// will pass); the per-table create/update/delete helpers pass no unit, so both columns stay NULL and the
// flusher will derive mode/unit from the static consistency group (routing lands in 0022-C).

const schemaSql = generateLocalSchemaSql(projectsSyncRegistry);
const writeUrl = "http://localhost:3001";
const P1 = "01963227-d4c7-72db-b858-000000000001";
const P2 = "01963227-d4c7-72db-b858-000000000002";
const SYNCED_VERSION = "1000";

async function seededRuntime() {
  const db = await createFreshTestPGlite();
  await db.exec(schemaSql);
  for (const id of [P1, P2]) {
    await db.query(
      `INSERT INTO projects (id, name, created_at_us, updated_at_us) VALUES ($1, 'seed', $2::bigint, $2::bigint)`,
      [id, SYNCED_VERSION],
    );
  }
  return { db, runtime: createMutationRuntime({ db, registry: projectsSyncRegistry, writeUrl }) };
}

async function readTag(db: Awaited<ReturnType<typeof createFreshTestPGlite>>, mutationSeq: number) {
  const result = await db.query<{ writeUnit: string | null; writeMode: string | null }>(
    `SELECT write_unit AS "writeUnit", write_mode AS "writeMode" FROM projects_mutations WHERE mutation_seq = $1`,
    [mutationSeq],
  );
  return result.rows[0];
}

describe("write-unit tag substrate (ADR-0022-B)", () => {
  it("batch(items, unit) tags every row with one shared unit id + mode", async () => {
    const { db, runtime } = await seededRuntime();
    try {
      await runtime.batch(
        [
          { table: "projects", kind: "update", entityKey: { id: P1 }, patch: { name: "a" } },
          { table: "projects", kind: "update", entityKey: { id: P2 }, patch: { name: "b" } },
        ],
        { id: "unit-1", mode: "pessimistic" },
      );

      // Both co-committed mutations carry the SAME unit id and the unit's mode.
      expect(await readTag(db, 1)).toEqual({ writeUnit: "unit-1", writeMode: "pessimistic" });
      expect(await readTag(db, 2)).toEqual({ writeUnit: "unit-1", writeMode: "pessimistic" });
    } finally {
      await db.close();
    }
  });

  it("an untagged batch and the per-table helpers leave write_unit / write_mode NULL", async () => {
    const { db, runtime } = await seededRuntime();
    try {
      await runtime.batch([{ table: "projects", kind: "update", entityKey: { id: P1 }, patch: { name: "a" } }]);
      await runtime.update("projects", { id: P2 }, { name: "b" });

      expect(await readTag(db, 1)).toEqual({ writeUnit: null, writeMode: null });
      expect(await readTag(db, 2)).toEqual({ writeUnit: null, writeMode: null });
    } finally {
      await db.close();
    }
  });
});
