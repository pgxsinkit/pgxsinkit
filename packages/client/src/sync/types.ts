// Started life as a copy of @electric-sql/pglite-sync (Apache-2.0, © ElectricSQL — see NOTICE).
// Fully internalized (ADR-0009); upstream compatibility is an explicit anti-goal (ADR-0028) — evolve freely.
import type { ChangeMessage, FetchError, Row, ShapeStreamInterface, ShapeStreamOptions } from "@electric-sql/client";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import type { GroupBootStamp } from "../boot-report";

// Re-exported so in-repo tests (e.g. tests/unit/sync-engine.test.ts) can name these Electric types
// via this engine module — they resolve here, inside @pgxsinkit/client's dependency scope, without
// the root workspace needing a direct dependency on the Electric client packages.
export type { Row, ShapeStreamOptions } from "@electric-sql/client";
export type { MultiShapeMessages } from "@electric-sql/experimental";

export type Lsn = bigint;

export type SubscriptionKey = string;
export type InitialInsertMethod = "insert" | "copy" | "json";

/** Default hard cap on commit-transaction attempts before the engine goes degraded (ADR-0009). */
export const DEFAULT_MAX_COMMIT_RETRIES = 5;

/**
 * Per-shape options for the group form (ADR-0029 D1). Every table-scoped fact — local table identity,
 * projection, primary keys, apply strategy, column types — is derived by the engine from the
 * group-level `registry` and this shape's `tableKey`; none is passed here. Only the Electric shape
 * stream, an optional per-shape backfill override, and the must-refetch hook remain.
 */
export interface ShapeToTableOptions {
  shape: ShapeStreamOptions<Row<unknown>>;
  /** The registry table key this shape applies into — the engine's sole per-table spec (ADR-0029 D1). */
  tableKey: string;
  /**
   * Must-refetch override: replaces the default `TRUNCATE` cache wipe (ADR-0029 D4). Receives a Drizzle
   * handle bound to the commit transaction (`drizzleOverPg(tx)`), so a scoped clear authors tier-①
   * (`db.delete(table).where(…)`).
   */
  onMustRefetch?: ((db: PgliteDatabase) => Promise<void>) | undefined;
  /**
   * Per-shape initial-backfill apply strategy override (ADR-0009 decisions 2 + 3). In a consistency
   * group each shape resolves its own apply path, so one shape's backfill never forces the rest onto
   * plain `INSERT`. When set it wins over the registry-classified strategy; otherwise the strategy is
   * derived from the entry and mapped, else the group-level default applies.
   */
  initialInsertMethod?: InitialInsertMethod | undefined;
}

export interface SyncShapesToTablesOptions {
  key: string | null;
  /** The engine's per-table spec source (ADR-0029 D1): every shape's `tableKey` resolves against it. */
  registry: SyncTableRegistry;
  shapes: Record<string, ShapeToTableOptions>;
  /**
   * ADR-0042: this group's sync bookkeeping (subscription cursor + tagged-subquery reason sets) is
   * SESSION-scoped — stored in the engine's `pg_temp` metadata relations that die with the engine, not the
   * durable ones. Set for an `ephemeral`-retention group, whose whole cluster is already TEMP: the cursor
   * and tags then die with the rows they index, so a returning engine re-streams the shape from scratch
   * instead of resuming a stale durable cursor over a recreated-empty TEMP cluster. Default `false` — a
   * persistent group's storage is identical whether the bit is `false` or unset; it only scopes an
   * ephemeral group's bookkeeping. One storage-scope bit; the engine never learns the retention model.
   */
  sessionScoped?: boolean | undefined;
  initialInsertMethod?: InitialInsertMethod | undefined;
  onInitialSync?: (() => void) | undefined;
  /**
   * Fresh-store prefetch overlap (ADR-0032 S4 / backlog-0003). When present, the group is on a
   * PROVABLY-FRESH store (a claimed schemaless spare — the caller's `freshStore` hint), so the engine
   * starts the shape streams and BUFFERS their catch-up into the memory inbox immediately — WITHOUT the
   * two DB touches the sequential path takes first (`initMetadataTables`, `getSubscriptionState`) — and
   * gates every commit (the first write to PGlite) until this promise resolves. The owner resolves it
   * once the local store is ready (schema exec + journal recovery + store-version reconcile complete), so
   * the network catch-up overlaps those local phases instead of running strictly after them. Absent → the
   * exact sequential path (warm stores, and every non-overlap caller). Because a fresh store has no prior
   * subscription state, the overlap treats the group as a new subscription (`subState === null`), which the
   * `freshStore` gate guarantees.
   */
  dbReady?: Promise<void> | undefined;
  /** Stream-level (network / fetch) error from Electric, forwarded to `MultiShapeStream.subscribe`. */
  onError?: ((error: FetchError | Error) => void) | undefined;
  /**
   * Commit-level error surfacing (ADR-0009 decision 5). Fired when a sync commit transaction
   * still fails after `maxCommitRetries` jittered-backoff attempts. The engine then holds its
   * buffer and committed frontier (never advancing `isUpToDate` on an unapplied commit) so the
   * read cache cannot silently diverge; recovery is a later commit or a restart/refetch.
   */
  onSyncError?: ((error: Error) => void) | undefined;
  /**
   * Fired whenever the stream delivers a batch — i.e. a fetch just succeeded (ADR-0013 Phase 3).
   * The runtime uses this as the read path's "alive again" signal to clear an `auth-needed` status
   * once sync resumes after re-authentication.
   */
  onSyncActivity?: (() => void) | undefined;
  /** Hard cap on commit-transaction attempts before going degraded. Defaults to {@link DEFAULT_MAX_COMMIT_RETRIES}. */
  maxCommitRetries?: number | undefined;
  /**
   * Backoff before re-attempting a failed commit, as a function of the attempt number. Defaults to
   * the runtime's jittered backoff (`computeRetryDelayMs`). A test seam — pass `() => 0` for an
   * immediate retry instead of sleeping the real backoff.
   */
  commitRetryDelayMs?: ((attempt: number) => number) | undefined;
  /**
   * Boot observability (ADR-0034): a per-group accumulator, stamped as this group's stream chain delivers
   * batches (`onBatchDelivered`), applies commits into PGlite (`onApply`), and reaches initial sync
   * (`markReady`). Present only for eager + promoted BOOT groups; absent for on-demand lazy starts and any
   * boot without report instrumentation.
   */
  bootStamp?: GroupBootStamp | undefined;
}

export interface SyncShapesToTablesResult {
  unsubscribe: () => void;
  readonly isUpToDate: boolean;
  streams: Record<string, ShapeStreamInterface<Row<unknown>>>;
}

/**
 * Single-shape options (ADR-0029 D6): thin sugar over the group form, taking the same entry-based
 * fields plus a `shapeKey`. Every table-scoped fact is derived from `(registry, tableKey)`.
 */
export interface SyncShapeToTableOptions {
  shape: ShapeStreamOptions<Row<unknown>>;
  registry: SyncTableRegistry;
  tableKey: string;
  shapeKey: string | null;
  /** ADR-0042: SESSION-scope this shape's cursor + tags (ephemeral retention); see {@link SyncShapesToTablesOptions.sessionScoped}. */
  sessionScoped?: boolean | undefined;
  initialInsertMethod?: InitialInsertMethod | undefined;
  onInitialSync?: (() => void) | undefined;
  onError?: ((error: FetchError | Error) => void) | undefined;
  /** Commit-level error surfacing (ADR-0009 decision 5); see {@link SyncShapesToTablesOptions.onSyncError}. */
  onSyncError?: ((error: Error) => void) | undefined;
  /** Hard cap on commit-transaction attempts before going degraded. Defaults to {@link DEFAULT_MAX_COMMIT_RETRIES}. */
  maxCommitRetries?: number | undefined;
  /** Backoff before re-attempting a failed commit; see {@link SyncShapesToTablesOptions.commitRetryDelayMs}. */
  commitRetryDelayMs?: ((attempt: number) => number) | undefined;
  onMustRefetch?: ((db: PgliteDatabase) => Promise<void>) | undefined;
}

export interface SyncShapeToTableResult {
  unsubscribe: () => void;
  readonly isUpToDate: boolean;
  stream: ShapeStreamInterface<Row<unknown>>;
}

export interface ElectricSyncOptions {
  debug?: boolean;
  metadataSchema?: string;
}

export type InsertChangeMessage = ChangeMessage<Row<unknown>> & {
  headers: { operation: "insert" };
};
