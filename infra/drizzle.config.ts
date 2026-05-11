import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./packages/schema/src/schema.ts", "./packages/server/src/operations-log/schema.ts"],
  out: "./infra/drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:54321/pgxsinkit?sslmode=disable",
  },
});
