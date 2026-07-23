/**
 * The single SQL identifier and literal resolver (ADR-0004).
 *
 * Every package routes identifier quoting and literal escaping through this module
 * so there is exactly one definition of "what is a bare-safe identifier", the
 * reserved-word set, quoting, and string-literal escaping. Previously five-plus
 * copies disagreed — one of them (the client mutation path) left reserved-word
 * table names unquoted, the same class of bug the local-schema generator had to fix.
 *
 * Note: this is the bare-quoting concern. Validation guards that merely assert a
 * value is a syntactically valid identifier (e.g. allowing uppercase, which is legal
 * but must be quoted) are a distinct concern and live with their callers.
 */

// PostgreSQL fully-reserved keywords: cannot be used as a bare identifier.
const RESERVED_SQL_KEYWORDS = new Set([
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "asymmetric",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "column",
  "constraint",
  "create",
  "current_catalog",
  "current_date",
  "current_role",
  "current_time",
  "current_timestamp",
  "current_user",
  "default",
  "deferrable",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "from",
  "grant",
  "group",
  "having",
  "in",
  "initially",
  "intersect",
  "into",
  "lateral",
  "leading",
  "limit",
  "localtime",
  "localtimestamp",
  "not",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "placing",
  "primary",
  "references",
  "returning",
  "select",
  "session_user",
  "some",
  "symmetric",
  "table",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "variadic",
  "when",
  "where",
  "window",
  "with",
]);

/** Always wrap an identifier in double quotes, escaping any embedded quote. */
export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Escape a SQL string-literal body (`'` -> `''`); does not add the surrounding quotes. */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** A SQL string literal, surrounding quotes included. */
export function quoteSqlLiteral(value: string): string {
  return `'${escapeSqlLiteral(value)}'`;
}

/**
 * A bare-safe identifier: a simple lowercase identifier Postgres will neither fold
 * nor misparse. Uppercase is excluded because Postgres folds an unquoted identifier
 * to lowercase, which would change its meaning. Internal to {@link maybeQuoteIdentifier}.
 */
function isSimpleIdentifier(value: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(value);
}

/**
 * Quote only when required: bare for a simple, non-reserved identifier; quoted
 * otherwise. Keeps generated SQL stable for the common case while never emitting a
 * reserved word or mixed-case name unquoted.
 */
export function maybeQuoteIdentifier(value: string): string {
  if (isSimpleIdentifier(value) && !RESERVED_SQL_KEYWORDS.has(value)) {
    return value;
  }
  return quoteIdentifier(value);
}
