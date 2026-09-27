/**
 * The database's own session, before and after pg_dump runs on it.
 *
 * pg_dump expects a connection of its own and leaves the session in a state a real disconnect would
 * discard: its read-only transaction open (it never commits; ending the connection ends it), its
 * prepared statements, and every setting it changed (`search_path`, `row_security`,
 * `restrict_nonsystem_relation_kind`, `extra_float_digits`, the timeouts, …). Here the session is the
 * database's, so each of those is undone explicitly, and nothing of the database's own is touched.
 * Every exchange runs over `/protocol` inside the exclusive session pgDump holds, without persisting
 * (nothing here writes data).
 */

import { messages, serialize, type BackendMessage, type PgwasmProtocol } from "@pgxsinkit/pgwasm/protocol";

import { PgDumpSessionError } from "./errors";

/**
 * Every setting a session can change for itself, and the role (`SET ROLE`, which `pg_settings` does not
 * list). The three transaction-scoped settings end with the transaction.
 */
const SETTINGS_QUERY = `SELECT name, pg_catalog.current_setting(name) FROM pg_catalog.pg_settings
  WHERE context IN ('user', 'superuser')
    AND name NOT IN ('transaction_isolation', 'transaction_read_only', 'transaction_deferrable')
  UNION ALL SELECT 'role', pg_catalog.current_setting('role')`;

const PREPARED_STATEMENTS_QUERY = "SELECT name FROM pg_catalog.pg_prepared_statements";

const SET_CONFIG = "SELECT pg_catalog.set_config($1, $2, false)";

/** What of the session pg_dump can change: its settings, by name, and its prepared statements. */
export interface SessionState {
  readonly settings: ReadonlyMap<string, string>;
  readonly preparedStatements: ReadonlySet<string>;
}

async function exchange(wire: PgwasmProtocol, message: Uint8Array): Promise<BackendMessage[]> {
  return (await wire.execProtocol(message, { persist: false })).messages;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * The transaction status: `I` idle, `T` in a transaction block, `E` in a failed one. A lone Sync runs
 * nothing: the backend only answers it with ReadyForQuery (and ends an extended-query cycle a failed
 * client left without its Sync).
 */
export async function transactionStatus(wire: PgwasmProtocol): Promise<string> {
  const replies = await exchange(wire, serialize.sync());
  const ready = replies.findLast((reply) => reply instanceof messages.ReadyForQueryMessage);
  if (!(ready instanceof messages.ReadyForQueryMessage)) {
    throw new Error("the database answered a Sync without ReadyForQuery");
  }
  return ready.status;
}

/** Each data row's text fields. */
async function rows(wire: PgwasmProtocol, sql: string): Promise<(string | null)[][]> {
  return (await exchange(wire, serialize.query(sql)))
    .filter((reply) => reply instanceof messages.DataRowMessage)
    .map((row) => row.fields);
}

async function readSettings(wire: PgwasmProtocol): Promise<Map<string, string>> {
  const settings = new Map<string, string>();
  for (const [name, value] of await rows(wire, SETTINGS_QUERY)) {
    if (typeof name === "string" && typeof value === "string") settings.set(name, value);
  }
  return settings;
}

async function readPreparedStatements(wire: PgwasmProtocol): Promise<Set<string>> {
  return new Set((await rows(wire, PREPARED_STATEMENTS_QUERY)).flatMap(([name]) => (name == null ? [] : [name])));
}

/** The session's settings and prepared statements. */
export async function readSession(wire: PgwasmProtocol): Promise<SessionState> {
  return { settings: await readSettings(wire), preparedStatements: await readPreparedStatements(wire) };
}

function differing(before: ReadonlyMap<string, string>, now: ReadonlyMap<string, string>): string[] {
  return [...before].filter(([name, value]) => now.get(name) !== value).map(([name]) => name);
}

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * Put the session back as it was before pg_dump: end the transaction it left open, deallocate the
 * statements it prepared, and restore every setting it changed (the role last, undoing pg_dump's own
 * order). A setting still differing afterwards is a {@link PgDumpSessionError}.
 */
export async function restoreSession(wire: PgwasmProtocol, before: SessionState): Promise<void> {
  // pg_dump never ends its read-only transaction (a disconnect would); nothing it did needs keeping.
  if ((await transactionStatus(wire)) !== "I") await exchange(wire, serialize.query("ROLLBACK"));
  // A disconnect would drop pg_dump's prepared statements; the database's own (a live query's) stay.
  for (const name of await readPreparedStatements(wire)) {
    if (!before.preparedStatements.has(name)) {
      await exchange(wire, serialize.query(`DEALLOCATE ${quoteIdentifier(name)}`));
    }
  }
  const changed = differing(before.settings, await readSettings(wire)).sort((a, b) =>
    a === "role" ? 1 : b === "role" ? -1 : a.localeCompare(b),
  );
  const failures: unknown[] = [];
  for (const name of changed) {
    const value = before.settings.get(name) ?? "";
    try {
      await exchange(
        wire,
        concat([
          serialize.parse({ text: SET_CONFIG }),
          serialize.bind({ values: [name, value] }),
          serialize.execute({}),
          serialize.sync(),
        ]),
      );
    } catch (error) {
      failures.push(error);
    }
  }
  const unrestored = differing(before.settings, await readSettings(wire));
  if (unrestored.length > 0) {
    throw new PgDumpSessionError(
      `pg_dump changed session settings that could not be restored: ${unrestored.join(", ")}. The database's ` +
        "session keeps pg_dump's values for them.",
      unrestored,
      failures.length > 0 ? { cause: failures[0] } : undefined,
    );
  }
}
