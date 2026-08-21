import type { SyncChange, SyncRow } from "@pgxsinkit/contracts";

import type { InsertChangeMessage } from "./types";

type Operation = "insert" | "update" | "delete";

/**
 * A drained shape batch folded to **one net operation per primary key** (ADR-0014 decision 1).
 * Each PK appears in at most one of `inserts`/`updates`, and at most once in `deletes` — except a
 * *re-created* PK (`[delete, insert]`), which appears in both `deletes` and `inserts` so the bulk
 * apply clears the pre-existing row before inserting the new one. The Sync applier therefore runs
 * three bulk statements **in the order `deletes → inserts → updates`** (Phase 3): that ordering is
 * what makes a re-create safe, and every other PK is touched by exactly one statement, so the rest
 * of the order is irrelevant within the atomic commit.
 */
export interface FoldedShapeBatch {
  /** PKs to delete — net-`delete` keys, plus the clearing delete of each re-created key. */
  deletes: SyncChange[];
  /** Full rows to insert — net-`insert` keys, plus each re-created key's new row (merged values). */
  inserts: InsertChangeMessage[];
  /** Merged partial updates — net-`update` keys (carry the PK plus the union of updated columns). */
  updates: SyncChange[];
}

/** Clone a representative message, overriding its row value and operation (headers like LSN are kept). */
function withValue(template: SyncChange, value: SyncRow, operation: Operation): SyncChange {
  return { ...template, value, headers: { ...template.headers, operation } };
}

/** Shallow-merge the row values of an ordered op segment, last-write-wins per column. */
function mergeValues(segment: SyncChange[]): SyncRow {
  return Object.assign({}, ...segment.map((message) => message.value)) as SyncRow;
}

/**
 * Fold a drained shape batch (ordered by LSN, one shape) to one net operation per primary key
 * (ADR-0014 decision 1), so the read path can bulk-apply without the `UPDATE … FROM` / `INSERT …
 * SELECT json_to_recordset(…)` same-PK join hazard (those use **one arbitrary** matching row when
 * the source holds duplicate PKs). Each PK's ops are replayed in LSN order down to:
 *
 * - **trailing `delete`** ⇒ a single DELETE;
 * - **`insert` with no preceding delete**, then any updates ⇒ a single INSERT with merged values
 *   (a *plain* insert — a genuine PK collision still surfaces, never a silent upsert);
 * - **only `update`s** ⇒ a single UPDATE with merged values;
 * - **re-created** (`[delete, … , insert, …]`, no trailing delete) ⇒ DELETE **and** INSERT, so the
 *   pre-existing row is cleared first (faithful to the per-row `DELETE`-then-`INSERT`; a plain INSERT
 *   would collide with the row the dropped delete was meant to remove);
 * - **`update` after a delete** (`[delete, update]` and kin) is malformed for a faithful stream
 *   (an update asserts the row exists) ⇒ throw, surfacing stream corruption rather than silently
 *   dropping it.
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

  const folded: FoldedShapeBatch = { deletes: [], inserts: [], updates: [] };
  for (const [key, ops] of groups) {
    foldKey(key, ops, folded);
  }
  return folded;
}

function foldKey(key: string, ops: SyncChange[], folded: FoldedShapeBatch): void {
  const lastDeleteIndex = ops.findLastIndex((message) => message.headers.operation === "delete");

  // A trailing delete is the net effect regardless of anything before it; emit one DELETE.
  if (lastDeleteIndex === ops.length - 1) {
    folded.deletes.push(ops[lastDeleteIndex]!);
    return;
  }

  // The net is decided by the segment after the last delete (or the whole sequence if none).
  const segment = ops.slice(lastDeleteIndex + 1);
  const merged = mergeValues(segment);
  const template = segment[segment.length - 1]!;
  const startsWithInsert = segment[0]!.headers.operation === "insert";
  const hadDelete = lastDeleteIndex >= 0;

  if (startsWithInsert) {
    if (hadDelete) {
      // Re-created: clear the pre-existing row, then insert the new one (DELETE before INSERT).
      folded.deletes.push(ops[lastDeleteIndex]!);
    }
    folded.inserts.push(withValue(template, merged, "insert") as InsertChangeMessage);
    return;
  }

  if (hadDelete) {
    throw new Error(`foldChangeBatch: malformed batch — update after delete for key ${JSON.stringify(key)}`);
  }
  folded.updates.push(withValue(template, merged, "update"));
}
