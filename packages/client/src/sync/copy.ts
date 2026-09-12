// Started life as a copy of @electric-sql/pglite-sync (Apache-2.0, © ElectricSQL — see NOTICE) —
// specifically a port of the serializer from electric-sql/pglite PR #1035.
// Fully internalized (ADR-0009); upstream compatibility is an explicit anti-goal (ADR-0028) — evolve freely.
/**
 * Serialization of JavaScript values into a PostgreSQL `COPY ... WITH (FORMAT
 * text)` stream.
 *
 * Values reach this module already decoded, so the runtime types it accepts are
 * the decoded ones: `int2`/`int4`/`float4`/`float8` as `number`, `bool` as
 * `boolean`, `json`/`jsonb` as parsed objects/arrays/scalars, `int8` as
 * `bigint`, and every other type — **array columns included** — as its raw
 * Postgres text representation (a `string`). To feed those values back into
 * `COPY` we have to reverse that: turn each value into the exact text Postgres'
 * input functions expect, then apply the COPY framing.
 *
 * Only the json ones are decoded on the way in, and by exactly one step:
 * `envelopeToChange`'s `decodeJsonColumns` (`../circuits/envelope-to-change`).
 * The wire itself carries EVERY non-int/float/bool cell as Postgres output text
 * — a `jsonb` column included — so without that step the `JSON.stringify` below
 * would encode already-encoded JSON a second time and the column would land as a
 * JSON string scalar. An array column's `array_out` text is deliberately left
 * alone: it passes through {@link valueToText} unchanged and `COPY`'s `array_in`
 * parses it, which is why a `json[]` value here is a `string`, not a JS array.
 *
 * Rather than invent an escaping scheme (the previous CSV-based approach broke
 * on arrays, JSON, embedded delimiters, etc.) this is a faithful port of the
 * two relevant PostgreSQL backend routines:
 *
 *   - `CopyAttributeOutText`  (src/backend/commands/copyto.c) — field escaping
 *   - `array_out`             (src/backend/utils/adt/arrayfuncs.c) — array literals
 *
 * The TEXT format is used (not CSV) because it is what Postgres itself emits
 * internally, has a single well-defined escaping algorithm, and round-trips
 * every built-in type.
 */

import { type AnyPgTable, getTableConfig } from "drizzle-orm/pg-core";

import { quoteIdentifier } from "@pgxsinkit/contracts";

import type { RawStatement } from "../index";

// Defaults for COPY ... WITH (FORMAT text), matching the Postgres backend.
const DELIMITER = "\t";
const NULL_MARKER = "\\N";
const ROW_SEPARATOR = "\n";

// CopyAttributeOutText escapes the backslash, the field delimiter, and the
// control characters that have C-style escapes. Every other byte is emitted
// literally. Our delimiter is a tab, which already has a C-style escape, so the
// single map below covers all cases.
const COPY_TEXT_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\v": "\\v",
};
const COPY_TEXT_ESCAPE_RE = /[\\\b\f\n\r\t\v]/g;

/** Escape an already-stringified field value per `CopyAttributeOutText`. */
function escapeCopyText(value: string): string {
  return value.replace(COPY_TEXT_ESCAPE_RE, (c) => COPY_TEXT_ESCAPES[c] ?? c);
}

/**
 * Convert a Uint8Array to Postgres `bytea` hex-format text (`\xDEADBEEF`).
 * The read path normally delivers `bytea` already as such a string, so this only
 * matters for a caller whose decoder yields binary.
 */
function byteaToText(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return "\\x" + hex;
}

/**
 * Render a JS `number` the way Postgres' float/int input accepts it. The only
 * special cases are the non-finite values, which Postgres spells out in words.
 */
function numberToText(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return String(value);
}

// array_out quotes an element when it is empty, looks like the literal NULL, or
// contains a brace, the element delimiter (comma), a double-quote, a backslash,
// or ASCII whitespace. We mirror `array_isspace`, which is stricter than JS
// `\s` (it excludes Unicode whitespace), so the output matches Postgres' own
// `array_out` TEXT format exactly and re-parses correctly on `COPY FROM`.
const ARRAY_NEEDS_QUOTE_RE = /[{}",\\ \t\n\r\v\f]/;

/** Quote/escape a single array element's text per `array_out`. */
function quoteArrayElement(text: string): string {
  const needsQuote = text.length === 0 || text.toLowerCase() === "null" || ARRAY_NEEDS_QUOTE_RE.test(text);
  if (!needsQuote) return text;
  // Inside quotes only `"` and `\` are escaped, each with a single backslash.
  return '"' + text.replace(/(["\\])/g, "\\$1") + '"';
}

/**
 * Build a Postgres array literal (`{...}`) from a JS array, recursing into
 * nested arrays for multi-dimensional arrays. NULL elements become an unquoted
 * `NULL`; nested arrays are emitted as bare `{...}` (never quoted), exactly as
 * `array_out` does.
 */
function arrayToText(arr: ReadonlyArray<unknown>): string {
  const elements = arr.map((el) => {
    if (el === null || el === undefined) return "NULL";
    if (Array.isArray(el)) return arrayToText(el);
    return quoteArrayElement(valueToText(el));
  });
  return "{" + elements.join(",") + "}";
}

/**
 * Convert a non-null JS value to its bare Postgres text representation (before
 * COPY field escaping is applied). Dispatch is on the value's decoded runtime
 * type. `json`/`jsonb` columns are handled ahead of this by
 * `serializeCopyValue` when a column type is known; reaching the object branch
 * here is the type-less fallback.
 */
function valueToText(value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      return numberToText(value);
    case "bigint":
      return value.toString();
    case "boolean":
      return value ? "t" : "f";
    case "object": {
      if (Array.isArray(value)) return arrayToText(value);
      if (value instanceof Date) return value.toISOString();
      if (value instanceof Uint8Array) return byteaToText(value);
      if (value instanceof ArrayBuffer) return byteaToText(new Uint8Array(value));
      if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;
        return byteaToText(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      }
      // json / jsonb arrive already parsed; re-serialize them.
      return JSON.stringify(value);
    }
    default:
      // Should be unreachable for decoded wire values; be defensive.
      return String(value);
  }
}

/**
 * Build a Postgres array literal from a `json[]`/`jsonb[]` value. Each element
 * is JSON text (re-serialized from the parsed value), so we cannot reuse the
 * generic array path: a JSON array element must stay JSON (`[1,2]`), not be
 * turned into a nested SQL array (`{1,2}`).
 */
function jsonArrayToText(arr: ReadonlyArray<unknown>): string {
  const elements = arr.map((el) => (el === null || el === undefined ? "NULL" : quoteArrayElement(jsonToText(el))));
  return "{" + elements.join(",") + "}";
}

/**
 * Re-serialize a parsed `json`/`jsonb` value to its JSON text form. These columns
 * arrive already run through `JSON.parse` (the read path's `decodeJsonColumns`),
 * so the value is the decoded JS value (object, array, string, number, boolean or
 * null) and always needs `JSON.stringify` to become valid JSON input again —
 * including scalars (the string `hi` must be written as `"hi"`).
 */
function jsonToText(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Postgres `udt_name`s that need JSON-aware serialization rather than the
 * generic runtime-type dispatch. Used to resolve the otherwise undecidable
 * "is this JS array a SQL array or a JSON array?" ambiguity.
 */
const JSON_UDT_NAMES = new Set(["json", "jsonb"]);
const JSON_ARRAY_UDT_NAMES = new Set(["_json", "_jsonb"]);

/**
 * Serialize a single value into one COPY TEXT field. `null`/`undefined` become
 * the NULL marker (`\N`); everything else is converted to text and escaped.
 *
 * `udtName` is the column's Postgres `udt_name`. When supplied it disambiguates
 * `json`/`jsonb` columns; when omitted the value's runtime type is used (which
 * cannot tell a `jsonb` array from a SQL array).
 *
 * PUBLIC (re-exported from the package root) so an app that bulk-loads a table
 * pgxsinkit does not manage writes the SAME COPY TEXT the applier does. The
 * value contract is the one this module's header states: numbers/booleans/
 * bigints as JS primitives, `json`/`jsonb` as **parsed** values (an object, an
 * array, or a scalar — never pre-stringified JSON, which would land as a JSON
 * string), a `Date` or its text for the temporal types, a JS array (or the
 * Postgres array text) for an array column, and every other type as a `string`.
 */
export function serializeCopyValue(value: unknown, udtName?: string): string {
  if (value === null || value === undefined) return NULL_MARKER;
  if (udtName !== undefined) {
    if (JSON_UDT_NAMES.has(udtName)) return escapeCopyText(jsonToText(value));
    if (JSON_ARRAY_UDT_NAMES.has(udtName) && Array.isArray(value)) return escapeCopyText(jsonArrayToText(value));
  }
  return escapeCopyText(valueToText(value));
}

/**
 * Serialize a list of row objects into the body of a `COPY ... FROM` request in
 * TEXT format. Columns are emitted in the given order, fields are tab
 * separated, and rows are newline separated.
 *
 * `columnTypes` optionally maps a column name to its Postgres `udt_name`; pass
 * it so `json`/`jsonb` columns serialize correctly.
 *
 * PUBLIC (re-exported from the package root) for an app-owned, pgxsinkit-unmanaged
 * table. Two contracts bind the caller:
 *
 *   - **`columns` IS the column list of the COPY statement.** The fields are
 *     emitted in exactly this order, so the same array must be named — in the
 *     same order — in the `COPY <table> (...)` that ingests the bytes.
 *     {@link buildCopyFromBlobStatement} renders both from one array so they
 *     cannot drift.
 *   - **`columnTypes` keys are DB column names, values are Postgres `udt_name`s**
 *     (`text`, `int4`, `jsonb`, `timestamptz`, `_text` for `text[]`, …). Only the
 *     json ones (`json`/`jsonb`/`_json`/`_jsonb`) change behaviour — everything
 *     else dispatches on the value's runtime type — but passing the full map is
 *     harmless. A `json`/`jsonb` value MUST be the parsed value, per
 *     {@link serializeCopyValue}.
 */
export function generateCopyData(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: ReadonlyArray<string>,
  columnTypes?: Readonly<Record<string, string | undefined>>,
): string {
  return rows
    .map((row) => columns.map((column) => serializeCopyValue(row[column], columnTypes?.[column])).join(DELIMITER))
    .join(ROW_SEPARATOR);
}

/** One shared UTF-8 encoder for the COPY TEXT body — `TextEncoder` is stateless, so module-level. */
const COPY_TEXT_ENCODER = new TextEncoder();

/** The inputs {@link buildCopyFromBlobStatement} renders a COPY-from-blob statement from. */
export interface CopyFromBlobStatementOptions {
  /**
   * The REAL Drizzle table object to load into — the identifier is read off it with `getTableConfig`,
   * never taken as a hand-written string, so a rename can never leave a stale name in the SQL. A bare
   * (schemaless) table renders unqualified and resolves through `search_path` (that is how the applier
   * reaches an ephemeral relation in `pg_temp`).
   */
  table: AnyPgTable;
  /**
   * The DB column names to load, in order. ONE array drives both halves of the statement: the COPY
   * column list and the field order of the serialized body, so they cannot drift.
   */
  columns: readonly string[];
  /** The rows to load, keyed by DB column name (a key missing from a row is loaded as NULL). */
  rows: ReadonlyArray<Record<string, unknown>>;
  /**
   * DB column name → Postgres `udt_name`, per {@link generateCopyData}. Needed for `json`/`jsonb`
   * (and `_json`/`_jsonb`) columns; ignored for every other type.
   */
  udtNames?: Readonly<Record<string, string | undefined>>;
}

/**
 * Render the `COPY <table> (<columns>) FROM '/dev/blob' WITH (FORMAT text)` statement for `rows`,
 * together with the COPY TEXT bytes PGlite must read for it — a {@link RawStatement} whose `blob`
 * carries the body (narrowed to a non-optional `blob`: this builder ALWAYS produces one).
 *
 * This is the ONE implementation of the COPY-from-blob load: the sync applier's bulk path
 * (`applyMessagesToTableWithCopy`) and the public raw seam both call it, so an app-owned table
 * bulk-loads on exactly the contract the applier is tested against.
 *
 * Hand it to `rawTransaction` (to bulk-load inside one local transaction, e.g. delete-then-COPY) or
 * to `rawQuery`'s `blob` option for a single statement. On a worker-attached client the bytes are
 * TRANSFERRED, not copied — see {@link RawStatement.blob}: the buffer is detached after the call.
 *
 * Tier ③ (ADR-0028 allow-list), exactly as the applier's copy of this statement was: `COPY … FROM
 * '/dev/blob'` is PGlite's blob-ingest grammar and has NO Drizzle builder form, so the statement text
 * stays a raw string. Every identifier in it is still derived — the table from `getTableConfig`, each
 * column through `quoteIdentifier` — so nothing in the string is a hand-written identifier.
 */
export function buildCopyFromBlobStatement({
  table,
  columns,
  rows,
  udtNames,
}: CopyFromBlobStatementOptions): RawStatement & { blob: Uint8Array<ArrayBuffer> } {
  const { name: tableName, schema } = getTableConfig(table);
  const copyTarget = schema ? `${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}` : quoteIdentifier(tableName);
  const columnList = columns.map((column) => quoteIdentifier(column)).join(", ");
  // TEXT is the default COPY format; its default delimiter is a tab and NULL marker is `\N`, both of
  // which generateCopyData emits.
  const sql = `COPY ${copyTarget} (${columnList}) FROM '/dev/blob' WITH (FORMAT text)`;
  return { sql, params: [], blob: COPY_TEXT_ENCODER.encode(generateCopyData(rows, columns, udtNames)) };
}
