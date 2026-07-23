import { bigint, uuid, varchar } from "drizzle-orm/pg-core";

import { createSyncClient, type SyncClient } from "@pgxsinkit/client";
import {
  defineSyncRegistry,
  defineSyncTable,
  type SyncTableCreateInput,
  type SyncTableRegistry,
  type SyncTableUpdateInput,
} from "@pgxsinkit/contracts";
import { demoSyncRegistry } from "@pgxsinkit/schema";

const projectedRegistry = defineSyncRegistry({
  projectedItems: defineSyncTable({
    tableName: "projected_items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      ownerId: uuid("owner_id").notNull(),
      title: varchar("title", { length: 120 }).notNull(),
      notes: varchar("notes", { length: 255 }),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    clientProjection: {
      omitColumns: ["ownerId"],
    },
    governance: {
      managedFields: [{ column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] }],
    },
  }),
});

const locallyManagedRegistry = defineSyncRegistry({
  locallyManagedItems: defineSyncTable({
    tableName: "locally_managed_items",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 120 }).notNull(),
      createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [
        { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
        { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
      ],
    },
  }),
});

const validInput: SyncTableCreateInput<typeof demoSyncRegistry, "todos"> = {
  id: "01963227-d4c7-72db-b858-f89f6af8f999",
  title: "valid",
  description: null,
  authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
  status: "todo",
  priority: "medium",
};

const validProjectedInput: SyncTableCreateInput<typeof projectedRegistry, "projectedItems"> = {
  id: "01963227-d4c7-72db-b858-f89f6af8f111",
  title: "projected",
};

const validProjectedPatch: SyncTableUpdateInput<typeof projectedRegistry, "projectedItems"> = {
  title: "updated projected",
};

const validLocallyManagedInput: SyncTableCreateInput<typeof locallyManagedRegistry, "locallyManagedItems"> = {
  id: "01963227-d4c7-72db-b858-f89f6af8f118",
  title: "managed timestamps",
};

const validLocallyManagedPatch: SyncTableUpdateInput<typeof locallyManagedRegistry, "locallyManagedItems"> = {
  title: "patched managed timestamps",
};

// @ts-expect-error registry keys must stay literal
const badKey: keyof typeof demoSyncRegistry = "doesnt_exist";

// @ts-expect-error create input must remain insert-compatible for todos
const badInput: SyncTableCreateInput<typeof demoSyncRegistry, "todos"> = {
  id: "01963227-d4c7-72db-b858-f89f6af8f999",
  title: "missing fields",
};

// @ts-expect-error projected creates must still require projected required fields
const badProjectedInput: SyncTableCreateInput<typeof projectedRegistry, "projectedItems"> = {
  id: "01963227-d4c7-72db-b858-f89f6af8f112",
};

const invalidProjectedField: SyncTableCreateInput<typeof projectedRegistry, "projectedItems"> = {
  id: "01963227-d4c7-72db-b858-f89f6af8f113",
  // @ts-expect-error projected creates must reject omitted managed fields
  ownerId: "01963227-d4c7-72db-b858-f89f6af8f114",
  title: "should fail",
};

const invalidProjectedPatch: SyncTableUpdateInput<typeof projectedRegistry, "projectedItems"> = {
  // @ts-expect-error projected updates must reject omitted managed fields
  ownerId: "01963227-d4c7-72db-b858-f89f6af8f115",
};

const invalidLocallyManagedInput: SyncTableCreateInput<typeof locallyManagedRegistry, "locallyManagedItems"> = {
  id: "01963227-d4c7-72db-b858-f89f6af8f119",
  title: "should fail",
  // @ts-expect-error locally retained create-managed fields must still be omitted from create input
  createdAtUs: 1n,
};

const invalidLocallyManagedCreateTimestamp: SyncTableCreateInput<typeof locallyManagedRegistry, "locallyManagedItems"> =
  {
    id: "01963227-d4c7-72db-b858-f89f6af8f120",
    title: "should also fail",
    // @ts-expect-error locally retained update-managed fields must still be omitted from create input
    updatedAtUs: 2n,
  };

const invalidLocallyManagedPatch: SyncTableUpdateInput<typeof locallyManagedRegistry, "locallyManagedItems"> = {
  // @ts-expect-error locally retained update-managed fields must be omitted from update input
  updatedAtUs: 3n,
};

async function check() {
  const client = await createSyncClient({
    registry: demoSyncRegistry,
    electricUrl: "http://localhost:3000/v1/shape",
    batchWriteUrl: "http://localhost:3001/api/mutations",
  });

  const projectedClient = await createSyncClient({
    registry: projectedRegistry,
    electricUrl: "http://localhost:3000/v1/shape",
    batchWriteUrl: "http://localhost:3001/api/mutations",
  });

  const locallyManagedClient = await createSyncClient({
    registry: locallyManagedRegistry,
    electricUrl: "http://localhost:3000/v1/shape",
    batchWriteUrl: "http://localhost:3001/api/mutations",
  });

  await client.tables.todos.create(validInput);
  await projectedClient.tables.projectedItems.create(validProjectedInput);
  await locallyManagedClient.tables.locallyManagedItems.create(validLocallyManagedInput);

  // @ts-expect-error unknown table names must fail
  await client.tables.doesnt_exist.create({ id: "x" });

  // @ts-expect-error todo create must require the full typed insert payload
  await client.tables.todos.create({
    id: "01963227-d4c7-72db-b858-f89f6af8f999",
    title: "missing fields",
  });

  await projectedClient.tables.projectedItems.create({
    id: "01963227-d4c7-72db-b858-f89f6af8f116",
    // @ts-expect-error projected create must reject omitted managed fields
    ownerId: "01963227-d4c7-72db-b858-f89f6af8f117",
    title: "should fail",
  });

  // Registry-erasure covariance guard: a concretely-typed client must stay assignable to a
  // bare-`SyncTableRegistry` supertype of the read seam — the pattern registry-agnostic consumer
  // helpers rely on. `PreparedQueryResult` is parameterized by the table-NAME union precisely so
  // this holds; a `keyof TRegistry` output position would silently make the registry contravariant.
  const readSeamClient: Pick<SyncClient<SyncTableRegistry>, "drizzle" | "prepareQuery" | "subscribeLiveRows"> = client;
  void readSeamClient;
}

void badKey;
void badInput;
void badProjectedInput;
void invalidProjectedField;
void invalidProjectedPatch;
void invalidLocallyManagedInput;
void invalidLocallyManagedCreateTimestamp;
void invalidLocallyManagedPatch;
void validInput;
void validLocallyManagedInput;
void validLocallyManagedPatch;
void validProjectedInput;
void validProjectedPatch;
void check;
