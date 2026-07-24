import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { z } from "zod";

const pgDialect = new PgDialect();

export type TableMode = "readonly" | "writeonly" | "readwrite";

/**
 * The per-writable-table Conflict policy (ADR-0015): what happens to a **stale** write — one whose
 * Base server version is behind the row's current Server version at apply (an external write
 * interleaved). It is a **required** declaration on every writable table; there is no silent default
 * (registry validation rejects an undeclared writable table — the third hard-require). v1:
 *
 * - `last-write-wins` — apply the stale write anyway. A required, named declaration: the toolkit never
 *   silently clobbers under an unspecified default, so choosing this is an explicit acceptance of the
 *   stale-overwrite semantics.
 * - `reject-if-stale` — do not apply; surface the conflict so the user's edit is kept (the optimistic
 *   Overlay stays, marked conflicted) and resolved as a new write.
 *
 * `field-merge` (apply only the changed fields over the current row) and `custom-resolver` (a client
 * re-resolution protocol) are reserved values for future policies — declared here so the policy surface
 * names its full intended range.
 */
export type ConflictPolicy = "last-write-wins" | "reject-if-stale";

/** The Conflict policy values accepted in v1 (ADR-0015). Source of truth for registry validation. */
export const CONFLICT_POLICIES = ["last-write-wins", "reject-if-stale"] as const satisfies readonly ConflictPolicy[];

/** Type guard: is `value` one of the v1 {@link ConflictPolicy} values? */
export function isConflictPolicy(value: unknown): value is ConflictPolicy {
  return typeof value === "string" && (CONFLICT_POLICIES as readonly string[]).includes(value);
}

/**
 * Subscription timing for a synced table (ADR-0021): **when** its Electric shape subscribes.
 *
 * - `eager` (default) — subscribed in the boot set, as today.
 * - `lazy` — excluded from boot; subscribed on first query-reference. With `persistent` retention,
 *   first use is a one-time ignition that promotes the table to a normal eager table for subsequent
 *   sessions; with `ephemeral` retention it is session-scoped.
 *
 * A property of the **consistency group**: every table sharing a `consistencyGroup` must agree, since
 * a group commits atomically on one `MultiShapeStream` and cannot be partly lazy (ADR-0021 §4).
 */
export type SubscriptionTiming = "eager" | "lazy";

/** The {@link SubscriptionTiming} values. Source of truth for registry validation. */
export const SUBSCRIPTION_TIMINGS = ["eager", "lazy"] as const satisfies readonly SubscriptionTiming[];

/** Type guard: is `value` a {@link SubscriptionTiming}? */
export function isSubscriptionTiming(value: unknown): value is SubscriptionTiming {
  return typeof value === "string" && (SUBSCRIPTION_TIMINGS as readonly string[]).includes(value);
}

/**
 * Retention for a synced table (ADR-0021): **whether** its local copy is durable.
 *
 * - `persistent` (default) — the durable PGlite backend with a resumable subscription-state.
 * - `ephemeral` — the table's whole per-table local cluster (read cache, overlay, journal, sequence,
 *   views, reconcile trigger/function) is emitted as `TEMP`, so reads **and** writes leave no durable
 *   trace. Consequence: no durable offline write queue — pair a must-not-lose write with a pessimistic
 *   flush (ADR-0022).
 *
 * Like {@link SubscriptionTiming}, a property of the consistency group: every table in a group agrees.
 */
export type Retention = "persistent" | "ephemeral";

/** The {@link Retention} values. Source of truth for registry validation. */
export const RETENTIONS = ["persistent", "ephemeral"] as const satisfies readonly Retention[];

/** Type guard: is `value` a {@link Retention}? */
export function isRetention(value: unknown): value is Retention {
  return typeof value === "string" && (RETENTIONS as readonly string[]).includes(value);
}

/**
 * Write-mode (ADR-0022): **how** a write reaches the server — the write-side twin of {@link Retention}.
 *
 * - `optimistic` (default) — the write enters the local journal with an optimistic overlay, the UI updates
 *   immediately, and the convergence loop flushes the journal as one all-or-nothing batch; the canonical
 *   row returns via the sync echo. The path that has always existed.
 * - `pessimistic` — the write is **server-authoritative**: it flush-routes to an authoritative endpoint that
 *   applies it in its own isolated, serialised transaction and returns a per-mutation result (accepted, or
 *   rejected-with-typed-reason) **before** the UI shows success. For invariants the client cannot evaluate
 *   locally — a capacity/quota/uniqueness gate enforced by a server-side rule.
 *
 * Write-mode is a property of an atomic **write-unit**, not a single table (ADR-0022 §1): a unit is uniformly
 * one mode. The *static* write-unit is the **consistency group** — so, like {@link SubscriptionTiming} and
 * {@link Retention}, every table sharing a `consistencyGroup` must agree (validated). A *dynamic* override is
 * the imperative `transaction({ mode })` block, which scopes a mode to an ad-hoc set of mutations.
 */
export type WriteMode = "optimistic" | "pessimistic";

/** The {@link WriteMode} values. Source of truth for registry validation. */
export const WRITE_MODES = ["optimistic", "pessimistic"] as const satisfies readonly WriteMode[];

/** Type guard: is `value` a {@link WriteMode}? */
export function isWriteMode(value: unknown): value is WriteMode {
  return typeof value === "string" && (WRITE_MODES as readonly string[]).includes(value);
}

/**
 * The registry-declared BROWSER storage backend (ADR-0049 decision 1). `opfs` (default) is the store's
 * normal boot on every platform — the capability machinery selects the `opfs-repacked` VFS where a home
 * can hold sync-access handles, and falls back to in-SharedWorker `idbfs` when no home can. `idbfs` is the
 * one way to opt out of that machinery entirely: no probe, no election, the engine boots on idb.
 *
 * Scopes the BROWSER store only. Environment resolution is orthogonal and unchanged (ADR-0049 decision 14):
 * a Node mint stays `file://` and the export clone stays memory regardless of this declaration.
 */
export type StorageBackend = "opfs" | "idbfs";

/** The {@link StorageBackend} values. Source of truth for {@link SyncStorageDeclaration} validation. */
export const STORAGE_BACKENDS = ["opfs", "idbfs"] as const satisfies readonly StorageBackend[];

/** Type guard: is `value` a {@link StorageBackend}? */
export function isStorageBackend(value: unknown): value is StorageBackend {
  return typeof value === "string" && (STORAGE_BACKENDS as readonly string[]).includes(value);
}

/**
 * The registry-declared durability mode (ADR-0047; ADR-0049 decision 9). `relaxed` (default) returns a
 * write before its durable flush and schedules the flush asynchronously — the local-first "instant write"
 * the toolkit exists to deliver. `strict` reinstates the synchronous flush boundary (a ~50ms+ per-statement
 * floor on idb; cheap on `opfs-repacked`). It binds EVERY open of EVERY store minted from the registry, so
 * no minting/open site takes a durability option to contradict it, and an opfs→idbfs capability fallback
 * keeps the declared mode.
 */
export type StorageDurability = "relaxed" | "strict";

/** The {@link StorageDurability} values. Source of truth for {@link SyncStorageDeclaration} validation. */
export const STORAGE_DURABILITIES = ["relaxed", "strict"] as const satisfies readonly StorageDurability[];

/** Type guard: is `value` a {@link StorageDurability}? */
export function isStorageDurability(value: unknown): value is StorageDurability {
  return typeof value === "string" && (STORAGE_DURABILITIES as readonly string[]).includes(value);
}

/**
 * The registry's storage contract (ADR-0049 decision 1, ADR-0047). Storage is PART OF THE DATA CONTRACT:
 * whether losing the last not-yet-flushed action is acceptable, and whether OPFS may be used at all, is
 * decided by what the data IS — so it is declared once on the registry, not at any minting/open site.
 *
 * - {@link StorageDurability durability} defaults to `"relaxed"` and binds every toolkit-minted open of
 *   every store the registry mints (its own boot AND the provision/spare path). No open-site option exists
 *   to contradict it; a capability fallback keeps the declared mode. A no-op on `memory` clones.
 * - {@link StorageBackend backend} defaults to `"opfs"` and scopes the BROWSER store only; Node/`file` and
 *   `memory` clones are unaffected. `"idbfs"` opts the store out of the capability/election machinery.
 */
export interface SyncStorageDeclaration {
  backend?: StorageBackend;
  durability?: StorageDurability;
}

/**
 * A {@link SyncStorageDeclaration} with every field resolved (ADR-0050) — the store's BOUND declaration.
 * Produced once per store by {@link resolveStorageDeclaration} and immutable for the store's lifetime: a
 * preference change mints a fresh store under a fresh path, never rebinds an existing one.
 */
export interface ResolvedStorageDeclaration {
  backend: StorageBackend;
  durability: StorageDurability;
}

/**
 * A storage declaration was refused (ADR-0050): two sources explicitly disagree on a field, or a later
 * declaration explicitly contradicts the store's bound declaration. Never resolved silently — the store's
 * storage contract has exactly one value per field, and a disagreement means one side is wrong. The stable
 * `name` survives bridge serialization (`BridgeErrorWire.name`), so a tab can detect the refusal typed.
 */
export class StorageDeclarationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageDeclarationRefusedError";
  }
}

/** One field's resolution: explicit-vs-explicit disagreement refuses; otherwise the explicit value, else the default. */
function resolveDeclarationField<TValue>(
  field: keyof SyncStorageDeclaration,
  staticValue: TValue | undefined,
  wireValue: TValue | undefined,
  defaultValue: TValue,
): TValue {
  if (staticValue !== undefined && wireValue !== undefined && staticValue !== wireValue) {
    throw new StorageDeclarationRefusedError(
      `storage declaration disagreement on "${field}": the registry-attached declaration says ` +
        `"${String(staticValue)}" but the wire declaration says "${String(wireValue)}" — a store's storage ` +
        `contract has one value per field; fix the declaring side (a preference change mints a fresh store, ` +
        `it never redeclares an existing one)`,
    );
  }
  return staticValue ?? wireValue ?? defaultValue;
}

/**
 * Resolve a store's storage declaration from its two sources (ADR-0050): the registry-attached STATIC
 * declaration (authoritative) and the tab's WIRE declaration (honoured only where the registry is silent).
 * Per field: an unset field is "no opinion" and can never conflict; both explicit and disagreeing is a
 * {@link StorageDeclarationRefusedError}; unresolved fields take the capability defaults
 * (`backend: "opfs"`, `durability: "relaxed"`).
 */
export function resolveStorageDeclaration(
  staticDeclaration: SyncStorageDeclaration | undefined,
  wireDeclaration: SyncStorageDeclaration | undefined,
): ResolvedStorageDeclaration {
  return {
    backend: resolveDeclarationField("backend", staticDeclaration?.backend, wireDeclaration?.backend, "opfs"),
    durability: resolveDeclarationField(
      "durability",
      staticDeclaration?.durability,
      wireDeclaration?.durability,
      "relaxed",
    ),
  };
}

/**
 * Check a LATER declaration against a store's bound resolution (ADR-0050): an unset or equal field is
 * idempotent; an explicit field disagreeing with the bound value is a {@link StorageDeclarationRefusedError}.
 * The bound declaration is immutable — first arrival binds, later arrivals only confirm.
 */
export function assertStorageDeclarationCompatible(
  bound: ResolvedStorageDeclaration,
  incoming: SyncStorageDeclaration | undefined,
): void {
  if (incoming === undefined) return;
  for (const field of ["backend", "durability"] as const) {
    const value = incoming[field];
    if (value !== undefined && value !== bound[field]) {
      throw new StorageDeclarationRefusedError(
        `storage declaration disagreement on "${field}": the store is bound to "${bound[field]}" but a later ` +
          `declaration says "${value}" — a store's declaration is immutable; a preference change mints a ` +
          `fresh store under a fresh path`,
      );
    }
  }
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
  /**
   * INTERNAL / resolved — the physical Postgres table this shape reads, when it differs from the
   * shape's own `tableName`. A read PROJECTION (`defineReadProjection`) sets it to the OWNING table's
   * name so several shapes can read one physical table under distinct `shapeKey`s; the engine resolves
   * an incoming request by `shapeKey` and consults this only on egress, to build the upstream Electric
   * `table` param. `attachSyncRegistrySchema` also fills/qualifies it for schema-bound registries.
   *
   * Not a consumer input — there is no valid reason to hand-set it (it can only be redundant with, or
   * wrong about, the table you are reading), so it is omitted from {@link ShapeSpecInput}. The
   * combinator derives it from the owner; `defineSyncTable` never sets it from input.
   */
  electricTable?: string;
  rowFilter?: RowFilterSpec;
}

/** Input variant of {@link ShapeSpec} where `tableName` and `shapeKey` are optional.
 * When omitted, both default to the top-level `tableName` of the `defineSyncTable` call.
 * `electricTable` is deliberately absent — it is a resolved/internal field, never a consumer input
 * (see {@link ShapeSpec.electricTable}); a read projection over an existing table is authored with
 * `defineReadProjection`, which derives it from the owner. */
export type ShapeSpecInput = Omit<ShapeSpec, "tableName" | "shapeKey" | "electricTable"> & {
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

/**
 * How the applier stamps a server-managed column (it overrides any client-sent value — the client write
 * payload omits managed fields, and the apply function re-derives them under the verified request claims):
 *
 * - `nowMicroseconds` — `clock_timestamp()` microseconds, stamped via the canonical `pgxsinkit_clock_us()`
 *   DB function (installed by the utilities migration). The audit/version columns (`created_at_us`,
 *   `updated_at_us`); the `updated_at_us`-on-update field is the strictly-monotonic Server version (ADR-0010).
 * - `authClaim` — a value read from the **verified JWT claims** at a JSON {@link ManagedFieldSpec.claimPath}
 *   (e.g. `["sub"]` for the auth subject, or `["app_metadata","person_id"]` for an app-minted identity). This
 *   is the single claim-stamping strategy: the old `authUid` is exactly `{ claimPath: ["sub"], cast: "uuid" }`,
 *   so there is one mechanism, not a `sub`-only special case beside a general one.
 */
export type ManagedFieldStrategy = "nowMicroseconds" | "authClaim";

export interface ManagedFieldSpec {
  column: string;
  applyOn: ManagedFieldApplyOn[];
  strategy: ManagedFieldStrategy;
  /**
   * For `strategy: "authClaim"` only (required there, forbidden otherwise): the JSON path into the verified
   * request claims to stamp from — `["sub"]`, `["app_metadata", "person_id"]`, etc. Each segment must be a
   * plain identifier (`[A-Za-z_][A-Za-z0-9_]*`); it is emitted into the apply-function DDL as a `jsonb #>>`
   * text-array path, so it is never a value-injection surface.
   */
  claimPath?: string[];
  /**
   * Optional SQL cast for an `authClaim` value (`jsonb #>>` yields text). Defaults to the **target column's
   * own SQL type** (so a `uuid` column casts to `uuid` with no declaration needed). Override only to force a
   * different cast; must be a plain SQL type name.
   */
  cast?: string;
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
   * Consistency group (ADR-0009 decision 2): tables sharing a group sync on one `MultiShapeStream`
   * and commit atomically at a shared LSN frontier. Absent → the table is its own singleton group.
   */
  consistencyGroup?: string;
  /**
   * Subscription timing (ADR-0021). Absent → `eager`. A `lazy` table is excluded from the boot
   * subscription set and subscribed on first query-reference. See {@link SubscriptionTiming}.
   */
  subscription?: SubscriptionTiming;
  /**
   * Retention (ADR-0021). Absent → `persistent`. An `ephemeral` table's whole local cluster is emitted
   * as `TEMP` — no durable trace. See {@link Retention}.
   */
  retention?: Retention;
  /**
   * Write-mode (ADR-0022). Absent → `optimistic`. A `pessimistic` consistency group is a standing
   * server-authoritative write-unit whose writes flush-route to the authoritative endpoint. See
   * {@link WriteMode}.
   */
  writeMode?: WriteMode;
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
   *
   * **Must be pure.** The proxy already calls this fresh on every shape request; the client also
   * *probes* it with empty claims (`{}`) to detect claims-dependence (ADR-0039 —
   * {@link isClaimsDependentRowFilter}). Do not memoize, mutate external state, or assume it runs once.
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

/**
 * Whether a row filter denies (or cannot serve) an unauthenticated caller — a *claims-dependent*
 * filter (ADR-0039). The client probes this at lazy-group activation: a group whose members probe
 * claims-dependent, activated with no auth token, opens an empty subscription by construction, so
 * the client warns.
 *
 * A filter is claims-dependent when its `customWhere`, evaluated with **empty claims** (`{}` —
 * exactly what the proxy passes for an unauthenticated request) and no params, either **throws** or
 * returns the {@link DENY_ALL} sentinel by **reference identity** (which every contracts helper —
 * {@link buildOwnershipShapeWhere} and friends — returns for a missing subject, and which is already
 * the documented deny-anonymous pattern). Any other result — `null` (no filtering), a string, or a
 * different `SQL` fragment — is not claims-dependent as far as this probe can tell.
 *
 * Requires `customWhere` to be pure (its contract; see {@link RowFilterSpec.customWhere}).
 */
export function isClaimsDependentRowFilter(filter: RowFilterSpec | undefined): boolean {
  if (!filter?.customWhere) {
    return false;
  }

  try {
    return filter.customWhere({}, undefined) === DENY_ALL;
  } catch {
    return true;
  }
}

/**
 * The ownership shape `where` — the read-path mirror of an owner-column RLS policy: rows whose owner
 * column equals the caller's subject, {@link DENY_ALL} for an unauthenticated caller. Takes the real
 * Drizzle owner column (bare via {@link c}, rename-safe); the subject rides as a typed interpolation —
 * a bound param through `buildRowFilterShape`, or a drizzle-escaped literal when a proxy renders it
 * inline for a shape URL.
 */
export function buildOwnershipShapeWhere(ownerColumn: AnyColumn, subject: string | null | undefined): SQL {
  return subject == null || subject === "" ? DENY_ALL : sql`${c(ownerColumn)} = ${subject}`;
}

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
