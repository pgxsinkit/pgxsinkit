import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export function createPostgresClient(connectionString: string) {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get("sslmode");

  return postgres({
    host: url.hostname,
    port: Number(url.port || "5432"),
    database: url.pathname.replace(/^\//, ""),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: sslmode === "disable" ? false : "prefer",
    max: 10,
  });
}

export function createDatabase(connectionString: string) {
  const client = createPostgresClient(connectionString);
  return {
    db: drizzle({ client }),
    client,
  };
}
