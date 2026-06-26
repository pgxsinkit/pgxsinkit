import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { ApplyStrategy, SyncColumnType } from "./apply-strategy";

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
  /**
   * The row filter: returns the Electric shape `where` for this request, or `null` to bypass
   * filtering (e.g. admin access). **Prefer returning a Drizzle `SQL` fragment** built from the
   * table's columns: reference each column through {@link c} (a bare, rename-safe identifier) and
   * embed request-derived values directly — they become **bound `$n` params**, never hand-escaped
   * literals. Enum columns must be cast to text (`${c(col)}::text = 'x'`) for Electric's grammar,
   * and subqueries must be self-contained (not correlated), since Electric needs plain column refs.
   *
   * Returning a raw **string** is the escape hatch for a predicate Drizzle can't express. SECURITY:
   * a string is interpolated verbatim into the `where` — it is NOT escaped, so any request-derived
   * value you embed must be escaped/validated (`escapeSqlLiteral`) inside this function, or it is a
   * SQL-injection vector. Reach for the string form only when the Drizzle fragment cannot express it.
   */
  customWhere?: (claims: JwtClaims, params?: Record<string, unknown>) => string | SQL | null;
  /** Column projection for the shape URL (e.g. ["id", "source_text"]). */
  columns?: string[];
  /**
   * An opaque version tag for the part of this filter the fingerprint cannot see — the `customWhere`
   * body (you cannot hash a closure; only its *presence* is fingerprinted). Bump this (any new
   * string/number) whenever you change that logic so the fingerprint shifts and the local read cache
   * rebuilds + the shape subscription resets. Leaving it unchanged after a `customWhere`
   * authorization change would silently serve the stale shape.
   */
  revision?: string | number;
}

/**
 * The non-parameterized inline `where` for a filter: the string a `customWhere` returns (the raw
 * escape hatch), or `null` when there is no filter or `customWhere` returns a Drizzle `SQL` fragment
 * (which is parameterized by {@link buildRowFilterShape}, not inlined here). Most callers want
 * `buildRowFilterShape` — this is the inline-string view it composes from.
 */
export function buildRowFilterWhere(
  filter: RowFilterSpec,
  claims: JwtClaims | null,
  params?: Record<string, unknown>,
): string | null {
  const custom = filter.customWhere?.(claims ?? {}, params);
  return typeof custom === "string" && custom ? custom : null;
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

/**
 * The deny-all row filter: a `customWhere` returns this to make **no** rows visible (e.g. an
 * unauthenticated request), the counterpart to returning `null` (which bypasses filtering — all rows
 * visible). It is a Drizzle `SQL` fragment (`false`), so it stays on the typed/parameterized path
 * with the rest of the filter rather than being a hand-written `"1 = 0"` string. `WHERE false`
 * matches nothing; Electric accepts it (verified) exactly as it accepts `1 = 0`.
 */
export const DENY_ALL: SQL = sql`false`;

/** The parameterized shape filter the proxy sends to Electric: a `where` and its positional params. */
export interface RowFilterShape {
  where: string;
  params: string[];
}

/**
 * The shape filter the proxy sends to Electric: the `where` plus its positional `params` (`$1`, `$2`,
 * …). A `customWhere` returning a Drizzle `SQL` fragment is serialized here, so request-derived values
 * become **bound params** — never hand-escaped literals; a string `customWhere` is the raw escape
 * hatch (no params). Returns `null` when there is no filter (all rows visible).
 */
export function buildRowFilterShape(
  filter: RowFilterSpec,
  claims: JwtClaims | null,
  params?: Record<string, unknown>,
): RowFilterShape | null {
  const custom = filter.customWhere?.(claims ?? {}, params);

  if (custom == null) {
    return null;
  }

  if (typeof custom === "string") {
    return custom ? { where: custom, params: [] } : null;
  }

  const compiled = pgDialect.sqlToQuery(custom);
  return { where: compiled.sql, params: compiled.params.map((value) => String(value)) };
}
