import { describe, expect, it } from "bun:test";

import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import {
  defineSyncTable,
  type MutationEnvelope,
  type SyncTableEntry,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import {
  buildUpdateValidationSchema,
  findManagedFieldViolations,
  sanitizeRestrictedFields,
} from "../../packages/server/src/mutations/route";

// A create-only managed field (`applyOn: ["create"]`) is server-stamped at birth and INERT thereafter:
// the generated apply function offers no UPDATE SET candidate for it. The write route must say so at the
// request boundary too — flag it, strip it, and omit it from the update schema — exactly as it already
// treats a create-managed field on a create, rather than leaving consumer RLS as the only defense.
const ownedItems = defineSyncTable({
  tableName: "guarded_owned_items",
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
}) as unknown as SyncTableEntry;

const registry = { guarded_owned_items: ownedItems } as unknown as SyncTableRegistry;

function updateMutation(payload: Record<string, unknown>): MutationEnvelope {
  return {
    tableName: "guarded_owned_items",
    kind: "update",
    entityKey: { id: "01963227-d4c7-72db-b858-f89f6af8fd01" },
    payload,
    mutationId: "01963227-d4c7-72db-b858-f89f6af8fd02",
    mutationSeq: 1,
    clientTimestampUs: "1000",
  };
}

describe("create-only managed fields on the update path (request guards)", () => {
  it("flags a create-only managed field sent in an update payload", () => {
    // `ownerId` is stamped once, from the verified `sub` claim. Sending it on an update asserts an
    // ownership change the apply path will never honour — a managed-field violation, so a 400.
    expect(findManagedFieldViolations(ownedItems, "update", { body: "edit", ownerId: "…" })).toEqual(["ownerId"]);
    expect(findManagedFieldViolations(ownedItems, "update", { body: "edit", createdAtUs: "1" })).toEqual([
      "createdAtUs",
    ]);
  });

  it("still flags an update-managed field, and leaves an ordinary edit alone", () => {
    expect(findManagedFieldViolations(ownedItems, "update", { updatedAtUs: "1" })).toEqual(["updatedAtUs"]);
    expect(findManagedFieldViolations(ownedItems, "update", { body: "edit" })).toEqual([]);
  });

  it("keeps the create path unchanged — a create-managed field is flagged there as before", () => {
    expect(findManagedFieldViolations(ownedItems, "create", { body: "new", ownerId: "…" })).toEqual(["ownerId"]);
    expect(findManagedFieldViolations(ownedItems, "create", { id: "x", body: "new" })).toEqual([]);
  });

  it("strips a create-only managed field from an update payload (defense in depth)", () => {
    const sanitized = sanitizeRestrictedFields(
      { mutations: [updateMutation({ body: "edit", ownerId: "…", created_at_us: "1", updatedAtUs: "2" })] },
      registry,
    );

    // Both spellings (property key and DB column name) are removed; the ordinary edit survives.
    expect(sanitized.mutations[0]?.payload).toEqual({ body: "edit" });
  });

  it("omits every managed key from the update validation schema while keeping ordinary keys", () => {
    const schema = buildUpdateValidationSchema(ownedItems);

    // An update is a patch, so every remaining key is optional...
    const patch: unknown = schema.parse({ body: "edit" });
    expect(patch).toEqual({ body: "edit" });
    // ...and the managed keys are not part of the schema at all, so nothing about a create-only managed
    // column is required or carried through (the violation check has already 400-rejected such a payload).
    const withManagedKeys: unknown = schema.parse({ body: "edit", ownerId: "not-a-uuid", createdAtUs: "nope" });
    expect(withManagedKeys).toEqual({ body: "edit" });
    // A genuinely-wrong value for an ordinary column is still rejected.
    expect(() => schema.parse({ body: 42 })).toThrow();
  });
});
