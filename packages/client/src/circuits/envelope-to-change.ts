import type { StreamEnvelope, StreamValue, SyncOperation } from "@pgxsinkit/contracts";

import type { ApplyTarget } from "../local-tables";

/**
 * Separator the engine joins composite primary-key values with (`schema.rs`, `PK_"\u001f"`).
 *
 * ASCII Unit Separator, chosen upstream so it cannot collide with real id text. Restated here rather
 * than derived: getting it wrong does not fail loudly, it produces deletes that match no row.
 */
const PK_SEPARATOR = "\u001f";

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
 * Rebuild the primary-key columns of a row from the stream key.
 *
 * Composite keys are joined in **primary-key declaration order**, which is the order `ApplyTarget`
 * already holds — so the two must agree. A count mismatch is thrown rather than tolerated: a
 * silently short split would produce a `WHERE` over only part of the key, and a delete matching more
 * rows than it should is data loss, not a stale row.
 */
export function primaryKeyFromStreamKey(target: ApplyTarget, key: string): Record<string, unknown> {
  const parts = target.primaryKey.length === 1 ? [key] : key.split(PK_SEPARATOR);
  if (parts.length !== target.primaryKey.length) {
    throw new Error(
      `[pgxsinkit] stream key "${key}" splits into ${parts.length} part(s) but the target has a ` +
        `${target.primaryKey.length}-column primary key (${target.primaryKey.join(", ")})`,
    );
  }

  const row: Record<string, unknown> = {};
  target.primaryKey.forEach((column, index) => {
    const sqlType = target.columnTypes.find((type) => type.name === column)?.sqlType ?? "text";
    row[column] = coercePrimaryKeyValue(sqlType, parts[index]!);
  });
  return row;
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

  return { key: envelope.key, value: envelope.value, headers: { operation: "upsert" } };
}
