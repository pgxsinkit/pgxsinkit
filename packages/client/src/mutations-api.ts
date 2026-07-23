// The registry-wide reactive mutation-status API (the current warm-store observability contract,
// option 1). `client.mutations.*` lets a consumer render a global sync indicator or diagnostics screen with
// ONE subscription over the `pgxsinkit_all_mutations` view (schema.ts) instead of one live query per writable
// journal — the O(writable-table) fan-out the proposal set out to remove.
//
// It is a FACTORY over the two seams BOTH client modes already share — `subscribeLiveRows` (in-process over
// `pglite.live`; worker-attached over the bridge) and a one-shot `query` (in-process `pglite.query`;
// worker-attached the `rawQuery` RPC) — so the worker bridge needs ZERO protocol change. Every runtime query
// is Drizzle-built over `getAllMutationsView` (tier ①); consumers never touch generated journal relation
// names.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { MutationSummary, SyncTableName, SyncTableRegistry } from "@pgxsinkit/contracts";

import { getAllMutationsView } from "./local-tables";
import type { MutationDetail, MutationKind } from "./mutation";
import type { MutationStatus } from "./mutation-state";

// Re-export the detail shape under the summary-API name. The list/subscribe detail rows ARE
// {@link MutationDetail} (it already carries `tableName` + the parsed `entityKey`), reused verbatim.
export type { MutationDetail } from "./mutation";
export type MutationSummaryDetail = MutationDetail;

/**
 * Build-only Drizzle (compiles to SQL via `.toSQL()`; never executes) — same mock seam mutation.ts uses.
 * Lazily constructed: some unit suites mock `drizzle-orm/pglite`, so `drizzle.mock` is unavailable at module
 * load; a lazy builder is only reached when a real query is actually authored (never in those mocked boots).
 */
let queryBuilderInstance: ReturnType<typeof drizzle.mock> | undefined;
function queryBuilder(): ReturnType<typeof drizzle.mock> {
  return (queryBuilderInstance ??= drizzle.mock());
}

/** Optional filters for {@link MutationsApi.list} / {@link MutationsApi.subscribe}. */
export interface MutationListOptions<TRegistry extends SyncTableRegistry> {
  /** Restrict to one registry table key (the `table_key` column). */
  table?: SyncTableName<TRegistry>;
  /**
   * Restrict to one entity — matched on the serialized `entity_key_json` (`JSON.stringify(entityKey)`),
   * byte-for-byte against the enqueue-time serialization. For a COMPOSITE key, pass the properties in the
   * same order pgxsinkit serialized them (a key taken from a returned {@link MutationSummaryDetail} or the
   * write API round-trips correctly; a hand-built object with a different property order silently matches
   * nothing).
   */
  entityKey?: Record<string, string>;
  /** Restrict to a set of journal statuses. */
  statuses?: readonly MutationStatus[];
  /** Cap the returned rows (applied after the `enqueued_at_us` ordering). */
  limit?: number;
}

/** A handle to a live summary subscription: the initial summary plus an idempotent unsubscribe. */
export interface MutationSummarySubscription {
  initial: MutationSummary;
  unsubscribe: () => void;
}

/** A handle to a live detail subscription: the initial ordered rows plus an idempotent unsubscribe. */
export interface MutationListSubscription {
  initial: MutationSummaryDetail[];
  unsubscribe: () => void;
}

/**
 * The registry-wide reactive mutation-status surface (`client.mutations`), identical on the in-process and
 * worker-attached client. Consumers NEVER touch the generated journal relation names — everything routes
 * through the `pgxsinkit_all_mutations` view.
 *
 * The `summary` is cheap enough to mount PERMANENTLY (one fingerprinted registration regardless of subscriber
 * count — ADR-0040 dedup gives one shared rerun per journal write, not N). Full `list`/`subscribe` detail
 * subscriptions should stay route- or feature-scoped.
 */
export interface MutationsApi<TRegistry extends SyncTableRegistry> {
  /** One-shot per-status counts across every writable journal (absent statuses = 0). */
  summary(): Promise<MutationSummary>;
  /**
   * Live per-status counts: `listener` fires on every change, the initial summary is on the returned handle
   * (matching `subscribeLiveRows`' initial-via-return / changes-via-callback split). One registration
   * regardless of subscriber count. Cheap to mount permanently.
   */
  subscribeSummary(listener: (summary: MutationSummary) => void): Promise<MutationSummarySubscription>;
  /** One-shot normalized detail rows, filtered by {@link MutationListOptions}, ordered newest-first by `enqueued_at_us`. */
  list(options?: MutationListOptions<TRegistry>): Promise<MutationSummaryDetail[]>;
  /**
   * Live normalized detail rows (same filters/ordering as {@link list}). Route/feature-scoped: a detail
   * subscription reruns the union SELECT on each relevant write — cheap for a scoped view, but prefer the
   * summary for anything mounted app-wide.
   */
  subscribe(
    options: MutationListOptions<TRegistry>,
    listener: (rows: MutationSummaryDetail[]) => void,
  ): Promise<MutationListSubscription>;
}

/** The row shape the raw seams return for the summary aggregate (unmapped, keyed by output column name). */
interface SummaryRow extends Record<string, unknown> {
  status: string;
  count: number | string;
}

/** The row shape the raw seams return for a detail query (unmapped, keyed by the select's aliases). */
interface DetailRow extends Record<string, unknown> {
  tableName: string;
  entityKeyJson: string;
  mutationId: string;
  mutationSeq: number | string;
  mutationKind: MutationKind;
  status: MutationStatus;
  attemptCount: number | string;
  lastHttpStatus: number | null;
  lastError: string | null;
  conflictReason: string | null;
  nextRetryAtUs: string | null;
  serverUpdatedAtUs: string | null;
  updatedAtUs: string;
  registryVersion: string;
}

/** The seams the factory needs — shared verbatim by both client modes (zero worker-protocol change). */
export interface MutationsApiDeps<TRegistry extends SyncTableRegistry> {
  registry: TRegistry;
  subscribeLiveRows: <TRow extends Record<string, unknown>>(
    input: { sql: string; params: readonly unknown[] },
    onRows: (rows: TRow[]) => void,
  ) => Promise<{ initialRows: TRow[]; unsubscribe: () => void }>;
  /** One-shot query seam (in-process `pglite.query`; worker-attached the `rawQuery` RPC). Rows are UNMAPPED. */
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

const STATUS_TO_SUMMARY_KEY: Record<MutationStatus, keyof MutationSummary> = {
  pending: "pendingCount",
  sending: "sendingCount",
  acked: "ackedCount",
  failed: "failedCount",
  quarantined: "quarantinedCount",
  conflicted: "conflictedCount",
  rejected: "rejectedCount",
};

function emptySummary(): MutationSummary {
  return {
    pendingCount: 0,
    sendingCount: 0,
    ackedCount: 0,
    failedCount: 0,
    rejectedCount: 0,
    conflictedCount: 0,
    quarantinedCount: 0,
    unsettledCount: 0,
    settledCount: 0,
  };
}

/** Fold `{status, count}` aggregate rows into the summary shape (absent statuses = 0; derive the totals). */
function foldSummary(rows: readonly SummaryRow[]): MutationSummary {
  const summary = emptySummary();
  for (const row of rows) {
    const key = STATUS_TO_SUMMARY_KEY[row.status as MutationStatus];
    if (key) {
      summary[key] = Number(row.count);
    }
  }
  // See MutationSummary's JSDoc (FIX 3): `conflicted` AND `quarantined` are journal-terminal but user-UNSETTLED
  // (overlay kept, entity blocked, `destroy()` refuses them, reconciliation counts them owed), so both join
  // pending/sending/failed. `settledCount` is the truly-done complement — `acked` + `rejected` only.
  summary.unsettledCount =
    summary.pendingCount +
    summary.sendingCount +
    summary.failedCount +
    summary.conflictedCount +
    summary.quarantinedCount;
  summary.settledCount = summary.ackedCount + summary.rejectedCount;
  return summary;
}

function mapDetailRow(row: DetailRow): MutationSummaryDetail {
  return {
    tableName: row.tableName,
    entityKey: JSON.parse(row.entityKeyJson) as Record<string, string>,
    mutationId: row.mutationId,
    mutationSeq: Number(row.mutationSeq),
    mutationKind: row.mutationKind,
    status: row.status,
    attemptCount: Number(row.attemptCount),
    lastHttpStatus: row.lastHttpStatus,
    lastError: row.lastError,
    conflictReason: row.conflictReason,
    nextRetryAtUs: row.nextRetryAtUs,
    serverUpdatedAtUs: row.serverUpdatedAtUs,
    updatedAtUs: row.updatedAtUs,
    registryVersion: row.registryVersion,
  };
}

/** Does the registry declare ≥1 writable table (a journal to union → the view is emitted)? */
function hasWritableTable(registry: SyncTableRegistry): boolean {
  return Object.values(registry).some((entry) => entry.mode !== "readonly" && entry.clientProjection?.journalTable);
}

/** The `SELECT status, count(*) … GROUP BY status` aggregate over the view (tier ①). */
function buildSummarySql(registry: SyncTableRegistry): { sql: string; params: unknown[] } {
  const view = getAllMutationsView(registry);
  return queryBuilder()
    .select({ status: view.status, count: sql<number>`count(*)::int`.as("count") })
    .from(view)
    .groupBy(view.status)
    .toSQL();
}

/**
 * The filtered detail SELECT over the view (tier ①). Every column is aliased to its camelCase key (the raw
 * seams return rows UNMAPPED), mirroring `readMutationDetailsForContexts`, plus the `table_key`. Ordered
 * newest-first by `enqueued_at_us` — the per-journal `mutation_seq` is NOT globally ordered, so it is never
 * used across tables.
 */
function buildDetailSql<TRegistry extends SyncTableRegistry>(
  registry: TRegistry,
  options: MutationListOptions<TRegistry> | undefined,
): { sql: string; params: unknown[] } {
  const view = getAllMutationsView(registry);
  const conditions = [];
  if (options?.table != null) {
    conditions.push(eq(view.tableKey, options.table));
  }
  if (options?.entityKey != null) {
    conditions.push(eq(view.entityKeyJson, JSON.stringify(options.entityKey)));
  }
  if (options?.statuses != null && options.statuses.length > 0) {
    conditions.push(inArray(view.status, options.statuses as string[]));
  }

  const base = queryBuilder()
    .select({
      tableName: sql<string>`${view.tableKey}`.as("tableName"),
      entityKeyJson: sql<string>`${view.entityKeyJson}`.as("entityKeyJson"),
      mutationId: sql<string>`${view.mutationId}`.as("mutationId"),
      mutationSeq: sql<number>`${view.mutationSeq}`.as("mutationSeq"),
      mutationKind: sql<MutationKind>`${view.mutationKind}`.as("mutationKind"),
      status: sql<MutationStatus>`${view.status}`.as("status"),
      attemptCount: sql<number>`${view.attemptCount}`.as("attemptCount"),
      lastHttpStatus: sql<number | null>`${view.lastHttpStatus}`.as("lastHttpStatus"),
      lastError: sql<string | null>`${view.lastError}`.as("lastError"),
      conflictReason: sql<string | null>`${view.conflictReason}`.as("conflictReason"),
      nextRetryAtUs: sql<string | null>`${view.nextRetryAtUs}::text`.as("nextRetryAtUs"),
      serverUpdatedAtUs: sql<string | null>`${view.serverUpdatedAtUs}::text`.as("serverUpdatedAtUs"),
      updatedAtUs: sql<string>`${view.updatedAtUs}::text`.as("updatedAtUs"),
      registryVersion: sql<string>`${view.registryVersion}`.as("registryVersion"),
    })
    .from(view)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    // `mutation_id` tiebreak: mutations enqueued in the same microsecond (e.g. a multi-table batch) must not
    // shuffle relative order between live-query reruns.
    .orderBy(desc(view.enqueuedAtUs), desc(view.mutationId));

  return (options?.limit != null ? base.limit(options.limit) : base).toSQL();
}

/**
 * Build the `client.mutations` API over the shared seams. Implemented ONCE — both client modes pass their own
 * `subscribeLiveRows` + one-shot `query`, so semantics are identical and the worker bridge is untouched. A
 * registry with NO writable table emits no view, so the API short-circuits to empty shapes WITHOUT touching
 * the (absent) view — derived from the registry, never a runtime probe.
 */
export function createMutationsApi<TRegistry extends SyncTableRegistry>(
  deps: MutationsApiDeps<TRegistry>,
): MutationsApi<TRegistry> {
  const { registry, subscribeLiveRows, query } = deps;
  const writable = hasWritableTable(registry);

  return {
    summary: async () => {
      if (!writable) {
        return emptySummary();
      }
      const built = buildSummarySql(registry);
      const { rows } = await query(built.sql, built.params);
      return foldSummary(rows as SummaryRow[]);
    },
    subscribeSummary: async (listener) => {
      if (!writable) {
        return { initial: emptySummary(), unsubscribe: () => {} };
      }
      const built = buildSummarySql(registry);
      const subscription = await subscribeLiveRows<SummaryRow>({ sql: built.sql, params: built.params }, (rows) =>
        listener(foldSummary(rows)),
      );
      return { initial: foldSummary(subscription.initialRows), unsubscribe: subscription.unsubscribe };
    },
    list: async (options) => {
      if (!writable) {
        return [];
      }
      const built = buildDetailSql(registry, options);
      const { rows } = await query(built.sql, built.params);
      return (rows as DetailRow[]).map(mapDetailRow);
    },
    subscribe: async (options, listener) => {
      if (!writable) {
        return { initial: [], unsubscribe: () => {} };
      }
      const built = buildDetailSql(registry, options);
      const subscription = await subscribeLiveRows<DetailRow>({ sql: built.sql, params: built.params }, (rows) =>
        listener(rows.map(mapDetailRow)),
      );
      return { initial: subscription.initialRows.map(mapDetailRow), unsubscribe: subscription.unsubscribe };
    },
  };
}
