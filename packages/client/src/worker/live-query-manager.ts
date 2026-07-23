// The worker-owned live-query manager (ADR-0040). It owns the PGlite `live` registration lifecycle, the
// single change listener + shared `LiveDiffState` per query, and the awaited-teardown bookkeeping (decision
// 1). Slice 3 added DEDUPLICATION: identical live queries (same fingerprint — see live-query-fingerprint.ts)
// share ONE registration and ONE diff computation, fanned out to every subscriber (decision 2). Slice 4 adds
// BOUNDED ZERO-SUBSCRIBER KEEP-ALIVE (decision 4): when the last subscriber of an entry leaves, a nonzero
// effective keep-alive retains the registration for a grace period so a matching resubscribe reuses it
// verbatim (no ~400 ms re-materialization); retention is bounded by explicit count/row budgets and defaults
// to OFF (keep-alive 0 → tear down the instant the last subscriber leaves). The 0 default is deliberate:
// a retained entry still pays a full SQL rerun + diff on every dependent write (PGlite live queries cannot
// be paused), so keeping one alive is only worthwhile for a genuinely hot, re-mounted query — the default
// keeps worker memory bounded and never runs surprise standing SQL.
//
// What stays with the CALLER (`defineSyncWorker`), never this manager (ADR-0040 decision 3): lazy-relation
// activation (`prepareQuery`), hydration accounting (`hydratingTablesFor` → `groupReady`), the
// `live-initial`/`live-diff`/`live-hydrated` bridge posting with its per-`queryId` correlation, and
// `wrapLiveQueryForMaterialization` (the manager receives POST-WRAP SQL — the fingerprint's SQL input). Those
// are per-subscriber pre-/post-steps that never influence the shared registration or its rows; in particular
// `use` NEVER reaches here, so differing `use` sets share one registration.

import type { LiveNamespace, LiveQuery, LiveQueryResults } from "@electric-sql/pglite/live";

import { syncDebug } from "../debug";
import { computeLiveDiff, type LiveDiffState, seedLiveDiffState } from "./live-diff";
import { fingerprintLiveQuery } from "./live-query-fingerprint";
import { assertLiveQueryParamsSafe } from "./live-query-params-guard";
import type { LiveDiffPayload } from "./protocol";

type Row = Record<string, unknown>;

/** The wire diff a subscriber receives — exactly `computeLiveDiff`'s output, minus the caller's `queryId`. */
export type LiveDiffWire = Omit<LiveDiffPayload, "queryId">;

/** The two delivery callbacks a subscriber supplies; the caller wires these to its bridge posting. */
export interface LiveSubscriber {
  /** The verbatim initial snapshot (NOT a diff), delivered ONCE before any diff (rows-before-diff ordering). */
  deliverInitial(rows: readonly Row[]): void;
  /** A subsequent change, already diffed against the last delivered set. */
  deliverDiff(diff: LiveDiffWire): void;
}

/** Post-wrap SQL + bound params + optional single-column PK (selects `incrementalQuery` vs `query`). */
export interface LiveQuerySpec {
  materialSql: string;
  params: unknown[];
  pkColumns?: readonly string[];
}

/** Per-subscription options (ADR-0040). */
export interface LiveSubscribeOptions {
  /**
   * How long (ms) THIS subscriber asks the entry to be retained after IT (and any siblings) leave. The
   * entry's effective keep-alive is `max(policy default, the max hint of the current active generation)`
   * (see the generation rule on `subscribe`); the worker count/row budgets stay authoritative over any hint.
   * Absent / 0 → no retention from this subscriber. Must be a finite number ≥ 0.
   */
  keepAliveMs?: number;
  /**
   * An opaque grouping key for diagnostics only (ADR-0040 decision 5) — never part of the fingerprint, so it
   * NEVER affects dedup or registration. The worker passes one stable scope per bridge port, so a snapshot's
   * `scopeCount` reads as the distinct-tab count; the in-process client passes none.
   */
  scope?: string;
}

/** A live registration's handle: awaited/tracked teardown and a coalesced refresh. */
export interface LiveSubscription {
  /** Non-blocking for the caller; the promise is retained internally so `dispose()` awaits it (decision 1). */
  unsubscribe(): Promise<void>;
  /** Force one recompute; concurrent calls SHARE one underlying `live.refresh()` (never N stacked reruns). */
  refresh(): Promise<void>;
}

/** The manager's bounded keep-alive policy (ADR-0040 decision 4). All fields default; the block is opt-in. */
export interface LiveQueryPolicy {
  /**
   * Default retention (ms) for a zero-subscriber entry, floored by each subscriber's own `keepAliveMs` hint.
   * Default 0 — the current route-scoped behaviour (tear a query down the moment its last consumer leaves).
   * The standing argument for 0: a retained zero-subscriber entry STILL pays a full SQL rerun + diff on every
   * dependent-table write — PGlite live queries cannot be paused, only torn down — so retention trades that
   * standing cost for avoiding re-materialization, and is only worth it for a genuinely hot, re-mounted query.
   */
  defaultKeepAliveMs?: number;
  /** Max simultaneously-retained (zero-subscriber) entries; LRU-evicted past this. Active entries never count. */
  maxRetainedQueries?: number;
  /** Max total rows held across ALL retained entries; LRU-evicted past this. Active entries never count. */
  maxRetainedRows?: number;
}

type TimerHandle = unknown;

/**
 * The signed-32-bit `setTimeout` delay ceiling (ADR-0040 decision 4). Browsers and Node clamp a delay above
 * this to ~0, so a "30-day" keep-alive would EXPIRE IMMEDIATELY rather than retain — the opposite of intent.
 * A keep-alive above this is rejected at the public boundary (never silently clamped), matching the ADR's
 * deliberate refusal of de-facto permanent retention. The budgets (count/rows) are NOT timers and are uncapped.
 */
const MAX_KEEP_ALIVE_MS = 2_147_483_647;

export interface LiveQueryManagerDeps {
  /** The engine's `live` namespace — only the two registration entry points are used. */
  live: Pick<LiveNamespace, "query" | "incrementalQuery">;
  /** Bounded keep-alive policy (ADR-0040 decision 4); omitted → all defaults (retention off). */
  policy?: LiveQueryPolicy;
  /** Monotonic clock for keep-alive LRU accounting. Default `performance.now()` (Date.now fallback). */
  now?: () => number;
  /** Injectable eviction timer (tests drive it deterministically). Default `setTimeout`. */
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  /** Injectable timer cancel. Default `clearTimeout`. */
  clearTimer?: (handle: TimerHandle) => void;
}

/**
 * A structured-clone-safe, per-entry diagnostics record (ADR-0040 decision 5). It carries ONLY opaque
 * fingerprint digests and counts/timings — NEVER SQL text, bound param values, or result-row values (those
 * live only in the fingerprint's private `key`, which is deliberately absent here). Safe to cross the bridge
 * and surface in support tooling.
 */
export interface LiveQueryDiagnostics {
  /** The opaque fingerprint digest (a short hash — see live-query-fingerprint.ts). NEVER the full key. */
  digest: string;
  /** Current subscriber count (0 while retained). */
  subscriberCount: number;
  /**
   * Distinct subscription scopes on this entry. The worker passes one scope per bridge port, so in WORKER
   * mode this is the number of distinct tabs on the query; the in-process client passes none, so it stays 1
   * while any subscriber is attached (0 while retained).
   */
  scopeCount: number;
  /** Rows currently held in the shared diff state. */
  rowCount: number;
  /** Whether this is a zero-subscriber entry currently kept alive (ADR-0040 decision 4). */
  retained: boolean;
  /** How many subscribes JOINED this entry rather than creating it (active-joins + retained rejoins). */
  dedupHits: number;
  /** Monotonic stamp (ms) when the entry was created. */
  createdAt: number;
  /** Time (ms) the registration setup took, or `null` until setup completes. */
  setupMs: number | null;
  /** Refresh timings for the shared registration (the hydration-chain / force refreshes). */
  refresh: { count: number; lastMs: number | null; totalMs: number; maxMs: number };
  /** Monotonic stamp (ms) of the last transition to zero subscribers, or `null` if never retained. */
  lastUsedAt: number | null;
  /** How long (ms) the entry has been retained (now − lastUsedAt), or `null` when not retained. */
  retainedSinceMs: number | null;
  /** A teardown is in flight (the entry is unsubscribing from PGlite). */
  teardownPending: boolean;
}

export interface LiveQueryManager {
  subscribe(spec: LiveQuerySpec, subscriber: LiveSubscriber, opts?: LiveSubscribeOptions): Promise<LiveSubscription>;
  /** Tear down every live registration and await ALL teardowns (the Slice-1 close-vs-unsubscribe guard). */
  dispose(): Promise<void>;
  /**
   * A point-in-time diagnostics snapshot (ADR-0040 decision 5): one plain-object record per live entry,
   * carrying digests + counts/timings only — NO SQL, params, or rows. For the `liveQueryDiagnostics` RPC and
   * support tooling.
   */
  snapshot(): LiveQueryDiagnostics[];
}

/**
 * Validate a keep-alive policy at the public boundary (ADR-0040 decision 4 — bounded, no permanent retention).
 * Every provided field must be a finite number ≥ 0; the two budgets must additionally be integers. Throws a
 * `TypeError` naming the offending field so a misconfiguration fails at construction, not at first subscribe.
 */
export function validateLiveQueryPolicy(policy: LiveQueryPolicy | undefined): void {
  if (policy == null) return;
  const ms = (name: keyof LiveQueryPolicy, value: number | undefined) => {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new TypeError(`[pgxsinkit] liveQueries.${String(name)} must be a finite number >= 0 (got ${value})`);
    }
    // A keep-alive above the signed-32-bit timer ceiling would clamp to ~0 and expire immediately (see
    // MAX_KEEP_ALIVE_MS) — reject it rather than let a huge value become a no-retention footgun.
    if (value !== undefined && value > MAX_KEEP_ALIVE_MS) {
      throw new TypeError(
        `[pgxsinkit] liveQueries.${String(name)} must be <= ${MAX_KEEP_ALIVE_MS} ms (the platform setTimeout ceiling; got ${value})`,
      );
    }
  };
  const int = (name: keyof LiveQueryPolicy, value: number | undefined) => {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new TypeError(`[pgxsinkit] liveQueries.${String(name)} must be a non-negative integer (got ${value})`);
    }
  };
  ms("defaultKeepAliveMs", policy.defaultKeepAliveMs);
  int("maxRetainedQueries", policy.maxRetainedQueries);
  int("maxRetainedRows", policy.maxRetainedRows);
}

/** One deduplicated registration: a shared listener + diff state, fanned out to many subscribers. */
interface LiveEntry {
  readonly key: string;
  readonly digest: string;
  /** Resolves once `registered`/`state`/`listener` are wired; rejects (and removes the entry) on setup failure. */
  readonly setup: Promise<void>;
  /**
   * Fan-out map keyed by an opaque per-subscription token (so `(port, queryId)` callers stay independent),
   * carrying each subscriber's keep-alive hint and diagnostics scope.
   */
  readonly subscribers: Map<symbol, { subscriber: LiveSubscriber; keepAliveMs: number; scope: string | undefined }>;
  registered?: LiveQuery<Row>;
  listener?: (results: LiveQueryResults<Row>) => void;
  state?: LiveDiffState;
  torn: boolean;
  teardown?: Promise<void>;
  refreshInFlight?: Promise<void>;
  /** Monotonic stamp of the last transition to zero subscribers — the LRU key while retained. */
  lastUsedAt?: number;
  /** The live eviction timer while retained; cleared on rejoin, expiry, eviction, or dispose. */
  evictionTimer?: TimerHandle;
  /**
   * The max keep-alive hint observed during the CURRENT active generation (reset to the joiner's hint on any
   * 0→1 join, `max`'d on every later join). The last-out effective keep-alive is `max(default, this)` — so it
   * is independent of the ORDER subscribers depart in (a hint no longer vanishes the instant its subscriber
   * leaves), making equivalent subscriber sets behave identically.
   */
  generationKeepAliveMs: number;
  // ── Diagnostics counters (ADR-0040 decision 5) — digests/counts/timings only, never SQL/params/rows ──
  readonly createdAt: number;
  dedupHits: number;
  setupMs?: number;
  refreshCount: number;
  refreshLastMs?: number;
  refreshTotalMs: number;
  refreshMaxMs: number;
  teardownPending: boolean;
}

export function createLiveQueryManager(deps: LiveQueryManagerDeps): LiveQueryManager {
  validateLiveQueryPolicy(deps.policy);
  const { live } = deps;
  const policy = {
    defaultKeepAliveMs: deps.policy?.defaultKeepAliveMs ?? 0,
    maxRetainedQueries: deps.policy?.maxRetainedQueries ?? 16,
    maxRetainedRows: deps.policy?.maxRetainedRows ?? 50_000,
  };
  const now = deps.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  // ADR-0040 decision 1 (originally define-sync-worker's Slice 1): a fire-and-forget live `unsubscribe()`
  // still in flight when PGlite closes wedges the process forever. Every teardown promise is retained here so
  // `dispose()` settles them ALL before the caller closes the engine; rejections are swallowed so an
  // interrupted teardown never becomes an unhandled rejection.
  const pendingTeardowns = new Set<Promise<void>>();
  // The deduplication table: one entry per fingerprint (identical live queries share it).
  const entries = new Map<string, LiveEntry>();
  // Zero-subscriber entries currently being kept alive (ADR-0040 decision 4). ONLY these are counted against
  // the budgets and eligible for LRU eviction; active (subscriber-holding) entries are never in this set.
  const retained = new Set<LiveEntry>();
  // In-flight `subscribe()` calls (each resolves only once its join/self-teardown has fully run). `dispose()`
  // drains these so a subscribe completing mid-dispose is torn down instead of leaking a live query.
  const setups = new Set<Promise<void>>();
  // Manager-level count of dedup HITS — subscribes that joined an EXISTING entry (active-join or retained
  // rejoin) rather than creating a registration. Surfaced on the debug rail (`live-query dedup-hit`).
  let dedupHits = 0;
  let disposed = false;

  const createEntry = (key: string, digest: string, spec: LiveQuerySpec): LiveEntry => {
    const entry: LiveEntry = {
      key,
      digest,
      subscribers: new Map(),
      torn: false,
      generationKeepAliveMs: 0,
      createdAt: now(),
      dedupHits: 0,
      refreshCount: 0,
      refreshTotalMs: 0,
      refreshMaxMs: 0,
      teardownPending: false,
      // Assigned synchronously just below — the IIFE reads `entry`, which is fully initialized by then.
      setup: undefined as unknown as Promise<void>,
    };
    (entry as { setup: Promise<void> }).setup = (async () => {
      const setupStartedAt = now();
      const { materialSql, params, pkColumns } = spec;
      // Single-column PK → PGlite's incremental machinery (`live.incrementalQuery`); composite/keyless →
      // `live.query` (full ordered result each fire) + worker-side diff. Identical selection to the pre-dedup
      // path; the fingerprint already encoded this choice as its `mode`.
      const registered =
        pkColumns && pkColumns.length === 1
          ? await live.incrementalQuery<Row>(materialSql, params, pkColumns[0]!)
          : await live.query<Row>(materialSql, params);
      const state = seedLiveDiffState(registered.initialResults.rows, pkColumns);
      const listener = (results: LiveQueryResults<Row>) => {
        // `subscribe` fires only on a real change (never the initial), so every fire yields a genuine delta.
        // ONE diff, computed once against the shared state, fanned to EVERY current subscriber (decision 2).
        const diff = computeLiveDiff(state, results.rows);
        // Isolate per subscriber: a throwing consumer (the in-process `onRows` reaches app code) must NOT
        // starve its siblings — the shared state already advanced, so a skipped delivery is unrecoverable.
        for (const record of entry.subscribers.values()) {
          try {
            record.subscriber.deliverDiff(diff);
          } catch {
            syncDebug("live-query subscriber-error", { digest: entry.digest });
          }
        }
        // A retained (zero-subscriber) entry stays live and its rows can GROW past the row budget on a write.
        // Re-enforce OUTSIDE this callback (a queued microtask) — eviction's PGlite `unsubscribe()` must not
        // run inside PGlite's own notification call (ADR-0040 decision 4 — the budget stays authoritative).
        if (retained.has(entry)) queueMicrotask(() => enforceBudgets());
      };
      registered.subscribe(listener);
      entry.registered = registered;
      entry.state = state;
      entry.listener = listener;
      entry.setupMs = now() - setupStartedAt;
      syncDebug("live-query register", { digest, setupMs: Math.round(entry.setupMs) });
    })();
    // Failed setup: drop the entry so every joined waiter rejects and a LATER subscribe builds a fresh one.
    entry.setup.catch(() => {
      if (entries.get(key) === entry) entries.delete(key);
    });
    return entry;
  };

  const tearDownEntry = (entry: LiveEntry): Promise<void> => {
    if (entry.torn) return entry.teardown ?? Promise.resolve();
    entry.torn = true;
    entry.teardownPending = true;
    // Deliberately keep the torn entry in the map until its teardown COMPLETES: a resubscribe to the same
    // fingerprint arriving mid-teardown must find it, await the teardown, and only THEN build a fresh entry
    // (ADR-0040 decision 2 — never overlap a new registration with the old one's in-flight unsubscribe).
    const teardown = (async () => {
      // Wait out setup so there is a registration to unsubscribe (setup may still be in flight under dispose,
      // or a resubscribe-during-teardown awaiting this promise). A failed setup leaves nothing to unwind.
      await entry.setup.catch(() => {});
      if (entry.registered && entry.listener) await entry.registered.unsubscribe(entry.listener);
    })()
      .catch(() => {
        // A completed teardown failure is a one-shot event surfaced ONLY on the debug rail (ADR-0040
        // decision 5): the entry is removed from the map in the finally below, so no ordinary snapshot could
        // ever observe a per-entry flag — the rail line (buffered + replayable) is the sole failure signal.
        syncDebug("live-query teardown-failed", { digest: entry.digest });
      })
      .finally(() => {
        entry.teardownPending = false;
        // Drop the slot only if still ours — a fresh entry never replaces it while we hold the map key, but
        // stay defensive against a future keep-alive path swapping entries under the same fingerprint.
        if (entries.get(entry.key) === entry) entries.delete(entry.key);
        syncDebug("live-query teardown-complete", { digest: entry.digest });
      });
    entry.teardown = teardown;
    pendingTeardowns.add(teardown);
    void teardown.finally(() => pendingTeardowns.delete(teardown));
    return teardown;
  };

  /** Stop retaining an entry (rejoin / eviction / dispose): clear its timer and drop it from the retained set. */
  const cancelEviction = (entry: LiveEntry): void => {
    if (entry.evictionTimer !== undefined) {
      clearTimer(entry.evictionTimer);
      entry.evictionTimer = undefined;
    }
    retained.delete(entry);
  };

  /** Total rows held across all retained (zero-subscriber) entries — the row-budget accumulator. */
  const retainedRowTotal = (): number => {
    let total = 0;
    for (const entry of retained) total += entry.state?.previous.size ?? 0;
    return total;
  };

  // Enforce the retention budgets (ADR-0040 decision 4): while either the count OR the total-row budget is
  // exceeded, evict the LRU retained entry (smallest `lastUsedAt`). Budgets are AUTHORITATIVE over any hint,
  // and ONLY zero-subscriber entries are ever counted or evicted — active entries are untouchable. Run on
  // every transition INTO retained AND after a retained entry's rows grow (queued from the listener).
  const enforceBudgets = (): void => {
    if (disposed) return; // dispose owns teardown; a queued re-check after dispose is a no-op
    while (retained.size > policy.maxRetainedQueries || retainedRowTotal() > policy.maxRetainedRows) {
      // The count budget is checked first, so it is the reason whenever it is the one exceeded (a single
      // over-budget entry that trips both is attributed to the count budget).
      const reason = retained.size > policy.maxRetainedQueries ? "count-budget" : "row-budget";
      let victim: LiveEntry | undefined;
      for (const entry of retained) {
        if (victim === undefined || (entry.lastUsedAt ?? 0) < (victim.lastUsedAt ?? 0)) victim = entry;
      }
      if (victim === undefined) break;
      cancelEviction(victim);
      syncDebug("live-query evicted", { digest: victim.digest, reason });
      void tearDownEntry(victim);
    }
  };

  const onEvictionTimer = (entry: LiveEntry): void => {
    entry.evictionTimer = undefined;
    // Guard the rejoin race: only tear down if the entry is STILL retained and zero-subscriber. A rejoin
    // cancelled the timer and removed it from `retained`; a stale/cancelled timer is a no-op.
    if (entry.torn || !retained.has(entry) || entry.subscribers.size > 0) return;
    retained.delete(entry);
    syncDebug("live-query evicted", { digest: entry.digest, reason: "expiry" });
    void tearDownEntry(entry);
  };

  const removeSubscriber = (entry: LiveEntry, token: symbol): Promise<void> => {
    // Idempotent per subscriber: a second unsubscribe for the same token is a no-op (returns any teardown).
    if (!entry.subscribers.has(token)) return entry.teardown ?? Promise.resolve();
    entry.subscribers.delete(token);
    if (entry.subscribers.size > 0) return Promise.resolve(); // another subscriber still holds the registration
    // ── Last subscriber out (ADR-0040 decision 4) ──: the effective keep-alive is the max of the policy
    // default and the CURRENT generation's max hint — order-independent (see `generationKeepAliveMs`).
    const effective = Math.max(policy.defaultKeepAliveMs, entry.generationKeepAliveMs);
    // Never retain under dispose or on a torn entry: the drain in `dispose()` cancelled all timers and cleared
    // `retained`, so retaining here would re-arm a timer the engine close can no longer cancel (a post-close
    // stale timeout, the hang class decision 1 removed).
    if (effective <= 0 || disposed || entry.torn) return tearDownEntry(entry);
    // Retain: keep the registration + diff state live for the grace period (the listener keeps the state
    // current with zero fan-out), start an eviction timer, and enforce the budgets on this new retention.
    entry.lastUsedAt = now();
    retained.add(entry);
    entry.evictionTimer = setTimer(() => onEvictionTimer(entry), effective);
    syncDebug("live-query retained", { digest: entry.digest, keepAliveMs: effective });
    enforceBudgets();
    return Promise.resolve();
  };

  const refreshEntry = (entry: LiveEntry): Promise<void> => {
    if (entry.torn || !entry.registered) return Promise.resolve();
    // Coalesce PER ENTRY, shared across all subscribers (ADR-0040 plan risk note): concurrent refreshes —
    // e.g. several subscribers finishing hydration together — collapse to ONE underlying `live.refresh()`,
    // whose single diff fans out to everyone. N hydrating subscribers never stack N full reruns. Time the
    // underlying refresh into the entry's diagnostics stats (decision 5).
    if (entry.refreshInFlight === undefined) {
      const startedAt = now();
      entry.refreshInFlight = entry.registered.refresh().finally(() => {
        const ms = now() - startedAt;
        entry.refreshCount++;
        entry.refreshLastMs = ms;
        entry.refreshTotalMs += ms;
        if (ms > entry.refreshMaxMs) entry.refreshMaxMs = ms;
        delete entry.refreshInFlight;
      });
    }
    return entry.refreshInFlight;
  };

  const subscribe = async (
    spec: LiveQuerySpec,
    subscriber: LiveSubscriber,
    opts?: LiveSubscribeOptions,
  ): Promise<LiveSubscription> => {
    // Reject synchronously once disposal has begun (ADR-0040 decision 1): a subscribe that started after
    // dispose would create a registration whose self-teardown nothing awaits — the exact close race.
    if (disposed) throw new Error("[pgxsinkit] live-query subscribe after dispose — the engine is closing");
    const hint = opts?.keepAliveMs;
    if (hint !== undefined && (!Number.isFinite(hint) || hint < 0)) {
      throw new TypeError(`[pgxsinkit] keepAliveMs must be a finite number >= 0 (got ${hint})`);
    }
    // A hint above the signed-32-bit timer ceiling (see MAX_KEEP_ALIVE_MS) would clamp to ~0 and expire
    // immediately — reject it at the boundary, same as the policy default (ADR-0040 decision 4).
    if (hint !== undefined && hint > MAX_KEEP_ALIVE_MS) {
      throw new TypeError(
        `[pgxsinkit] keepAliveMs must be <= ${MAX_KEEP_ALIVE_MS} ms (the platform setTimeout ceiling; got ${hint})`,
      );
    }
    // Reject a param shape that would trip PGlite bug #1055's broken live-query param inlining BEFORE any
    // fingerprinting or registration (see live-query-params-guard.ts). Synchronous, so every subscriber —
    // in-process and worker alike — fails loudly rather than binding wrong rows or hitting a cryptic
    // `format()` error deep inside PGlite.
    assertLiveQueryParamsSafe(spec.materialSql, spec.params);
    const keepAliveMs = hint ?? 0;
    const scope = opts?.scope;
    // Track this whole call so `dispose()` can drain the post-await join before it settles the teardown set —
    // otherwise a join completing mid-dispose would leak.
    let markSetupDone!: () => void;
    const setupDone = new Promise<void>((resolve) => {
      markSetupDone = resolve;
    });
    setups.add(setupDone);

    try {
      const { key, digest } = fingerprintLiveQuery(spec.materialSql, spec.params, spec.pkColumns);

      // Resolve a joinable, non-tearing entry (single-flight over BOTH setup and teardown):
      //   - existing & healthy → join it (shared registration);
      //   - existing & tearing down → await the teardown, then build a fresh entry (resubscribe-during-teardown);
      //   - absent → create it (its `setup` is the shared single-flight registration for concurrent joiners).
      let entry = entries.get(key);
      while (entry && entry.torn) {
        await entry.teardown;
        entry = entries.get(key);
      }
      // Rejoin within grace (ADR-0040 decision 4): a retained zero-subscriber entry is reused verbatim — cancel
      // its eviction NOW (synchronously, before any await) so the timer cannot fire while we join; the snapshot
      // below comes from the still-current diff state, exactly as for an active entry.
      if (entry && retained.has(entry)) cancelEviction(entry);
      // A dedup HIT (ADR-0040 decision 5): we are joining an EXISTING entry (active-join OR retained-rejoin)
      // rather than creating a registration. The first subscriber of a fresh fingerprint is NOT a hit.
      const isDedupHit = entry != null;
      if (!entry) {
        entry = createEntry(key, digest, spec);
        entries.set(key, entry);
      }
      const joined = entry;
      if (isDedupHit) {
        dedupHits++;
        joined.dedupHits++;
        syncDebug("live-query dedup-hit", { digest: joined.digest, dedupHits });
      }

      // Await the SHARED setup: concurrent subscribers to one fingerprint all await the SAME promise, so there
      // is exactly one registration. A failed setup rejects here for every joined waiter (the entry was already
      // removed by `createEntry`'s catch), so a later subscribe starts clean.
      await joined.setup;

      // ── JOIN ATOMICALLY (ADR-0040 decision 2) ─────────────────────────────────────────────────────────
      // Snapshot the entry's CURRENT rows from the shared diff state AND register this subscriber in the
      // fan-out map in ONE synchronous section — there MUST be no `await` between the snapshot and the
      // membership write. A listener fire (computeLiveDiff → deliverDiff) is synchronous, so with no yield here
      // no diff can land between the two: the joiner can neither miss a diff (it would be added to the map
      // first) nor be handed one its snapshot already reflects (the snapshot is taken first). The initial rows
      // come from the diff state, NOT a fresh PGlite read — the registration is already current.
      //
      // Keep-alive GENERATION rule (ADR-0040 decision 4): a 0→1 join opens a new generation and RESETS the
      // entry's generation hint to this joiner's; any later join `max`'s it. The last-out effective keep-alive
      // is `max(default, generationKeepAliveMs)`, so it depends only on the SET of hints in a generation, not
      // the order subscribers leave — equivalent subscriber sets behave identically.
      const firstOfGeneration = joined.subscribers.size === 0;
      joined.generationKeepAliveMs = firstOfGeneration
        ? keepAliveMs
        : Math.max(joined.generationKeepAliveMs, keepAliveMs);
      const token = Symbol("live-subscriber");
      const snapshot = [...joined.state!.previous.values()];
      joined.subscribers.set(token, { subscriber, keepAliveMs, scope });
      try {
        subscriber.deliverInitial(snapshot);
      } catch (error) {
        // A failed initial delivery must not leak membership (the caller gets no handle to unsubscribe with).
        // Roll the token back; if that emptied the entry, tear it down NOW — a failed join never retains.
        joined.subscribers.delete(token);
        if (joined.subscribers.size === 0) void tearDownEntry(joined);
        throw error;
      }
      // ────────────────────────────────────────────────────────────────────────────────────────────────────

      return {
        unsubscribe: () => removeSubscriber(joined, token),
        refresh: () => refreshEntry(joined),
      };
    } finally {
      setups.delete(setupDone);
      markSetupDone();
    }
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    // Cancel every retention timer up front so none can fire mid-dispose.
    for (const entry of entries.values()) {
      if (entry.evictionTimer !== undefined) {
        clearTimer(entry.evictionTimer);
        entry.evictionTimer = undefined;
      }
    }
    retained.clear();
    // DRAIN to a stable empty state rather than a single snapshot: an in-flight subscribe (in `setups`) can
    // complete its join AFTER a one-shot teardown pass and leave a registration whose teardown nothing awaits
    // — the close race. `disposed` blocks NEW subscribes (they throw), and every teardown deletes its entry,
    // so this loop terminates once no setup, entry, or teardown remains.
    while (setups.size > 0 || entries.size > 0 || pendingTeardowns.size > 0) {
      await Promise.allSettled([...setups]);
      for (const entry of entries.values()) void tearDownEntry(entry);
      await Promise.allSettled([...pendingTeardowns]);
    }
  };

  const snapshot = (): LiveQueryDiagnostics[] => {
    const records: LiveQueryDiagnostics[] = [];
    for (const entry of entries.values()) {
      const isRetained = retained.has(entry);
      const scopes = new Set<string | undefined>();
      for (const { scope } of entry.subscribers.values()) scopes.add(scope);
      records.push({
        digest: entry.digest,
        subscriberCount: entry.subscribers.size,
        scopeCount: scopes.size,
        rowCount: entry.state?.previous.size ?? 0,
        retained: isRetained,
        dedupHits: entry.dedupHits,
        createdAt: entry.createdAt,
        setupMs: entry.setupMs ?? null,
        refresh: {
          count: entry.refreshCount,
          lastMs: entry.refreshLastMs ?? null,
          totalMs: entry.refreshTotalMs,
          maxMs: entry.refreshMaxMs,
        },
        lastUsedAt: entry.lastUsedAt ?? null,
        retainedSinceMs: isRetained && entry.lastUsedAt != null ? Math.max(0, now() - entry.lastUsedAt) : null,
        teardownPending: entry.teardownPending,
      });
    }
    return records;
  };

  return { subscribe, dispose, snapshot };
}
