import { defineConfig } from "drizzle-kit";

// The board demo runs on its own (partial) Supabase stack with its own database, so its migration
// history is separate from the toolkit demo/harness migrations in `infra/drizzle`. Schema is the
// board registry's server tables (RLS policies travel with them via drizzle `pgPolicy`).
export default defineConfig({
  dialect: "postgresql",
  schema: ["./packages/board-schema/src/schema.ts"],
  out: "./infra/board-drizzle",
  dbCredentials: {
    // Matches the board compose stack (infra/compose/board-compose.yml): supabase_admin on host
    // port 54322. The applier switches the RLS actor to `authenticated` per batch, so connecting as
    // the superuser to run migrations is correct — migrations are server authority, never local.
    url:
      process.env["BOARD_DATABASE_URL"] ??
      "postgresql://supabase_admin:your-super-secret-and-long-postgres-password@localhost:54322/postgres?sslmode=disable",
  },
});
