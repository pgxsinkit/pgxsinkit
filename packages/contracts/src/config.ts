export type TableMode = "readonly" | "writeonly" | "readwrite";

export interface PrimaryKeySpec {
  columns: string[];
}

export interface ShapeSpec {
  tableName: string;
  shapeKey: string;
  electricTable?: string;
  rowFilter?: RowFilterSpec;
}

/** Input variant of {@link ShapeSpec} where `tableName` and `shapeKey` are optional.
 * When omitted, both default to the top-level `tableName` of the `defineSyncTable` call. */
export type ShapeSpecInput = Omit<ShapeSpec, "tableName" | "shapeKey"> & {
  tableName?: string;
  shapeKey?: string;
};

export interface ClientProjectionSpec {
  syncedTable?: string;
  overlayTable?: string;
  journalTable?: string;
  omitColumns?: string[];
  localPrimaryKey?: PrimaryKeySpec;
}

export interface DeferrableConstraintSpec {
  constraintName: string;
  columns: string[];
  initiallyDeferred?: boolean;
}

export type ManagedFieldApplyOn = "create" | "update";
export type ManagedFieldStrategy = "authUid" | "nowMicroseconds";

export interface ManagedFieldSpec {
  column: string;
  applyOn: ManagedFieldApplyOn[];
  strategy: ManagedFieldStrategy;
}

export interface TableGovernanceSpec {
  deferrableConstraints?: DeferrableConstraintSpec[];
  managedFields?: ManagedFieldSpec[];
}

export interface TableSpecInput {
  mode: TableMode;
  primaryKey: PrimaryKeySpec;
  shape?: ShapeSpec;
  clientProjection?: ClientProjectionSpec;
  governance?: TableGovernanceSpec;
}

export interface SyncConfigInput {
  electricUrl: string;
  localSchema?: string;
  tables: Record<string, TableSpecInput>;
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
  /**
   * Escape hatch: returns a raw SQL fragment ANDed with other filters.
   * Return `null` to bypass all filters (e.g. admin access).
   */
  customWhere?: (claims: Record<string, unknown>, params?: Record<string, unknown>) => string | null;
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
