import { type AnyPgTable, getTableConfig } from "drizzle-orm/pg-core";

import { resolveServerVersionColumnName, type SyncTableEntry } from "./registry";
import { quoteIdentifier } from "./sql-identifier";

/**
 * The Convergence model (ADR-0011): the single owner of *how* local optimistic state converges to
 * server state. It owns the shared barrier predicate, the per-table sync-state **view** generator,
 * and the event-model spec below. Read sync (the Sync applier) and write sync (the mutation runtime)
 * remain the two edges with their own transaction paths, but neither independently decides whether an
 * entity is resolved — this module is the one resolution authority.
 *
 * Distinct from the convergence *driver* (`convergence.ts`, ADR-0005), which schedules *when* to
 * converge. This module defines *how* an entity resolves.
 */

/**
 * The Convergence barrier predicate (ADR-0010): an acked create/update is resolved only once the
 * synced echo's Server version has reached the write's acked version. Emitted identically by the
 * reconcile trigger (schema.ts), `reconcileTable` (mutation.ts), **and** the per-table sync-state
 * view (decision 4) — one rule, three consumers, no drift (ADR-0004).
 *
 * `syncedAlias` is the synced-side reference (a table alias, or `NEW` inside the trigger);
 * `journalAlias` qualifies the journal's `server_updated_at_us` (omit it where the journal is the
 * unaliased target of the `DELETE`).
 */
export function buildOverlayResolutionBarrier<TTable extends AnyPgTable>(
  entry: SyncTableEntry<TTable>,
  options: { syncedAlias: string; journalAlias?: string },
): string {
  const serverVersionColumn = resolveServerVersionColumnName(entry);

  if (!serverVersionColumn) {
    throw new Error(
      `writable table ${getTableConfig(entry.table).name} has no Server version; cannot build the convergence barrier (ADR-0010)`,
    );
  }

  const journalRef = options.journalAlias ? `${options.journalAlias}.server_updated_at_us` : "server_updated_at_us";
  return `${journalRef} <= ${options.syncedAlias}.${quoteIdentifier(serverVersionColumn)}`;
}

/**
 * The qualified object names the sync-state view is generated over. The synced read cache is
 * droppable (ADR-0006); overlay + journal are the authority. The view joins all three but stores
 * nothing — it is a derived projection (ADR-0011 decision 2).
 */
export interface SyncStateViewProjection {
  /** Qualified synced read-cache table. */
  syncedTable: string;
  /** Qualified overlay (optimistic intent) table. */
  overlayTable: string;
  /** Qualified mutation-journal table. */
  journalTable: string;
}

/**
 * Generate the per-writable-table `<table>_sync_state` **view** (ADR-0011 decision 2): a derived
 * projection — never a stored copy — over synced + overlay + journal that answers "what is this
 * entity's convergence state?" with one authoritative, queryable row per entity that has local
 * activity (an overlay or journal row). Keyed on the **real PK columns**, never a generic
 * `entity_key_json` (decision 2).
 *
 * Columns:
 * - `observed_server_version` — the synced row's Server version (NULL when no echo has landed).
 * - `acked_server_version` — the highest Server version the server assigned to our acked writes.
 * - `pending_count` — journal rows still owed to the server (pending/sending/failed).
 * - `has_acked_unobserved_write` — an acked create/update whose echo has not yet caught up. Derived
 *   from the **same** {@link buildOverlayResolutionBarrier} predicate the resolver uses (decision 4),
 *   so what the UI shows can never drift from what the resolver does.
 * - `local_delete_pending` — an optimistic delete is staged in the overlay.
 * - `conflict_state` — the reason a `conflicted` (stale, reject-if-stale) write was declined, or NULL
 *   when the entity has no conflicted mutation (ADR-0015). Surfaced from the journal's
 *   `conflict_reason`, scoped to `status = 'conflicted'` so a stale failure reason never leaks in.
 *
 * The Read model stays lean (it already carries `overlay_kind`); an app that wants per-row
 * convergence status joins this view on the PK.
 */
export function buildSyncStateView<TTable extends AnyPgTable>(
  entry: SyncTableEntry<TTable>,
  projection: SyncStateViewProjection,
): string {
  const serverVersionColumn = resolveServerVersionColumnName(entry);

  if (!serverVersionColumn) {
    throw new Error(
      `writable table ${getTableConfig(entry.table).name} has no Server version; cannot build the sync-state view (ADR-0011)`,
    );
  }

  const pkColumns = [...entry.primaryKey.columns];
  const quotedVersion = quoteIdentifier(serverVersionColumn);
  const keyColumnList = pkColumns.map((column) => quoteIdentifier(column)).join(", ");
  const keySelectList = pkColumns.map((column) => `k.${quoteIdentifier(column)}`).join(",\n  ");

  const pkEquality = (left: string, right: string) =>
    pkColumns.map((column) => `${left}.${quoteIdentifier(column)} = ${right}.${quoteIdentifier(column)}`).join(" AND ");

  // Decision 4: the SAME barrier the resolver's journal-clear DELETE uses. The view asks whether an
  // acked write is *not yet* resolved (`(barrier) IS NOT TRUE`) — NULL (no synced row) counts as
  // unobserved, exactly the create-with-no-echo case. One predicate string, two consumers.
  const barrier = buildOverlayResolutionBarrier(entry, { syncedAlias: "synced", journalAlias: "journal" });

  return [
    `SELECT`,
    `  ${keySelectList},`,
    `  synced.${quotedVersion} AS observed_server_version,`,
    `  j.acked_server_version,`,
    `  COALESCE(j.pending_count, 0) AS pending_count,`,
    `  COALESCE(j.has_acked_unobserved_write, FALSE) AS has_acked_unobserved_write,`,
    `  COALESCE(o.local_delete_pending, FALSE) AS local_delete_pending,`,
    `  j.conflict_state`,
    `FROM (`,
    `  SELECT DISTINCT ${keyColumnList} FROM ${projection.journalTable}`,
    `  UNION`,
    `  SELECT DISTINCT ${keyColumnList} FROM ${projection.overlayTable}`,
    `) AS k`,
    `LEFT JOIN ${projection.syncedTable} AS synced ON ${pkEquality("synced", "k")}`,
    `LEFT JOIN LATERAL (`,
    `  SELECT`,
    `    MAX(journal.server_updated_at_us) FILTER (WHERE journal.status = 'acked') AS acked_server_version,`,
    `    COUNT(*) FILTER (WHERE journal.status IN ('pending', 'sending', 'failed')) AS pending_count,`,
    `    COALESCE(bool_or(`,
    `      journal.status = 'acked'`,
    `      AND journal.mutation_kind <> 'delete'`,
    `      AND journal.server_updated_at_us IS NOT NULL`,
    `      AND (${barrier}) IS NOT TRUE`,
    `    ), FALSE) AS has_acked_unobserved_write,`,
    `    MAX(journal.conflict_reason) FILTER (WHERE journal.status = 'conflicted') AS conflict_state`,
    `  FROM ${projection.journalTable} AS journal`,
    `  WHERE ${pkEquality("journal", "k")}`,
    `) AS j ON TRUE`,
    `LEFT JOIN LATERAL (`,
    `  SELECT bool_or(overlay.overlay_kind = 'pending_delete') AS local_delete_pending`,
    `  FROM ${projection.overlayTable} AS overlay`,
    `  WHERE ${pkEquality("overlay", "k")}`,
    `) AS o ON TRUE`,
  ].join("\n");
}

/**
 * The event model the Convergence model implements (ADR-0011). The per-entity convergence state is
 * **derived** from synced + overlay + journal — never a mutated row — so this table is the spec the
 * derivation answers to, not a state machine that is stepped. Exported so a test can assert the
 * implemented derivation covers every event.
 */
export const CONVERGENCE_EVENTS = [
  {
    event: "local create/update/delete enqueued",
    effect: "overlay upserted; a journal mutation appended (records base server version for ADR-0015)",
  },
  { event: "mutation sent", effect: "journal row → sending" },
  {
    event: "mutation acked",
    effect:
      "journal row → acked, server_updated_at_us stamped; entity shows acked_unobserved until the echo catches up",
  },
  {
    event: "Electric insert/update observed",
    effect: "synced row applied; the barrier predicate runs; resolved entities clear overlay + acked journal",
  },
  {
    event: "Electric delete observed",
    effect: "resolved by synced-row absence (deletes carry no Server version — ADR-0010)",
  },
  { event: "resolution", effect: "clear overlay/journal only through the shared barrier predicate (decision 4)" },
  { event: "conflict detected", effect: "conflict_state recorded on the journal row (ADR-0015); surfaced in the view" },
  {
    event: "shape must-refetch",
    effect: "subscription reset + re-stream; affected entity state re-derives from the fresh synced rows",
  },
] as const;
