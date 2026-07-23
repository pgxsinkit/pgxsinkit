import type { ExternalHeadersRecord } from "@electric-sql/client";
import type { PGliteInterface } from "@electric-sql/pglite";

import {
  type Retention,
  type SubscriptionTiming,
  type SyncConfigInput,
  type SyncTableRegistry,
  type TableSpecInput,
} from "@pgxsinkit/contracts";

import type { BootStampCollector, GroupBootStamp } from "./boot-report";
import type { SyncNamespaceObj } from "./sync";
import { createShapeErrorHandler } from "./sync-auth";

export interface ShapeSyncSpec {
  electricUrl: string;
  tableName: string;
  schema?: string;
  shapeKey: string;
  primaryKey: string[];
  electricTable?: string;
  /**
   * Consistency group (ADR-0009 decision 2). Specs sharing a group sync on one `MultiShapeStream`
   * and commit atomically. Absent → the table is its own singleton group keyed by its `shapeKey`.
   */
  consistencyGroup?: string;
  /**
   * Subscription timing (ADR-0021). Absent → `eager`. A `lazy` spec's group is held out of the eager
   * boot set and started on demand via {@link StartConfiguredSyncResult.ensureGroupStarted}. A group's
   * members all agree (registry-validated), so the group's timing is any member's.
   */
  subscription?: SubscriptionTiming;
  /**
   * Retention (ADR-0021). Absent → `persistent`. Only a `persistent` `lazy` group is promoted to the
   * eager set on activation (its activation is permanent across boots); an `ephemeral` group's activation
   * is session-scoped by construction, so it is never promoted/persisted.
   */
  retention?: Retention;
}

export interface ConfiguredShapeSyncSpec extends ShapeSyncSpec {
  key: string;
}

export interface StartConfiguredSyncOptions {
  syncConfig: SyncConfigInput;
  /**
   * The sync registry (ADR-0029 D1): the engine's sole per-table spec source. Each shape's `tableKey`
   * (its `syncConfig` table key) resolves against it for the local table, PKs, apply strategy, and
   * column types — no table-scoped fact is threaded from `syncConfig` into the engine.
   */
  registry: SyncTableRegistry;
  /**
   * Shape request headers shared by every member shape. Values may be async functions resolved per
   * request (ADR-0013) — the read-path `Authorization` token is one such function.
   */
  shapeHeaders?: ExternalHeadersRecord;
  onInitialSync?: () => void;
  onTableInitialSync?: (tableKey: string) => void;
  /**
   * Fresh-store prefetch overlap (ADR-0032 S4). When present, every EAGER group starts its shape streams
   * and buffers their catch-up into the memory inbox immediately, gating all commits until this promise
   * resolves — so the network catch-up overlaps the local boot phases (schema/journal/reconcile) instead
   * of running after them. Set ONLY by `createSyncClient` on a provably-fresh store (its `freshStore`
   * hint); absent → the sequential path. Passed straight through to the engine's `syncShapesToTables`.
   */
  dbReady?: Promise<void>;
  /** Commit-level error surfacing (ADR-0009 decision 5): a sync commit exhausted its retries. */
  onSyncError?: (error: Error) => void;
  /**
   * Notified when a shape hits an auth error (401/403) and the read path is retrying for a fresh
   * token (ADR-0013 Phase 3). The runtime surfaces a distinct `auth-needed` status from this.
   */
  onAuthError?: () => void;
  /**
   * Notified when a shape hits a NON-auth stream error (#4): a transient 5xx/429/network (retried) or
   * a structural 4xx (stops the stream). The runtime surfaces a `degraded` status from this so it
   * never silently believes the read path is live while it has actually stalled.
   */
  onReadStreamError?: (error: Error) => void;
  /**
   * Notified when a shape successfully delivers a batch — i.e. a fetch just succeeded (ADR-0013
   * Phase 3). The runtime uses this to clear an `auth-needed`/`degraded` status once sync resumes.
   */
  onSyncActivity?: () => void;
  /**
   * Consistency-group keys of `lazy` groups that were activated on a previous boot and persisted their
   * activation flag (ADR-0021 §2 — `lazy + persistent` promotion). These join the eager boot set as if
   * they were declared `eager`, so a once-activated durable lazy group resumes without re-evaluation.
   * Computed by the caller from the local meta table (the sync engine does no DB read of its own).
   */
  promotedGroups?: ReadonlySet<string>;
  /**
   * Invoked when a `persistent` `lazy` group is activated on demand (not promoted at boot), so the
   * caller can persist its activation flag for the next boot (ADR-0021 §2). Never fired for an
   * `ephemeral` group (its activation is session-scoped and leaves no durable trace).
   */
  onLazyActivated?: (groupKey: string) => void;
  /**
   * Invoked exactly once per consistency group the moment it becomes up-to-date (ADR-0032 decision 6 —
   * per-group readiness). Fires for eager, promoted, and on-demand `lazy` groups alike, so a client can
   * surface progressive per-group paint (and the worker bridge can fan a `groupReady` event to tabs)
   * without the all-eager-groups `onInitialSync` gate. The matching promise is {@link StartConfiguredSyncResult.groupReady}.
   */
  onGroupReady?: (groupKey: string) => void;
  /**
   * Boot observability (ADR-0034): opens a per-group accumulator (rows/requests/fetch/apply wall) for each
   * EAGER + PROMOTED boot group, stamped by the engine as the group's stream chain delivers and applies. A
   * lazy on-demand start gets none — so a lazily-activated-later group never enters (or mutates) the report.
   * Absent → no boot instrumentation.
   */
  bootCollector?: BootStampCollector;
}

// The engine is reached through the `electric` namespace the client attaches post-create (ADR-0032 S1) —
// a plain property carrying the sync entry points, no longer a create-time PGlite extension.
type SyncEnginePGlite = PGliteInterface & { electric: SyncNamespaceObj };

export interface ShapeSyncResult {
  unsubscribe: () => void;
  readonly isUpToDate: boolean;
}

export interface StartConfiguredSyncResult {
  unsubscribe: () => void;
  tables: Record<string, ShapeSyncResult>;
  /**
   * Start a `lazy` consistency group (ADR-0021) held out of the eager boot set. Idempotent and
   * single-flight: concurrent calls share one start; a started, unknown, or eager group resolves
   * immediately. Resolves once the group's initial sync completes — the seam the live-query layer
   * calls on first reference to a lazy table. After it resolves, the group's member `tables` entries
   * report `isUpToDate` live.
   */
  ensureGroupStarted: (groupKey: string) => Promise<void>;
  /**
   * Stop a group's stream and return it to dormant (ADR-0021 §2): tear down its live subscription and
   * clear the runtime so {@link isTableStarted} reports false again and a later {@link ensureGroupStarted}
   * re-subscribes from scratch — the inverse of an on-demand activation. Used by the client's `desync`
   * to halt a lazy group before truncating its read cache. A no-op for an unknown or never-started group.
   * The temp cluster of an `ephemeral` group is NOT dropped here (that is the deferred idle-eviction); the
   * cluster simply stops being fed.
   */
  stopGroup: (groupKey: string) => void;
  /** The consistency-group key a table belongs to — maps a queried table to its {@link ensureGroupStarted}. */
  groupKeyForTable: (tableKey: string) => string | undefined;
  /**
   * Whether a table's consistency group has started and completed its initial sync, so its reads are
   * hydrated (ADR-0021). False for a `lazy` group still held out of the boot set. Drives the read-path
   * tripwire — a lazy relation read while this is false would return empty/stale rows.
   */
  isTableStarted: (tableKey: string) => boolean;
  /**
   * A promise that resolves the moment the given consistency group is up-to-date (ADR-0032 decision 6).
   * Resolves immediately for an already-ready group; stays pending for a `lazy` group until it is
   * activated (via {@link ensureGroupStarted}) and catches up. An unknown group resolves immediately
   * (nothing to await). Per-group readiness the client re-exposes as `client.groupReady(table)`.
   */
  groupReady: (groupKey: string) => Promise<void>;
  /** Whether the given consistency group has completed its initial sync (synchronous peek at {@link groupReady}). */
  isGroupReady: (groupKey: string) => boolean;
  /** Every consistency-group key this config declares — the domain of {@link groupReady}/{@link isGroupReady}. */
  groupKeys: () => string[];
}

export function buildShapeUrl(electricUrl: string, table: string) {
  const url = new URL(electricUrl);
  url.searchParams.set("table", table);
  return url.toString();
}

export function buildShapeConfig(input: ShapeSyncSpec) {
  return {
    shape: {
      // The ingress `table` param carries the unique `shapeKey` — the proxy resolves the shape by it and
      // maps it to the physical Electric table on egress (so a read projection and its owner, which share
      // a physical table, stay distinguishable). `table` below is the LOCAL PGlite apply target.
      url: buildShapeUrl(input.electricUrl, input.shapeKey),
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

/**
 * One consistency group's runtime: its specs, the subscription timing its members agree on, and its
 * live stream once started (`null` while a `lazy` group is still held). `startPromise` makes start
 * single-flight so concurrent on-demand triggers share one subscription.
 */
interface GroupRuntime {
  groupKey: string;
  specs: ConfiguredShapeSyncSpec[];
  subscription: SubscriptionTiming;
  retention: Retention;
  result: ShapeSyncResult | null;
  startPromise: Promise<void> | null;
}

export async function startConfiguredSync(
  pg: SyncEnginePGlite,
  input: StartConfiguredSyncOptions,
): Promise<StartConfiguredSyncResult> {
  const specs = buildConfiguredShapeSpecs(input.syncConfig);

  // Bucket specs into consistency groups (ADR-0009 decision 2). Each group is one MultiShapeStream
  // committed atomically; an ungrouped table is its own singleton group keyed by its shapeKey. A group
  // carries the subscription timing its members agree on (ADR-0021; registry validation guarantees
  // agreement, so the first member's value is the group's): `eager` groups start at boot, `lazy` groups
  // are held until ensureGroupStarted (the on-demand / live-query interception seam).
  const groups = new Map<string, GroupRuntime>();
  const groupKeyByTable = new Map<string, string>();
  for (const spec of specs) {
    const groupKey = groupSubscriptionKey(spec);
    groupKeyByTable.set(spec.key, groupKey);
    const existing = groups.get(groupKey);
    if (existing) {
      existing.specs.push(spec);
    } else {
      groups.set(groupKey, {
        groupKey,
        specs: [spec],
        subscription: spec.subscription ?? "eager",
        retention: spec.retention ?? "persistent",
        result: null,
        startPromise: null,
      });
    }
  }

  // Per-group readiness (ADR-0032 decision 6): one deferred per group, created up front so a caller can
  // await ANY group — eager or still-dormant lazy — before it has started. Resolved once (idempotent) the
  // moment the group reports up-to-date; a never-activated lazy group's promise simply stays pending.
  interface GroupReadyDeferred {
    promise: Promise<void>;
    resolve: () => void;
    ready: boolean;
  }
  const groupReadyState = new Map<string, GroupReadyDeferred>();
  for (const groupKey of groups.keys()) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    groupReadyState.set(groupKey, { promise, resolve, ready: false });
  }
  const markGroupReady = (groupKey: string) => {
    const state = groupReadyState.get(groupKey);
    if (!state || state.ready) return;
    state.ready = true;
    state.resolve();
    input.onGroupReady?.(groupKey);
  };

  // A `lazy` group activated on a previous boot (ADR-0021 §2 `lazy + persistent` promotion) is treated
  // as eager this boot: its activation is permanent, so it joins the boot set and resumes like any durable
  // table — no per-session re-evaluation, no half-lazy.
  const promotedGroups = input.promotedGroups ?? new Set<string>();
  const isEagerAtBoot = (group: GroupRuntime) => group.subscription !== "lazy" || promotedGroups.has(group.groupKey);

  // Boot readiness (`onInitialSync`) waits only for the boot (eager + promoted) groups to catch up; a lazy
  // group started later via ensureGroupStarted signals its members' `onTableInitialSync` but never the gate.
  const eagerGroups = [...groups.values()].filter(isEagerAtBoot);
  let pendingBootGroups = eagerGroups.length;
  let bootSignalled = false;
  const signalBootIfReady = () => {
    if (!bootSignalled && pendingBootGroups <= 0) {
      bootSignalled = true;
      input.onInitialSync?.();
    }
  };

  // Start one group's stream, single-flight: a started group resolves immediately; an in-flight start
  // is shared. `countsTowardBoot` is true only for the eager boot starts.
  const startGroup = (group: GroupRuntime, countsTowardBoot: boolean): Promise<void> => {
    if (group.result) {
      return Promise.resolve();
    }
    if (group.startPromise) {
      return group.startPromise;
    }
    // Boot observability (ADR-0034): open an accumulator for a BOOT group only (eager + promoted); an
    // on-demand lazy start (`countsTowardBoot === false`) gets none, so it never enters the report.
    const bootStamp: GroupBootStamp | undefined =
      countsTowardBoot && input.bootCollector
        ? input.bootCollector.beginGroup(group.groupKey, group.specs.length)
        : undefined;
    group.startPromise = startGroupSync(pg, {
      groupKey: group.groupKey,
      specs: group.specs,
      registry: input.registry,
      // ADR-0042: an ephemeral group's cursor + tags are session-scoped (stored in `pg_temp`), so a warm
      // engine restart re-streams the shape from scratch rather than resuming a stale durable cursor over
      // the recreated-empty TEMP cluster. The engine learns only this one storage-scope bit.
      ...(group.retention === "ephemeral" ? { sessionScoped: true } : {}),
      ...(bootStamp ? { bootStamp } : {}),
      // The prefetch overlap (ADR-0032 S4) applies ONLY to the eager BOOT starts: a fresh store's eager
      // groups are genuinely new, so buffering their catch-up behind the commit gate is safe. An on-demand
      // `lazy` start happens post-boot on an already-provisioned store (which may even be RESUMING persisted
      // subscription state), so it must take the exact sequential path — never the fresh-store overlap.
      ...(countsTowardBoot && input.dbReady ? { dbReady: input.dbReady } : {}),
      ...(input.shapeHeaders ? { headers: input.shapeHeaders } : {}),
      ...(input.onSyncError ? { onSyncError: input.onSyncError } : {}),
      ...(input.onAuthError ? { onAuthError: input.onAuthError } : {}),
      ...(input.onReadStreamError ? { onReadStreamError: input.onReadStreamError } : {}),
      ...(input.onSyncActivity ? { onSyncActivity: input.onSyncActivity } : {}),
      onGroupInitialSync: () => {
        // The group is up-to-date as a unit; signal each member table, mark the group ready (per-group
        // readiness, ADR-0032 decision 6), then (for an eager group only) advance the boot gate once
        // every eager group is caught up.
        for (const spec of group.specs) {
          input.onTableInitialSync?.(spec.key);
        }
        // Boot observability (ADR-0034): stamp readyAtMs and freeze the accumulator at the group's ready edge,
        // so later live traffic never mutates a finalized report.
        bootStamp?.markReady();
        markGroupReady(group.groupKey);
        if (countsTowardBoot) {
          pendingBootGroups -= 1;
          signalBootIfReady();
        }
      },
    }).then((result) => {
      group.result = result;
      // A `persistent` `lazy` group activated on demand (not a boot start) persists its activation, so the
      // next boot promotes it to eager (ADR-0021 §2). `ephemeral` activation is session-scoped — never persisted.
      if (!countsTowardBoot && group.subscription === "lazy" && group.retention === "persistent") {
        input.onLazyActivated?.(group.groupKey);
      }
    });
    return group.startPromise;
  };

  // Each member table exposes a per-table view backed by its group's runtime: up-to-date exactly when
  // the group is (false until a lazy group is started), and unsubscribing it tears down the group.
  const tables: Record<string, ShapeSyncResult> = {};
  for (const [tableKey, groupKey] of groupKeyByTable) {
    const group = groups.get(groupKey)!;
    tables[tableKey] = {
      unsubscribe: () => group.result?.unsubscribe(),
      get isUpToDate() {
        return group.result?.isUpToDate ?? false;
      },
    };
  }

  // Start the eager groups at boot; lazy groups wait for ensureGroupStarted. `signalBootIfReady` after
  // the await covers a config with no eager groups (boot is trivially complete).
  await Promise.all(eagerGroups.map((group) => startGroup(group, true)));
  signalBootIfReady();

  return {
    unsubscribe: () => {
      // Unsubscribe per group (not per table) so a multi-table group's stream is torn down once.
      for (const group of groups.values()) {
        group.result?.unsubscribe();
      }
    },
    tables,
    ensureGroupStarted: (groupKey) => {
      const group = groups.get(groupKey);
      return group ? startGroup(group, false) : Promise.resolve();
    },
    stopGroup: (groupKey) => {
      const group = groups.get(groupKey);
      if (!group) return;
      // Tear down the live stream and clear the runtime so the group is dormant again: `isTableStarted`
      // reports false and `ensureGroupStarted` re-runs `startGroupSync` (its `group.result`/`startPromise`
      // short-circuits no longer apply) on the next reference.
      group.result?.unsubscribe();
      group.result = null;
      group.startPromise = null;
      // Return the group's readiness to pending: a stopped group is dormant again, so `groupReady` for a
      // later re-activation must re-await its fresh catch-up rather than resolve on the stale deferred.
      if (groupReadyState.get(groupKey)?.ready) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        groupReadyState.set(groupKey, { promise, resolve, ready: false });
      }
    },
    groupKeyForTable: (tableKey) => groupKeyByTable.get(tableKey),
    isTableStarted: (tableKey) => {
      const groupKey = groupKeyByTable.get(tableKey);
      if (groupKey == null) return false;
      return groups.get(groupKey)?.result != null;
    },
    // An unknown group key has nothing to await, so its readiness resolves immediately (never blocks).
    groupReady: (groupKey) => groupReadyState.get(groupKey)?.promise ?? Promise.resolve(),
    isGroupReady: (groupKey) => groupReadyState.get(groupKey)?.ready ?? true,
    groupKeys: () => [...groups.keys()],
  };
}

interface StartGroupSyncOptions {
  groupKey: string;
  specs: ConfiguredShapeSyncSpec[];
  registry: SyncTableRegistry;
  /**
   * ADR-0042: the group's retention is `ephemeral`, so its sync bookkeeping (cursor + tags) is session-
   * scoped — the engine stores it in `pg_temp` relations that die with the engine. Forwarded straight to
   * the engine's `syncShapesToTables`; absent/`false` for a persistent group (byte-identical storage).
   */
  sessionScoped?: boolean;
  headers?: ExternalHeadersRecord;
  /** Fresh-store prefetch overlap gate (ADR-0032 S4) — forwarded to the engine's `syncShapesToTables`. */
  dbReady?: Promise<void>;
  /** Boot observability (ADR-0034): the group's accumulator, stamped by the engine on delivery/apply. */
  bootStamp?: GroupBootStamp;
  onGroupInitialSync?: () => void;
  onSyncError?: (error: Error) => void;
  onAuthError?: () => void;
  onReadStreamError?: (error: Error) => void;
  onSyncActivity?: () => void;
}

/**
 * Sync one consistency group on a single `MultiShapeStream` (ADR-0009 decision 2). All member
 * shapes share the group's subscription key and commit atomically at a shared LSN frontier; each
 * shape keeps its own apply strategy and column types (resolved per-shape inside the engine).
 */
export async function startGroupSync(pg: SyncEnginePGlite, input: StartGroupSyncOptions) {
  const shapeHeaders = input.headers && Object.keys(input.headers).length > 0 ? input.headers : undefined;

  // The per-shape onError owns read-path auth recovery (ADR-0013 Phase 2: a 401/403 retries with a
  // fresh token) AND read-stream error surfacing (#4: a non-auth error moves the runtime to
  // `degraded`, retrying transient 5xx/429/network and stopping a structural 4xx).
  const onError = createShapeErrorHandler({
    ...(input.onAuthError ? { onAuthError: input.onAuthError } : {}),
    ...(input.onReadStreamError ? { onReadStreamError: input.onReadStreamError } : {}),
  });

  const shapes = Object.fromEntries(
    input.specs.map((spec) => [
      spec.key,
      {
        shape: {
          // Ingress `table` = the unique `shapeKey` (proxy maps it to the physical table on egress).
          url: buildShapeUrl(spec.electricUrl, spec.shapeKey),
          ...(shapeHeaders ? { headers: shapeHeaders } : {}),
          onError,
        },
        // ADR-0029 D1: the registry table key is the engine's sole per-table spec — the local apply
        // target, PKs, strategy, and column types all derive from `(registry, tableKey)`. The
        // `syncConfig` table key IS the registry key, so the spec's `key` is the `tableKey`.
        tableKey: spec.key,
      },
    ]),
  );

  return getElectricNamespace(pg).syncShapesToTables({
    key: input.groupKey,
    registry: input.registry,
    shapes,
    ...(input.sessionScoped ? { sessionScoped: input.sessionScoped } : {}),
    ...(input.dbReady ? { dbReady: input.dbReady } : {}),
    ...(input.bootStamp ? { bootStamp: input.bootStamp } : {}),
    ...(input.onGroupInitialSync ? { onInitialSync: input.onGroupInitialSync } : {}),
    ...(input.onSyncError ? { onSyncError: input.onSyncError } : {}),
    ...(input.onSyncActivity ? { onSyncActivity: input.onSyncActivity } : {}),
  });
}

function getElectricNamespace(pg: SyncEnginePGlite) {
  return pg.electric;
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
    // ADR-0021 §3: an ephemeral table's cluster is `TEMP` (bare names in `pg_temp`), so the row-applier
    // must target the unqualified name (resolved via search_path) — omit the schema for it.
    ...(localSchema && table.retention !== "ephemeral" ? { schema: localSchema } : {}),
    shapeKey: table.shape.shapeKey,
    primaryKey: [...(table.clientProjection?.localPrimaryKey?.columns ?? table.primaryKey.columns)],
    electricTable: table.shape.electricTable ?? table.shape.tableName,
    ...(table.consistencyGroup ? { consistencyGroup: table.consistencyGroup } : {}),
    ...(table.subscription ? { subscription: table.subscription } : {}),
    ...(table.retention ? { retention: table.retention } : {}),
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
