import type { StreamEnvelope, StreamValue, SyncOperation } from "@pgxsinkit/contracts";

import type { ApplyTarget } from "../local-tables";

/**
 * Separator the engine joins composite primary-key values with (`schema.rs`, `PK_SEP`).
 *
 * ASCII Unit Separator, chosen upstream so it cannot collide with real id text. Restated here rather
 * than derived: getting it wrong does not fail loudly, it produces deletes that match no row.
 */
const PK_SEPARATOR = "\u001f";

/**
 * Decode one component of a COMPOSITE stream key — the exact inverse of the engine's
 * `escape_key_component` (`schema.rs`): `\\` was a literal backslash, `\x1f` (four characters) was a
 * literal U+001F. The escaping is what makes the joined key an injective encoding of the tuple, so an
 * escaped component contains no bare separator and the split-then-unescape here recovers exactly the
 * original values. Single-column keys are NOT escaped upstream and never reach this function. Any
 * other backslash sequence cannot be engine output — throw rather than guess at an identity.
 */
function unescapeKeyComponent(part: string): string {
  if (!part.includes("\\")) return part;
  let out = "";
  for (let i = 0; i < part.length; i += 1) {
    const ch = part[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    if (part[i + 1] === "\\") {
      out += "\\";
      i += 1;
    } else if (part.startsWith("x1f", i + 1)) {
      out += PK_SEPARATOR;
      i += 3;
    } else {
      throw new Error(`[pgxsinkit] stream key component ${JSON.stringify(part)} carries an unknown escape sequence`);
    }
  }
  return out;
}

/** The applier's message shape, once an envelope has been resolved against its table. */
export interface ChangeLike {
  key: string;
  value: Record<string, unknown>;
  headers: { operation: SyncOperation };
}

/**
 * Coerce one primary-key value out of its key-string rendering.
 *
 * The engine writes keys through `Value::to_key_string`, which erases type: `Int(42)` becomes
 * `"42"`, `Bool(true)` becomes `"true"`. A delete carries **only** that key, so the pk has to be
 * re-typed here or the `WHERE` binds text against a non-text column.
 *
 * `bigint` and `numeric` stay strings deliberately — routing them through `Number` would lose
 * precision above 2^53, and a silently-wrong id is worse than a driver-level coercion.
 */
function coercePrimaryKeyValue(sqlType: string, raw: string): StreamValue {
  switch (sqlType) {
    case "integer":
    case "smallint":
    case "serial":
    case "smallserial":
      return Number(raw);
    case "boolean":
      return raw === "true";
    default:
      return raw;
  }
}

/**
 * Rebuild the LOCAL primary-key columns of a row from the stream key.
 *
 * The key is the SERVER identity: composite keys are joined in server primary-key declaration order
 * (escaped per component — see {@link unescapeKeyComponent}), single keys are the raw value. Under a
 * `clientProjection.localPrimaryKey` narrowing the local key is a subset of the server key, so the
 * split runs over `serverPrimaryKey` and only the local components are kept — the dropped ones are
 * predicate-pinned (subscribe-time compile refuses the narrowing otherwise), so within this shape
 * the narrowed key is still unique. A count mismatch is thrown rather than tolerated: a silently
 * short split would produce a `WHERE` over only part of the key, and a delete matching more rows
 * than it should is data loss, not a stale row.
 */
export function primaryKeyFromStreamKey(target: ApplyTarget, key: string): Record<string, unknown> {
  const serverKey = target.serverPrimaryKey;
  const parts = serverKey.length === 1 ? [key] : key.split(PK_SEPARATOR).map(unescapeKeyComponent);
  if (parts.length !== serverKey.length) {
    throw new Error(
      `[pgxsinkit] stream key "${key}" splits into ${parts.length} part(s) but the server identity is a ` +
        `${serverKey.length}-column primary key (${serverKey.join(", ")})`,
    );
  }

  const localKey = new Set(target.primaryKey);
  const row: Record<string, unknown> = {};
  serverKey.forEach((column, index) => {
    if (!localKey.has(column)) return;
    const sqlType = target.columnTypes.find((type) => type.name === column)?.sqlType ?? "text";
    row[column] = coercePrimaryKeyValue(sqlType, parts[index]!);
  });
  for (const column of target.primaryKey) {
    if (!(column in row)) {
      throw new Error(
        `[pgxsinkit] local primary-key column "${column}" is not part of the server key ` +
          `(${serverKey.join(", ")}) — the stream key cannot address the local row`,
      );
    }
  }
  return row;
}

/**
 * Decode the cells of the SCALAR `json`/`jsonb` columns in a streamed row — **the one place the wire's
 * text becomes a JS value**, and the invariant every apply tier below depends on.
 *
 * THE WIRE CARRIES A JSON COLUMN AS TEXT. The engine's cell model is five scalars (`value.rs`:
 * `Null | Int | Text | Bool | Float`), and its Postgres type map (`pg.rs` `map_pg_type`) sends everything
 * that is not int/float/bool through `Text` — so a `jsonb` column is emitted as a JSON **string** holding
 * Postgres's own output text (`t.col::text` on the backfill path, `test_decoding`'s text on the live path;
 * that is deliberate upstream, so a backfilled row and its first replicated update compare equal). Hence
 * `{"lang.v1": {"levelOrdinal": 1}}` — `jsonb_out` spacing, which `JSON.stringify` never emits.
 *
 * Left as text, every apply tier then encodes that text a SECOND time and the local column ends up holding
 * a JSON *string scalar* (`jsonb_typeof` = `'string'`) instead of the document: `json_to_recordset` escapes
 * a JSON string into a JSON literal when the target column is json/jsonb (`populate_scalar`), the COPY
 * serializer runs `JSON.stringify` over it (`copy.ts` `jsonToText`), and drizzle's `jsonb` codec does the
 * same on the param-bound tiers. All three were measured doing exactly that. Decoding here — once, at the
 * boundary — fixes all of them at their shared root, and matches what the appliers have always documented
 * they receive ("json/jsonb as parsed objects/arrays").
 *
 * ARRAY columns (json arrays included) are deliberately NOT decoded: they arrive as Postgres `array_out`
 * text, which every tier hands back to `array_in` — the recordset cast, COPY's field text, and drizzle's
 * array codec all accept the literal verbatim (measured), so parsing it here would only mean re-rendering
 * it below.
 *
 * A cell that is not a string (a wire that already sent a parsed value) is passed through untouched, so
 * the decode is idempotent. A string that is not valid JSON cannot come from Postgres — the server column
 * validated it — so it throws rather than being stored as text.
 */
function decodeJsonColumns(target: ApplyTarget, value: Record<string, unknown>): Record<string, unknown> {
  let decoded: Record<string, unknown> | undefined;
  for (const column of target.jsonColumns) {
    const cell = value[column];
    if (typeof cell !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(cell);
    } catch (error) {
      throw new Error(
        `[pgxsinkit] json column "${column}" carried a value that is not JSON text: ${JSON.stringify(
          cell.slice(0, 120),
        )}`,
        { cause: error },
      );
    }
    decoded ??= { ...value };
    decoded[column] = parsed;
  }
  return decoded ?? value;
}

/**
 * Translate a Circuits envelope into the message the applier consumes.
 *
 * There is no operation mapping to do — {@link SyncOperation} is the wire's own vocabulary. What
 * this function carries is the one structural difference: **a delete has no row body**, only its
 * key, so the pk columns are reconstructed here. That is a privacy improvement (an eviction
 * discloses the key and nothing else) and an implementation hazard in the same change, which is why
 * the reconstruction is a named, tested function rather than an inline split.
 *
 * An `upsert` carries the **complete projected row** every time — the engine's `row_to_json_cols`
 * emits every column of the shape's `out_cols`, never a changed-column subset — which is what lets
 * the apply path refresh every non-pk column from `excluded` without knowing whether the row already
 * existed locally.
 */
export function envelopeToChange(target: ApplyTarget, envelope: StreamEnvelope): ChangeLike {
  const operation = envelope.headers.operation;

  if (operation === "delete") {
    return {
      key: envelope.key,
      value: primaryKeyFromStreamKey(target, envelope.key),
      headers: { operation: "delete" },
    };
  }

  if (envelope.value === undefined) {
    throw new Error(
      `[pgxsinkit] ${operation} envelope for key "${envelope.key}" carries no row body — only a ` +
        `delete may omit one`,
    );
  }

  // The engine force-includes every server pk component in the emitted row (its `resolve_columns`
  // keeps them "so the client can identify rows"), so under a localPrimaryKey narrowing the pinned,
  // projected-away components arrive anyway. Project exactly those off; any other column the local
  // table lacks still fails loudly in the applier's re-keying.
  let value: Record<string, unknown> = envelope.value;
  if (target.droppedKeyColumns.length > 0) {
    value = { ...value };
    for (const column of target.droppedKeyColumns) {
      delete value[column];
    }
  }

  // The wire→JS decode: a json column's text becomes its value here and stays a value all the way to the
  // store (see {@link decodeJsonColumns}).
  return { key: envelope.key, value: decodeJsonColumns(target, value), headers: { operation: "upsert" } };
}
