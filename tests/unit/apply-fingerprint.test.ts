import { describe, expect, it, spyOn } from "bun:test";

import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import {
  buildPlpgsqlBatchFunctionDdl,
  expectedApplyFingerprint,
  verifyPlpgsqlBatchFunction,
} from "../../packages/server/src/mutations/plpgsql-apply";
import { createFreshTestPGlite } from "../support/pglite";

// ADR-0018: the generated apply function is stamped with a fingerprint of its exact DDL body, so the
// server (at startup) and CI (pre-deploy) can detect a function that is stale relative to the registry
// + applier codegen it is meant to serve. The fingerprint lives in a COMMENT ON FUNCTION and is read
// back via obj_description.

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
          { column: "ownerId", applyOn: ["create"], strategy: "authUid" },
          { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
          { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
        ],
      },
    }),
  });
}

const baseRegistry = itemsRegistry();
const expected = expectedApplyFingerprint(baseRegistry);
const applySignature = "pgxsinkit_apply_mutations(jsonb,text,boolean,boolean,jsonb)";

type PresenceRow = { functionName: string | null; fingerprintComment: string | null };

// The production driver (bun-sql) returns an iterable RowList from `execute`; `verifyPlpgsqlBatchFunction`
// consumes it via `Array.from(result)`. A bare array reproduces that contract faithfully and lets us
// drive every drift outcome without a database.
function dbReturning(row: PresenceRow): Parameters<typeof verifyPlpgsqlBatchFunction<typeof baseRegistry>>[0] {
  return { execute: async () => [row] } as unknown as Parameters<
    typeof verifyPlpgsqlBatchFunction<typeof baseRegistry>
  >[0];
}

describe("apply-function fingerprint (ADR-0018)", () => {
  it("stamps the DDL with a COMMENT carrying the expected fingerprint", () => {
    const ddl = buildPlpgsqlBatchFunctionDdl(baseRegistry);
    expect(expected.startsWith(FP_PREFIX)).toBe(true);
    expect(ddl).toContain(
      `COMMENT ON FUNCTION "pgxsinkit_apply_mutations"(jsonb, text, boolean, boolean, jsonb) IS '${expected}'`,
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

describe("verifyPlpgsqlBatchFunction drift check (ADR-0018)", () => {
  const present = (fingerprintComment: string | null): PresenceRow => ({
    functionName: `public.${applySignature}`,
    fingerprintComment,
  });

  it("passes silently when the installed fingerprint matches", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(verifyPlpgsqlBatchFunction(dbReturning(present(expected)), baseRegistry)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("throws on a mismatch by default (error mode)", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      verifyPlpgsqlBatchFunction(dbReturning(present(`${FP_PREFIX}0000000000000000`)), baseRegistry),
    ).rejects.toThrow(/does not match the current registry/);
  });

  it("warns but continues on a mismatch in warn mode", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      verifyPlpgsqlBatchFunction(dbReturning(present(`${FP_PREFIX}0000000000000000`)), baseRegistry, {
        driftCheck: "warn",
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("skips the comparison entirely in off mode", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      verifyPlpgsqlBatchFunction(dbReturning(present(`${FP_PREFIX}0000000000000000`)), baseRegistry, {
        driftCheck: "off",
      }),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns but does not fail when the function carries no fingerprint comment (older pgxsinkit)", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(verifyPlpgsqlBatchFunction(dbReturning(present(null)), baseRegistry)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("treats an unknown comment format as 'cannot verify', not a mismatch", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      verifyPlpgsqlBatchFunction(dbReturning(present("a hand-written comment")), baseRegistry),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("still throws when the function is missing entirely", async () => {
    // oxlint-disable-next-line typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return a real promise typed as void
    await expect(
      verifyPlpgsqlBatchFunction(dbReturning({ functionName: null, fingerprintComment: null }), baseRegistry),
    ).rejects.toThrow(/requires the preinstalled function/);
  });
});
