import { describe, expect, it } from "bun:test";

import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import {
  buildPlpgsqlBatchFunctionDdl,
  expectedApplyFingerprint,
} from "../../packages/server/src/mutations/plpgsql-apply";
import { createFreshTestPGlite } from "../support/pglite";

// ADR-0018: the generated apply function is stamped with a fingerprint of its exact DDL body, so CI
// (pre-deploy, via `pgxsinkit-generate --check`) and the function itself (ADR-0030, in-body on every
// call) can detect a function that is stale relative to the registry + applier codegen it is meant to
// serve. The fingerprint lives in a COMMENT ON FUNCTION and is read back via obj_description.

const FP_PREFIX = "pgxsinkit:fp1:";

// A minimal, valid writable registry (mirrors the projected demo table). `extraColumn` adds a plain
// syncable column so the generated DDL — and therefore the fingerprint — changes shape.
function itemsRegistry(opts: { extraColumn?: boolean } = {}) {
  return defineSyncRegistry({
    items: defineSyncTable({
      tableName: "fp_items",
      makeColumns: () => ({
        id: uuid("id").primaryKey(),
        ownerId: uuid("owner_id").notNull(),
        title: varchar("title", { length: 120 }).notNull(),
        ...(opts.extraColumn ? { subtitle: varchar("subtitle", { length: 120 }) } : {}),
        createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
        updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
      }),
      mode: "readwrite",
      conflictPolicy: "last-write-wins",
      clientProjection: { omitColumns: ["ownerId"] },
      governance: {
        managedFields: [
          { column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
          { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
          { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
        ],
      },
    }),
  });
}

const baseRegistry = itemsRegistry();
const expected = expectedApplyFingerprint(baseRegistry);
// ADR-0030: the apply function's signature gained a trailing p_expected_fingerprint text.
const applySignature = "pgxsinkit_apply_mutations(jsonb,text,boolean,boolean,jsonb,text)";

describe("apply-function fingerprint (ADR-0018)", () => {
  it("stamps the DDL with a COMMENT carrying the expected fingerprint", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(baseRegistry);
    expect(expected.startsWith(FP_PREFIX)).toBe(true);
    expect(ddl).toContain(
      `COMMENT ON FUNCTION "pgxsinkit_apply_mutations"(jsonb, text, boolean, boolean, jsonb, text) IS '${expected}'`,
    );
  });

  it("is stable for the same registry + codegen", () => {
    expect(expectedApplyFingerprint(itemsRegistry())).toBe(expected);
  });

  it("changes when the registry shape changes", () => {
    expect(expectedApplyFingerprint(itemsRegistry({ extraColumn: true }))).not.toBe(expected);
  });

  it("changes when the function schema changes", () => {
    expect(expectedApplyFingerprint(baseRegistry, { functionSchema: "custom" })).not.toBe(expected);
  });

  // ADR-0054 decision 3: the ACL is hashed WITH the body, so who may execute is part of the artifact's
  // identity. An install that lost the revokes — or that grants a role this server does not expect —
  // is a different fingerprint and is refused at call time, instead of running on while `--check`
  // reports green.
  it("changes when grantExecuteTo changes, and is stable for the same list", () => {
    const granted = expectedApplyFingerprint(baseRegistry, { grantExecuteTo: ["app_writer"] });

    expect(granted).not.toBe(expected);
    expect(expectedApplyFingerprint(itemsRegistry(), { grantExecuteTo: ["app_writer"] })).toBe(granted);
    expect(expectedApplyFingerprint(baseRegistry, { grantExecuteTo: ["other_writer"] })).not.toBe(granted);
    expect(expectedApplyFingerprint(baseRegistry, { grantExecuteTo: ["app_writer", "reporter"] })).not.toBe(granted);
    // An explicitly empty list IS the default (owner-only), not a third state.
    expect(expectedApplyFingerprint(baseRegistry, { grantExecuteTo: [] })).toBe(expected);
  });

  it("refuses an invalid grantExecuteTo role rather than fingerprinting an artifact it cannot emit", () => {
    expect(() => expectedApplyFingerprint(baseRegistry, { grantExecuteTo: ["app writer"] })).toThrow(/grantExecuteTo/);
  });

  // The grant list is a SET, not a sequence: the renderer sorts it canonically, so the same roles in
  // any order are one artifact identity. Without this, a generate command and a `createSyncServer`
  // config that agree on WHO may execute but not on the order would fail every write with PXS01.
  it("is independent of the ORDER grantExecuteTo is listed in", () => {
    expect(expectedApplyFingerprint(baseRegistry, { grantExecuteTo: ["reporter", "app_writer"] })).toBe(
      expectedApplyFingerprint(baseRegistry, { grantExecuteTo: ["app_writer", "reporter"] }),
    );
  });

  // F2: the schema is a fingerprint input AND the name the server must call, so both sides read it
  // through one validator — a name the renderer would refuse must never be accepted by the server.
  it("refuses a functionSchema that is not a plain SQL identifier", () => {
    for (const schema of ["", "   ", "app fns", 'app"; DROP TABLE x --', "1schema"]) {
      expect(() => expectedApplyFingerprint(baseRegistry, { functionSchema: schema })).toThrow(/functionSchema/);
    }
    expect(() => expectedApplyFingerprint(baseRegistry, { functionSchema: "a".repeat(64) })).toThrow(/63-byte/);
  });

  it("installs the COMMENT so obj_description reads back the exact fingerprint", async () => {
    const db = await createFreshTestPGlite();
    await db.exec(`CREATE TABLE fp_items (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL,
      title varchar(120) NOT NULL,
      created_at_us bigint NOT NULL DEFAULT 0,
      updated_at_us bigint NOT NULL DEFAULT 0
    )`);
    await db.exec(buildPlpgsqlBatchFunctionDdl(baseRegistry));

    const result = await db.query<{ comment: string | null }>(
      `SELECT obj_description(to_regprocedure('public.${applySignature}')::oid, 'pg_proc') AS "comment"`,
    );
    expect(result.rows[0]?.comment).toBe(expected);
  });
});
