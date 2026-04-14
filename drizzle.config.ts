import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./packages/demo/src/schema.ts", "./packages/server/src/operations-log/schema.ts"],
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:password@localhost:54321/pgxsinkit?sslmode=disable",
  },
});
