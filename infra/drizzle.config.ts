import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./packages/schema/src/schema.ts",
    "./packages/schema/src/integration.ts",
    "./packages/server/src/operations-log/schema.ts",
  ],
  out: "./infra/drizzle",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgresql://postgres:password@localhost:54321/pgxsinkit?sslmode=disable",
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
