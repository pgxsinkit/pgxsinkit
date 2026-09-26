// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.

/**
 * The name Postgres stores for an identifier: a quoted one keeps its case (quotes removed), an
 * unquoted one is folded to lower case. Used to key notification listeners the way Postgres names
 * the channel.
 */
export function toPostgresName(input: string): string {
  if (input.startsWith('"') && input.endsWith('"') && input.length >= 2) {
    return input.slice(1, -1);
  }
  return input.toLowerCase();
}

/** Quote an identifier for SQL: wrap in double quotes, doubling any inside. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A random 32-character hex id, for the names of temporary objects. */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
