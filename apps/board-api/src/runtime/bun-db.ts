import { drizzle } from "drizzle-orm/bun-sql";
import { defineRelations } from "drizzle-orm/relations";

import { boardSyncRegistry } from "@pgxsinkit/board-schema";
import { buildRegistrySchema } from "@pgxsinkit/server";

const schema = buildRegistrySchema(boardSyncRegistry);
const relations = defineRelations(schema);

export function createBunBoardDb(connection: string) {
  return drizzle({ connection, relations });
}
