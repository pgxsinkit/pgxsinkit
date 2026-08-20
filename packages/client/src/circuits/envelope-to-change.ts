import type { StreamEnvelope, StreamValue } from "@pgxsinkit/contracts";

import type { ApplyTarget } from "../local-tables";

/**
 * Separator the engine joins composite primary-key values with (`schema.rs`, `PK_"\u001f"`).
 *
 * ASCII Unit Separator, chosen upstream so it cannot collide with real id text. Restated here rather
 * than derived: getting it wrong does not fail loudly, it produces deletes that match no row.
 */
const PK_SEPARATOR = "\u001f";

/** The applier's message shape — Electric's `ChangeMessage` as far as `applyMessageToTable` reads it. */
export interface ChangeLike {
  key: string;
  value: Record<string, unknown>;
  headers: { operation: "insert" | "update" | "delete" };
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
 * Two differences from Electric's wire format carry real weight:
 *
 * **A delete has no row body** — only its key. Circuits' `delete_envelopes` carries no value at all,
 * so the pk columns are reconstructed here. That is a privacy improvement (an eviction discloses the
 * key and nothing else) and an implementation hazard in the same change, which is why the
 * reconstruction is a named, tested function rather than an inline split.
 *
 * **`upsert` is a real operation**, emitted on backfill rows where the engine is not claiming the
 * row is new. It maps to `insert` because backfill only ever lands on an empty table — a fresh
 * subscription, or a post-must-refetch re-snapshot — which is the same invariant the existing bulk
 * backfill path already relies on. Mapping it to `update` instead would silently no-op every
 * backfill row, and mapping it away from `insert` would lose ADR-0014's primary-key collision
 * surfacing on the tables that declare they want it.
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

  return {
    key: envelope.key,
    value: envelope.value,
    headers: { operation: operation === "update" ? "update" : "insert" },
  };
}
