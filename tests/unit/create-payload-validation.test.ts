import { describe, expect, it } from "bun:test";

import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncTable, type SyncTableEntry } from "@pgxsinkit/contracts";

import { buildCreateValidationSchema } from "../../packages/server/src/mutations/route";

// A writable table with an `authClaim` managed-on-create field that is NOT NULL and carries no column
// default (the board's `message.author_id`). Regression: board Phase 7 — the create-validation schema
// must NOT require a server-stamped managed field, or every create on such a table 400s even though
// the client correctly omits it (and including it is a managed-field violation). Before the fix the
// full insert schema required `ownerId`, so the create was impossible: omitting it → 400 here;
// including it → 400 at the managed-field-violation check. The two managed timestamps are also
// managed-on-create, so they are omitted too.
const authOwned = defineSyncTable({
  tableName: "auth_owned_items",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").notNull(),
    body: varchar("body", { length: 200 }).notNull(),
    createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
  }),
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  governance: {
    managedFields: [
      { column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
      { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
    ],
  },
});

describe("create payload validation (managed-on-create fields)", () => {
  it("accepts a create payload that omits the authClaim + managed-timestamp fields", () => {
    const schema = buildCreateValidationSchema(authOwned as unknown as SyncTableEntry);
    expect(() =>
      schema.parse({ id: "01963227-d4c7-72db-b858-f89f6af8fc01", body: "optimistic message" }),
    ).not.toThrow();
  });

  it("still requires a genuinely-required non-managed field", () => {
    const schema = buildCreateValidationSchema(authOwned as unknown as SyncTableEntry);
    // `body` is NOT NULL and not managed, so it stays required — the omit only relaxes managed fields.
    expect(() => schema.parse({ id: "01963227-d4c7-72db-b858-f89f6af8fc02" })).toThrow();
  });
});
