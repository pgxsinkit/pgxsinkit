import type { PGliteInterface } from "@electric-sql/pglite";
import { and, eq, getTableName, isNull, type SQL } from "drizzle-orm";

import type { PredicateValue, SyncTableEntry, SyncTableRegistry } from "@pgxsinkit/contracts";

import type { BootStampCollector, GroupBootStamp } from "../boot-report";
import { resolveApplyTarget, type ApplyTarget } from "../local-tables";
import type { drizzleOverPg } from "../sync/drizzle-executor";
import {
  ControlPlaneError,
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
 * carrying ADR-0021's eager/lazy lifecycle. It succeeded the removed `startConfiguredSync` as its own
 * module rather than a branch inside it: that one BUILT shape URLs from a base, and this one is TOLD
 * its URLs by the control plane, which is the whole inversion ADR-0055 decision 10 describes — nothing
 * useful was shared between the two paths above the apply layer.
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
  /**
   * Boot observability (ADR-0034). Only the BOOT starts (eager + promoted) open an accumulator, so an
   * on-demand lazy activation never enters a finalized report.
   */
  bootCollector?: BootStampCollector;
  /** Fired the first time every eager/promoted group has caught up. */
  onInitialSync?: () => void;
  onGroupReady?: (groupKey: string) => void;
  onSyncError?: (error: Error) => void;
  onSyncActivity?: () => void;
  /** Called when a durable lazy group is activated on demand, so the next boot can promote it. */
  onLazyActivated?: (groupKey: string) => void;
  /** Called with the scopes the control plane refused or later revoked. */
  onRefused?: (refused: readonly RefusedStream[]) => void;
  /**
   * The subject's own credential was refused by the control plane (401/403), and subscribe is still
   * retrying (ADR-0013). The app prompts for re-login; nothing here needs restarting, because the
   * auth adapter is consulted fresh on every attempt.
   *
   * Distinct from `onSyncError`, which reports a fault the subject cannot act on.
   */
  onAuthError?: (error: ControlPlaneError) => void;
  /**
   * Subscribe failed for a reason the subject cannot act on — the control plane is down, degraded,
   * or unreachable — and is still retrying.
   *
   * Separate from `onSyncError` because the two recover differently: a failed subscribe clears the
   * moment a batch is delivered, while a commit failure is sticky by design (ADR-0009 decision 5) —
   * reads can keep succeeding while applies keep failing.
   */
  onSubscribeError?: (error: Error) => void;
  live?: boolean;
  /**
   * Tears the whole read path down from OUTSIDE, including mid-boot.
   *
   * `unsubscribe()` cannot cover that window: it lives on the handle this function returns, and a boot
   * whose control plane is unreachable has not returned one yet. A client stopped in that window would
   * otherwise sit on a TCP connect with nothing able to cancel it — which is precisely when a stop is
   * most likely, because the network being down is why the boot is still running.
   */
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export interface CircuitsTableSyncResult {
  readonly isUpToDate: boolean;
}

export interface CircuitsGroupSyncResult {
  unsubscribe: () => void;
  tables: Record<string, CircuitsTableSyncResult>;
  /**
   * Start a held lazy group. Idempotent and single-flight; resolves once it has caught up — EXCEPT
   * for an already-promoted group, which resolves at once because it is durable and boot-started
   * (ADR-0021 §2), so its catch-up must not gate a read.
   */
  ensureGroupStarted: (groupKey: string) => Promise<void>;
  /**
   * Tear a group's streams down and return it to dormant, so a later start re-subscribes. Also drops
   * the group's promotion for this session — a desync truncates the local copy, so the group is held
   * again and re-activates (and re-persists its flag) on its next reference.
   */
  stopGroup: (groupKey: string) => void;
  groupKeyForTable: (tableKey: string) => string | undefined;
  /**
   * Whether the table's group is STARTED — a durable subscription for it exists, so reads of it are
   * meaningful. NOT the same question as caught up, which is {@link CircuitsGroupSyncResult.isGroupReady}:
   * a promoted group is started from boot even while its first subscribe is still retrying.
   */
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

/**
 * Exponential backoff for a failing subscribe, capped so a long outage still retries promptly once
 * it clears. The first retry is immediate-ish, because the overwhelmingly common case is a token
 * that a refresh already fixed by the time we ask again.
 */
function subscribeBackoffMs(attempt: number): number {
  return Math.min(SUBSCRIBE_RETRY_BASE_MS * 2 ** attempt, SUBSCRIBE_RETRY_MAX_MS);
}

const SUBSCRIBE_RETRY_BASE_MS = 250;
const SUBSCRIBE_RETRY_MAX_MS = 10_000;

export async function startCircuitsSync(
  pg: PGliteInterface,
  options: CircuitsGroupSyncOptions,
): Promise<CircuitsGroupSyncResult> {
  const specs = deriveSpecs(options.registry);
  // A LOCAL, MUTABLE copy: promotion is durable state the caller persisted, but this runtime can drop
  // a group out of it — `stopGroup` returns a promoted group to held for the rest of this session.
  const promoted = new Set(options.promotedGroups ?? []);

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

  /**
   * Aborts in-flight control-plane requests on teardown — the other half of the same problem the
   * `teardown` promise solves. A subscribe sitting on a TCP connect to an unreachable host can take
   * minutes to fail on its own, and `stop()` waits for the boot tail.
   */
  const controlPlaneRequests = new AbortController();

  const readBarrier = shareBarrierReads(
    createBarrierReader({
      controlPlaneUrl: options.controlPlaneUrl,
      ...(options.authHeaders ? { authHeaders: options.authHeaders } : {}),
      signal: controlPlaneRequests.signal,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  );

  let torn = false;
  let initialSyncSignalled = false;

  /**
   * Resolved by `unsubscribe`, so a retry parked on its backoff wakes immediately on teardown.
   *
   * Not a nicety: `stop()` awaits the boot tail, and the tail awaits these starts, so a sleep that
   * only checks `torn` on the far side would hold a teardown open for a whole backoff window — up to
   * ten seconds per group, on every stop of an offline client.
   */
  let signalTorn!: () => void;
  const teardown = new Promise<void>((resolve) => {
    signalTorn = resolve;
  });

  // The BOOT set, snapshotted here: every eager group plus every group a previous boot promoted. A
  // later `stopGroup` un-promotes its group in `promoted` but must not rewrite what boot started, so
  // this stays a plain array captured before the boot loop — it also fixes what initial-sync waits on.
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
   * Subscribe one group, retrying until it succeeds or the runtime is torn down.
   *
   * Retrying rather than failing is ADR-0013's requirement carried onto the native path: a client
   * whose JWT expired between boots must surface `auth-needed` and resume the moment a fresh one
   * works, with no restart. Failing the start instead would leave the app holding a client that
   * never syncs again, which is the exact wedge that ADR predates.
   *
   * The same loop covers an outage. A 503 from the control plane and a dead socket are both "not
   * now, try again"; only the STATUS differs, and only because a stale credential is the one failure
   * the subject can personally fix.
   */
  async function subscribeWithRetry(
    group: GroupRuntime,
    onFirstAttempt?: () => void,
  ): Promise<SubscriptionSession | null> {
    let reportedFirstAttempt = false;
    const reportAttempt = () => {
      if (reportedFirstAttempt) return;
      reportedFirstAttempt = true;
      onFirstAttempt?.();
    };

    for (let attempt = 0; !torn; attempt += 1) {
      try {
        const session = await openSubscriptionSession(
          {
            controlPlaneUrl: options.controlPlaneUrl,
            streamBaseUrl: options.streamBaseUrl,
            ...(options.authHeaders ? { authHeaders: options.authHeaders } : {}),
            signal: controlPlaneRequests.signal,
            ...(options.fetch ? { fetch: options.fetch } : {}),
            onRevoked: (revoked) => {
              group.refused.push(...revoked);
              options.onRefused?.(revoked);
            },
          },
          group.specs.map((spec) => ({ shapeKey: spec.shapeKey })),
        );
        if (torn) {
          reportAttempt();
          session.close();
          return null;
        }
        // Deliberately no `reportAttempt()` here. A subscribe that SUCCEEDED holds the boot for the
        // rest of the start, so a boot that reached the control plane still comes back with its
        // groups streaming — the release below is only for the case where it could not.
        return session;
      } catch (error) {
        if (torn) {
          reportAttempt();
          return null;
        }
        if (error instanceof ControlPlaneError && error.isAuthFailure) {
          options.onAuthError?.(error);
        } else {
          options.onSubscribeError?.(error instanceof Error ? error : new Error(String(error)));
        }
        // The first failure releases the boot: it keeps retrying in the background, but an offline
        // client must still reach `localReadReady` rather than waiting on a control plane that may
        // be down for hours.
        reportAttempt();
        await sleepUntil(subscribeBackoffMs(attempt));
      }
    }
    reportAttempt();
    return null;
  }

  /** Sleep, but wake at once on teardown — and leave no timer behind either way. */
  function sleepUntil(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      void teardown.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
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
  async function startGroup(
    group: GroupRuntime,
    onFirstAttempt?: () => void,
    bootStamp?: GroupBootStamp,
  ): Promise<void> {
    const specsByShapeKey = new Map(group.specs.map((spec) => [spec.shapeKey, spec]));

    const session = await subscribeWithRetry(group, onFirstAttempt);
    if (session === null) return;

    group.session = session;
    group.refused.push(...session.refused);
    if (session.refused.length > 0) options.onRefused?.(session.refused);

    const shapes = shapesFromGrants(options.registry, specsByShapeKey, session.granted);
    if (Object.keys(shapes).length === 0) {
      // Nothing was granted. The group is "ready" in the only sense available to it — there is
      // nothing to wait for — and saying so is what stops a boot hanging on an entitlement the
      // subject simply does not hold.
      bootStamp?.markReady();
      markReady(group);
      return;
    }

    group.handle = await syncCircuitsShapes({
      pg,
      registry: options.registry,
      key: group.groupKey,
      metadataSchema: options.metadataSchema,
      sessionScoped: group.retention === "ephemeral",
      ...(bootStamp ? { bootStamp } : {}),
      shapes,
      token: () => session.token(),
      onTokenRejected: async () => session.refresh(),
      readBarrier,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.live !== undefined ? { live: options.live } : {}),
      ...(options.onSyncError ? { onSyncError: options.onSyncError } : {}),
      ...(options.onSyncActivity ? { onSyncActivity: options.onSyncActivity } : {}),
      onInitialSync: () => {
        // Stamp readyAtMs and freeze the accumulator at the group's ready edge, so later live traffic
        // never mutates a finalized report.
        bootStamp?.markReady();
        markReady(group);
      },
    });

    if (torn) {
      group.handle.unsubscribe();
      session.close();
    }
  }

  async function ensureGroupStarted(groupKey: string): Promise<void> {
    const group = groups.get(groupKey);
    if (group === undefined) return;

    /**
     * A PROMOTED group is already durable and already boot-started, so a reference to it must not
     * wait for anything.
     *
     * ADR-0021 §2: activation is permanent — a `lazy + persistent` group that was activated once
     * "joins the normal eager-persistent set", and subsequent boots subscribe it eagerly and resume
     * it like any other durable table. Boot did exactly that (`startGroupForBoot`), but that start
     * only resolves once a subscribe SUCCEEDS. Awaiting it here would make a read of a promoted
     * relation block on the network — and an offline reopen, the very state promotion exists to
     * serve, would never get past it even though every row is on disk and readable NOW.
     *
     * This is the same deal eager relations already get: their reads never pass through this
     * activation choke point at all, and their catch-up is a background concern. Nothing is hidden
     * by returning early — catch-up stays separately visible through `isGroupReady`/`groupReady`
     * (what the React hooks' `hydrating` reports), and the retry loop is still running.
     */
    if (promoted.has(groupKey) && group.startPromise != null) return;

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
    // Stopping a group also revokes its PROMOTION for the rest of this session (ADR-0021 §2): a
    // desync truncates the local copy, so the durable-and-readable premise the promotion fast path
    // rests on no longer holds. The group is HELD again — its next reference goes through the normal
    // activation path, where `wasHeld` is true once more and `onLazyActivated` re-persists the flag.
    promoted.delete(groupKey);
    // A stopped group must be able to become pending again, or a later activation would resolve its
    // readiness instantly against the previous run's settled promise.
    group.readyPromise = new Promise<void>((resolve) => {
      group.resolveReady = resolve;
    });
  }

  /** Tear the whole read path down: stop retrying, abort in-flight requests, drop every stream. */
  function tearDown(): void {
    torn = true;
    signalTorn();
    controlPlaneRequests.abort();
    for (const group of groups.values()) {
      group.handle?.unsubscribe();
      group.session?.close();
    }
  }

  // Wired BEFORE the boot loop, so a stop that lands while the first subscribe is still in flight
  // reaches the same teardown the returned handle would.
  if (options.signal) {
    if (options.signal.aborted) tearDown();
    else options.signal.addEventListener("abort", tearDown, { once: true });
  }

  /**
   * Start one eager group for BOOT, and wait only as far as its first subscribe attempt.
   *
   * Two things this deliberately does not wait for. Not the catch-up — `bootSettled` means sync START
   * done (ADR-0041), and a client that blocked boot on catch-up would make every cold start as slow as
   * its slowest shape. And not a SUCCESSFUL subscribe — an unreachable control plane retries in the
   * background, so an offline boot still reaches `localReadReady` with `ready` correctly left pending,
   * rather than hanging until the network returns.
   */
  async function startGroupForBoot(groupKey: string): Promise<void> {
    const group = groups.get(groupKey);
    if (group === undefined) return;
    if (group.startPromise) return group.startPromise;

    let markAttempted!: () => void;
    const firstAttempt = new Promise<void>((resolve) => {
      markAttempted = resolve;
    });
    const bootStamp = options.bootCollector?.beginGroup(groupKey, group.specs.length);
    const started = startGroup(group, markAttempted, bootStamp).catch((error: unknown) => {
      // A failed start must not be remembered as started: clearing the latch lets a later reference
      // try again rather than resolving instantly against a group that never subscribed.
      group.startPromise = null;
      throw error;
    });
    group.startPromise = started;
    // Boot is released by whichever comes first: the start settling, or the retry loop reporting that
    // its first attempt failed and it is now retrying in the background.
    void started.then(markAttempted, markAttempted);
    // A start that fails PAST the boot release has no caller left to throw at, so it is reported here
    // or it is lost. `onSyncError` rather than `onSubscribeError` because this is not the retried
    // path: subscribe already succeeded, something after it did not, and nothing will try again.
    void started.catch((error: unknown) => {
      if (torn) return;
      options.onSyncError?.(error instanceof Error ? error : new Error(String(error)));
    });
    await firstAttempt;
  }

  // Boot: every eager group, plus any lazy group a previous boot promoted. Started concurrently —
  // they are independent consistency groups, and serializing them would make boot the sum of their
  // subscribes rather than the slowest.
  await Promise.all(eagerKeys.map((groupKey) => startGroupForBoot(groupKey)));

  const tables: Record<string, CircuitsTableSyncResult> = {};
  for (const spec of specs) {
    const groupKey = groupKeyOf(spec);
    Object.defineProperty(tables, spec.key, {
      enumerable: true,
      get: () => ({ isUpToDate: groups.get(groupKey)?.handle?.isUpToDate === true }),
    });
  }

  return {
    unsubscribe: tearDown,
    tables,
    ensureGroupStarted,
    stopGroup,
    groupKeyForTable: (tableKey) => groupKeyByTable.get(tableKey),
    isTableStarted: (tableKey) => {
      const groupKey = groupKeyByTable.get(tableKey);
      if (groupKey === undefined) return false;
      const group = groups.get(groupKey);
      if (group === undefined) return false;
      // A promoted group counts as started from the moment boot kicked its start off, without waiting
      // for the subscribe to land: its table is durable and populated, which is what "started" asks.
      // Catching up is `ready`/`isGroupReady`'s question, and it is deliberately not asked here.
      if (promoted.has(groupKey) && group.startPromise != null) return true;
      return group.ready;
    },
    groupReady: async (groupKey) => {
      await (groups.get(groupKey)?.readyPromise ?? Promise.resolve());
    },
    isGroupReady: (groupKey) => groups.get(groupKey)?.ready === true,
    groupKeys: () => [...groups.keys()],
  };
}
