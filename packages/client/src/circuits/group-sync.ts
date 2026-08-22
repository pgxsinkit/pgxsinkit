import type { PGliteInterface } from "@electric-sql/pglite";
import { and, eq, getTableName, isNull, sql, type SQL } from "drizzle-orm";

import type { PredicateValue, SyncTableEntry, SyncTableRegistry } from "@pgxsinkit/contracts";

import type { BootStampCollector, GroupBootStamp } from "../boot-report";
import { resolveApplyTarget, type ApplyTarget } from "../local-tables";
import { drizzleOverPg } from "../sync/drizzle-executor";
import {
  deleteSubscriptionState,
  getSubscriptionState,
  updateSubscriptionState,
  type ShapeSubscriptionState,
} from "../sync/subscription-state";
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
 *
 * It is also the only layer that can RE-subscribe, which is why the mid-session recovery lives here
 * (backlog 0010). A group has four lifecycle transitions and they are deliberately distinct:
 *
 * - **start** — subscribe, reconcile, open the streams; the group becomes ready when it catches up.
 * - **restart** ({@link CircuitsGroupSyncOptions.onStreamError}) — a live read ended, so the whole
 *   group re-subscribes with backoff and re-opens. It touches neither `ready`, nor `startPromise`,
 *   nor promotion, nor the boot stamp: nothing about the group's identity or its boot changed, only
 *   the streams underneath it.
 * - **stop** (`stopGroup`) — the group returns to dormant and un-promotes.
 * - **tear down** (`unsubscribe`) — the whole runtime stops.
 *
 * The last two bump a per-group `generation`, and every restart re-checks the generation it captured
 * after each await. That is what stops a restart parked on its backoff from resurrecting a group the
 * caller has since stopped, or opening streams into a torn-down runtime.
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
  /**
   * This group's boot accumulator (ADR-0034) while it is still catching up, `null` otherwise.
   *
   * Held here rather than only on the `startGroupForBoot` call stack because a restart that lands
   * BEFORE the group is ready re-opens it, and an open with no stamp would leave the group's row in
   * the boot report without a ready edge. Once `ready` the stamp is finalized, so a restart past that
   * point deliberately does not pass it.
   */
  bootStamp: GroupBootStamp | null;
  /** Single-flight restart, so K dying streams in one group cost ONE re-subscribe, not K. */
  restartPromise: Promise<void> | null;
  /**
   * Consecutive restarts with no delivered batch between them — the backoff ladder's rung. Reset by
   * any delivery, so a transient blip never inherits the cadence a long outage climbed to.
   */
  restartAttempt: number;
  /**
   * Bumped by every stop and by teardown. A restart captures it and abandons itself if it moved, so
   * a re-subscribe parked on its backoff can never resurrect a group the caller stopped.
   */
  generation: number;
  /**
   * Revocations heard on a re-mint, held until the re-subscribe has CLEARED their rows.
   *
   * They cannot be reported when they arrive: `onRefused` promises the caller that the rows are
   * already gone (ADR-0055 decision 6), and at re-mint time nothing has been cleared yet — the clear
   * happens at the next subscribe, where the answer says what this subject may still read.
   */
  pendingRefusedNotifications: RefusedStream[];
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
  /**
   * Called with the scopes the control plane refused or later revoked.
   *
   * Fired AFTER the refused scopes' local rows have been cleared, never before. Losing entitlement
   * means losing the subscription, not keeping the rows (ADR-0055 decision 6), and an app that reacts
   * to this — re-rendering, prompting, navigating away — must not be handed a store that still shows
   * what the subject may no longer read.
   */
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
  /**
   * A live stream ended or could not be opened — a `403` that survived a re-mint, a `404`/`410` on an
   * evicted stream, `Stream-Closed`, a lost connection — and the group is re-subscribing with
   * backoff.
   *
   * Recoverable, and it clears on the next delivered batch. Distinct from `onSubscribeError` (the
   * CONTROL PLANE could not be reached, so there is nothing to read from yet) and from `onSyncError`
   * (a COMMIT failed, which is sticky by design because reads can keep succeeding while applies keep
   * failing).
   */
  onStreamError?: (error: Error) => void;
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
 * The name one READER of a stream is known by, within its group and across boots.
 *
 * A grant's shape key plus its scope, because neither alone identifies a reader. A shared shape fans
 * out to one grant per entitled scope (ADR-0055 decision 6), so shape keys are not unique within a
 * group; and the STREAM PATH is not unique either, which is the sharper of the two. Circuits
 * ref-counts byte-identical shape definitions, so two distinct read projections that compile to the
 * same table, columns and predicate come back as one path — keying on it dropped the second
 * projection's reader outright and left its local table empty forever.
 *
 * Exported for the tests that pin that naming: it is also the key of a persisted cursor entry, so it
 * is the thing a later subscribe matches a grant against.
 */
export function logicalShapeName(shapeKey: string, scope?: readonly PredicateValue[]): string {
  return scope === undefined ? shapeKey : `${shapeKey}@${JSON.stringify(scope)}`;
}

/**
 * Turn one group's grants into the shape map `syncCircuitsShapes` takes.
 *
 * Keyed by {@link logicalShapeName} — the reader's identity, not the stream's. When the engine hands
 * two logical shapes ONE deduplicated stream, they become two readers of that stream: each opens its
 * own read, applies into its own table, and persists its own offset. That is a second read of bytes
 * the engine only stores once, and it is the right trade for a rare configuration — the alternative
 * is a projection that silently never populates.
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
    shapes[logicalShapeName(grant.shapeKey, grant.scope)] = {
      streamUrl: grant.streamUrl,
      tableKey: spec.key,
      identity: { shapeKey: grant.shapeKey, ...(grant.scope ? { scope: grant.scope } : {}) },
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
      bootStamp: null,
      restartPromise: null,
      restartAttempt: 0,
      generation: 0,
      pendingRefusedNotifications: [],
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
   *
   * `generation` is the group generation the caller captured. A subscribe retrying for a group that
   * has since been stopped has nothing left to subscribe FOR, so the loop ends with it rather than
   * hammering a control plane on behalf of a dead group.
   */
  async function subscribeWithRetry(
    group: GroupRuntime,
    generation: number,
    onFirstAttempt?: () => void,
  ): Promise<SubscriptionSession | null> {
    let reportedFirstAttempt = false;
    const reportAttempt = () => {
      if (reportedFirstAttempt) return;
      reportedFirstAttempt = true;
      onFirstAttempt?.();
    };
    const abandoned = () => torn || group.generation !== generation;

    for (let attempt = 0; !abandoned(); attempt += 1) {
      try {
        const session = await openSubscriptionSession(
          {
            controlPlaneUrl: options.controlPlaneUrl,
            streamBaseUrl: options.streamBaseUrl,
            ...(options.authHeaders ? { authHeaders: options.authHeaders } : {}),
            signal: controlPlaneRequests.signal,
            ...(options.fetch ? { fetch: options.fetch } : {}),
            // Held, not reported. A revoked scope's rows are still on disk at this instant — they are
            // cleared at the re-subscribe this revocation triggers — and `onRefused` may only fire
            // once they are gone. The restart is what turns "the control plane says you lost this"
            // into "and it is no longer in your store".
            onRevoked: (revoked) => {
              group.refused.push(...revoked);
              group.pendingRefusedNotifications.push(...revoked);
              scheduleRestart(group, new Error("[pgxsinkit] stream grants revoked on re-mint"));
            },
          },
          group.specs.map((spec) => ({ shapeKey: spec.shapeKey })),
        );
        if (abandoned()) {
          reportAttempt();
          session.close();
          return null;
        }
        // Deliberately no `reportAttempt()` here. A subscribe that SUCCEEDED holds the boot for the
        // rest of the start, so a boot that reached the control plane still comes back with its
        // groups streaming — the release below is only for the case where it could not.
        return session;
      } catch (error) {
        if (abandoned()) {
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
   * Clear what this subject may no longer read, BEFORE anything is synced or reported ready.
   *
   * ADR-0055 decision 6: losing entitlement means losing the subscription — "truncate that scope and
   * unsubscribe". The live half of that is a 403 surviving a re-mint (ADR-0056 decision 7), but a
   * revocation that lands while the client is OFFLINE has no 403 to deliver: the next boot simply
   * subscribes and is granted less. Nothing else in the start path notices. `shapesFromGrants` only
   * ever covers what WAS granted, and a group granted nothing at all takes the ready branch straight
   * over the previous session's rows.
   *
   * So the check lives at subscribe, because the subscribe answer is the single authoritative
   * statement of what this subject may read right now. A persisted reader the answer does not name is
   * exactly a revocation discovered late, and the cursor is the only thing that still remembers it —
   * hence the shape key and scope persisted alongside the offset.
   *
   * Deliberately NOT the handle check. A shape that is still granted but on a different stream is
   * `syncCircuitsShapes`'s must-refetch (ADR-0056 decision 6/7): it re-snapshots in the same
   * transaction the new rows land in, and nothing here touches it. This one answers the other
   * question — whether the reader should exist at all.
   *
   * Returns what it cleared, because a clear nobody is told about is half a revocation. The control
   * plane's own `denied`/`revoked` lists only cover what it was ASKED about; a scope it has simply
   * stopped enumerating produces no entry anywhere, so without this the rows would vanish and the app
   * would never learn which scope it lost. The caller folds these into the one `onRefused` call it
   * makes after this returns — after the clear, as that callback's contract requires.
   */
  async function reconcilePersistedShapes(
    group: GroupRuntime,
    granted: readonly GrantedStream[],
  ): Promise<RefusedStream[]> {
    const sessionScoped = group.retention === "ephemeral";
    const state = await getSubscriptionState({
      pg,
      metadataSchema: options.metadataSchema,
      subscriptionKey: group.groupKey,
      sessionScoped,
    });
    if (state === null) return [];

    const stillGranted = new Set(granted.map((grant) => logicalShapeName(grant.shapeKey, grant.scope)));
    const specsByShapeKey = new Map(group.specs.map((spec) => [spec.shapeKey, spec]));

    const surviving: Record<string, ShapeSubscriptionState> = {};
    const stale: { spec: NativeSpec; persisted: ShapeSubscriptionState }[] = [];
    for (const [shapeName, persisted] of Object.entries(state.shape_metadata)) {
      if (stillGranted.has(shapeName)) {
        surviving[shapeName] = persisted;
        continue;
      }
      // An entry naming a shape this group no longer declares is a REGISTRY change, and that is
      // ADR-0006's rebuild rather than this path — it drops the whole store, so clearing rows here
      // would be both redundant and a guess at which table they were in. The entry itself is dropped
      // with the rest of the stale set: nothing can ever resume it.
      const spec = specsByShapeKey.get(persisted.shapeKey);
      if (spec === undefined) continue;
      stale.push({ spec, persisted });
    }

    if (stale.length === 0) return [];

    await pg.transaction(async (tx) => {
      // Tier ③ (ADR-0028 allow-list): the sync-origin GUC the apply trigger reads, set exactly as the
      // engine's own commit sets it — this clear is streamed server truth reversing itself, not a
      // local write. GUCs have no tier-①/② builder form.
      await tx.exec(`SET LOCAL ${options.metadataSchema}.syncing = true;`);
      const db = drizzleOverPg(tx);

      for (const { spec, persisted } of stale) {
        const target = resolveApplyTarget(options.registry, spec.key);
        if (spec.scopeColumns && persisted.scope) {
          // Shared tier: co-tenant scopes live in this same table, so only this scope's rows go.
          await scopedClear(target, spec.scopeColumns, persisted.scope)(db);
        } else {
          // Private tier: a scope-less shape is always its table's sole occupant (`resolveTableSharing`
          // in sync-engine refuses co-tenancy without a scoped clear), so the table IS the shape's
          // rows. Tier ②: TRUNCATE has no Drizzle builder, so the table object is interpolated rather
          // than its name spliced.
          await db.execute(sql`TRUNCATE ${target.table}`);
        }
      }

      // The cursor is rewritten in the SAME transaction as the clear, or a crash between them leaves a
      // resume token for rows that are gone.
      if (Object.keys(surviving).length === 0) {
        await deleteSubscriptionState({
          pg: tx,
          metadataSchema: options.metadataSchema,
          subscriptionKey: group.groupKey,
        });
      } else {
        await updateSubscriptionState({
          pg: tx,
          metadataSchema: options.metadataSchema,
          subscriptionKey: group.groupKey,
          sessionScoped,
          shapeMetadata: surviving,
          // `last_lsn` has no native meaning (ADR-0056) — written as the same constant the engine's
          // commit writes, until the vestigial column is dropped.
          lastLsn: BigInt(0),
        });
      }
    });

    return stale.map(({ persisted }) => ({
      shapeKey: persisted.shapeKey,
      ...(persisted.scope ? { scope: persisted.scope } : {}),
      reason: "no longer granted at subscribe",
    }));
  }

  /**
   * Subscribe one group and open its streams — the whole of a group's connected state, in one place
   * because start and RESTART must do exactly the same thing.
   *
   * One session PER GROUP rather than one for the whole client. ADR-0055 decision 6's batching
   * property is about SCOPES — "a subject with K scopes refreshes in one request per window" — and
   * expansion keeps every scope of a shape inside the one group that declared it, so that property
   * is preserved here. What one-per-group buys is that a group's lifecycle and its session's are
   * the same object: activation opens one, `stopGroup` closes one, and no group can hold a grant
   * alive for a group that has stopped.
   *
   * The generation captured on entry is re-checked after every await: a stop or a teardown that
   * lands mid-open has already closed whatever this group held, and finishing the open would hand it
   * back a session and a set of streams nobody asked for.
   *
   * Throws if the streams could not be opened. Both callers answer that with a backoff and another
   * attempt — see {@link scheduleRestart} — because "the edge is not answering" is a condition that
   * ends by itself.
   */
  async function openGroup(
    group: GroupRuntime,
    bootStamp?: GroupBootStamp,
    onFirstAttempt?: () => void,
  ): Promise<void> {
    const generation = group.generation;
    const abandoned = () => torn || group.generation !== generation;
    const specsByShapeKey = new Map(group.specs.map((spec) => [spec.shapeKey, spec]));

    const session = await subscribeWithRetry(group, generation, onFirstAttempt);
    if (session === null) return;
    if (abandoned()) {
      session.close();
      return;
    }

    group.session = session;
    group.refused.push(...session.refused);

    // Before EITHER branch below: the zero-grants branch reports ready immediately, and it must not
    // report ready over rows the subject lost while this client was offline.
    const cleared = await reconcilePersistedShapes(group, session.granted);
    if (abandoned()) return;
    group.refused.push(...cleared);

    notifyRefused(group, session.refused, cleared);

    const shapes = shapesFromGrants(options.registry, specsByShapeKey, session.granted);
    if (Object.keys(shapes).length === 0) {
      // Nothing was granted. The group is "ready" in the only sense available to it — there is
      // nothing to wait for — and saying so is what stops a boot hanging on an entitlement the
      // subject simply does not hold.
      bootStamp?.markReady();
      markReady(group);
      return;
    }

    const handle = await syncCircuitsShapes({
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
      onSyncActivity: () => {
        // A delivered batch ends the fault the ladder was climbing, so the next one starts at the
        // bottom again: a blip an hour from now must not inherit an outage's ten-second cadence.
        group.restartAttempt = 0;
        options.onSyncActivity?.();
      },
      // The mid-session half of ADR-0056 decision 7 (backlog 0010). A read that ends under `live`
      // has no way back on its own — the engine is handed URLs, not a subscription — so the whole
      // group re-subscribes here. A NORMAL end under `live: false` is not that: a one-shot hydration
      // finishing is the success case, and restarting it would loop forever.
      onStreamEnd: (shapeName, error) => {
        if (options.live === false && error === null) return;
        scheduleRestart(group, error ?? new Error(`[pgxsinkit] stream "${shapeName}" closed by the server`));
      },
      onInitialSync: () => {
        // Stamp readyAtMs and freeze the accumulator at the group's ready edge, so later live traffic
        // never mutates a finalized report.
        bootStamp?.markReady();
        markReady(group);
      },
    });

    if (abandoned()) {
      handle.unsubscribe();
      session.close();
      return;
    }
    group.handle = handle;
  }

  /**
   * Tell the caller what this group lost, ONCE, and only after the rows are gone.
   *
   * Three sources converge here and they are not interchangeable: scopes the control plane refused at
   * this subscribe, scopes it revoked on an earlier re-mint (held since — see
   * {@link GroupRuntime.pendingRefusedNotifications}), and readers the reconcile CLEARED because the
   * subscribe answer no longer names them. The third is the one nothing else reports.
   *
   * A cleared reader the control plane already named is not repeated: the control plane's reason says
   * WHY the subject lost it, which is strictly more informative than "no longer granted", and a
   * caller counting entries should see one per lost reader rather than two.
   */
  function notifyRefused(
    group: GroupRuntime,
    refused: readonly RefusedStream[],
    cleared: readonly RefusedStream[],
  ): void {
    const announced = [...group.pendingRefusedNotifications, ...refused];
    group.pendingRefusedNotifications = [];
    const named = new Set(announced.map((entry) => logicalShapeName(entry.shapeKey, entry.scope)));
    const entries = [
      ...announced,
      ...cleared.filter((entry) => !named.has(logicalShapeName(entry.shapeKey, entry.scope))),
    ];
    if (entries.length > 0) options.onRefused?.(entries);
  }

  /**
   * Re-subscribe a group whose streams stopped, after a backoff — the recovery half of ADR-0056
   * decision 7 (backlog 0010).
   *
   * The WHOLE GROUP re-subscribes, not the one dead shape, and that is deliberate: the subscribe
   * answer is the single authoritative statement of what this subject may read, and the reconcile
   * that runs on it is what clears a scope that has since been revoked. Re-opening one stream would
   * recover liveness while leaving both of those unasked.
   *
   * Single-flight per group (K streams of one group die together on a lost connection, and they need
   * ONE re-subscribe), generation-guarded, and it deliberately touches nothing about the group's
   * identity: not `ready`, not `startPromise`, not promotion, not the boot stamp. A restart is
   * neither a boot nor a stop — the group never stopped being this group.
   */
  function scheduleRestart(group: GroupRuntime, cause: Error): void {
    if (torn || group.restartPromise !== null) return;
    const generation = group.generation;

    options.onStreamError?.(cause);
    // Down before the backoff, not after: a dead stream still holds a connection and its token thunk
    // still fires, and the re-subscribe below is going to replace both.
    group.handle?.unsubscribe();
    group.session?.close();
    group.handle = null;
    group.session = null;

    group.restartPromise = (async () => {
      let failure: Error | null = null;
      await sleepUntil(subscribeBackoffMs(group.restartAttempt++));
      if (!torn && group.generation === generation) {
        try {
          // Still catching up: the boot stamp rides the re-open, or this group's boot-report row never
          // gets a ready edge. Past `ready` the stamp is finalized and must not be handed back.
          await openGroup(group, group.ready ? undefined : (group.bootStamp ?? undefined));
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
      }
      // The latch is released BEFORE the next attempt is scheduled, or that attempt would see a
      // restart still in flight and drop itself — leaving a group that is neither reading nor
      // recovering. The generation is the identity check: only one restart can exist per generation
      // (this latch is why), and a stop that moved it has already cleared the latch itself, so
      // clearing it here would only clobber a newer owner's.
      if (group.generation === generation) group.restartPromise = null;
      // The streams could not be re-opened. Same ladder, so an edge that stays down is retried at the
      // capped 10 s cadence until it answers, rather than being abandoned after one try.
      if (failure !== null && !torn && group.generation === generation) scheduleRestart(group, failure);
    })();
  }

  /**
   * Start one group: open it, and if the streams could not be opened, keep trying rather than failing.
   *
   * An edge that is down at boot is the same condition as an edge that dies mid-session, and the
   * subscribe retry loop already takes that view of the control plane. A start that threw instead
   * would leave the app holding a group that never syncs again even though the network came back
   * seconds later — the ADR-0013 wedge, one layer down. The group is started-and-recovering: its
   * `ready` stays pending, `onStreamError` says why, and the ladder in {@link scheduleRestart} runs.
   */
  async function startGroup(
    group: GroupRuntime,
    onFirstAttempt?: () => void,
    bootStamp?: GroupBootStamp,
  ): Promise<void> {
    try {
      await openGroup(group, bootStamp, onFirstAttempt);
    } catch (error) {
      if (torn) return;
      scheduleRestart(group, error instanceof Error ? error : new Error(String(error)));
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

  /**
   * Stop a group and return it to dormant.
   *
   * The generation bump is what makes that stick. A restart may be parked on its backoff right now,
   * holding a captured generation and a plan to re-subscribe; moving the generation is how it learns,
   * on the far side of every await, that the group it was recovering no longer wants to be recovered.
   * Without it a stopped group would quietly come back streaming a few hundred milliseconds later.
   */
  function stopGroup(groupKey: string): void {
    const group = groups.get(groupKey);
    if (group === undefined) return;
    group.generation += 1;
    group.restartPromise = null;
    group.restartAttempt = 0;
    group.pendingRefusedNotifications = [];
    group.handle?.unsubscribe();
    group.session?.close();
    group.handle = null;
    group.session = null;
    group.startPromise = null;
    group.ready = false;
    group.refused = [];
    // A stop ends this group's boot generation, so a later activation must not re-open against a
    // stamp whose report was finalized on the previous run.
    group.bootStamp = null;
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

  /**
   * Tear the whole read path down: stop retrying, abort in-flight requests, drop every stream.
   *
   * `torn` alone would do for the restart ladder — every guard tests it — but the generation moves
   * too, so a restart holding a stale generation abandons itself for the same reason a stopped
   * group's does, rather than for a second reason that has to be kept in step with this one.
   */
  function tearDown(): void {
    torn = true;
    signalTorn();
    controlPlaneRequests.abort();
    for (const group of groups.values()) {
      group.generation += 1;
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
    // On the runtime as well as the call stack: a pre-ready restart re-opens the group and needs it.
    group.bootStamp = bootStamp ?? null;
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
