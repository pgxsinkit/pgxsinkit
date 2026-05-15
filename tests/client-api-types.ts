import { uuid, varchar } from "drizzle-orm/pg-core";

import { createSyncClient } from "@pgxsinkit/client";
import {
  defineSyncRegistry,
  defineSyncTable,
  type SyncTableCreateInput,
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
    clientProjection: {
      omitColumns: ["ownerId"],
    },
    governance: {
      managedFields: [{ column: "ownerId", applyOn: ["create"], strategy: "authUid" }],
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

async function check() {
  const client = await createSyncClient({
    registry: demoSyncRegistry,
    electricUrl: "http://localhost:3000/v1/shape",
    writeUrl: "http://localhost:3001",
  });

  const projectedClient = await createSyncClient({
    registry: projectedRegistry,
    electricUrl: "http://localhost:3000/v1/shape",
    writeUrl: "http://localhost:3001",
  });

  await client.tables.todos.create(validInput);
  await projectedClient.tables.projectedItems.create(validProjectedInput);

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
}

void badKey;
void badInput;
void badProjectedInput;
void invalidProjectedField;
void invalidProjectedPatch;
void validInput;
void validProjectedInput;
void validProjectedPatch;
void check;
