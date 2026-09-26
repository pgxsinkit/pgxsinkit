// Began as a copy of drizzle-orm's PGlite driver (`src/pglite/*.ts` at 1.0.0-rc.4; Apache-2.0, © Drizzle Team
// and contributors — see NOTICE). Changes: rebound from PGlite to pgwasm; the driver never constructs its
// own database. Owned outright (ADR-0062).

import { makePgArray, parsePgArray } from "drizzle-orm/pg-core/array";
import {
  arrayCompatNormalize,
  castToText,
  castToTextArr,
  genericPgCodecs,
  parseGeometryTuple,
  parseGeometryXY,
  parsePgArrayAndNormalize,
  refineGenericPgCodecs,
  textToDate,
  textToDateWithTz,
  type PgCodecs,
} from "drizzle-orm/pg-core/codecs";
import { base64ToUint8Array } from "drizzle-orm/utils";

import { DATE, INTERVAL, TIMESTAMP, TIMESTAMPTZ } from "../types";

/**
 * The identity parsers the driver passes with every query: these types reach drizzle as Postgres'
 * text, and drizzle's codecs turn them into values (dates, intervals, numeric arrays).
 */
export const drizzleParsers: Readonly<Record<number, (value: string) => string>> = {
  [TIMESTAMP]: (value) => value,
  [TIMESTAMPTZ]: (value) => value,
  [INTERVAL]: (value) => value,
  [DATE]: (value) => value,
  1231: (value) => value, // numeric[]
  1115: (value) => value, // timestamp[]
  1185: (value) => value, // timestamptz[]
  1187: (value) => value, // interval[]
  1182: (value) => value, // date[]
};

const hasBuffer = typeof Buffer !== "undefined";

/** drizzle's codecs for pgwasm's value formats (the text protocol, pgwasm's default parsers). */
export const pgwasmCodecs: PgCodecs = refineGenericPgCodecs({
  bigint: {
    cast: castToText,
    castArray: castToTextArr,
    normalize: BigInt,
    normalizeArray: arrayCompatNormalize(BigInt),
  },
  "bigint:string": { cast: castToText, castArray: castToTextArr },
  "bigint:number": { cast: castToText, castArray: castToTextArr },
  bigserial: {
    normalize: BigInt,
    normalizeArray: arrayCompatNormalize(BigInt),
    cast: castToText,
    castArray: castToTextArr,
  },
  "bigserial:number": { cast: castToText, castArray: castToTextArr },
  bytea: hasBuffer
    ? {
        normalizeInJson: genericPgCodecs.bytea?.normalizeInJson,
        normalizeArrayInJson: genericPgCodecs.bytea?.normalizeArrayInJson,
        normalize: (value: Uint8Array) => Buffer.from(value),
        normalizeArray: arrayCompatNormalize((value: Uint8Array) => Buffer.from(value)),
      }
    : {
        normalizeInJson: base64ToUint8Array,
        normalizeArrayInJson: arrayCompatNormalize(base64ToUint8Array),
      },
  interval: { castArray: castToTextArr },
  date: { castArray: castToTextArr, normalize: textToDate, normalizeArray: arrayCompatNormalize(textToDate) },
  "date:string": { castArray: castToTextArr },
  timestamp: {
    castArray: castToTextArr,
    normalize: textToDateWithTz,
    normalizeArray: arrayCompatNormalize(textToDateWithTz),
  },
  timestamptz: { castArray: castToTextArr, normalize: textToDate, normalizeArray: arrayCompatNormalize(textToDate) },
  "timestamp:string": { castArray: castToTextArr },
  "timestamptz:string": { castArray: castToTextArr },
  json: { normalizeParam: (value: unknown) => (typeof value === "object" ? value : JSON.stringify(value)) },
  jsonb: { normalizeParam: (value: unknown) => (typeof value === "object" ? value : JSON.stringify(value)) },
  "geometry(point)": {
    normalizeArray: parsePgArrayAndNormalize(parseGeometryXY),
    castParam: (name: string) => `${name}::geometry`,
    castArrayParam: (name: string, _column: unknown, dimensions: number) =>
      `${name}::geometry${"[]".repeat(dimensions)}`,
    normalizeParamArray: makePgArray,
  },
  "geometry(point):tuple": {
    normalizeArray: parsePgArrayAndNormalize(parseGeometryTuple),
    castParam: (name: string) => `${name}::geometry`,
    castArrayParam: (name: string, _column: unknown, dimensions: number) =>
      `${name}::geometry${"[]".repeat(dimensions)}`,
    normalizeParamArray: makePgArray,
  },
  halfvec: {
    castParam: (name: string) => `${name}::halfvec`,
    castArrayParam: (name: string, _column: unknown, dimensions: number) =>
      `${name}::halfvec${"[]".repeat(dimensions)}`,
    normalizeParamArray: makePgArray,
  },
  vector: {
    castParam: (name: string) => `${name}::vector`,
    castArrayParam: (name: string, _column: unknown, dimensions: number) => `${name}::vector${"[]".repeat(dimensions)}`,
    normalizeParamArray: makePgArray,
  },
  sparsevec: {
    normalizeArray: parsePgArray,
    castParam: (name: string) => `${name}::sparsevec`,
    castArrayParam: (name: string, _column: unknown, dimensions: number) =>
      `${name}::sparsevec${"[]".repeat(dimensions)}`,
    normalizeParamArray: makePgArray,
  },
});
