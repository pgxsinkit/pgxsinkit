import type { SyncChange, SyncRow } from "@pgxsinkit/contracts";

import type { UpsertChangeMessage } from "./types";

/**
 * A drained shape batch folded to **one net operation per primary key** (ADR-0014 decision 1).
 * Each PK appears in at most one of `deletes`/`upserts` — except a *re-created* PK
 * (`[delete, … , upsert]`), which appears in both so the pre-existing row is cleared before the new
 * one lands. The Sync applier therefore runs two bulk statements **in the order `deletes → upserts`**:
 * that ordering is what makes a re-create drop local-only column state instead of inheriting it, and
 * every other PK is touched by exactly one statement.
 */
export interface FoldedShapeBatch {
  /** PKs to delete — net-`delete` keys, plus the clearing delete of each re-created key. */
  deletes: SyncChange[];
  /** Full rows to upsert — net-`upsert` keys, plus each re-created key's new row. */
  upserts: UpsertChangeMessage[];
}

/** Clone a representative message, overriding its row value (headers like LSN are kept). */
function withValue(template: SyncChange, value: SyncRow): UpsertChangeMessage {
  return { ...template, value, headers: { ...template.headers, operation: "upsert" } };
}

/**
 * Collapse an ordered run of upserts to its net row.
 *
 * Every engine upsert carries the complete projected row, so this degenerates to "the last one
 * wins" — the merge is kept rather than a bare `at(-1)` because it stays correct if a future engine
 * ever narrows an upsert to its changed columns, and costs nothing at this batch size.
 */
function mergeValues(segment: SyncChange[]): SyncRow {
  return Object.assign({}, ...segment.map((message) => message.value)) as SyncRow;
}

/**
 * Fold a drained shape batch (ordered by LSN, one shape) to one net operation per primary key
 * (ADR-0014 decision 1), so the read path can bulk-apply without the `INSERT … SELECT
 * json_to_recordset(…)` same-PK join hazard (which uses **one arbitrary** matching row when the
 * source holds duplicate PKs). Each PK's ops are replayed in stream order down to:
 *
 * - **trailing `delete`** ⇒ a single DELETE;
 * - **upserts, no preceding delete** ⇒ a single UPSERT of the net row;
 * - **re-created** (`[delete, … , upsert, …]`, no trailing delete) ⇒ DELETE **and** UPSERT.
 *
 * The clearing DELETE on a re-create is not redundant against an upsert. `ON CONFLICT DO UPDATE`
 * refreshes only the columns the shape projects; a row that genuinely left and re-entered must not
 * keep local-only column values from its previous life, so it is removed first.
 *
 * There is no `updates` bucket and no malformed-batch case, because there is no third verb: the
 * engine emits `upsert | delete` and nothing else ({@link SyncOperation}). The old
 * "update after delete ⇒ throw" guard checked for a stream state the vocabulary can no longer
 * express.
 *
 * Pure and dependency-free by design (ADR-0014 / ISS-06): property-tested against the oracle
 * *fold-then-bulk ≡ ordered per-row apply* over random same-PK sequences and random initial state.
 */
export function foldChangeBatch(messages: SyncChange[]): FoldedShapeBatch {
  const groups = new Map<string, SyncChange[]>();
  for (const message of messages) {
    let group = groups.get(message.key);
    if (!group) {
      group = [];
      groups.set(message.key, group);
    }
    group.push(message);
  }

  const folded: FoldedShapeBatch = { deletes: [], upserts: [] };
  for (const ops of groups.values()) {
    foldKey(ops, folded);
  }
  return folded;
}

function foldKey(ops: SyncChange[], folded: FoldedShapeBatch): void {
  const lastDeleteIndex = ops.findLastIndex((message) => message.headers.operation === "delete");

  // A trailing delete is the net effect regardless of anything before it; emit one DELETE.
  if (lastDeleteIndex === ops.length - 1) {
    folded.deletes.push(ops[lastDeleteIndex]!);
    return;
  }

  // The net is decided by the segment after the last delete (or the whole sequence if none), which
  // is all upserts — a delete would have been the last delete.
  const segment = ops.slice(lastDeleteIndex + 1);

  if (lastDeleteIndex >= 0) {
    // Re-created: clear the pre-existing row, then land the new one (DELETE before UPSERT).
    folded.deletes.push(ops[lastDeleteIndex]!);
  }
  folded.upserts.push(withValue(segment[segment.length - 1]!, mergeValues(segment)));
}
