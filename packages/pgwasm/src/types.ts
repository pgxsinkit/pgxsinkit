// Began as a copy of `@electric-sql/pglite` (taken under its PostgreSQL License option, © ElectricSQL
// — see NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal — evolve freely.
//
// Based on postgres.js types.js (https://github.com/porsager/postgres/blob/master/src/types.js),
// published under the Unlicense.

import type { ParserOptions } from "./interface";

const JSON_parse = globalThis.JSON.parse;
const JSON_stringify = globalThis.JSON.stringify;

/** Built-in type OIDs. */
export const BOOL = 16,
  BYTEA = 17,
  CHAR = 18,
  INT8 = 20,
  INT2 = 21,
  INT4 = 23,
  REGPROC = 24,
  TEXT = 25,
  OID = 26,
  TID = 27,
  XID = 28,
  CID = 29,
  JSON = 114,
  XML = 142,
  PG_NODE_TREE = 194,
  SMGR = 210,
  PATH = 602,
  POLYGON = 604,
  CIDR = 650,
  FLOAT4 = 700,
  FLOAT8 = 701,
  ABSTIME = 702,
  RELTIME = 703,
  TINTERVAL = 704,
  CIRCLE = 718,
  MACADDR8 = 774,
  MONEY = 790,
  MACADDR = 829,
  INET = 869,
  ACLITEM = 1033,
  BPCHAR = 1042,
  VARCHAR = 1043,
  DATE = 1082,
  TIME = 1083,
  TIMESTAMP = 1114,
  TIMESTAMPTZ = 1184,
  INTERVAL = 1186,
  TIMETZ = 1266,
  BIT = 1560,
  VARBIT = 1562,
  NUMERIC = 1700,
  REFCURSOR = 1790,
  REGPROCEDURE = 2202,
  REGOPER = 2203,
  REGOPERATOR = 2204,
  REGCLASS = 2205,
  REGTYPE = 2206,
  UUID = 2950,
  TXID_SNAPSHOT = 2970,
  PG_LSN = 3220,
  PG_NDISTINCT = 3361,
  PG_DEPENDENCIES = 3402,
  TSVECTOR = 3614,
  TSQUERY = 3615,
  GTSVECTOR = 3642,
  REGCONFIG = 3734,
  REGDICTIONARY = 3769,
  JSONB = 3802,
  REGNAMESPACE = 4089,
  REGROLE = 4096;

/** Turns a value's text representation into a JS value. */
export type Parser = (value: string, typeId?: number) => unknown;
/** Turns a JS value into its text representation. */
export type Serializer = (value: unknown) => string;

interface TypeHandler {
  to: number;
  from: readonly number[];
  serialize: Serializer;
  parse: Parser;
}

function serializeString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function serializeBoolean(value: unknown): string {
  // Mirror PostgreSQL's own boolean input (`boolin`): accept the literals Postgres accepts, plus the JS
  // shapes drivers send for a boolean column (1/0, "true"/"false"). Anything Postgres would reject
  // throws rather than silently becoming 'f'.
  if (typeof value === "boolean") return value ? "t" : "f";
  if (typeof value === "number") {
    if (value === 1) return "t";
    if (value === 0) return "f";
  } else if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["true", "t", "yes", "y", "on", "1"].includes(s)) return "t";
    if (["false", "f", "no", "n", "off", "0"].includes(s)) return "f";
  }
  throw new Error("Invalid input for boolean type");
}

function serializeDate(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  throw new Error("Invalid input for date type");
}

function serializeBytea(value: unknown): string {
  if (!(value instanceof Uint8Array)) {
    throw new Error("Invalid input for bytea type");
  }
  return `\\x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function parseBytea(value: string): Uint8Array {
  const hexString = value.slice(2);
  return Uint8Array.from({ length: hexString.length / 2 }, (_, idx) =>
    Number.parseInt(hexString.substring(idx * 2, (idx + 1) * 2), 16),
  );
}

function parseBigint(value: string): number | bigint {
  const n = BigInt(value);
  // In the safe range a plain number; outside it, the bigint.
  return n < Number.MIN_SAFE_INTEGER || n > Number.MAX_SAFE_INTEGER ? n : Number(n);
}

function serializeJson(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON_stringify(value, (_, inner: unknown) => (typeof inner === "bigint" ? inner.toString() : inner));
}

/** The default handlers, by the name pgwasm has always used for each family. */
export const types = {
  string: { to: TEXT, from: [TEXT, VARCHAR, BPCHAR], serialize: serializeString, parse: (x: string) => x },
  number: {
    to: 0,
    from: [INT2, INT4, OID, FLOAT4, FLOAT8],
    serialize: toText,
    parse: (x: string) => +x,
  },
  bigint: { to: INT8, from: [INT8], serialize: toText, parse: parseBigint },
  json: { to: JSON, from: [JSON, JSONB], serialize: serializeJson, parse: (x: string): unknown => JSON_parse(x) },
  boolean: { to: BOOL, from: [BOOL], serialize: serializeBoolean, parse: (x: string) => x === "t" },
  date: {
    to: TIMESTAMPTZ,
    from: [DATE, TIMESTAMP, TIMESTAMPTZ],
    serialize: serializeDate,
    parse: (x: string) => new Date(x),
  },
  bytea: { to: BYTEA, from: [BYTEA], serialize: serializeBytea, parse: parseBytea },
} satisfies Record<string, TypeHandler>;

function typeHandlers(handlers: Record<string, TypeHandler>): {
  parsers: Record<number | string, Parser>;
  serializers: Record<number | string, Serializer>;
} {
  const parsers: Record<number | string, Parser> = {};
  const serializers: Record<number | string, Serializer> = {};
  for (const [name, { to, from, serialize, parse }] of Object.entries(handlers)) {
    serializers[to] = serialize;
    serializers[name] = serialize;
    parsers[name] = parse;
    for (const oid of from) {
      parsers[oid] = parse;
      serializers[oid] = serialize;
    }
  }
  return { parsers, serializers };
}

const defaultHandlers = typeHandlers(types);

/** The default parsers, by OID (and by family name). */
export const parsers = defaultHandlers.parsers;
/** The default serializers, by OID (and by family name). */
export const serializers = defaultHandlers.serializers;

/**
 * The text form of a value that has no serializer for its type: the value's own `toString()`, which
 * for a primitive is its usual text.
 */
export function toText(value: unknown): string {
  if (typeof value === "string") return value;
  return (value as { toString(): string }).toString();
}

/** Parse one text value of the given type OID (`null` stays `null`; an unknown type stays text). */
export function parseType(value: string | null, type: number, overrides?: ParserOptions): unknown {
  if (value === null) return null;
  const handler = overrides?.[type] ?? defaultHandlers.parsers[type];
  return handler ? handler(value, type) : value;
}

const escapeBackslash = /\\/g;
const escapeQuote = /"/g;

function arrayEscape(x: string): string {
  return x.replace(escapeBackslash, "\\\\").replace(escapeQuote, '\\"');
}

/** Serialize a (nested) JS array to a Postgres array literal. A non-array is returned as it is. */
export function arraySerializer(xs: unknown, serializer: Serializer | undefined, typarray: number): string {
  if (!Array.isArray(xs)) return toText(xs);
  if (xs.length === 0) return "{}";
  // Only _box (1020) uses ';' as its array delimiter; every other type uses ','.
  const delimiter = typarray === 1020 ? ";" : ",";
  const first: unknown = xs[0];
  if (Array.isArray(first)) {
    return `{${xs.map((x: unknown) => arraySerializer(x, serializer, typarray)).join(delimiter)}}`;
  }
  return `{${xs
    .map((x: unknown) => {
      // undefined is sent as NULL.
      if (x === undefined || x === null) return "null";
      return `"${arrayEscape(serializer ? serializer(x) : toText(x))}"`;
    })
    .join(delimiter)}}`;
}

interface ArrayParserState {
  i: number;
  char: string | null;
  str: string;
  quoted: boolean;
  last: number;
  p: string | null;
}

/** Parse a Postgres array literal, applying `parser` to each element. */
export function arrayParser(x: string, parser: Parser | undefined, typarray: number): unknown {
  const state: ArrayParserState = { i: 0, char: null, str: "", quoted: false, last: 0, p: null };
  return arrayParserLoop(state, x, parser, typarray)[0];
}

function arrayParserLoop(s: ArrayParserState, x: string, parser: Parser | undefined, typarray: number): unknown[] {
  const xs: unknown[] = [];
  const delimiter = typarray === 1020 ? ";" : ",";
  for (; s.i < x.length; s.i++) {
    s.char = x[s.i] ?? null;
    if (s.quoted) {
      if (s.char === "\\") {
        s.str += x[++s.i] ?? "";
      } else if (s.char === '"') {
        xs.push(parser ? parser(s.str) : s.str);
        s.str = "";
        s.quoted = x[s.i + 1] === '"';
        s.last = s.i + 2;
      } else {
        s.str += s.char;
      }
    } else if (s.char === '"') {
      s.quoted = true;
    } else if (s.char === "{") {
      s.last = ++s.i;
      xs.push(arrayParserLoop(s, x, parser, typarray));
    } else if (s.char === "}") {
      if (s.last < s.i) {
        const el = x.slice(s.last, s.i);
        xs.push(el === "NULL" && !s.quoted ? null : parser ? parser(el) : el);
      }
      s.quoted = false;
      s.last = s.i + 1;
      break;
    } else if (s.char === delimiter && s.p !== "}" && s.p !== '"') {
      const el = x.slice(s.last, s.i);
      xs.push(el === "NULL" && !s.quoted ? null : parser ? parser(el) : el);
      s.last = s.i + 1;
    }
    s.p = s.char;
  }
  if (s.last < s.i) {
    const el = x.slice(s.last, s.i + 1);
    xs.push(parser ? parser(el) : el);
  }
  return xs;
}
