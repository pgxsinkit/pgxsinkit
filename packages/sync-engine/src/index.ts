import type { PGlite, PGliteInterfaceExtensions } from "@electric-sql/pglite";
import { z } from "zod";

import { syncConfigSchema, type SyncConfigInput, type TableSpecInput } from "@pgxsinkit/contracts";
import { electricSync } from "@pgxsinkit/pglite-sync";

export const shapeSyncSpecSchema = z
  .object({
    electricUrl: z.url(),
    tableName: z.string().trim().min(1),
    schema: z.string().trim().min(1).optional(),
    shapeKey: z.string().trim().min(1),
    primaryKey: z.array(z.string().trim().min(1)).min(1),
    electricTable: z.string().trim().min(1).optional(),
  })
  .strict();

export type ShapeSyncSpec = z.infer<typeof shapeSyncSpecSchema>;

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
  const parsed = shapeSyncSpecSchema.parse(input);
  return {
    shape: {
      url: buildShapeUrl(parsed.electricUrl, parsed.electricTable ?? parsed.tableName),
    },
    table: parsed.tableName,
    schema: parsed.schema,
    primaryKey: [...parsed.primaryKey],
    shapeKey: parsed.shapeKey,
  };
}

export function buildConfiguredShapeSpecs(input: SyncConfigInput): ConfiguredShapeSyncSpec[] {
  const parsed = syncConfigSchema.parse(input);

  return Object.entries(parsed.tables)
    .filter(([, table]) => table.mode !== "writeonly")
    .map(([key, table]) => buildConfiguredShapeSpec(parsed.electricUrl, parsed.localSchema, key, table));
}

export function createElectricExtension() {
  return electricSync({ debug: false });
}

export async function startShapeSync(
  pg: PGlite & PGliteInterfaceExtensions<{ electric: ElectricNamespace }>,
  input: StartShapeSyncOptions,
) {
  const config = buildShapeConfig({
    electricUrl: input.electricUrl,
    tableName: input.tableName,
    schema: input.schema,
    shapeKey: input.shapeKey,
    primaryKey: input.primaryKey,
    electricTable: input.electricTable,
  });

  const shapeHeaders = input.headers && Object.keys(input.headers).length > 0 ? input.headers : undefined;

  return pg.electric.syncShapeToTable(
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
  pg: PGlite & PGliteInterfaceExtensions<{ electric: ElectricNamespace }>,
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
        schema: spec.schema,
        shapeKey: spec.shapeKey,
        primaryKey: spec.primaryKey,
        electricTable: spec.electricTable,
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

function buildConfiguredShapeSpec(
  electricUrl: string,
  localSchema: string | undefined,
  key: string,
  table: TableSpecInput,
): ConfiguredShapeSyncSpec {
  if (table.shape === undefined) {
    throw new Error(`shape is required for synced table ${key}`);
  }

  if (table.clientProjection === undefined) {
    throw new Error(`clientProjection is required for synced table ${key}`);
  }

  return {
    key,
    electricUrl,
    tableName: table.clientProjection.syncedTable,
    ...(localSchema ? { schema: localSchema } : {}),
    shapeKey: table.shape.shapeKey,
    primaryKey: [...table.primaryKey.columns],
    electricTable: table.shape.electricTable ?? table.shape.tableName,
  };
}
