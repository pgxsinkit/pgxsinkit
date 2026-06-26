import { defineConfig } from "drizzle-kit";

// The board demo runs on its own (partial) Supabase stack with its own database, so its migration
// history is separate from the toolkit demo/harness migrations in `infra/drizzle`. Schema is the
// board registry's server tables (RLS policies travel with them via drizzle `pgPolicy`).
export default defineConfig({
  dialect: "postgresql",
  schema: ["./packages/board-schema/src/schema.ts"],
  out: "./infra/board-drizzle",
  dbCredentials: {
    // Matches the board compose stack (infra/compose/board-compose.yml): the `postgres` role on host
    // port 54322 — the same role the official self-hosted stack uses for app/admin connections (it
    // has the known ${POSTGRES_PASSWORD}). Migrations are public-schema only; never touch auth.
    url:
      process.env["BOARD_DATABASE_URL"] ??
      "postgresql://postgres:your-super-secret-and-long-postgres-password@localhost:54322/postgres?sslmode=disable",
  },
  // Declare the Supabase-managed roles (authenticated/anon/service_role/…) to drizzle-kit so it treats
  // them as external — referenced in `pgPolicy(to: authenticatedRole)` but never created/dropped — and
  // so a future custom `pgRole(...)` would be managed while the built-ins stay excluded. A no-op for the
  // current schema (we only *reference* `authenticated`); it generates no role DDL.
  entities: {
    roles: {
      provider: "supabase",
    },
  },
});
