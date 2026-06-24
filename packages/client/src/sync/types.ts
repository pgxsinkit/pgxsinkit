import type { ChangeMessage, FetchError, Row, ShapeStreamInterface, ShapeStreamOptions } from "@electric-sql/client";
import type { Transaction } from "@electric-sql/pglite";

import type { ApplyStrategy, SyncColumnType } from "@pgxsinkit/contracts";

export type { ApplyStrategy };

export type Lsn = bigint;

export type MapColumnsMap = Record<string, string>;
export type MapColumnsFn = (message: ChangeMessage<Row<unknown>>) => Row<unknown>;
export type MapColumns = MapColumnsMap | MapColumnsFn;
export type SubscriptionKey = string;
export type InitialInsertMethod = "insert" | "copy" | "json";

/** Default hard cap on commit-transaction attempts before the engine goes degraded (ADR-0009). */
export const DEFAULT_MAX_COMMIT_RETRIES = 5;

export interface ShapeToTableOptions {
  shape: ShapeStreamOptions<Row<unknown>>;
  table: string;
  schema?: string | undefined;
  mapColumns?: MapColumns | undefined;
  primaryKey: string[];
  onMustRefetch?: ((tx: Transaction) => Promise<void>) | undefined;
  /**
   * Resolved column types for this shape's `json` apply path (ADR-0009 decision 3). When present
   * the engine builds the `json_to_recordset` casts from them instead of querying
   * `information_schema`; when absent the `json` path falls back to runtime introspection.
   */
  columnTypes?: SyncColumnType[] | undefined;
  /**
   * Per-shape initial-backfill apply strategy (ADR-0009 decisions 2 + 3). In a consistency group
   * each shape resolves its own apply path and its own `useInsert` transition, so one shape's
   * backfill never forces the rest onto plain `INSERT`. `initialInsertMethod` (explicit) wins;
   * otherwise `applyStrategy` is mapped; otherwise the group-level default applies.
   */
  applyStrategy?: ApplyStrategy | undefined;
  initialInsertMethod?: InitialInsertMethod | undefined;
}

export interface SyncShapesToTablesOptions {
  key: string | null;
  shapes: Record<string, ShapeToTableOptions>;
  initialInsertMethod?: InitialInsertMethod | undefined;
  onInitialSync?: (() => void) | undefined;
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
}

export interface SyncShapesToTablesResult {
  unsubscribe: () => void;
  readonly isUpToDate: boolean;
  streams: Record<string, ShapeStreamInterface<Row<unknown>>>;
}

export interface SyncShapeToTableOptions {
  shape: ShapeStreamOptions<Row<unknown>>;
  table: string;
  schema?: string | undefined;
  mapColumns?: MapColumns | undefined;
  primaryKey: string[];
  shapeKey: string | null;
  initialInsertMethod?: InitialInsertMethod | undefined;
  /**
   * The statically-resolved bulk-insert strategy for this table (ADR-0009 decision 3). When set
   * (and `initialInsertMethod` is not), it selects the initial-backfill apply path:
   * `copy` → `COPY` (TEXT format), `json` → `json_to_recordset`, `insert` → batched `INSERT`.
   */
  applyStrategy?: ApplyStrategy | undefined;
  /** Resolved column types for the `json` apply path; see {@link ShapeToTableOptions.columnTypes}. */
  columnTypes?: SyncColumnType[] | undefined;
  onInitialSync?: (() => void) | undefined;
  onError?: ((error: FetchError | Error) => void) | undefined;
  /** Commit-level error surfacing (ADR-0009 decision 5); see {@link SyncShapesToTablesOptions.onSyncError}. */
  onSyncError?: ((error: Error) => void) | undefined;
  /** Hard cap on commit-transaction attempts before going degraded. Defaults to {@link DEFAULT_MAX_COMMIT_RETRIES}. */
  maxCommitRetries?: number | undefined;
  onMustRefetch?: ((tx: Transaction) => Promise<void>) | undefined;
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
