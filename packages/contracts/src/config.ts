import { z } from "zod";

export const tableModeSchema = z.enum(["readonly", "writeonly", "readwrite"]);

export const primaryKeySpecSchema = z
  .object({
    columns: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

export const shapeSpecSchema = z
  .object({
    tableName: z.string().trim().min(1),
    shapeKey: z.string().trim().min(1),
    electricTable: z.string().trim().min(1).optional(),
    // rowFilter is a runtime-only TypeScript type (contains function fields Zod can't represent).
    // Declared as z.unknown() passthrough so Zod doesn't strip it during .strict() validation.
    rowFilter: z.unknown().optional(),
  })
  .strict();

export const serverRouteSpecSchema = z
  .object({
    basePath: z.string().trim().min(1),
    allowBatch: z.boolean().default(false),
  })
  .strict();

export const clientProjectionSpecSchema = z
  .object({
    syncedTable: z.string().trim().min(1),
    overlayTable: z.string().trim().min(1).optional(),
    journalTable: z.string().trim().min(1).optional(),
    readModel: z.string().trim().min(1),
    omitColumns: z.array(z.string().trim().min(1)).optional(),
    localPrimaryKey: primaryKeySpecSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.omitColumns && new Set(value.omitColumns).size !== value.omitColumns.length) {
      context.addIssue({
        code: "custom",
        message: "omitColumns must not contain duplicate entries",
        path: ["omitColumns"],
      });
    }

    if (value.localPrimaryKey && new Set(value.localPrimaryKey.columns).size !== value.localPrimaryKey.columns.length) {
      context.addIssue({
        code: "custom",
        message: "localPrimaryKey.columns must not contain duplicate entries",
        path: ["localPrimaryKey", "columns"],
      });
    }
  });

export const deferrableConstraintSpecSchema = z
  .object({
    constraintName: z.string().trim().min(1),
    columns: z.array(z.string().trim().min(1)).min(1),
    initiallyDeferred: z.boolean().optional(),
  })
  .strict();

export const managedFieldApplyOnSchema = z.enum(["create", "update"]);
export const managedFieldStrategySchema = z.enum(["authUid", "nowMicroseconds"]);

export const managedFieldSpecSchema = z
  .object({
    column: z.string().trim().min(1),
    applyOn: z.array(managedFieldApplyOnSchema).min(1),
    strategy: managedFieldStrategySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.applyOn).size !== value.applyOn.length) {
      context.addIssue({
        code: "custom",
        message: "applyOn must not contain duplicate operations",
        path: ["applyOn"],
      });
    }
  });

export const tableGovernanceSpecSchema = z
  .object({
    deferrableConstraints: z.array(deferrableConstraintSpecSchema).optional(),
    managedFields: z.array(managedFieldSpecSchema).optional(),
  })
  .strict();

export const tableSpecInputSchema = z
  .object({
    name: z.string().trim().min(1),
    mode: tableModeSchema,
    primaryKey: primaryKeySpecSchema,
    shape: shapeSpecSchema.optional(),
    clientProjection: clientProjectionSpecSchema.optional(),
    governance: tableGovernanceSpecSchema.optional(),
    routes: serverRouteSpecSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode !== "writeonly" && value.shape === undefined) {
      context.addIssue({
        code: "custom",
        message: "shape is required for readonly and readwrite tables",
        path: ["shape"],
      });
    }

    if (value.mode !== "writeonly" && value.clientProjection === undefined) {
      context.addIssue({
        code: "custom",
        message: "clientProjection is required for readonly and readwrite tables",
        path: ["clientProjection"],
      });
    }

    if (value.clientProjection?.localPrimaryKey && value.mode !== "readonly") {
      context.addIssue({
        code: "custom",
        message: "clientProjection.localPrimaryKey is only supported for readonly tables",
        path: ["clientProjection", "localPrimaryKey"],
      });
    }

    const omittedColumns = new Set(value.clientProjection?.omitColumns ?? []);
    const localPrimaryKeyColumns = value.clientProjection?.localPrimaryKey?.columns ?? [];
    const omittedLocalPrimaryKeyColumns = localPrimaryKeyColumns.filter((column) => omittedColumns.has(column));

    if (omittedLocalPrimaryKeyColumns.length > 0) {
      context.addIssue({
        code: "custom",
        message:
          "clientProjection.localPrimaryKey.columns must not include omitted columns: " +
          omittedLocalPrimaryKeyColumns.join(", "),
        path: ["clientProjection", "localPrimaryKey", "columns"],
      });
    }
  });

export const syncConfigSchema = z
  .object({
    electricUrl: z.url(),
    localSchema: z.string().trim().min(1).optional(),
    tables: z.record(z.string(), tableSpecInputSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.tables).length === 0) {
      context.addIssue({
        code: "custom",
        message: "at least one table must be configured",
        path: ["tables"],
      });
    }

    for (const [key, spec] of Object.entries(value.tables)) {
      if (spec.name !== key) {
        context.addIssue({
          code: "custom",
          message: "table config key must match spec.name",
          path: ["tables", key, "name"],
        });
      }
    }
  });

export type TableMode = z.infer<typeof tableModeSchema>;
export type PrimaryKeySpec = z.infer<typeof primaryKeySpecSchema>;
export type ShapeSpecBase = z.infer<typeof shapeSpecSchema>;
export interface ShapeSpec extends ShapeSpecBase {
  rowFilter?: RowFilterSpec;
}
export type ServerRouteSpec = z.infer<typeof serverRouteSpecSchema>;
export type ClientProjectionSpec = z.infer<typeof clientProjectionSpecSchema>;
export type DeferrableConstraintSpec = z.infer<typeof deferrableConstraintSpecSchema>;
export type ManagedFieldApplyOn = z.infer<typeof managedFieldApplyOnSchema>;
export type ManagedFieldStrategy = z.infer<typeof managedFieldStrategySchema>;
export type ManagedFieldSpec = z.infer<typeof managedFieldSpecSchema>;
export type TableGovernanceSpec = z.infer<typeof tableGovernanceSpecSchema>;
export type TableSpecInput = z.infer<typeof tableSpecInputSchema>;
export type SyncConfigInput = z.infer<typeof syncConfigSchema>;

export interface TableSchemas<TCreate, TUpdate, TRecord> {
  createSchema: z.ZodType<TCreate>;
  updateSchema: z.ZodType<TUpdate>;
  recordSchema: z.ZodType<TRecord>;
}

export interface TableAdapters {
  toEntityKey?: (record: Record<string, unknown>) => Record<string, string>;
}

export interface TableSpec<TCreate, TUpdate, TRecord> extends TableSpecInput {
  schemas: TableSchemas<TCreate, TUpdate, TRecord>;
  adapters?: TableAdapters;
}

export interface SyncConfig {
  electricUrl: string;
  tables: Record<string, TableSpec<any, any, any>>;
}

export function getLocalSyncPrimaryKey(source: {
  primaryKey: PrimaryKeySpec;
  clientProjection?: Pick<ClientProjectionSpec, "localPrimaryKey">;
}) {
  return source.clientProjection?.localPrimaryKey ?? source.primaryKey;
}

export function getLocalSyncPrimaryKeyColumns(source: {
  primaryKey: PrimaryKeySpec;
  clientProjection?: Pick<ClientProjectionSpec, "localPrimaryKey">;
}) {
  return [...getLocalSyncPrimaryKey(source).columns];
}

// RowFilterSpec is defined as a pure TypeScript type (not Zod) because it contains
// function-typed fields (customWhere, sharedUserId) that Zod cannot represent.
export interface RowFilterSpec {
  /** WHERE "column" = auth.uid() — ownership-based row filtering. */
  ownership?: {
    column: string;
  };
  /** OR clause for shared content: adds rows owned by sharedUserId. */
  shared?: {
    /** Column used for owner comparison. Defaults to ownership.column. */
    ownerColumn?: string;
    /** If set, also requires "sharedColumn" = true. */
    sharedColumn?: string;
    /** Static UUID or a function that returns a UUID given runtime params. */
    sharedUserId: string | ((params: Record<string, unknown>) => string);
  };
  /** Escape hatch: returns a raw SQL fragment ANDed with other filters. */
  customWhere?: (claims: Record<string, unknown>, params?: Record<string, unknown>) => string;
  /** Column projection for the shape URL (e.g. ["id", "source_text"]). */
  columns?: string[];
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Composes ownership, shared, and customWhere filters into a single
 * SQL WHERE clause suitable for Electric shape requests.
 *
 * Returns null if no filters apply (all rows visible).
 */
export function buildRowFilterWhere(
  filter: RowFilterSpec,
  claims: Record<string, unknown> | null,
  params?: Record<string, unknown>,
): string | null {
  const parts: string[] = [];
  const { ownership, shared, customWhere } = filter;

  // Ownership
  if (ownership && claims?.sub) {
    const userId = escapeSqlLiteral(String(claims.sub as string | number | bigint | boolean));
    parts.push(`"${ownership.column}" = '${userId}'`);
  } else if (ownership && !claims?.sub) {
    // No authenticated user — block all rows
    return "1 = 0";
  }

  // Shared content
  if (shared) {
    const ownerCol = shared.ownerColumn ?? ownership?.column;
    if (!ownerCol) {
      throw new Error("shared.ownerColumn or ownership.column is required for shared row filter");
    }

    const sharedUserId =
      typeof shared.sharedUserId === "function" ? shared.sharedUserId(params ?? {}) : shared.sharedUserId;
    const escapedSharedUserId = escapeSqlLiteral(sharedUserId);

    let sharedClause: string;
    if (shared.sharedColumn) {
      sharedClause = `("${shared.sharedColumn}" = true AND "${ownerCol}" = '${escapedSharedUserId}')`;
    } else {
      sharedClause = `"${ownerCol}" = '${escapedSharedUserId}'`;
    }

    if (parts.length > 0) {
      parts.push(`OR ${sharedClause}`);
    } else {
      parts.push(sharedClause);
    }
  }

  // Custom where
  if (customWhere) {
    const custom = customWhere(claims ?? {}, params);
    if (custom) {
      if (parts.length > 0) {
        return `(${parts.join(" ")}) AND (${custom})`;
      }
      return custom;
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.length > 1 ? `(${parts.join(" ")})` : parts[0]!;
}
