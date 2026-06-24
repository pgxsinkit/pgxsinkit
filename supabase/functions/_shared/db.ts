// The Drizzle handle the write path uses inside the Edge function.
//
// The write-api app (Bun) builds its handle with `drizzle-orm/bun-sql`; Bun's SQL driver does not
// exist under Deno, so the Edge functions use **postgres.js** (`drizzle-orm/postgres-js`) — the
// driver the board grilling settled on precisely because it runs on both Bun and Deno. Everything
// above the driver (registry → relations → server) is identical, which is the whole point of the
// toolkit server being a runtime-portable `fetch` handler.

import { drizzle } from "drizzle-orm/postgres-js";
import { defineRelations } from "drizzle-orm/relations";
import postgres from "postgres";

import { boardSyncRegistry } from "@pgxsinkit/board-schema";
import { buildRegistrySchema } from "@pgxsinkit/server";

const schema = buildRegistrySchema(boardSyncRegistry);
const relations = defineRelations(schema);

/**
 * Builds the board's Drizzle handle from `SUPABASE_DB_URL` (the in-cluster connection string the Edge
 * runtime is given). One client per worker; postgres.js pools internally. The applier switches the
 * Postgres role to `authenticated` and sets `request.jwt.claims` per batch, so the connection role
 * itself only needs to be allowed to assume `authenticated` — it does not bypass RLS for the write.
 */
export function createBoardDb() {
  const connectionString = Deno.env.get("SUPABASE_DB_URL");
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is not set — the board-write function cannot reach Postgres.");
  }

  const client = postgres(connectionString, { prepare: false });
  return drizzle({ client, relations });
}
