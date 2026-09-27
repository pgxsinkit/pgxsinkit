// Began as a copy of `@electric-sql/pglite-repl` (taken under PGlite's PostgreSQL License option,
// © ElectricSQL — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { describe } from "psql-describe";

import type { ReplDatabase, ReplResponse, ReplRows } from "./types";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Rows asked for with `rowMode: "array"` are arrays; anything else is shown as one value. */
function asRows(result: { readonly rows: readonly unknown[]; readonly fields: ReplRows["fields"] }): ReplRows {
  return { rows: result.rows.map((row) => (Array.isArray(row) ? row : [row])), fields: result.fields };
}

/**
 * Run what was typed: psql's `\d` family of commands through psql-describe, anything else as SQL (every
 * statement of it, rows as arrays). A failure is a response with its message, never a throw.
 */
export async function runQuery(query: string, pg: ReplDatabase): Promise<ReplResponse> {
  if (query.trim().startsWith("\\")) return await runDescribe(query, pg);
  const start = performance.now();
  try {
    const results = await pg.exec(query, { rowMode: "array" });
    return { query, results: results.map(asRows), time: performance.now() - start };
  } catch (error) {
    return { query, error: errorMessage(error), time: performance.now() - start };
  }
}

/** The text type's OID: psql-describe hands its tables over as text. */
const TEXT_OID = 25;

/** A table psql-describe produced (its cells row by row), as rows to show. */
function describedTable(item: Record<string, unknown>): ReplRows | undefined {
  const { title, headers, cells, footers, ncolumns } = item;
  if (!Array.isArray(headers) || !Array.isArray(cells) || typeof ncolumns !== "number" || ncolumns < 1) {
    return undefined;
  }
  const rows: unknown[][] = [];
  for (let at = 0; at < cells.length; at += ncolumns) rows.push(cells.slice(at, at + ncolumns));
  return {
    rows,
    fields: headers.map((name) => ({ name: String(name), dataTypeID: TEXT_OID })),
    ...(typeof title === "string" ? { title } : {}),
    ...(Array.isArray(footers) ? { footers: footers.map(String) } : {}),
  };
}

/**
 * Run a psql describe command (`\d`, `\dt`, `\df+ pattern`, …): each table psql-describe produces is a
 * result, with its caption and footers; its messages are the response's text.
 */
export async function runDescribe(query: string, pg: ReplDatabase): Promise<ReplResponse> {
  const start = performance.now();
  const items: (string | Record<string, unknown>)[] = [];
  try {
    const { promise } = describe(
      query,
      "postgres",
      async (sql: string) => {
        const [result] = await pg.exec(sql, { rowMode: "array" });
        const rows = asRows(result ?? { rows: [], fields: [] });
        return { rows: rows.rows, fields: rows.fields, rowCount: rows.rows.length };
      },
      (item) => {
        items.push(item);
      },
    );
    await promise;
  } catch (error) {
    return { query, error: errorMessage(error), time: performance.now() - start };
  }
  const time = performance.now() - start;
  const texts = items.filter((item) => typeof item === "string");
  const error = texts.find((text) => text.startsWith("ERROR:"));
  if (error !== undefined) return { query, error, time };
  const results = items.flatMap((item) => {
    const table = typeof item === "string" ? undefined : describedTable(item);
    return table === undefined ? [] : [table];
  });
  if (texts.length === 0 && results.length === 0) return { query, error: "No output", time };
  return {
    query,
    ...(texts.length > 0 ? { text: texts.join("\n") } : {}),
    ...(results.length > 0 ? { results } : {}),
    time,
  };
}

/** Every table's columns, by `schema.table`, for autocompletion. */
export async function getSchema(pg: ReplDatabase): Promise<Record<string, string[]>> {
  const result = await pg.query(
    `SELECT table_schema || '.' || table_name, column_name::text
       FROM information_schema.columns
      ORDER BY table_schema, table_name, ordinal_position`,
    [],
    { rowMode: "array" },
  );
  const schema: Record<string, string[]> = {};
  for (const [table, column] of asRows(result).rows) {
    if (typeof table === "string" && typeof column === "string") (schema[table] ??= []).push(column);
  }
  return schema;
}
