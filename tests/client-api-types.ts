import { createSyncClient } from "@pgxsinkit/client";
import type { SyncTableCreateInput } from "@pgxsinkit/contracts";
import { demoSyncRegistry } from "@pgxsinkit/demo";

const validInput: SyncTableCreateInput<typeof demoSyncRegistry, "todos"> = {
  id: "01963227-d4c7-72db-b858-f89f6af8f999",
  title: "valid",
  description: null,
  authorId: "01963227-d4c7-72db-b858-f89f6af8f920",
  status: "todo",
  priority: "medium",
};

// @ts-expect-error registry keys must stay literal
const badKey: keyof typeof demoSyncRegistry = "doesnt_exist";

// @ts-expect-error create input must remain insert-compatible for todos
const badInput: SyncTableCreateInput<typeof demoSyncRegistry, "todos"> = {
  id: "01963227-d4c7-72db-b858-f89f6af8f999",
  title: "missing fields",
};

async function check() {
  const client = await createSyncClient({
    registry: demoSyncRegistry,
    electricUrl: "http://localhost:3000/v1/shape",
    writeUrl: "http://localhost:3001",
  });

  await client.tables.todos.create(validInput);

  // @ts-expect-error unknown table names must fail
  await client.tables.doesnt_exist.create({ id: "x" });

  // @ts-expect-error todo create must require the full typed insert payload
  await client.tables.todos.create({
    id: "01963227-d4c7-72db-b858-f89f6af8f999",
    title: "missing fields",
  });
}

void badKey;
void badInput;
void validInput;
void check;
