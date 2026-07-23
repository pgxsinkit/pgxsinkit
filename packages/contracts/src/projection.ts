import type { AnyPgTable } from "drizzle-orm/pg-core";

import type { Retention } from "./config";
import { fingerprintReadContract } from "./fingerprint";
import type { ClientProjectionSpecForTable, SyncTableEntry, SyncTableRegistry } from "./registry";

/**
 * Per-client mode projection (ADR-0025). The authoritative (server) registry defines a table once with
 * its full write contract; a client that must only *read* that table consumes the same entry through
 * `asReadonly`. The read/identity contract — table, columns, primary key, synced-table name, column
 * omission, the shape/row filter, AND the column-builder factory (`makeColumns`) — is preserved
 * verbatim; the write-capability metadata is dropped:
 *
 * - `mode` flips to `readonly`;
 * - the overlay-merged read-model `view` and the overlay/journal client projection (the local write
 *   machinery `@pgxsinkit/client` provisions for a writable table) are removed — a readonly client reads
 *   the synced base table directly;
 * - `conflictPolicy`, `governance` (managed fields), and `writeMode` are removed — a readonly table has
 *   no write path, and `defineSyncRegistry` would otherwise still treat them as a writable declaration.
 *
 * The result is the same entry `defineSyncTable` would have produced for this table with
 * `mode: "readonly"`, so `defineSyncRegistry` accepts it without the writable-table requirements
 * (server-version field + `conflictPolicy`).
 *
 * Lifecycle axes (`consistencyGroup`, `subscription`, `retention`) are preserved — a projection may keep
 * the authoritative grouping/timing/durability; change them on the projected entry if a client needs to.
 *
 * `makeColumns` (the column-builder factory `defineSyncTable` stashes) is carried too: since ADR-0029 P1
 * the client derives EVERY synced-table object from it (`getSyncedLocalTable` → `projectedColumnBuilders`),
 * so a readonly projection that dropped it could not build its own local synced read cache — the member-boot
 * failure this keep-list's NOTE below predicted. It is read-derivation machinery, not a write handle.
 *
 * NOTE: if a new *read-relevant* field is added to {@link SyncTableEntry}, carry it here too (this builds
 * the readonly entry by listing what to keep, so a new field is otherwise silently dropped).
 */
export function asReadonly<TTable extends AnyPgTable, TLocalTable extends AnyPgTable>(
  entry: SyncTableEntry<TTable, TLocalTable>,
): SyncTableEntry<TTable, TLocalTable> {
  const { clientProjection } = entry;
  const readonlyProjection: ClientProjectionSpecForTable<TTable> | undefined =
    clientProjection != null
      ? {
          ...(clientProjection.syncedTable != null ? { syncedTable: clientProjection.syncedTable } : {}),
          ...(clientProjection.omitColumns != null ? { omitColumns: clientProjection.omitColumns } : {}),
          ...(clientProjection.localPrimaryKey != null ? { localPrimaryKey: clientProjection.localPrimaryKey } : {}),
        }
      : undefined;

  return {
    table: entry.table,
    localTable: entry.localTable,
    mode: "readonly",
    primaryKey: entry.primaryKey,
    // Read-relevant (ADR-0045): a readonly projection over a table that receives locally-derived rows must
    // apply CDC inserts with the same idempotent policy, so carry the resolved applyMode verbatim.
    applyMode: entry.applyMode,
    ...(entry.shape != null ? { shape: entry.shape } : {}),
    ...(readonlyProjection != null ? { clientProjection: readonlyProjection } : {}),
    ...(entry.serverProjection != null ? { serverProjection: entry.serverProjection } : {}),
    ...(entry.consistencyGroup != null ? { consistencyGroup: entry.consistencyGroup } : {}),
    ...(entry.subscription != null ? { subscription: entry.subscription } : {}),
    ...(entry.retention != null ? { retention: entry.retention } : {}),
    ...(entry.readProjection ? { readProjection: true } : {}),
    // Read-derivation machinery, not a write handle: the client rebuilds the readonly table's own local
    // synced object from this factory (ADR-0029 P1). Dropping it would break member-mode boot.
    ...(entry.makeColumns != null ? { makeColumns: entry.makeColumns } : {}),
  };
}

/**
 * Project an entry onto a different **retention** (ADR-0021) — the per-table local-persistence axis:
 * `persistent` (the durable PGlite/OPFS backend) | `ephemeral` (the table's whole local cluster — read
 * cache, overlay, journal, sequence, views, reconcile function — emitted as `TEMP`/`pg_temp`, leaving no
 * durable trace). Returns a copy of `entry` with `retention` overridden and **everything else preserved
 * verbatim** (table, columns, mode, write contract, shape/row filter, the other lifecycle axes).
 *
 * Retention is a **lifecycle** axis, not a read-contract one, so a per-client registry may legitimately
 * differ on it: {@link fingerprintReadContract} excludes retention, so a `withRetention(...)` of an
 * authoritative entry still satisfies {@link assertReadContractPreserved}. This is how one authoritative
 * registry yields a table that is durable for one client and ephemeral for another, e.g.
 * `withRetention(asReadonly(authoritative.exam), "ephemeral")`.
 *
 * Unlike `mode` (whose overlay/journal/view fields {@link asReadonly} must re-resolve), retention has **no
 * entry-derived fields** — the durable-vs-`TEMP` decision is taken by the client's schema generator at
 * runtime from this scalar — so overriding it needs no re-resolution and a plain copy is correct. The
 * return type is the input entry's exact type (write handles, create/update typing, governance marker all
 * carry through); the cast restates what a generic object spread cannot prove.
 *
 * Two constraints carry over (enforced elsewhere, not by this helper):
 * - **Consistency-group uniformity** (ADR-0021 §4): every table sharing a `consistencyGroup` must agree on
 *   retention — override the whole group, not one member, or `defineSyncRegistry` rejects the mixed group.
 *   A singleton-group table can be flipped alone.
 * - **No durable offline write queue for `ephemeral`** (ADR-0021 composition rule): an ephemeral writable
 *   table's journal is `TEMP`, so a write staged offline does not survive session end — pair a must-not-lose
 *   write with a `pessimistic` write-mode (ADR-0022) or a prompt flush.
 */
export function withRetention<TEntry extends SyncTableEntry>(entry: TEntry, retention: Retention): TEntry {
  return { ...entry, retention } as TEntry;
}

/**
 * The named `ephemeral` lifecycle projection — `withRetention(entry, "ephemeral")` — the lifecycle twin of
 * {@link asReadonly}, for the common direction (a client wants no durable trace of a table the authoritative
 * registry keeps `persistent`). Composes with `asReadonly`: `asEphemeral(asReadonly(authoritative.exam))`
 * is a read-only, no-durable-trace projection. The reverse direction (an ephemeral authoritative table a
 * client wants durable) is the bidirectional {@link withRetention} with `"persistent"`. See
 * {@link withRetention} for the constraints that carry over (group uniformity; no durable offline queue).
 */
export function asEphemeral<TEntry extends SyncTableEntry>(entry: TEntry): TEntry {
  return withRetention(entry, "ephemeral");
}

/**
 * Assert that a per-client `projection` registry preserves the **read contract** (ADR-0025) of the
 * `authoritative` registry it projects from. For every table the projection declares, its
 * {@link fingerprintReadContract} must equal the authoritative entry's: a projection may differ only in
 * write capability and lifecycle orchestration, never in the data it syncs (columns, primary key,
 * row-filter shape). A table present in the authoritative registry but absent from the projection is a
 * permitted subset; a table in the projection with no authoritative source is an error (no contract to
 * project from).
 *
 * Throws, naming the divergent tables, on any mismatch. Call it where the client registries are assembled
 * (module-eval or a test) so a drifted projection fails closed instead of silently serving different rows
 * to different clients. The `customWhere` body is invisible to the fingerprint — bump
 * {@link RowFilterSpec.revision} so a logic-only divergence is caught.
 */
export function assertReadContractPreserved(
  authoritative: SyncTableRegistry,
  projection: SyncTableRegistry,
  options?: { label?: string },
): void {
  const divergent: string[] = [];

  for (const [key, projectedEntry] of Object.entries(projection)) {
    const authoritativeEntry = authoritative[key];
    if (authoritativeEntry == null) {
      divergent.push(`${key} (absent from the authoritative registry)`);
      continue;
    }
    if (fingerprintReadContract(authoritativeEntry) !== fingerprintReadContract(projectedEntry)) {
      divergent.push(key);
    }
  }

  if (divergent.length > 0) {
    const where = options?.label ? ` (${options.label})` : "";
    throw new Error(
      `read-contract divergence${where}: a per-client projection must preserve its authoritative table's ` +
        `read contract (synced columns, primary key, row-filter shape) and differ only in write capability ` +
        `and lifecycle. Divergent tables: ${divergent.join(", ")}.`,
    );
  }
}
