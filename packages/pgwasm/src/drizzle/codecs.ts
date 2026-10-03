// Began as a copy of drizzle-orm's PGlite driver (`src/pglite/*.ts` at 1.0.0-rc.4; Apache-2.0, © Drizzle Team
// and contributors — see NOTICE). Changes: rebound from PGlite to pgwasm; the driver never constructs its
// own database. Owned outright (ADR-0062).

import type { NormalizeCodec } from "drizzle-orm/codecs";
import { makePgArray, parsePgArray } from "drizzle-orm/pg-core/array";
import {
  arrayCompatNormalize,
  castToText,
  castToTextArr,
  genericPgCodecs,
  makeGeometryArray,
  parseGeometryArrayAndNormalize,
  parseGeometryTuple,
  parseGeometryXY,
  refineGenericPgCodecs,
  textToDate,
  textToDateWithTz,
  type PgCodecs,
} from "drizzle-orm/pg-core/codecs";
import { base64ToUint8Array } from "drizzle-orm/utils";

import { arrayParser, DATE, INTERVAL, TIMESTAMP, TIMESTAMPTZ, type Parser } from "../types";

/**
 * The identity parsers the driver passes with every query: these types reach drizzle as Postgres'
 * text, and drizzle's codecs turn them into values. Array parsers keep each element's text while
 * preserving PostgreSQL nulls and dimensions; the scalar Date parser must not run before Drizzle's
 * mode-specific normalizer. Numeric arrays use pgwasm's native precision-preserving parser.
 */
export const drizzleParsers: Readonly<Record<number, Parser>> = {
  [TIMESTAMP]: (value) => value,
  [TIMESTAMPTZ]: (value) => value,
  [INTERVAL]: (value) => value,
  [DATE]: (value) => value,
  1115: (value) => arrayParser(value, undefined, 1115), // timestamp[]
  1185: (value) => arrayParser(value, undefined, 1185), // timestamptz[]
  1187: (value) => arrayParser(value, undefined, 1187), // interval[]
  1182: (value) => arrayParser(value, undefined, 1182), // date[]
};

const hasBuffer = typeof Buffer !== "undefined";
const normalizeNullableArray = (normalize: NormalizeCodec) =>
  arrayCompatNormalize((value) => (value === null ? null : normalize(value)));

/** drizzle's codecs for pgwasm's value formats (the text protocol, pgwasm's default parsers). */
export const pgwasmCodecs: PgCodecs = refineGenericPgCodecs({
  bigint: {
    cast: castToText,
    castArray: castToTextArr,
    normalize: BigInt,
    normalizeArray: normalizeNullableArray(BigInt),
  },
  "bigint:string": { cast: castToText, castArray: castToTextArr },
  "bigint:number": {
    cast: castToText,
    castArray: castToTextArr,
    normalize: Number,
    normalizeArray: normalizeNullableArray(Number),
  },
  bigserial: {
    normalize: BigInt,
    normalizeArray: normalizeNullableArray(BigInt),
    cast: castToText,
    castArray: castToTextArr,
  },
  "bigserial:number": {
    cast: castToText,
    castArray: castToTextArr,
    normalize: Number,
    normalizeArray: normalizeNullableArray(Number),
  },
  "numeric:number": { normalize: Number, normalizeArray: normalizeNullableArray(Number) },
  "numeric:bigint": { normalize: BigInt, normalizeArray: normalizeNullableArray(BigInt) },
  bytea: hasBuffer
    ? {
        normalizeInJson: genericPgCodecs.bytea?.normalizeInJson,
        normalizeArrayInJson: genericPgCodecs.bytea?.normalizeArrayInJson,
        normalize: (value: Uint8Array) => Buffer.from(value),
        normalizeArray: normalizeNullableArray((value: Uint8Array) => Buffer.from(value)),
      }
    : {
        normalizeInJson: base64ToUint8Array,
        normalizeArrayInJson: arrayCompatNormalize(base64ToUint8Array),
      },
  interval: { castArray: castToTextArr },
  date: { castArray: castToTextArr, normalize: textToDate, normalizeArray: normalizeNullableArray(textToDate) },
  "date:string": { castArray: castToTextArr },
  timestamp: {
    castArray: castToTextArr,
    normalize: textToDateWithTz,
    normalizeArray: normalizeNullableArray(textToDateWithTz),
  },
  timestamptz: { castArray: castToTextArr, normalize: textToDate, normalizeArray: normalizeNullableArray(textToDate) },
  "timestamp:string": { castArray: castToTextArr },
  "timestamptz:string": { castArray: castToTextArr },
  json: { normalizeParam: (value: unknown) => (typeof value === "object" ? value : JSON.stringify(value)) },
  jsonb: { normalizeParam: (value: unknown) => (typeof value === "object" ? value : JSON.stringify(value)) },
  "geometry(point)": {
    normalizeArray: parseGeometryArrayAndNormalize(parseGeometryXY),
    castParam: (name: string) => `${name}::geometry`,
    castArrayParam: (name: string, _column: unknown, dimensions: number) =>
      `${name}::geometry${"[]".repeat(dimensions)}`,
    normalizeParamArray: makeGeometryArray,
  },
  "geometry(point):tuple": {
    normalizeArray: parseGeometryArrayAndNormalize(parseGeometryTuple),
    castParam: (name: string) => `${name}::geometry`,
    castArrayParam: (name: string, _column: unknown, dimensions: number) =>
      `${name}::geometry${"[]".repeat(dimensions)}`,
    normalizeParamArray: makeGeometryArray,
  },
  halfvec: {
    castParam: (name: string) => `${name}::halfvec`,
    castArrayParam: (name: string, _column: unknown, dimensions: number) =>
      `${name}::halfvec${"[]".repeat(dimensions)}`,
    // Codec callbacks receive array dimensions as their second argument, not a text delimiter.
    normalizeParamArray: (value) => makePgArray(value),
  },
  vector: {
    castParam: (name: string) => `${name}::vector`,
    castArrayParam: (name: string, _column: unknown, dimensions: number) => `${name}::vector${"[]".repeat(dimensions)}`,
    normalizeParamArray: (value) => makePgArray(value),
  },
  sparsevec: {
    normalizeArray: (value) => parsePgArray(value),
    castParam: (name: string) => `${name}::sparsevec`,
    castArrayParam: (name: string, _column: unknown, dimensions: number) =>
      `${name}::sparsevec${"[]".repeat(dimensions)}`,
    normalizeParamArray: (value) => makePgArray(value),
  },
});
