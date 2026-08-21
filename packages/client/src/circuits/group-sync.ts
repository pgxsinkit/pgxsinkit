import type { PGliteInterface } from "@electric-sql/pglite";
import { and, eq, getTableName, isNull, type SQL } from "drizzle-orm";

import type { PredicateValue, SyncTableEntry, SyncTableRegistry } from "@pgxsinkit/contracts";

import { resolveApplyTarget, type ApplyTarget } from "../local-tables";
import type { drizzleOverPg } from "../sync/drizzle-executor";
import {
  openSubscriptionSession,
  type GrantedStream,
  type RefusedStream,
  type SubscriptionSession,
} from "./subscription-client";
import { createBarrierReader } from "./subscription-client";
import {
  syncCircuitsShapes,
  type CircuitsShapeSpec,
  type CircuitsSyncHandle,
  type ConvergenceBarrier,
} from "./sync-engine";

/**
 * Native consistency-group orchestration (ADR-0009 decision 2 on ADR-0055's substrate).
 *
 * `syncCircuitsShapes` syncs ONE consistency group: K streams committed atomically. This is the
 * layer above it — deriving groups from the registry, subscribing each to the control plane, and
 * carrying ADR-0021's eager/lazy lifecycle. It is the native counterpart of `startConfiguredSync`,
 * and deliberately a separate module rather than a branch inside it: the Electric one builds shape
 * URLs from a base and this one is TOLD its URLs, which is the whole inversion ADR-0055 decision 10
 * describes, and nothing useful is shared between the two paths above the apply layer.
 */

/** One synced table, resolved from the registry — the native spec, with no URL in it. */
interface NativeSpec {
  /** The registry key, which is also `syncCircuitsShapes`'s `tableKey`. */
  key: string;
  shapeKey: string;
  /** Shared tier only: the scope columns, whose values a grant supplies. */
  scopeColumns?: readonly string[];
  consistencyGroup?: string;
  subscription: "eager" | "lazy";
  retention: "persistent" | "ephemeral";
}

/** One group's runtime. `session`/`handle` are null while a lazy group is still held. */
interface GroupRuntime {
  groupKey: string;
  specs: NativeSpec[];
  subscription: "eager" | "lazy";
  retention: "persistent" | "ephemeral";
  session: SubscriptionSession | null;
  handle: CircuitsSyncHandle | null;
  /** Single-flight start, so concurrent on-demand triggers share one subscription. */
  startPromise: Promise<void> | null;
  ready: boolean;
  resolveReady: (() => void) | null;
  readyPromise: Promise<void>;
  refused: RefusedStream[];
}

export interface CircuitsGroupSyncOptions {
  registry: SyncTableRegistry;
  /** Base URL of the control plane — where subscribe, re-mint and the barrier live. */
  controlPlaneUrl: string;
  /** Base URL the edge serves streams from. */
  streamBaseUrl: string;
  /** The caller's own auth headers, resolved per request — the same adapter the write path uses. */
  authHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  metadataSchema: string;
  /**
   * Lazy groups whose activation persisted from a previous boot (ADR-0021), started eagerly here.
   */
  promotedGroups?: ReadonlySet<string>;
  /** Fired the first time every eager/promoted group has caught up. */
  onInitialSync?: () => void;
  onGroupReady?: (groupKey: string) => void;
  onSyncError?: (error: Error) => void;
  onSyncActivity?: () => void;
  /** Called when a durable lazy group is activated on demand, so the next boot can promote it. */
  onLazyActivated?: (groupKey: string) => void;
  /** Called with the scopes the control plane refused or later revoked. */
  onRefused?: (refused: readonly RefusedStream[]) => void;
  live?: boolean;
  fetch?: typeof fetch;
}

export interface CircuitsTableSyncResult {
  readonly isUpToDate: boolean;
}

export interface CircuitsGroupSyncResult {
  unsubscribe: () => void;
  tables: Record<string, CircuitsTableSyncResult>;
  /** Start a held lazy group. Idempotent and single-flight; resolves once it has caught up. */
  ensureGroupStarted: (groupKey: string) => Promise<void>;
  /** Tear a group's streams down and return it to dormant, so a later start re-subscribes. */
  stopGroup: (groupKey: string) => void;
  groupKeyForTable: (tableKey: string) => string | undefined;
  isTableStarted: (tableKey: string) => boolean;
  groupReady: (groupKey: string) => Promise<void>;
  isGroupReady: (groupKey: string) => boolean;
  groupKeys: () => string[];
}

/**
 * The scope columns a shape keys on, or undefined for the private tier.
 *
 * Read straight off the registry rather than inferred from a grant: a grant carries VALUES, and
 * which columns they belong to is the shape's declaration. Pairing them positionally is only sound
 * because both come from the same `shape.scope` ordering — the control plane compiles its predicate
 * from it too, so a mismatch here would be a mismatch there.
 */
function scopeColumnsOf(entry: SyncTableEntry): readonly string[] | undefined {
  const scope = entry.shape?.scope;
  return scope != null && scope.length > 0 ? scope : undefined;
}

function deriveSpecs(registry: SyncTableRegistry): NativeSpec[] {
  const specs: NativeSpec[] = [];
  for (const [key, entry] of Object.entries(registry)) {
    if (entry == null || entry.mode === "writeonly") continue;
    const shape = entry.shape;
    if (shape === undefined) continue;
    const scopeColumns = scopeColumnsOf(entry);
    specs.push({
      key,
      shapeKey: shape.shapeKey,
      ...(scopeColumns ? { scopeColumns } : {}),
      ...(entry.consistencyGroup ? { consistencyGroup: entry.consistencyGroup } : {}),
      subscription: entry.subscription === "lazy" ? "lazy" : "eager",
      retention: entry.retention === "ephemeral" ? "ephemeral" : "persistent",
    });
  }
  return specs;
}

/** The group key a spec belongs to: its explicit group, else its own shapeKey (a singleton). */
function groupKeyOf(spec: NativeSpec): string {
  return spec.consistencyGroup ?? spec.shapeKey;
}

/**
 * The scoped cache clear for one granted stream — what a must-refetch runs INSTEAD of truncating.
 *
 * Required, not optional, and the shared tier is why: expansion puts every scope of a shape on its
 * own stream but into ONE local table, so the default `TRUNCATE` would take a co-tenant scope's rows
 * with it. The clear is derived rather than authored — the scope columns come from the registry and
 * the values from the grant, which is the same pairing the control plane compiled its predicate
 * from.
 *
 * Tier ① throughout: real column objects and `eq`/`isNull`, never a spliced identifier. `NULL` needs
 * `isNull` rather than `eq(col, null)` for the same reason the compiler's `scopePredicate` does —
 * `col = NULL` is UNKNOWN for every row, so an `eq` here would clear nothing and silently leave the
 * old scope's rows behind.
 */
function scopedClear(
  target: ApplyTarget,
  scopeColumns: readonly string[],
  scope: readonly PredicateValue[],
): (db: ReturnType<typeof drizzleOverPg>) => Promise<void> {
  const conditions: SQL[] = [];
  for (const [index, name] of scopeColumns.entries()) {
    const column = target.columnByName[name];
    if (column === undefined) {
      throw new Error(
        `[pgxsinkit] shape scope column "${name}" is not a column of local table ` +
          `"${getTableName(target.table)}" — the registry's scope declaration and its local projection ` +
          `have diverged.`,
      );
    }
    const value = scope[index];
    conditions.push(value === null || value === undefined ? isNull(column) : eq(column, value));
  }

  return async (db) => {
    await db.delete(target.table).where(conditions.length === 1 ? conditions[0]! : and(...conditions));
  };
}

/**
 * Turn one group's grants into the shape map `syncCircuitsShapes` takes.
 *
 * Keyed by stream path, not by shape key. A shared shape fans out to one grant per entitled scope
 * (ADR-0055 decision 6), so shape keys are NOT unique within a group — keying by them would silently
 * drop every scope but the last.
 */
function shapesFromGrants(
  registry: SyncTableRegistry,
  specsByShapeKey: Map<string, NativeSpec>,
  granted: readonly GrantedStream[],
): Record<string, CircuitsShapeSpec> {
  const shapes: Record<string, CircuitsShapeSpec> = {};
  for (const grant of granted) {
    const spec = specsByShapeKey.get(grant.shapeKey);
    if (spec === undefined) continue;
    const target = resolveApplyTarget(registry, spec.key);
    shapes[grant.streamPath] = {
      streamUrl: grant.streamUrl,
      tableKey: spec.key,
      ...(spec.scopeColumns && grant.scope
        ? { onMustRefetch: scopedClear(target, spec.scopeColumns, grant.scope) }
        : {}),
    };
  }
  return shapes;
}

/**
 * Read the convergence barrier once per in-flight window, however many groups ask.
 *
 * The barrier is engine-global (ADR-0056 decision 3), so K groups aligning at boot would otherwise
 * make K identical round trips within milliseconds of each other. Only the IN-FLIGHT read is shared
 * — nothing is cached past it — so this dedups a stampede without introducing any staleness the
 * control plane's own cache does not already account for.
 */
function shareBarrierReads(read: () => Promise<ConvergenceBarrier>): () => Promise<ConvergenceBarrier> {
  let inFlight: Promise<ConvergenceBarrier> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = read().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

export async function startCircuitsSync(
  pg: PGliteInterface,
  options: CircuitsGroupSyncOptions,
): Promise<CircuitsGroupSyncResult> {
  const specs = deriveSpecs(options.registry);
  const promoted = options.promotedGroups ?? new Set<string>();

  const groups = new Map<string, GroupRuntime>();
  const groupKeyByTable = new Map<string, string>();
  for (const spec of specs) {
    const groupKey = groupKeyOf(spec);
    groupKeyByTable.set(spec.key, groupKey);
    const existing = groups.get(groupKey);
    if (existing) {
      existing.specs.push(spec);
      continue;
    }
    let resolveReady: (() => void) | null = null;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    groups.set(groupKey, {
      groupKey,
      specs: [spec],
      // Members of a group agree on timing and retention (registry-validated), so the first
      // member's value is the group's.
      subscription: spec.subscription,
      retention: spec.retention,
      session: null,
      handle: null,
      startPromise: null,
      ready: false,
      resolveReady,
      readyPromise,
      refused: [],
    });
  }

  const readBarrier = shareBarrierReads(
    createBarrierReader({
      controlPlaneUrl: options.controlPlaneUrl,
      ...(options.authHeaders ? { authHeaders: options.authHeaders } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  );

  let torn = false;
  let initialSyncSignalled = false;

  const eagerKeys = [...groups.values()]
    .filter((group) => group.subscription === "eager" || promoted.has(group.groupKey))
    .map((group) => group.groupKey);

  function signalInitialSyncIfReady(): void {
    if (initialSyncSignalled || torn) return;
    if (!eagerKeys.every((key) => groups.get(key)?.ready === true)) return;
    initialSyncSignalled = true;
    options.onInitialSync?.();
  }

  function markReady(group: GroupRuntime): void {
    if (group.ready) return;
    group.ready = true;
    group.resolveReady?.();
    options.onGroupReady?.(group.groupKey);
    signalInitialSyncIfReady();
  }

  /**
   * Subscribe one group and start syncing it.
   *
   * One session PER GROUP rather than one for the whole client. ADR-0055 decision 6's batching
   * property is about SCOPES — "a subject with K scopes refreshes in one request per window" — and
   * expansion keeps every scope of a shape inside the one group that declared it, so that property
   * is preserved here. What one-per-group buys is that a group's lifecycle and its session's are
   * the same object: activation opens one, `stopGroup` closes one, and no group can hold a grant
   * alive for a group that has stopped.
   */
  async function startGroup(group: GroupRuntime): Promise<void> {
    const specsByShapeKey = new Map(group.specs.map((spec) => [spec.shapeKey, spec]));

    const session = await openSubscriptionSession(
      {
        controlPlaneUrl: options.controlPlaneUrl,
        streamBaseUrl: options.streamBaseUrl,
        ...(options.authHeaders ? { authHeaders: options.authHeaders } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        onRevoked: (revoked) => {
          group.refused.push(...revoked);
          options.onRefused?.(revoked);
        },
      },
      group.specs.map((spec) => ({ shapeKey: spec.shapeKey })),
    );
    if (torn) {
      session.close();
      return;
    }

    group.session = session;
    group.refused.push(...session.refused);
    if (session.refused.length > 0) options.onRefused?.(session.refused);

    const shapes = shapesFromGrants(options.registry, specsByShapeKey, session.granted);
    if (Object.keys(shapes).length === 0) {
      // Nothing was granted. The group is "ready" in the only sense available to it — there is
      // nothing to wait for — and saying so is what stops a boot hanging on an entitlement the
      // subject simply does not hold.
      markReady(group);
      return;
    }

    group.handle = await syncCircuitsShapes({
      pg,
      registry: options.registry,
      key: group.groupKey,
      metadataSchema: options.metadataSchema,
      sessionScoped: group.retention === "ephemeral",
      shapes,
      token: () => session.token(),
      onTokenRejected: async () => session.refresh(),
      readBarrier,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.live !== undefined ? { live: options.live } : {}),
      ...(options.onSyncError ? { onSyncError: options.onSyncError } : {}),
      ...(options.onSyncActivity ? { onSyncActivity: options.onSyncActivity } : {}),
      onInitialSync: () => markReady(group),
    });

    if (torn) {
      group.handle.unsubscribe();
      session.close();
    }
  }

  async function ensureGroupStarted(groupKey: string): Promise<void> {
    const group = groups.get(groupKey);
    if (group === undefined) return;
    if (group.startPromise) return group.startPromise;

    const wasHeld = group.subscription === "lazy" && !promoted.has(groupKey);
    group.startPromise = startGroup(group).catch((error: unknown) => {
      // A failed start must not be remembered as started: clearing the latch lets a later reference
      // try again rather than resolving instantly against a group that never subscribed.
      group.startPromise = null;
      throw error;
    });
    await group.startPromise;
    if (wasHeld && group.retention === "persistent") options.onLazyActivated?.(groupKey);
    await group.readyPromise;
  }

  function stopGroup(groupKey: string): void {
    const group = groups.get(groupKey);
    if (group === undefined) return;
    group.handle?.unsubscribe();
    group.session?.close();
    group.handle = null;
    group.session = null;
    group.startPromise = null;
    group.ready = false;
    group.refused = [];
    // A stopped group must be able to become pending again, or a later activation would resolve its
    // readiness instantly against the previous run's settled promise.
    group.readyPromise = new Promise<void>((resolve) => {
      group.resolveReady = resolve;
    });
  }

  // Boot: every eager group, plus any lazy group a previous boot promoted. Started concurrently —
  // they are independent consistency groups, and serializing them would make boot the sum of their
  // catch-ups rather than the slowest.
  await Promise.all(eagerKeys.map((groupKey) => ensureGroupStarted(groupKey)));

  const tables: Record<string, CircuitsTableSyncResult> = {};
  for (const spec of specs) {
    const groupKey = groupKeyOf(spec);
    Object.defineProperty(tables, spec.key, {
      enumerable: true,
      get: () => ({ isUpToDate: groups.get(groupKey)?.handle?.isUpToDate === true }),
    });
  }

  return {
    unsubscribe: () => {
      torn = true;
      for (const group of groups.values()) {
        group.handle?.unsubscribe();
        group.session?.close();
      }
    },
    tables,
    ensureGroupStarted,
    stopGroup,
    groupKeyForTable: (tableKey) => groupKeyByTable.get(tableKey),
    isTableStarted: (tableKey) => {
      const groupKey = groupKeyByTable.get(tableKey);
      return groupKey !== undefined && groups.get(groupKey)?.ready === true;
    },
    groupReady: async (groupKey) => {
      await (groups.get(groupKey)?.readyPromise ?? Promise.resolve());
    },
    isGroupReady: (groupKey) => groups.get(groupKey)?.ready === true,
    groupKeys: () => [...groups.keys()],
  };
}
