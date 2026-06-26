import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { ApplyStrategy, SyncColumnType } from "./apply-strategy";
import { escapeSqlLiteral } from "./sql-identifier";

const pgDialect = new PgDialect();

export type TableMode = "readonly" | "writeonly" | "readwrite";

/**
 * The per-writable-table Conflict policy (ADR-0015): what happens to a **stale** write — one whose
 * Base server version is behind the row's current Server version at apply (an external write
 * interleaved). It is a **required** declaration on every writable table; there is no silent default
 * (registry validation rejects an undeclared writable table — the third hard-require). v1:
 *
 * - `last-write-wins` — apply the stale write anyway. This is today's implicit behaviour, but now a
 *   conscious, named choice rather than silent clobbering.
 * - `reject-if-stale` — do not apply; surface the conflict so the user's edit is kept (the optimistic
 *   Overlay stays, marked conflicted) and resolved as a new write.
 *
 * `field-merge` (apply only the changed fields over the current row) and `custom-resolver` (a client
 * re-resolution protocol) are reserved; the union is additive so they slot in without a breaking
 * change.
 */
export type ConflictPolicy = "last-write-wins" | "reject-if-stale";

/** The Conflict policy values accepted in v1 (ADR-0015). Source of truth for registry validation. */
export const CONFLICT_POLICIES = ["last-write-wins", "reject-if-stale"] as const satisfies readonly ConflictPolicy[];

/** Type guard: is `value` one of the v1 {@link ConflictPolicy} values? */
export function isConflictPolicy(value: unknown): value is ConflictPolicy {
  return typeof value === "string" && (CONFLICT_POLICIES as readonly string[]).includes(value);
}

/**
 * Minimal verified-JWT claim shape the sync layer understands. Providers may
 * attach arbitrary extra claims; those stay reachable through index access and
 * ownership claim paths (e.g. "app_metadata.person_id"). Parse decoded JWT
 * payloads with this schema at the auth boundary so the static type is honest.
 */
export const jwtClaimsSchema = z.looseObject({
  sub: z.string().optional(),
  app_metadata: z
    .looseObject({
      roles: z.array(z.string()).optional(),
    })
    .optional(),
});

export type JwtClaims = z.infer<typeof jwtClaimsSchema>;

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

/** Context available to a {@link RowTransform}: the verified claims and any extra runtime params. */
export interface RowTransformContext {
  claims: JwtClaims | null;
  params?: Record<string, unknown>;
}

/**
 * Per-row rewrite applied in the proxy response path (after the row filter, before
 * column omission). Receives a shape-log row's column map (keys are wire/column names)
 * and returns a possibly-rewritten one — letting the server strip a *sub-document* of a
 * jsonb column, or otherwise rewrite a value, *conditionally on row data*. This expresses
 * what a static, whole-column `omitColumns` cannot.
 *
 * It runs only in the proxy's per-response path: it never alters the local PGlite schema,
 * never changes the Electric shape URL, and so never pollutes Electric's shared shape
 * cache. Return the same `row` reference to signal "no change".
 */
export type RowTransform = (row: Record<string, unknown>, context: RowTransformContext) => Record<string, unknown>;

export interface ClientProjectionSpec {
  syncedTable?: string;
  overlayTable?: string;
  journalTable?: string;
  omitColumns?: readonly string[];
  localPrimaryKey?: PrimaryKeySpec;
}

/**
 * Server-side projection applied in the proxy response path. This is server
 * authority, not client shape — it never alters the local PGlite schema or the
 * Electric shape URL — so it lives apart from {@link ClientProjectionSpec} (ADR-0004).
 */
export interface ServerProjectionSpec {
  /**
   * Optional per-row rewrite applied in the proxy response path. Runs before column
   * omission, so it may read a column (e.g. a control flag) that
   * `clientProjection.omitColumns` then removes from the client-visible row. See
   * {@link RowTransform}.
   */
  rowTransform?: RowTransform;
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
  /**
   * The statically-resolved bulk-insert strategy for this table's read-path backfill (ADR-0009
   * decision 3), derived from its column types by the registry. Optional: when absent, the engine
   * defaults to `insert` (the always-correct floor).
   */
  applyStrategy?: ApplyStrategy;
  /**
   * The resolved column types for the `json` apply path (ADR-0009 decision 3), so it never queries
   * `information_schema` at runtime. Carried from the registry; absent for callers that drive the
   * engine without one (those fall back to runtime introspection).
   */
  columnTypes?: SyncColumnType[];
  /**
   * Consistency group (ADR-0009 decision 2): tables sharing a group sync on one `MultiShapeStream`
   * and commit atomically at a shared LSN frontier. Absent → the table is its own singleton group.
   */
  consistencyGroup?: string;
}

export interface SyncConfigInput<TTables extends Record<string, TableSpecInput> = Record<string, TableSpecInput>> {
  electricUrl: string;
  localSchema?: string;
  tables: TTables;
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
  /** WHERE "column" = '<owner claim>' — ownership-based row filtering. */
  ownership?: {
    column: string;
    /**
     * Dot-path into the JWT claims used as the owner value (e.g.
     * "app_metadata.person_id"). Defaults to "sub". A missing, empty, or
     * non-primitive claim denies all rows, matching the missing-sub behavior.
     */
    claim?: string;
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
   * Escape hatch: returns a raw SQL fragment ANDed with other filters. Return
   * `null` to bypass all filters (e.g. admin access).
   *
   * SECURITY: the returned string is interpolated verbatim into the Electric shape
   * `where` clause — it is NOT escaped. Any request-derived value (e.g. from
   * `params`) you embed must be escaped/validated inside this function, or it is a
   * SQL-injection vector. Prefer `ownership`/`shared`, which escape their values for
   * you; reach for `customWhere` only when those cannot express the predicate.
   */
  customWhere?: (claims: JwtClaims, params?: Record<string, unknown>) => string | SQL | null;
  /** Column projection for the shape URL (e.g. ["id", "source_text"]). */
  columns?: string[];
  /**
   * An opaque version tag for the parts of this filter the fingerprint cannot see — the
   * `customWhere` body and a function-valued `shared.sharedUserId`. Their *presence* is
   * fingerprinted, but their *logic* is invisible (you cannot hash a closure). Bump this
   * (any new string/number) whenever you change that logic so the fingerprint shifts and the
   * local read cache rebuilds + the shape subscription resets. Leaving it unchanged after a
   * `customWhere` authorization change would silently serve the stale shape.
   */
  revision?: string | number;
}

function readOwnerClaim(claims: JwtClaims | null, claimPath: string): string | null {
  let current: unknown = claims;

  for (const segment of claimPath.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  switch (typeof current) {
    case "string":
      return current.length > 0 ? current : null;
    case "number":
    case "bigint":
    case "boolean":
      // Mirrors the historical truthiness check on claims.sub.
      return current ? String(current) : null;
    default:
      return null;
  }
}

/**
 * Composes ownership, shared, and customWhere filters into a single
 * SQL WHERE clause suitable for Electric shape requests.
 *
 * Returns null if no filters apply (all rows visible).
 */
export function buildRowFilterWhere(
  filter: RowFilterSpec,
  claims: JwtClaims | null,
  params?: Record<string, unknown>,
): string | null {
  const parts: string[] = [];
  const { ownership, shared, customWhere } = filter;

  // Ownership
  if (ownership) {
    const ownerValue = readOwnerClaim(claims, ownership.claim ?? "sub");

    if (ownerValue === null) {
      // No authenticated owner claim — block all rows
      return "1 = 0";
    }

    parts.push(`"${ownership.column}" = '${escapeSqlLiteral(ownerValue)}'`);
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

  // Custom where. A SQL fragment is handled by the proxy's parameterized path, not here — this
  // legacy string composer ignores it (returns the ownership/shared parts, or null).
  if (customWhere) {
    const custom = customWhere(claims ?? {}, params);
    if (typeof custom === "string" && custom) {
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

/**
 * A **bare** (table-unqualified) quoted identifier for a Drizzle column — `"workspace_id"`, never
 * `"work_items"."workspace_id"`. Electric's shape `where` grammar requires *plain* column references
 * (it rejects a qualified one with "Expected a plain column reference"), and Drizzle qualifies columns
 * by default — so reference columns through `c()` when authoring a `customWhere` Drizzle fragment. The
 * column object keeps the reference rename-safe and existence-checked at compile time; only the bare
 * name reaches the wire. Subqueries must stay self-contained (not correlated), since bare names then
 * resolve unambiguously to each FROM — a correlated subquery would need qualification Electric rejects.
 */
export function c(column: AnyColumn): SQL {
  return sql`${sql.identifier(column.name)}`;
}

/** The parameterized shape filter the proxy sends to Electric: a `where` and its positional params. */
export interface RowFilterShape {
  where: string;
  params: string[];
}

/**
 * The parameterized form of {@link buildRowFilterWhere}, for the Electric shape proxy: returns the
 * `where` string plus the positional `params` (`$1`, `$2`, …) it references. A `customWhere` that
 * returns a Drizzle `SQL` fragment is serialized here, so request-derived values become **bound
 * params** — never hand-escaped literals. `ownership`/`shared` and a string `customWhere` stay inline
 * (no params), composed exactly as `buildRowFilterWhere` does; a SQL `customWhere` is ANDed on with its
 * params appended (the inline part has no `$n`, so the fragment's `$1…$n` index the returned params).
 */
export function buildRowFilterShape(
  filter: RowFilterSpec,
  claims: JwtClaims | null,
  params?: Record<string, unknown>,
): RowFilterShape | null {
  const inlinePart = buildRowFilterWhere(filter, claims, params);
  const custom = filter.customWhere?.(claims ?? {}, params);

  if (custom != null && typeof custom !== "string") {
    const compiled = pgDialect.sqlToQuery(custom);
    const where = inlinePart ? `(${inlinePart}) AND (${compiled.sql})` : compiled.sql;
    return { where, params: compiled.params.map((value) => String(value)) };
  }

  return inlinePart != null ? { where: inlinePart, params: [] } : null;
}
