import type { PGlite, PGliteInterfaceExtensions } from "@electric-sql/pglite";

import { type SyncConfigInput, type TableSpecInput } from "@pgxsinkit/contracts";
import { electricSync } from "@pgxsinkit/pglite-sync";

export interface ShapeSyncSpec {
  electricUrl: string;
  tableName: string;
  schema?: string;
  shapeKey: string;
  primaryKey: string[];
  electricTable?: string;
}

export interface StartShapeSyncOptions extends ShapeSyncSpec {
  headers?: Record<string, string>;
  onInitialSync?: () => void;
}

export interface ConfiguredShapeSyncSpec extends ShapeSyncSpec {
  key: string;
}

export interface StartConfiguredSyncOptions {
  syncConfig: SyncConfigInput;
  shapeHeaders?: Record<string, string>;
  onInitialSync?: () => void;
  onTableInitialSync?: (tableKey: string) => void;
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

  return getElectricNamespace(pg).syncShapeToTable(
    input.onInitialSync
      ? {
          ...config,
          ...(shapeHeaders ? { shape: { ...config.shape, headers: shapeHeaders } } : {}),
          onInitialSync: input.onInitialSync,
        }
      : {
          ...config,
          ...(shapeHeaders ? { shape: { ...config.shape, headers: shapeHeaders } } : {}),
        },
  );
}

export async function startConfiguredSync(
  pg: SyncEnginePGlite,
  input: StartConfiguredSyncOptions,
): Promise<StartConfiguredSyncResult> {
  const specs = buildConfiguredShapeSpecs(input.syncConfig);
  let pendingInitialSyncs = specs.length;
  let initialSyncSignalled = pendingInitialSyncs === 0;

  const entries = await Promise.all(
    specs.map(async (spec) => {
      const result = await startShapeSync(pg, {
        electricUrl: spec.electricUrl,
        tableName: spec.tableName,
        ...(spec.schema !== undefined ? { schema: spec.schema } : {}),
        shapeKey: spec.shapeKey,
        primaryKey: spec.primaryKey,
        ...(spec.electricTable !== undefined ? { electricTable: spec.electricTable } : {}),
        ...(input.shapeHeaders ? { headers: input.shapeHeaders } : {}),
        onInitialSync: () => {
          pendingInitialSyncs -= 1;
          input.onTableInitialSync?.(spec.key);

          if (!initialSyncSignalled && pendingInitialSyncs === 0) {
            initialSyncSignalled = true;
            input.onInitialSync?.();
          }
        },
      });

      return [spec.key, result] as const;
    }),
  );

  const tables = Object.fromEntries(entries);
  return {
    unsubscribe: () => {
      for (const table of Object.values(tables)) {
        table.unsubscribe();
      }
    },
    tables,
  };
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
  };
}
