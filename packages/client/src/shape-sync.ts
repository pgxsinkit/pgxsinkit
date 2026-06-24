import type { ExternalHeadersRecord } from "@electric-sql/client";
import type { PGlite, PGliteInterfaceExtensions } from "@electric-sql/pglite";

import {
  type ApplyStrategy,
  type SyncColumnType,
  type SyncConfigInput,
  type TableSpecInput,
} from "@pgxsinkit/contracts";

import { electricSync } from "./sync";

export interface ShapeSyncSpec {
  electricUrl: string;
  tableName: string;
  schema?: string;
  shapeKey: string;
  primaryKey: string[];
  electricTable?: string;
  /** Statically-resolved bulk-insert strategy for this table (ADR-0009 decision 3). */
  applyStrategy?: ApplyStrategy;
  /** Resolved column types for the `json` apply path (ADR-0009 decision 3); no `information_schema` probe. */
  columnTypes?: SyncColumnType[];
  /**
   * Consistency group (ADR-0009 decision 2). Specs sharing a group sync on one `MultiShapeStream`
   * and commit atomically. Absent → the table is its own singleton group keyed by its `shapeKey`.
   */
  consistencyGroup?: string;
}

export interface StartShapeSyncOptions extends ShapeSyncSpec {
  /**
   * Shape request headers. Values may be async functions resolved per request (ADR-0013): the
   * read-path `Authorization` header is one such function so every fetch presents a fresh token.
   */
  headers?: ExternalHeadersRecord;
  onInitialSync?: () => void;
  /** Commit-level error surfacing (ADR-0009 decision 5): a commit exhausted its retries. */
  onSyncError?: (error: Error) => void;
}

export interface ConfiguredShapeSyncSpec extends ShapeSyncSpec {
  key: string;
}

export interface StartConfiguredSyncOptions {
  syncConfig: SyncConfigInput;
  /**
   * Shape request headers shared by every member shape. Values may be async functions resolved per
   * request (ADR-0013) — the read-path `Authorization` token is one such function.
   */
  shapeHeaders?: ExternalHeadersRecord;
  onInitialSync?: () => void;
  onTableInitialSync?: (tableKey: string) => void;
  /** Commit-level error surfacing (ADR-0009 decision 5): a sync commit exhausted its retries. */
  onSyncError?: (error: Error) => void;
}

type ElectricNamespace = ReturnType<typeof electricSync>;
type SyncEnginePGlite = PGlite & PGliteInterfaceExtensions<{ electric: ElectricNamespace; sync: ElectricNamespace }>;

export interface ShapeSyncResult {
  unsubscribe: () => void;
  readonly isUpToDate: boolean;
}

export interface StartConfiguredSyncResult {
  unsubscribe: () => void;
  tables: Record<string, ShapeSyncResult>;
}

export function buildShapeUrl(electricUrl: string, table: string) {
  const url = new URL(electricUrl);
  url.searchParams.set("table", table);
  return url.toString();
}

export function buildShapeConfig(input: ShapeSyncSpec) {
  return {
    shape: {
      url: buildShapeUrl(input.electricUrl, input.electricTable ?? input.tableName),
    },
    table: input.tableName,
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
    primaryKey: [...input.primaryKey],
    shapeKey: input.shapeKey,
  };
}

export function buildConfiguredShapeSpecs(input: SyncConfigInput): ConfiguredShapeSyncSpec[] {
  return Object.entries(input.tables)
    .filter(([, table]) => table.mode !== "writeonly")
    .map(([key, table]) => buildConfiguredShapeSpec(input.electricUrl, input.localSchema, key, table));
}

export function createElectricExtension() {
  return electricSync({ debug: false });
}

export async function startShapeSync(pg: SyncEnginePGlite, input: StartShapeSyncOptions) {
  const config = buildShapeConfig({
    electricUrl: input.electricUrl,
    tableName: input.tableName,
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
    shapeKey: input.shapeKey,
    primaryKey: input.primaryKey,
    ...(input.electricTable !== undefined ? { electricTable: input.electricTable } : {}),
  });

  const shapeHeaders = input.headers && Object.keys(input.headers).length > 0 ? input.headers : undefined;

  return getElectricNamespace(pg).syncShapeToTable({
    ...config,
    ...(shapeHeaders ? { shape: { ...config.shape, headers: shapeHeaders } } : {}),
    ...(input.onInitialSync ? { onInitialSync: input.onInitialSync } : {}),
    ...(input.onSyncError ? { onSyncError: input.onSyncError } : {}),
    ...(input.applyStrategy ? { applyStrategy: input.applyStrategy } : {}),
    ...(input.columnTypes ? { columnTypes: input.columnTypes } : {}),
  });
}

export async function startConfiguredSync(
  pg: SyncEnginePGlite,
  input: StartConfiguredSyncOptions,
): Promise<StartConfiguredSyncResult> {
  const specs = buildConfiguredShapeSpecs(input.syncConfig);

  // Bucket specs into consistency groups (ADR-0009 decision 2). Each group is one MultiShapeStream
  // committed atomically; an ungrouped table is its own singleton group keyed by its shapeKey.
  const groups = new Map<string, ConfiguredShapeSyncSpec[]>();
  for (const spec of specs) {
    const groupKey = groupSubscriptionKey(spec);
    const bucket = groups.get(groupKey);
    if (bucket) {
      bucket.push(spec);
    } else {
      groups.set(groupKey, [spec]);
    }
  }

  let pendingInitialSyncs = groups.size;
  let initialSyncSignalled = pendingInitialSyncs === 0;

  const groupResults = await Promise.all(
    [...groups.entries()].map(async ([groupKey, groupSpecs]) => {
      const result = await startGroupSync(pg, {
        groupKey,
        specs: groupSpecs,
        ...(input.shapeHeaders ? { headers: input.shapeHeaders } : {}),
        ...(input.onSyncError ? { onSyncError: input.onSyncError } : {}),
        onGroupInitialSync: () => {
          // The group is up-to-date as a unit; signal each member table, then advance the global
          // initial-sync gate once every group is caught up.
          for (const spec of groupSpecs) {
            input.onTableInitialSync?.(spec.key);
          }
          pendingInitialSyncs -= 1;
          if (!initialSyncSignalled && pendingInitialSyncs === 0) {
            initialSyncSignalled = true;
            input.onInitialSync?.();
          }
        },
      });
      return { groupSpecs, result };
    }),
  );

  // Each member table exposes a per-table view backed by its group's single stream: the table is
  // up-to-date exactly when its group is, and unsubscribing it tears down the whole group.
  const tables: Record<string, ShapeSyncResult> = {};
  for (const { groupSpecs, result } of groupResults) {
    for (const spec of groupSpecs) {
      tables[spec.key] = {
        unsubscribe: result.unsubscribe,
        get isUpToDate() {
          return result.isUpToDate;
        },
      };
    }
  }

  return {
    unsubscribe: () => {
      // Unsubscribe per group (not per table) so a multi-table group's stream is torn down once.
      for (const { result } of groupResults) {
        result.unsubscribe();
      }
    },
    tables,
  };
}

interface StartGroupSyncOptions {
  groupKey: string;
  specs: ConfiguredShapeSyncSpec[];
  headers?: ExternalHeadersRecord;
  onGroupInitialSync?: () => void;
  onSyncError?: (error: Error) => void;
}

/**
 * Sync one consistency group on a single `MultiShapeStream` (ADR-0009 decision 2). All member
 * shapes share the group's subscription key and commit atomically at a shared LSN frontier; each
 * shape keeps its own apply strategy and column types (resolved per-shape inside the engine).
 */
export async function startGroupSync(pg: SyncEnginePGlite, input: StartGroupSyncOptions) {
  const shapeHeaders = input.headers && Object.keys(input.headers).length > 0 ? input.headers : undefined;

  const shapes = Object.fromEntries(
    input.specs.map((spec) => [
      spec.key,
      {
        shape: {
          url: buildShapeUrl(spec.electricUrl, spec.electricTable ?? spec.tableName),
          ...(shapeHeaders ? { headers: shapeHeaders } : {}),
        },
        table: spec.tableName,
        ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
        primaryKey: [...spec.primaryKey],
        ...(spec.applyStrategy ? { applyStrategy: spec.applyStrategy } : {}),
        ...(spec.columnTypes ? { columnTypes: spec.columnTypes } : {}),
      },
    ]),
  );

  return getElectricNamespace(pg).syncShapesToTables({
    key: input.groupKey,
    shapes,
    ...(input.onGroupInitialSync ? { onInitialSync: input.onGroupInitialSync } : {}),
    ...(input.onSyncError ? { onSyncError: input.onSyncError } : {}),
  });
}

function getElectricNamespace(pg: SyncEnginePGlite) {
  return pg.electric ?? pg.sync;
}

function buildConfiguredShapeSpec(
  electricUrl: string,
  localSchema: string | undefined,
  key: string,
  table: TableSpecInput,
): ConfiguredShapeSyncSpec {
  if (table.shape === undefined) {
    throw new Error(`shape is required for synced table ${key}`);
  }

  return {
    key,
    electricUrl,
    tableName: table.clientProjection?.syncedTable ?? table.shape.tableName,
    ...(localSchema ? { schema: localSchema } : {}),
    shapeKey: table.shape.shapeKey,
    primaryKey: [...(table.clientProjection?.localPrimaryKey?.columns ?? table.primaryKey.columns)],
    electricTable: table.shape.electricTable ?? table.shape.tableName,
    ...(table.applyStrategy ? { applyStrategy: table.applyStrategy } : {}),
    ...(table.columnTypes ? { columnTypes: table.columnTypes } : {}),
    ...(table.consistencyGroup ? { consistencyGroup: table.consistencyGroup } : {}),
  };
}

/**
 * The subscription key for a spec's consistency group (ADR-0009 decision 2): the explicit
 * `consistencyGroup` when set, else the table's own `shapeKey` (a singleton group). One persisted
 * subscription-state row exists per group key, so subscription reset enumerates these.
 */
export function groupSubscriptionKey(spec: Pick<ConfiguredShapeSyncSpec, "consistencyGroup" | "shapeKey">): string {
  return spec.consistencyGroup ?? spec.shapeKey;
}
