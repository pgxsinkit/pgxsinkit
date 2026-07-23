/**
 * Single source of truth for database credentials used by the compose stack.
 * All scripts and the write-api app must reference these values — never
 * hardcode connection strings elsewhere.
 *
 * Override any value via environment variables (see docker-compose.yml).
 */

const USER = process.env["PGXSINKIT_INTEGRATION_POSTGRES_USER"] ?? "supabase_admin";
const PASSWORD =
  process.env["PGXSINKIT_INTEGRATION_POSTGRES_PASSWORD"] ?? "your-super-secret-and-long-postgres-password";
const DB = process.env["PGXSINKIT_INTEGRATION_POSTGRES_DB"] ?? "postgres";

/** Builds a DATABASE_URL for the compose PostgreSQL instance. */
function buildLocalDatabaseUrl(
  host = "127.0.0.1",
  port = Number(process.env["PGXSINKIT_INTEGRATION_POSTGRES_PORT"] ?? 54321),
): string {
  return `postgresql://${USER}:${PASSWORD}@${host}:${port}/${DB}?sslmode=disable`;
}

/** Default DATABASE_URL for dev / local use (matches .env.example). */
const DEFAULT_DATABASE_URL = buildLocalDatabaseUrl();

export const composeCredentials = {
  user: USER,
  password: PASSWORD,
  db: DB,
  buildLocalDatabaseUrl,
  DEFAULT_DATABASE_URL,
} as const;
