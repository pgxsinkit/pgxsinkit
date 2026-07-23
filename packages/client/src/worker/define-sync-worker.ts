// The worker entry factory (ADR-0032 S2, decisions 3/4/6/7). `defineSyncWorker` boots ONE sync engine and
// fans it out to N attached tabs over the bridge. The first attach boots the engine by calling the
// unchanged `createSyncClient` (the strongest form of "reuse createSyncClient internals" — the in-process
// boot pipeline runs verbatim, so the unit suite stays its equivalence proof); later attaches join it.
//
// It serves BOTH a native `SharedWorker` (`onconnect`, many ports) and a dedicated `Worker` (one implicit
// port) behind {@link SyncWorkerHost.connect} — the same entry a test drives with a plain `MessageChannel`
// port, so no real Worker is needed to exercise the whole protocol.

import { type ParserOptions, type QueryOptions, types } from "@electric-sql/pglite";

import type { SyncRuntimeStatus, SyncTableName, SyncTableRegistry, WriteMode } from "@pgxsinkit/contracts";
import { getSyncRegistryStorage } from "@pgxsinkit/contracts";

import { type ConvergenceTrigger, createIntervalConvergenceTrigger } from "../convergence";
import { setSyncDebugSink, syncDebug } from "../debug";
import { describeErrorChain } from "../error-chain";
import {
  type AdoptionDeclaration,
  type ClientPGlite,
  createClientPGlite,
  type CreateSyncClientOptions,
  createSyncClient,
  type DataExportOptions,
  type DiagnosticExportOptions,
  type MutationBatchItem,
  type RawQueryOptions,
  type StoreExportOptions,
  type SyncClient,
} from "../index";
import { wrapLiveQueryForMaterialization } from "../live-rows-sql";
import type { LocalStoreVersionEvent } from "../local-store";
import { type PlacementProbeResult, probeOpfsSyncAccess } from "../placement-probe";
import { META_STORE_UNAVAILABLE, readStoreMetaRecord } from "../store-meta";
import { readTestStoreMarker, TEST_STORE_BACKEND, type TestStoreMarker } from "../store-path";
import {
  assertSameExecutionLimit,
  type EngineControlMessage,
  type EngineIdentity,
  ExecutionLimitMismatchError,
  executionLimitMismatchToWire,
  type ExecutionLimitConfig,
  readControlEnvelope,
  shouldApplyControlMessage,
  wrapControlEnvelope as controlEnvelope,
} from "./engine-control";
import { createEngineRouter, type EngineRouter, type RouterPort } from "./engine-router";
import {
  createLiveQueryManager,
  type LiveQueryManager,
  type LiveSubscription,
  validateLiveQueryPolicy,
} from "./live-query-manager";
import {
  type AttachPayload,
  type BootMilestone,
  type BridgeCodec,
  type BridgeEnvelope,
  type BridgeEvent,
  type BridgePort,
  type ExportArtefactWire,
  type GuardedQueryWireArgs,
  identityCodec,
  isBridgeEnvelope,
  postBridgeMessage,
  type ProvisionPayload,
  type RpcOp,
  type RpcPayload,
  type SetOnlinePayload,
  type SubscribePayload,
  type TokenResponsePayload,
} from "./protocol";
import { decideSwPlacement, type SwPlacementResult } from "./sw-placement";
import { createWorkerTokenCache } from "./token-cache";

// The identity-parser map a guarded bridge read re-applies before executing (ADR-0032 decision 4). It
// MIRRORS the fixed `parsers` constant in `drizzle-orm/pglite`'s session VERBATIM (pinned to
// drizzle-orm@1.0.0-rc.4, `drizzle-orm/pglite/session.js`): identity parsers so the listed OIDs come back as
// raw STRINGS — exactly what the in-process drizzle session receives, because it passes this same map into
// `pglite.query`. The members are: the scalar OIDs `types.TIMESTAMP` / `TIMESTAMPTZ` / `INTERVAL` / `DATE`,
// and the array OIDs 1115 = `timestamp[]`, 1185 = `timestamptz[]`, 1187 = `interval[]`, 1182 = `date[]`, and
// 1231 = `numeric[]` (NOT temporal — drizzle's list is mirrored verbatim, whatever its members). Over the
// bridge the map is FUNCTIONS (non-serializable), so the attach side strips the options down to `rowMode`
// and this worker re-applies the identical map. We do NOT import drizzle's private constant — this is a
// deliberate, version-pinned mirror.
const identityParser = (value: string): string => value;
const DRIZZLE_PGLITE_IDENTITY_PARSERS: ParserOptions = {
  [types.TIMESTAMP]: identityParser,
  [types.TIMESTAMPTZ]: identityParser,
  [types.INTERVAL]: identityParser,
  [types.DATE]: identityParser,
  1231: identityParser,
  1115: identityParser,
  1185: identityParser,
  1187: identityParser,
  1182: identityParser,
};

export interface DefineSyncWorkerOptions<TRegistry extends SyncTableRegistry> {
  /**
   * The sync registry — imported as CODE by the worker file, never cloned into it (ADR-0032 decision 4).
   * When {@link resolveRegistry} is also given this is the DEFAULT (used when the attach carries no role
   * or an unknown one).
   */
  registry: TRegistry;
  /**
   * Resolve the registry to boot from the attach's `config.role` (ADR-0032 S3). A single worker file can
   * bake BOTH role variants (e.g. the board's admin/member registries — same TS shape, different write
   * capability) and pick per-attach, which the spare flow needs: the spare is provisioned role-agnostic
   * (before the user is known) and the role is only settled at claim/attach. Returns `undefined` to fall
   * back to {@link registry}.
   */
  resolveRegistry?: (role: string | undefined) => TRegistry | undefined;
  /**
   * How the worker creates its raw PGlite store (provision + fresh-attach paths). Defaults to
   * {@link createClientPGlite}, which loads PGlite's own boot assets — in a browser worker those hit the
   * same-origin HTTP cache the tab's login-screen warm already primed (ADR-0032 S3). Injected in tests.
   * Takes a plain store PATH (ADR-0036); the internal `backendOverride` is the test lane's memory selection.
   */
  createPglite?: (storePath: string, backendOverride?: "memory") => Promise<ClientPGlite>;
  /**
   * ADR-0049 (capability-driven engine placement) decision 7, plan step 11b: the consumer's explicit
   * reconstructibility DECLARATION authorizing AUTOMATIC adoption of an existing idb-authoritative store into a
   * committed OPFS successor. A worker-ENTRY option (baked into the worker file as code, like
   * {@link executionLimit}), NEVER an attach option — a tab cannot set it (adoption DELETES local-only data, so
   * only the code author may authorize it). Forwarded verbatim to the {@link createSyncClient} boot below. DEFAULT
   * OFF (`undefined`): hook absence is never authority — only `"server-reconstructible"` (or the manual
   * `adoptStore` API) authorizes deleting the idb predecessor. Honoured only where the engine home grants OPFS
   * access (SW-direct / elected placement); inert on the browser-idb fallback where there is no opfs successor.
   */
  adoption?: AdoptionDeclaration;
  electricUrl: string;
  batchWriteUrl: string;
  /** Static headers on every read + write request (e.g. a gateway `apikey`). See `createSyncClient`. */
  requestHeaders?: Record<string, string>;
  /** Write-only headers merged over {@link requestHeaders} (e.g. region/DB-affinity). See `createSyncClient`. */
  writeRequestHeaders?: Record<string, string>;
  /** Default plain store PATH (ADR-0036) if the first attach carries none — a name, not a storage URL. */
  storePath?: string;
  maxMutationAttempts?: number;
  syncEnabled?: boolean;
  /**
   * How close to expiry (ms) a cached token may be before a read/write that needs it triggers a pull
   * broadcast (ADR-0032 decision 3). Default 30s — comfortably ahead of a long-poll cycle.
   */
  tokenExpiryMarginMs?: number;
  /**
   * The worker's own convergence cadence (ms) — the interval trigger FALLBACK only. Local writes
   * flush immediately via the event-driven `requestPass` seam and tab `wake` signals, so this
   * interval exists purely for retry/recovery sweeps; each idle pass still costs real worker CPU
   * (`flush` + `reconcile` queries). Default 15000.
   */
  convergenceIntervalMs?: number;
  /**
   * The opt-in engine-construction EXECUTION LIMIT (ADR-0049 D5), threaded into the ROUTER when this
   * SharedWorker lands in `elected-worker` placement (router-only mode). DISABLED by default (`undefined` /
   * absent `maxDispatchMs`) — no finite worst-case query duration exists, so an absent limit means the router
   * forwards no probe and queries run unbounded; enabling it is a deliberate consumer choice.
   * Elected placement ONLY: on SW-direct (`shared-worker`) the engine home is in-scope and there is no control
   * channel to probe, so an enabled value is rejected as unsupported before engine boot.
   */
  executionLimit?: ExecutionLimitConfig;
  /** Injected transport binder. Defaults to auto-detecting the SharedWorker/dedicated-worker global scope. */
  installGlobal?: boolean;
  /** Injected codec (ADR-0032 S2 §1). Defaults to the v1 identity codec. */
  codec?: BridgeCodec;
  /**
   * A raw PGlite the worker uses instead of creating its own (forwarded to `createSyncClient`'s
   * {@link CreateSyncClientOptions.precreatedPglite}) — the client still applies schema/reconcile. In a
   * browser worker the store is minted internally (`storePath`); this is the seam for a prepopulated store in
   * tests, and the future spare-worker claim (ADR-0032 decision 5).
   */
  precreatedPglite?: CreateSyncClientOptions<TRegistry>["precreatedPglite"];
  /** A fully-provisioned PGlite (forwarded to {@link CreateSyncClientOptions.pgliteInstance}; caller owns schema). */
  pgliteInstance?: CreateSyncClientOptions<TRegistry>["pgliteInstance"];
  /**
   * App-level schema prep run IN THE WORKER, against the engine's own local store, BEFORE the registry
   * schema exec — forwarded verbatim to {@link CreateSyncClientOptions.prepareLocalDbBeforeSchema}, same
   * timing as the in-process client. This is a worker-ENTRY option (baked into the worker file as code),
   * NOT an attach option: the hook is a function and functions cannot cross the bridge, so a tab can never
   * supply it — the worker owns it. Use it for DDL that must precede the registry's local tables (extensions,
   * a bespoke schema search_path). On a fresh store the registry-derived local tables do NOT yet exist when
   * this runs (that ordering is what distinguishes it from {@link prepareLocalDbAfterSchema}).
   *
   * Runs on the storePath, {@link precreatedPglite}, and restore boots; SKIPPED entirely on the
   * {@link pgliteInstance} path (the caller owns schema/prepare/reconcile there). On a restore boot it still
   * runs, but the store already carries the registry tables from the backup's datadir, so the "tables absent"
   * invariant does not hold there.
   */
  prepareLocalDbBeforeSchema?: CreateSyncClientOptions<TRegistry>["prepareLocalDbBeforeSchema"];
  /**
   * App-level schema prep run IN THE WORKER, against the engine's own local store, AFTER the registry schema
   * exec — forwarded verbatim to {@link CreateSyncClientOptions.prepareLocalDbAfterSchema}, same timing as the in-process
   * client. Like {@link prepareLocalDbBeforeSchema} this is a worker-ENTRY option, never an attach option (the
   * tab never sees it — functions cannot cross the bridge). Use it for app-level indexes, views, or migrations
   * that depend on the registry's local tables, which DO exist by the time this runs.
   *
   * Runs on the storePath, {@link precreatedPglite}, and restore boots; SKIPPED entirely on the
   * {@link pgliteInstance} path (the caller owns schema/prepare/reconcile there).
   */
  prepareLocalDbAfterSchema?: CreateSyncClientOptions<TRegistry>["prepareLocalDbAfterSchema"];
  /**
   * Bounded zero-subscriber keep-alive for the live-query manager (ADR-0040 decision 4). When an entry's last
   * subscriber leaves, a nonzero effective keep-alive retains its PGlite registration + diff state for a grace
   * period so a matching resubscribe (e.g. a re-mounted route across tabs) reuses it verbatim — no ~400 ms
   * re-materialization. Bounded by explicit budgets; DEFAULTS OFF (`defaultKeepAliveMs: 0` → tear a query
   * down the instant its last consumer leaves). The 0 default is justified: a retained entry STILL pays a
   * full SQL rerun + diff on every dependent write — PGlite live queries cannot be paused — so retention
   * only pays off for a genuinely hot, re-mounted query, and the default keeps worker memory bounded with
   * no surprise standing SQL reruns.
   */
  liveQueries?: {
    /** Baseline retention (ms) for a zero-subscriber entry; floored by each subscriber's own hint. Default 0. */
    defaultKeepAliveMs?: number;
    /** Max simultaneously-retained (zero-subscriber) entries — LRU-evicted past this. Default 16. */
    maxRetainedQueries?: number;
    /** Max total rows across all retained entries — LRU-evicted past this. Default 50_000. */
    maxRetainedRows?: number;
  };
}

/** The worker-side host: attach ports, await the boot, and (for tests) tear down. */
export interface SyncWorkerHost<TRegistry extends SyncTableRegistry> {
  /** Bind a transport port (a SharedWorker connection, the dedicated-worker `self`, or a test channel port). */
  connect: (port: BridgePort) => void;
  /** Resolves with the booted in-process engine once the first attach's `createSyncClient` completes. */
  whenBooted: () => Promise<SyncClient<TRegistry>>;
  /** Detach every port and stop the underlying client — for tests and dedicated-worker teardown. */
  close: () => Promise<void>;
}

interface LiveSub {
  // The manager-owned handle: `unsubscribe()` (awaited teardown, tracked inside the manager — ADR-0040
  // decision 1) and a coalesced `refresh()` the hydration chain drives.
  subscription: LiveSubscription;
  port: BridgePort;
}

/**
 * Build a worker host over the given engine config. In a real worker file the consumer calls this at module
 * top level and it auto-binds the global scope; a test constructs it and drives {@link SyncWorkerHost.connect}.
 */
export function defineSyncWorker<const TRegistry extends SyncTableRegistry>(
  options: DefineSyncWorkerOptions<TRegistry>,
): SyncWorkerHost<TRegistry> {
  // Fail at construction, not first subscribe, on a bad keep-alive policy (ADR-0040 decision 4 — bounded).
  validateLiveQueryPolicy(options.liveQueries);
  const codec = options.codec ?? identityCodec;
  const tokenExpiryMarginMs = options.tokenExpiryMarginMs ?? 30_000;
  const convergenceIntervalMs = options.convergenceIntervalMs ?? 15_000;
  // ADR-0049 D1: the placement probe's OPFS grant for THIS SharedWorker lifetime. Set true only by a GRANTED
  // `shared-worker` (SW-direct) probe, so both the provision-mint (default `createPglite` factory) and the boot
  // create (below) resolve the OPFS-repacked backend. False is the honest capability-absence invariant — the
  // engine home in this scope opens IDBFS: the registry-declared `backend: "idbfs"` mode (no probe ran), or a
  // capability-absence fallback (every home's probe denied / the OPFS API absent). Read at CALL time — every mint
  // that consults it runs only after a port has connected, and connections are gated on the resolved placement.
  let placementOpfsAccess = false;
  // ADR-0049 D1/D12: the verbatim reason this scope's engine opened IDBFS while OPFS was CAPABLE (a fallback,
  // not the declared-idbfs mode). Set alongside `placementOpfsAccess = false` by the bootstrap's capability-absence
  // fallback outcome; threaded into the boot's `storageFallbackReason`. Absent for a granted opfs boot AND for the
  // declared `backend: "idbfs"` mode (that is the contract, not a fallback — no reason to report).
  let placementFallbackReason: string | undefined;
  // ADR-0049 decision 12 (diagnostics): the resolved engine home for THIS SharedWorker scope, threaded into the
  // boot's {@link BootReport} (`engineHome`). Set alongside `placementOpfsAccess` when the placement decision
  // resolves. Both the SharedWorker and an elected dedicated-engine worker run the probe; only a plain test/Node
  // scope that has no browser placement omits `engineHome`.
  let placementEngineHome: SwPlacementResult["engineHome"] | undefined;
  // ADR-0049 step 10b (bug fix — elected engine self-probe): the boot's OPFS grant may be decided ASYNCHRONOUSLY
  // (the SharedWorker placement decision, or — for the elected DEDICATED engine — that scope's own OPFS probe).
  // Both resolve BEFORE the first attach in practice, but the elected engine's probe races the incoming
  // `connect-port` pipe, so `boot()` AWAITS this gate before reading `placementOpfsAccess`/`placementEngineHome` —
  // guaranteeing the grant is threaded into the boot options (invariant 8: probed per boot, never assumed). Opened
  // by {@link bootstrapWorkerScope}'s `onPlacement` (SharedWorker decision OR dedicated-engine probe OR the plain
  // test/Node scope's immediate settle); opened immediately when no global bootstrap runs (`installGlobal:false`).
  let openPlacementGate!: () => void;
  const placementGate = new Promise<void>((resolve) => {
    openPlacementGate = resolve;
  });
  // Durability (ADR-0047) is registry-declared. The provision/spare mint does not run through
  // `createSyncClient` (which resolves it for the boot create), so resolve it here off the DEFAULT registry —
  // provision is role-agnostic (the role is settled only at claim/attach), and durability binds every store
  // this worker mints regardless of role — and thread the resolved mode into the internal carrier.
  const provisionDurability = getSyncRegistryStorage(options.registry)?.durability ?? "relaxed";
  const createPglite =
    options.createPglite ??
    ((storePath: string, backendOverride?: "memory") =>
      createClientPGlite(storePath, {
        ...(backendOverride ? { backendOverride } : {}),
        durability: provisionDurability,
        // SW-direct placement grant (ADR-0049 D1): a spare minted in-scope opens OPFS-repacked, matching the boot.
        ...(placementOpfsAccess ? { hasOpfsSyncAccess: true } : {}),
      }));
  // A testing acknowledgment (ADR-0036) spread into THIS worker's options — needed when a test injects a
  // non-persistent BYO store (`precreatedPglite` / `pgliteInstance` / a memory-returning `createPglite`),
  // which `createSyncClient` would otherwise refuse. Forwarded to the boot below. A browser worker never
  // sets it; a memory selection carried on the attach wire wins over it.
  const workerTestMarker = readTestStoreMarker(options);

  const ports = new Set<BridgePort>();
  const liveSubs = new Map<string, LiveSub>();
  // The live-query lifecycle (PGlite registration, diff listener, and the ADR-0040 decision-1 awaited-teardown
  // set) lives in a single manager owned per engine. Created lazily on first subscribe because it needs the
  // booted client's `live` namespace (`active.pglite.live`); the worker never restarts its engine in place
  // (ADR-0040 decision 7), so one manager serves the host's whole lifetime. `close()` disposes it.
  let liveManager: LiveQueryManager | null = null;
  const ensureLiveManager = (active: SyncClient<TRegistry>): LiveQueryManager =>
    (liveManager ??= createLiveQueryManager({
      live: active.pglite.live,
      ...(options.liveQueries ? { policy: options.liveQueries } : {}),
    }));
  // Subscribes that have entered `handleSubscribe` but not yet reached `liveSubs.set` (they are mid-await on
  // prepareQuery / hydration / manager setup). Registered SYNCHRONOUSLY at entry, keyed by `queryId`, so an
  // `unsubscribe`/`detach` arriving during those awaits can mark the pending subscribe CANCELLED — otherwise
  // it would finish and store a subscription for an already-gone port, escaping the awaited-teardown boundary
  // (ADR-0040 decision 1). Removed in `handleSubscribe`'s finally.
  const pendingSubscribes = new Map<string, { port: BridgePort; cancelled: boolean }>();
  // Host shutdown state (ADR-0040 decision 1 — the pending-before-manager close race). `close()` flips
  // `closing` and awaits every in-flight `handleSubscribe` task BEFORE disposing the manager, so a subscribe
  // still mid-await when close begins can neither create a registration afterwards (it early-bails on
  // `closing`) nor escape the awaited-teardown boundary. `inFlightSubscribes` holds each whole-call task.
  let closing = false;
  const inFlightSubscribes = new Set<Promise<void>>();
  // One stable, opaque diagnostics scope per bridge port (ADR-0040 decision 5) — so a snapshot's `scopeCount`
  // reads as the distinct-tab count. Never part of the fingerprint; a lazy per-port counter.
  const portScopes = new WeakMap<BridgePort, string>();
  let nextScopeId = 0;
  const scopeForPort = (port: BridgePort): string => {
    let scope = portScopes.get(port);
    if (scope === undefined) {
      scope = `port-${nextScopeId++}`;
      portScopes.set(port, scope);
    }
    return scope;
  };

  // ─── Pre-spawned (schemaless) store — the spare flow (ADR-0032 decision 5) ────────────────────────
  // A `provision` mints the raw PGlite (initdb only) and holds it idle here; the first real `attach`
  // adopts it as `precreatedPglite` (the client still runs schema/journal recovery/reconcile). Provision
  // is role-agnostic — the registry is chosen at attach — so the same warmed store serves either role.
  // `stamp` carries the spare's create timing (ADR-0034): a boot adopting this store reports the initdb cost
  // as `BootReport.provision` (with `phases.pgliteCreateMs = null`) instead of timing a create it never ran.
  let provisioned: {
    storePath: string;
    pglite: Promise<ClientPGlite>;
    stamp: Promise<{ initdbMs: number; provisionReadyAt: number }>;
  } | null = null;
  // A provision request performs a bounded authority read before it may mint. An attach that arrives during
  // that read waits for the attempt to settle, then either adopts the minted store or runs the ordinary boot
  // path. This keeps provision a pure accelerator without racing a replacement underneath live deletion.
  let provisionAttempt: Promise<void> | null = null;

  // ─── Outbound-convergence gate — the tab's Offline toggle over the bridge (ADR-0032 S3) ───────────
  // The worker owns convergence; the tab forwards its Offline flag as `set-online`. When suppressed the
  // interval trigger's `shouldConverge` returns false (writes stage in the journal, unsent) and a `wake`
  // is ignored; resuming fires one immediate pass so the queue flushes at once.
  let convergenceSuppressed = false;
  let fireConvergence: (() => void) | null = null;
  const baseTrigger = createIntervalConvergenceTrigger(convergenceIntervalMs);
  const gatedTrigger: ConvergenceTrigger = {
    subscribe: (onSignal) => {
      fireConvergence = onSignal;
      const unsubscribe = baseTrigger.subscribe(onSignal);
      return () => {
        fireConvergence = null;
        unsubscribe();
      };
    },
    shouldConverge: () => !convergenceSuppressed && baseTrigger.shouldConverge(),
  };

  // ─── The single auth token cache + pull mechanism (ADR-0032 decision 3) ──────────────────────────
  const tokenCache = createWorkerTokenCache({
    marginMs: tokenExpiryMarginMs,
    broadcastRequest: (requestId) => {
      syncDebug("worker token pull broadcast", { requestId, tabs: ports.size });
      broadcast("token-request", { requestId });
    },
  });
  const getWorkerAuthToken = () => tokenCache.getToken();

  // ─── The broadcast event channel (ADR-0032 decision 7) ───────────────────────────────────────────
  const seenReadyGroups = new Set<string>();
  const broadcast = (type: BridgeEnvelope["type"], payload: unknown) => {
    for (const port of ports) postBridgeMessage(port, codec, type, payload);
  };
  const broadcastEvent = (event: BridgeEvent) => broadcast("event", event);

  // ─── Debug-rail buffer + replay (ADR-0034) ───────────────────────────────────────────────────────
  // The engine boots on the first ATTACH, but the front half of boot (provision, and the boot rail's
  // schema/journal/reconcile lines) can be emitted before any debug-enabled tab is listening — so they
  // vanished. Install the sink at construction (not at boot) into a bounded ring buffer, so the whole boot
  // is captured from worker start; the buffer is REPLAYED (marked `[replay]`) to the first attach, while the
  // back half streams live over the bridge. Bounded so a long-lived worker never grows the buffer unbounded.
  const RAIL_BUFFER_MAX = 500;
  const railBuffer: Array<{ stamp: number; line: string; data?: Record<string, unknown> }> = [];
  let railReplayed = false;
  setSyncDebugSink((line, stamp, data) => {
    if (railBuffer.length >= RAIL_BUFFER_MAX) railBuffer.shift();
    railBuffer.push({ stamp, line, ...(data ? { data } : {}) });
    broadcastEvent({ kind: "debug", stamp, line, ...(data ? { data } : {}) });
  });
  const nowStamp = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  // Replay the pre-attach rail buffer to the first attaching port. Taken as a snapshot BEFORE this attach's
  // boot runs, so the boot's own lines (which stream live to this now-connected port) are never doubled.
  const replayRailBufferTo = (port: BridgePort) => {
    if (railReplayed) return;
    railReplayed = true;
    const buffered = [...railBuffer];
    postBridgeMessage(port, codec, "event", {
      kind: "debug",
      stamp: nowStamp(),
      line: `[replay] replaying ${buffered.length} buffered rail line(s)`,
    } satisfies BridgeEvent);
    for (const entry of buffered) {
      postBridgeMessage(port, codec, "event", {
        kind: "debug",
        stamp: entry.stamp,
        line: `[replay] ${entry.line}`,
        ...(entry.data ? { data: entry.data } : {}),
      } satisfies BridgeEvent);
    }
  };

  const emitStatus = (status: SyncRuntimeStatus) => {
    broadcastEvent({ kind: "status", status });
    // Derive a per-group `groupReady` event for each group that newly reached ready, so a tab gets both the
    // status snapshot (`status.groups`) and a discrete edge to await (ADR-0032 decision 6/7).
    for (const [groupKey, ready] of Object.entries(status.groups ?? {})) {
      if (ready && !seenReadyGroups.has(groupKey)) {
        seenReadyGroups.add(groupKey);
        broadcastEvent({ kind: "groupReady", groupKey });
      }
    }
  };

  // ─── Engine boot — reuse createSyncClient verbatim (ADR-0032 decision 1/4) ────────────────────────
  let client: SyncClient<TRegistry> | null = null;
  let bootPromise: Promise<SyncClient<TRegistry>> | null = null;
  // The role the engine actually booted with (from the FIRST attach's config). Later attaches compare
  // their requested role against this and get a warning on mismatch (ADR-0032 FIX 5) — never a reject.
  let bootedRole: string | undefined;
  // The engine's `ready` is monotonic: once its initial sync lands it stays resolved even if the phase
  // later degrades. A tab attaching AFTER that moment must still get a resolved `ready`, so track whether
  // it has fired and tell the ack (ADR-0032 FIX 3).
  let engineReadyFired = false;
  let resolveBooted!: (client: SyncClient<TRegistry>) => void;
  const bootedPromise = new Promise<SyncClient<TRegistry>>((resolve) => {
    resolveBooted = resolve;
  });

  // ─── Boot milestone bridge (ADR-0041 stage 2) ────────────────────────────────────────────────────
  // One engine crosses each background boot stage once. Broadcast a one-shot `milestone` as it crosses
  // `writeReady`/`bootSettled` (or a `milestone-error` if the tail rejects the stage), and FOLD the current
  // set into every `attach-ack` so a tab that attached after a stage fired resolves it from the ack. The
  // ack itself fires AT `localReadReady` (the Option B contract), so that stage needs no milestone. Wired
  // exactly once off the booted client's stage promises (`milestonesWired`), then driven purely by them.
  const milestones = { writeReady: false, bootSettled: false };
  const stageErrors: {
    writeReady?: { message: string; detail?: unknown };
    bootSettled?: { message: string; detail?: unknown };
  } = {};
  let milestonesWired = false;
  const markMilestone = (stage: BootMilestone) => {
    if (milestones[stage]) return;
    milestones[stage] = true;
    broadcastEvent({ kind: "milestone", stage });
  };
  const failMilestone = (stage: BootMilestone, error: unknown) => {
    if (stageErrors[stage]) return;
    const serialized = serializeError(error);
    stageErrors[stage] = serialized;
    broadcastEvent({ kind: "milestone-error", stage, error: serialized });
  };
  // Attach-ack fold fields for a LATE attach — the milestones/failures already crossed at ack time.
  const milestoneAckFields = () => ({
    ...(milestones.writeReady ? { writeReady: true as const } : {}),
    ...(milestones.bootSettled ? { bootSettled: true as const } : {}),
    ...(stageErrors.writeReady ? { writeReadyError: stageErrors.writeReady } : {}),
    ...(stageErrors.bootSettled ? { bootSettledError: stageErrors.bootSettled } : {}),
  });

  const boot = async (attach: AttachPayload): Promise<SyncClient<TRegistry>> => {
    await placementGate;
    // Provision owns no recovery policy. Wait only for its bounded pre-mint check/create attempt; a declined
    // attempt leaves `provisioned` null and this attach continues through createSyncClient's full phase machine.
    await provisionAttempt?.catch(() => undefined);
    const attachLimit = attach.executionLimit?.maxDispatchMs;
    if (placementEngineHome === "shared-worker" && attachLimit !== undefined) {
      throw new Error(
        "[pgxsinkit] executionLimit is unsupported for SharedWorker-direct placement; it is available only " +
          "when the engine runs in elected-worker placement (ADR-0049 D5).",
      );
    }
    assertSameExecutionLimit(options.executionLimit?.maxDispatchMs, attachLimit);
    if (bootPromise) return bootPromise;
    // The tab is the auth owner: seed the cache with the token it presented at attach (decision 3).
    tokenCache.push(attach.token);
    bootedRole = attach.config?.role;
    // The debug-rail sink is installed at construction (ADR-0034) so it buffers from worker start and
    // forwards live to tabs, stamped with the WORKER's monotonic clock (decision 7) — see above.
    // Resolve the registry from the attach's role (ADR-0032 S3): a single worker file bakes both variants
    // and the claim/attach settles which one boots — the spare was provisioned before the role was known.
    const registry = options.resolveRegistry?.(attach.config?.role) ?? options.registry;
    // storePath-first, matching the `provision` handler's resolution (below): the board sends BOTH a bare
    // `storeId` (SharedWorker naming, tab-side) AND the real `storePath` (`pgxsinkit-board-<id>`), and the
    // PGlite store lives at `storePath` — so the provisioned store's path must be what we adopt on.
    // `storeId` is only a last-ditch fallback for a caller that passes it as the store path.
    const storePath = attach.storePath ?? attach.storeId ?? options.storePath ?? "pgxsinkit-overlay-v1";
    // The testing memory-backend override rides as an explicit wire field (a symbol does not survive
    // structured clone, ADR-0036); re-stamp it as the internal marker on the createSyncClient options below.
    // A memory selection on the attach wins over the worker's own acknowledgment (memory implies acknowledged).
    const backendOverride = attach.testStoreBackend;
    const testMarker: TestStoreMarker | undefined = backendOverride === "memory" ? "memory" : workerTestMarker;
    // Restore (ADR-0035 decision 6): the tab decomposed the backup into a transferred `ArrayBuffer` + mime
    // (`RestoreArtefactWire`); recompose a `Blob` to hand `createSyncClient` as `restoreFrom`. Restore OWNS the
    // store's creation (a `loadDataDir` seed), so it is mutually exclusive with adopting a pre-provisioned or
    // caller-supplied instance — when restoring, we suppress the adopt paths below rather than let
    // createSyncClient throw the exclusion error.
    const restoreFrom = attach.restore
      ? new Blob([attach.restore.buffer], { type: attach.restore.mimeType })
      : undefined;
    // Adopt a matching pre-provisioned store (its initdb already ran off-thread) as `precreatedPglite`;
    // createSyncClient falls back to a fresh `storePath` create if that promise rejects — a pure accelerator.
    // Never adopt when restoring (restore boots a brand-new store from the backup, not the provisioned one).
    const adoptingProvisioned = restoreFrom == null && provisioned != null && provisioned.storePath === storePath;
    const precreatedPglite = adoptingProvisioned
      ? provisioned!.pglite
      : restoreFrom
        ? undefined
        : options.precreatedPglite;
    // The adopted spare's create timing feeds `BootReport.provision` (ADR-0034); absent otherwise.
    const provisionStamp = adoptingProvisioned ? provisioned!.stamp : undefined;
    if (adoptingProvisioned) {
      syncDebug("worker adopting provisioned store", { storePath });
    }
    if (restoreFrom) {
      syncDebug("worker restoring store from backup", { storePath, byteLength: attach.restore!.buffer.byteLength });
    }
    // Gate the store create on the resolved placement grant (ADR-0049 step 10b, elected-engine self-probe fix):
    // `placementOpfsAccess` / `placementEngineHome` are read INSIDE this `.then`, after the probe settles, so the
    // elected dedicated engine boots the OPFS-repacked backend it actually holds instead of racing to `idbfs`.
    bootPromise = createSyncClient<TRegistry>({
      registry,
      electricUrl: options.electricUrl,
      batchWriteUrl: options.batchWriteUrl,
      storePath,
      // Re-stamp the internal testing marker (ADR-0036) so `createSyncClient`'s option handling selects the
      // memory backend on its fallback create and/or bypasses the BYO refusal for an injected test store —
      // the wire field / worker acknowledgment are the cross-clone carriers for it.
      ...(testMarker ? { [TEST_STORE_BACKEND]: testMarker } : {}),
      // Restore rides the boot attach (ADR-0035 decision 6): createSyncClient seeds the fresh store via
      // `loadDataDir`, boots offline, and quarantines the recovered journal.
      ...(restoreFrom ? { restoreFrom } : {}),
      // Boot observability (ADR-0034): label the report `worker`, and forward the provision stamp so an
      // adopted spare's initdb cost is reported rather than a create this boot never ran.
      bootMode: "worker",
      // ADR-0049 decision 12 diagnostics: stamp the resolved engine home into the BootReport. This is
      // `"shared-worker"` for the in-scope host or `"elected-worker"` for the elected dedicated engine; it is
      // omitted only for a plain test/Node scope with no browser placement.
      ...(placementEngineHome ? { engineHome: placementEngineHome } : {}),
      ...(provisionStamp ? { provisionStamp } : {}),
      ...(precreatedPglite ? { precreatedPglite } : {}),
      ...(options.pgliteInstance && restoreFrom == null ? { pgliteInstance: options.pgliteInstance } : {}),
      // App-level schema prep runs IN THE WORKER around the registry schema exec (before/after), exactly as
      // the in-process client. Worker-entry options, not attach options: functions cannot cross the bridge.
      ...(options.prepareLocalDbBeforeSchema ? { prepareLocalDbBeforeSchema: options.prepareLocalDbBeforeSchema } : {}),
      ...(options.prepareLocalDbAfterSchema ? { prepareLocalDbAfterSchema: options.prepareLocalDbAfterSchema } : {}),
      // Durability (ADR-0047) is registry-declared: `createSyncClient` resolves it from `registry` at its own
      // mint seam, so this boot needs no durability forward — the same `registry` decides the boot create's mode.
      // SW-direct placement grant (ADR-0049 D1): thread a GRANTED probe's grant into the boot create so the engine
      // home in this SharedWorker scope opens the OPFS-repacked backend. Absent (false) is the honest IDBFS home —
      // the declared `backend: "idbfs"` mode or a capability-absence fallback. `createSyncClient` forwards it to
      // its `createClientPGlite` boot create.
      ...(placementOpfsAccess ? { hasOpfsSyncAccess: true } : {}),
      // ADR-0049 D1/D12: on a capability-absence fallback (OPFS was capable but no home could hold handles) the
      // engine boots IDBFS and stamps this verbatim reason into the BootReport's `storageFallbackReason`. Absent
      // on a granted opfs boot and on the declared-idbfs mode (which is the contract, not a fallback).
      ...(placementFallbackReason ? { storageFallbackReason: placementFallbackReason } : {}),
      // Adoption declaration (ADR-0049 D7, step 11b): a worker-entry option (never attach-controlled). When the
      // engine home grants OPFS access, an existing idb-authoritative store is migrated to a committed opfs
      // successor at boot. Default off (absent) — nothing is ever deleted without this explicit declaration.
      ...(options.adoption ? { adoption: options.adoption } : {}),
      // Fresh-store prefetch overlap (ADR-0032 S4): the tab's claim path proved this store a schemaless
      // spare and forwarded the hint in the attach config, so the shape catch-up overlaps schema exec +
      // journal recovery + registry reconciliation. Never inferred from "adopting a provisioned store": the board
      // provisions a worker even for a MAPPED (returning) user, whose idb is NOT fresh — only the claim
      // path's explicit hint distinguishes them.
      ...(attach.config?.freshStore === true ? { freshStore: true } : {}),
      getAuthToken: getWorkerAuthToken,
      // The worker owns convergence via the interval trigger, GATED by the tab's Offline toggle
      // (`set-online`); tabs additionally forward online/visibility as `wake` pass requests (below).
      autoSync: gatedTrigger,
      syncEnabled: attach.config?.syncEnabled ?? options.syncEnabled ?? true,
      ...(options.requestHeaders ? { requestHeaders: options.requestHeaders } : {}),
      ...(options.writeRequestHeaders ? { writeRequestHeaders: options.writeRequestHeaders } : {}),
      ...(options.maxMutationAttempts != null ? { maxMutationAttempts: options.maxMutationAttempts } : {}),
      onStatusChange: (status) => emitStatus(status),
      onConflict: (details) => broadcastEvent({ kind: "conflict", details }),
      onQuarantine: (details) => broadcastEvent({ kind: "quarantine", details }),
      onReject: (details) => broadcastEvent({ kind: "reject", details }),
      onSchemaChange: (event: LocalStoreVersionEvent) => broadcastEvent({ kind: "schema-change", event }),
      // The cause chain, not just the wrapper message: the bridge carries a string, and dropping
      // `.cause` here hid the actual database error from every tab (SQLSTATE, detail).
      onSyncError: (error) => broadcastEvent({ kind: "sync-error", message: describeErrorChain(error) }),
      // Boot observability (ADR-0034): broadcast the finalized report to currently-attached ports (one-shot
      // push). Later tabs read the same report via the `bootReport` pull RPC — there is no replay event.
      onBootReport: (report) => broadcastEvent({ kind: "boot-report", report }),
      // ADR-0041 stage 2 (Option B contract): `createSyncClient` resolves AT `localReadReady`, so the boot
      // promise now resolves there too — the attach handler acks at local-read readiness and the write/sync
      // tail runs in the background, announced to tabs via the `writeReady`/`bootSettled` milestone messages
      // wired in the attach handler below. The stage-1 `await booted.bootSettled` shim is deleted: attach no
      // longer waits for the whole boot, which is exactly the behavioural change this stage delivers.
    });
    return bootPromise;
  };

  const whenBooted = () => bootedPromise;

  // ─── Write / mutation-state RPC dispatch ─────────────────────────────────────────────────────────
  const dispatchRpc = async (active: SyncClient<TRegistry>, op: RpcOp, args: unknown[]): Promise<unknown> => {
    // Guarded-read parser re-application (ADR-0032 decision 4). A guarded read compiled by the tab's
    // Drizzle-over-bridge arrives as the {@link GuardedQueryWireArgs} tuple `[sql, params?, { rowMode? }, use?]`:
    // the `parsers` map drizzle's pglite session normally passes could not cross the bridge (it is FUNCTIONS,
    // not clonable), so the tab stripped it and we re-apply the identical map here before executing. Without it
    // PGlite's default parsers would turn the identity-parsed OIDs (temporal OIDs + `numeric[]`) into `Date`s
    // and numbers, whereas the in-process drizzle session sees them as raw STRINGS — so a guarded read would
    // diverge from its in-process twin exactly on those columns. Typed against `GuardedQueryWireArgs` so the
    // decode here shares the wire contract with the tab-side encoders (attach-sync-client).
    const runGuardedQueryRpc = (): Promise<unknown> => {
      const [sql, params, options, use] = args as unknown as GuardedQueryWireArgs;
      const queryOptions: QueryOptions = {
        ...(options?.rowMode ? { rowMode: options.rowMode } : {}),
        parsers: DRIZZLE_PGLITE_IDENTITY_PARSERS,
      };
      return active.guardedRawQuery(sql, params, queryOptions, use as readonly SyncTableName<TRegistry>[] | undefined);
    };
    type TableKey = SyncTableName<TRegistry>;
    switch (op) {
      case "create":
        return active.mutate.create(args[0] as TableKey, args[1] as never);
      case "update":
        return active.mutate.update(args[0] as TableKey, args[1] as Record<string, string>, args[2] as never);
      case "delete":
        return active.mutate.delete(args[0] as TableKey, args[1] as Record<string, string>);
      case "batch":
        return active.mutate.batch(args[0] as ReadonlyArray<MutationBatchItem<TRegistry>>);
      case "transaction": {
        // The tab collected the unit's mutations (the run callback can't cross the wire); the worker replays
        // the serialized items into a real `client.transaction` so pessimistic acks / optimistic flush match
        // the in-process semantics exactly.
        const { mode, items } = args[0] as { mode: WriteMode; items: MutationBatchItem<TRegistry>[] };
        return active.transaction({ mode }, (tx) => {
          for (const item of items) {
            const handle = tx.tables[item.table];
            if (item.kind === "create") {
              handle.create(item.input as never);
            } else if (item.kind === "update") {
              // ADR-0022 addendum: a `blind` update replays through `updateBlind` (journal-only, no overlay).
              if (item.blind) handle.updateBlind(item.entityKey, item.patch as never);
              else handle.update(item.entityKey, item.patch as never);
            } else {
              handle.delete(item.entityKey);
            }
          }
        });
      }
      case "flush":
        return active.flush(args[0] as TableKey | undefined);
      case "reconcile":
        return active.reconcile(args[0] as TableKey | undefined);
      case "retryFailed":
        return active.retryFailed(args[0] as TableKey | undefined);
      case "recoverSending":
        return active.recoverSending(args[0] as TableKey | undefined);
      case "discardConflict":
        return active.discardConflict(args[0] as TableKey, args[1] as Record<string, string>);
      case "discardQuarantined":
        return active.discardQuarantined(args[0] as TableKey, args[1] as Record<string, string>);
      case "desync":
        return active.desync(args[0] as TableKey);
      case "discardEphemeral":
        return active.discardEphemeral(args[0] as TableKey);
      case "ensureSynced":
        // Lazy activation (ADR-0021) on the worker's real client. Engine-wide but additive/idempotent — a tab
        // activating a group another tab already started is a no-op, so no cross-tab revert hazard (cf. desync).
        return active.ensureSynced(args[0] as readonly TableKey[]);
      case "readMutationDetails":
        return active.readMutationDetails(args[0] as TableKey | undefined);
      case "diagnostics":
        return active.diagnostics(args[0] as TableKey | undefined);
      case "rawQuery":
        // Inspection read (ADR-0032 S2): run straight against the worker's own store — `active.pglite`
        // exists worker-side (it's the in-process client). `Results` rows/fields structured-clone across
        // the wire (Dates survive postMessage), so the tab receives the same shape it would in-process.
        // The options arg is the clonable RawQueryOptions subset (rowMode) — the REPL's array mode.
        return active.rawQuery(args[0] as string, args[1] as unknown[] | undefined, args[2] as RawQueryOptions);
      case "rawExec":
        return active.rawExec(args[0] as string, args[1] as RawQueryOptions);
      case "guardedQuery":
        // Guarded one-shot Drizzle read (ADR-0032 decision 4): the ADR-0041 read gate + the ADR-0021
        // lazy-group guard run worker-side inside the engine's `guardedRawQuery`, so a read referencing a
        // lazy relation activates its group exactly as in-process. The full `Results` structured-clones back
        // and drizzle's own mapping (relational/nested included) runs on the tab.
        return runGuardedQueryRpc();
      case "bootReport":
        // Boot observability (ADR-0034): the worker engine's stored report (or null). Pull, so a late tab
        // reads a boot predating it; the report structured-clones across the bridge as a plain object.
        return active.bootReport();
      case "liveQueryDiagnostics":
        // Live-query diagnostics (ADR-0040 decision 5): the manager lives in THIS host closure (not on
        // `active`), so read it directly. Plain-object records (digests + counts only) structured-clone
        // across the bridge; `[]` when nothing has subscribed yet (the manager is created lazily).
        return liveManager?.snapshot() ?? [];
      case "exportStore": {
        // Store backup (ADR-0035): run the live export on the worker's OWN client (its lifecycle slot
        // serialises it against every tab's export). A `File` cannot cross the bridge as a transferable, so
        // decompose it into an `ExportArtefactWire` — the `ArrayBuffer` is listed on `postMessage`'s transfer
        // list in the `rpc` handler and rebuilt into a `File` tab-side.
        const { file, report } = await active.exportStore(args[0] as StoreExportOptions | undefined);
        const buffer = await file.arrayBuffer();
        return { buffer, fileName: file.name, mimeType: file.type, report } satisfies ExportArtefactWire;
      }
      case "exportDiagnostics": {
        // Diagnostic dump (ADR-0035): identical bridge shape to the store backup — the worker runs the live
        // datadir dump → memory throwaway clone → `pg_dump` on its OWN client (same lifecycle slot), and the
        // SQL crosses back as the same transferred-`ArrayBuffer` `ExportArtefactWire`.
        const { file, report } = await active.exportDiagnostics(args[0] as DiagnosticExportOptions | undefined);
        const buffer = await file.arrayBuffer();
        return { buffer, fileName: file.name, mimeType: file.type, report } satisfies ExportArtefactWire;
      }
      case "exportData": {
        // Data export (ADR-0035): identical bridge shape — the worker runs the drain-guarded `pg_dump -t`
        // per-synced-table export on its OWN client (same lifecycle slot), and the portable SQL crosses back
        // as the same transferred-`ArrayBuffer` `ExportArtefactWire`. A DataExportDrainError rejects the RPC
        // like any other failure (serialised back to the tab).
        const { file, report } = await active.exportData(args[0] as DataExportOptions | undefined);
        const buffer = await file.arrayBuffer();
        return { buffer, fileName: file.name, mimeType: file.type, report } satisfies ExportArtefactWire;
      }
      default: {
        const exhaustive: never = op;
        throw new Error(`unknown rpc op ${String(exhaustive)}`);
      }
    }
  };

  // ─── Live-query bridge (ADR-0032 S2 §4) ──────────────────────────────────────────────────────────
  // `queryId`s are minted by a PER-TAB counter (`live-1`, `live-2`, …), so two tabs collide on the bare id —
  // every worker-side bookkeeping key MUST be port-scoped or one tab's unsubscribe/close tears down another
  // tab's identically-numbered subscription (latent since ADR-0032; exposed the moment tab close started
  // sending unsubscribes — the two-tab board e2e's scenario (c)). The wire keeps the bare `queryId` (the
  // port disambiguates); only the worker's maps compose it with the port's scope.
  const subKeyFor = (port: BridgePort, queryId: string): string => `${scopeForPort(port)}:${queryId}`;

  const handleSubscribe = (port: BridgePort, id: string | undefined, payload: SubscribePayload): Promise<void> => {
    // Register the in-flight subscribe SYNCHRONOUSLY (before the first await) so an `unsubscribe`/`detach`/
    // `close` arriving mid-await can mark it cancelled (ADR-0040 decision 1 — no subscription escapes teardown).
    const pending = { port, cancelled: false };
    const subKey = subKeyFor(port, payload.queryId);
    pendingSubscribes.set(subKey, pending);
    // Track the WHOLE call so `close()` awaits it before disposing the manager: the task is added to
    // `inFlightSubscribes` synchronously here and removed in its own finally, so close can never observe an
    // empty set while a subscribe is still awaiting prepareQuery / hydration / manager setup.
    // `let task!` (not `const`): the finally references `task` to remove itself, and it only runs after the
    // first await — by then the assignment below has completed, so the definite-assignment assertion is safe.
    let task!: Promise<void>;
    task = (async () => {
      try {
        await handleSubscribeInner(port, id, payload, pending, subKey);
      } finally {
        pendingSubscribes.delete(subKey);
        inFlightSubscribes.delete(task);
      }
    })();
    inFlightSubscribes.add(task);
    return task;
  };

  const handleSubscribeInner = async (
    port: BridgePort,
    id: string | undefined,
    payload: SubscribePayload,
    pending: { port: BridgePort; cancelled: boolean },
    subKey: string,
  ) => {
    const active = client ?? (await bootPromise);
    if (!active) throw new Error("subscribe before attach");
    const { queryId, sql, params, pkColumns, use, fields, keepAliveMs } = payload;
    // Activate any lazy relations the query reads BEFORE registering the live query (ADR-0021) — the worker
    // owns the real client, so its `prepareQuery` does the real work; the tab's `prepareQuery` is a no-op.
    // Scan the ORIGINAL sql (the wrap only adds an outer `SELECT * FROM (...)`; table refs are inside).
    // The activated keys travel back on the initial snapshot: activation is stream-start, not catch-up,
    // so the tab needs them to await `groupReady` (its `hydrating` signal) without blocking this register.
    const prepared = await active.prepareQuery({ sql, ...(use ? { use: use as SyncTableName<TRegistry>[] } : {}) });
    // Hydration spans EVERY referenced consistency group (eager AND lazy), computed on the real client the
    // worker owns: the referenced tables whose group is not yet caught up at subscribe time. Empty (steady
    // state / sync disabled) → no `hydrated` gating at all; otherwise it drives both the `live-initial`
    // `hydratingTables` field (the tab's `hydrating` source) and the `live-hydrated` block below.
    const hydratingTables = active.hydratingTablesFor({ sql, ...(use ? { use: use as string[] } : {}) });

    // Render the query safe to materialise: a JOIN with same-named columns fails BOTH live APIs' temp-view
    // creation (`column "title" specified more than once`) unless every output column has a unique alias.
    // No `fields` → SQL unchanged (the default name-keyed row shape; the aliased path keys by alias). The
    // wrap stays caller-side (ADR-0040 decision 3): the manager receives POST-WRAP SQL as its query input.
    const materialSql = wrapLiveQueryForMaterialization(sql, fields);
    // Early bail BEFORE the manager is created (ADR-0040 decision 1 — the pending-before-manager close race):
    // if the host is closing, this subscribe was cancelled, or its port detached WHILE we awaited prepareQuery
    // / hydration, do NOT call `ensureLiveManager` — creating a registration now would race the engine close
    // with a fire-and-forget teardown nothing awaits (a manager born after `close()` disposed is never
    // disposed). Post the rpc error for this subscribe id so a still-live tab's `subscribeLiveRows` rejects
    // instead of hanging, and return without touching the manager. The post-setup check below still catches a
    // cancellation that lands DURING manager setup (after the manager already exists).
    if (closing || pending.cancelled || !ports.has(port)) {
      postBridgeMessage(
        port,
        codec,
        "rpc-result",
        {
          ok: false,
          error: { message: "[pgxsinkit] subscribe cancelled — the worker is closing or the port detached" },
        },
        id,
      );
      return;
    }
    // The manager owns registration + diff + teardown; the bridge posting (per-`queryId`, with the caller-owned
    // `lazyTables`/`hydratingTables` observability fields) stays here — those are per-subscriber pre-steps.
    const subscription = await ensureLiveManager(active).subscribe(
      { materialSql, params: params as unknown[], ...(pkColumns ? { pkColumns } : {}) },
      {
        deliverInitial: (rows) => {
          // Initial snapshot verbatim (not a diff), correlated to the subscribe request so the tab resolves.
          postBridgeMessage(
            port,
            codec,
            "live-initial",
            {
              queryId,
              rows,
              // `lazyTables` = the activated lazy relations (observability); `hydratingTables` = the referenced
              // groups (eager OR lazy) still catching up, which the tab turns into its `hydrated` promise.
              ...(prepared.lazyTables.length > 0 ? { lazyTables: prepared.lazyTables.map(String) } : {}),
              ...(hydratingTables.length > 0 ? { hydratingTables: [...hydratingTables] } : {}),
            },
            id,
          );
        },
        deliverDiff: (diff) => {
          postBridgeMessage(port, codec, "live-diff", { queryId, ...diff });
        },
      },
      // The per-subscriber keep-alive hint (ADR-0040 decision 4) — kept OUT of the spec so it never touches
      // the fingerprint (decision 3). Absent → no hint (the manager falls back to its policy default). The
      // `scope` is one stable id per port (decision 5 diagnostics), also fingerprint-excluded.
      { ...(keepAliveMs != null ? { keepAliveMs } : {}), scope: scopeForPort(port) },
    );
    // The port was detached, or this query was unsubscribed, WHILE we awaited (prepareQuery / hydration /
    // manager setup all yield). Neither cleanup path found a `liveSubs` entry — so undo the just-created
    // subscription here and DO NOT record it, else it would outlive its port (ADR-0040 decision 1). A
    // `live-initial` may already have been posted to a dead port; that is harmless (a closed port's
    // postMessage is a no-op) and not worth preventing. `closing` is included so a `close()` that began DURING
    // manager setup still unwinds this just-created subscription rather than recording it.
    if (closing || pending.cancelled || !ports.has(port)) {
      void subscription.unsubscribe();
      return;
    }
    liveSubs.set(subKey, { port, subscription });

    // Hydration completion travels the SAME port as the diff stream, so ordering is guaranteed: await the
    // pending groups' catch-up (eager AND lazy), force one refresh of the live query against the caught-up
    // store (its listener posts the rows as a live-diff, synchronously inside the refresh), THEN post
    // `live-hydrated`. The tab therefore always has the caught-up rows before its `hydrated` resolves — a
    // readiness signal on a side channel (e.g. the `groupReady` broadcast) can beat the rows and flash a
    // false "empty" state. Skipped entirely when nothing is pending (steady state / sync disabled).
    if (hydratingTables.length > 0) {
      void Promise.all(hydratingTables.map((key) => active.groupReady(key as SyncTableName<TRegistry>)))
        .then(async () => {
          if (!liveSubs.has(subKey)) return; // unsubscribed while catching up
          await subscription.refresh();
          if (!liveSubs.has(subKey)) return;
          postBridgeMessage(port, codec, "live-hydrated", { queryId });
        })
        .catch(() => undefined); // a torn-down engine mid-catch-up must not surface as an unhandled rejection
    }
  };

  // ─── Per-port message routing ────────────────────────────────────────────────────────────────────
  const onPortMessage = (port: BridgePort, data: unknown) => {
    if (!isBridgeEnvelope(data)) return;
    const envelope = data;
    const payload = codec.decode(envelope.payload);
    switch (envelope.type) {
      case "provision": {
        // Pre-spawn the raw store (initdb only), idle and schemaless, for the first attach to adopt
        // (ADR-0032 decision 5). A no-op once the engine has booted or a store is already provisioned.
        const provision = payload as ProvisionPayload;
        const storePath = provision.storePath ?? provision.storeId ?? options.storePath ?? "pgxsinkit-overlay-v1";
        // The testing memory-backend override rides as an explicit wire field (ADR-0036) — a symbol does not
        // survive structured clone, so the store's backend selection travels here and is passed to createPglite.
        const backendOverride = provision.testStoreBackend;
        if (bootPromise != null || provisioned != null || provisionAttempt != null) {
          postBridgeMessage(port, codec, "provision-ack", {
            ok: true,
            ...(provision.storeId ? { storeId: provision.storeId } : {}),
          });
          break;
        }
        // Stamp the spare's create timing (ADR-0034): initdb cost + the monotonic instant it became ready,
        // so an adopting boot can compute how long it sat idle before adoption. Gated on the placement grant
        // (ADR-0049 elected engine self-probe): the elected dedicated engine pre-spawns the OPFS-repacked store it
        // holds access to, not idbfs, so the adopting boot backend matches its engine home. Opens the gate at
        // once for SW-direct / plain scopes (already settled before any port connects).
        const attempt = placementGate.then(async () => {
          // Provision is only an accelerator, never an authority-recovery path. Read the meta record on EVERY
          // persistent placement before minting. If deletion is live, decline the pre-mint and let the first
          // attach run createSyncClient's full ordinary phase machine. This closes both granted and denied lanes:
          // no replacement (and therefore no journal) can be created beneath a record a later boot must delete.
          if (backendOverride !== "memory") {
            const record = await readStoreMetaRecord(storePath);
            if (record !== META_STORE_UNAVAILABLE && record?.phase === "deleting") {
              syncDebug("worker provision declined — deletion authority is live", { storePath });
              return;
            }
          }
          // An attach or another completed provision may have won while the bounded read was in flight.
          if (bootPromise != null || provisioned != null) return;

          const provisionStartedAt = nowStamp();
          const pglite = Promise.resolve().then(() => createPglite(storePath, backendOverride));
          const stamp = pglite.then(() => {
            const readyAt = nowStamp();
            return { initdbMs: readyAt - provisionStartedAt, provisionReadyAt: readyAt };
          });
          provisioned = { storePath, pglite, stamp };
          // Guard unobserved rejections when no attach ever adopts the spare (the page navigated away).
          void pglite.catch(() => undefined);
          void stamp.catch(() => undefined);
          syncDebug("worker store provisioned", { storePath });
          await pglite;
        });
        provisionAttempt = attempt;
        void attempt.then(
          () => {
            if (provisionAttempt === attempt) provisionAttempt = null;
          },
          () => {
            if (provisionAttempt === attempt) provisionAttempt = null;
          },
        );
        void attempt.then(
          () =>
            postBridgeMessage(port, codec, "provision-ack", {
              ok: true,
              ...(provision.storeId ? { storeId: provision.storeId } : {}),
            }),
          (error: unknown) =>
            postBridgeMessage(port, codec, "provision-ack", {
              ok: false,
              error: serializeError(error),
              ...(provision.storeId ? { storeId: provision.storeId } : {}),
            }),
        );
        break;
      }
      case "set-online": {
        // The tab's Offline toggle over the bridge (ADR-0032 S3). Suppress/resume the worker's outbound
        // convergence; resuming fires one immediate pass so queued writes flush at once.
        const { online } = payload as SetOnlinePayload;
        convergenceSuppressed = !online;
        syncDebug("worker convergence gate", { online });
        if (online) fireConvergence?.();
        break;
      }
      case "attach": {
        const attach = payload as AttachPayload;
        // Boot observability (ADR-0034): replay the pre-attach rail buffer (provision + any early lines) to
        // the FIRST attaching tab, so the front half of boot is no longer invisible. Snapshotted before this
        // attach's boot runs, so the boot's own lines (streamed live) are not doubled.
        replayRailBufferTo(port);
        const alreadyBooted = bootPromise !== null;
        // Restore rides the FIRST (boot) attach only (ADR-0035 decision 6): a restore attach that arrives once
        // the engine has already booted CANNOT be honoured — `loadDataDir` is a create-time seed and the store
        // is already live. Reject THIS attach with a typed error rather than silently ignoring the backup, so
        // the caller learns their restore did not happen (the engine keeps running its existing store).
        if (alreadyBooted && attach.restore != null) {
          postBridgeMessage(port, codec, "attach-ack", {
            alreadyBooted,
            error: {
              message:
                "[pgxsinkit] cannot restore into a running store: the worker engine has already booted, and a store backup can only seed a brand-new store on the FIRST attach (ADR-0035 decision 6). Restore into a fresh worker instead.",
            },
          });
          break;
        }
        if (alreadyBooted) {
          // A later attach seeds auth WITHOUT clobbering a fresher cached token (ADR-0032 FIX 5) — the
          // first-boot `push` already ran, and only an explicit `token-push` (auth owner) may overwrite.
          tokenCache.pushIfFresher(attach.token);
          // Role is a property of the (user, store) the engine already booted for: the worker is
          // one-engine-per-(user,store) by ADR-0032 decision 2 and is NOT keyed by role. A mismatch is an
          // app-layer bug to surface, not a supported topology — warn, keep the booted registry.
          const requested = attach.config?.role;
          if (requested !== bootedRole) {
            syncDebug("worker attach role mismatch — engine keeps its booted registry", {
              booted: bootedRole,
              requested,
            });
          }
        }
        void boot(attach).then(
          (booted) => {
            client = booted;
            resolveBooted(booted);
            // Wire the engine's background stage promises to the milestone bridge exactly ONCE (ADR-0041
            // stage 2). `createSyncClient` resolved at `localReadReady`, so by here the engine has crossed
            // that stage — the ack below carries it implicitly. `writeReady`/`bootSettled` cross later (or
            // fail): broadcast each as a one-shot `milestone`/`milestone-error` for currently-attached ports
            // and fold the current set into every subsequent ack for late attachers.
            if (!milestonesWired) {
              milestonesWired = true;
              void booted.writeReady.then(
                () => markMilestone("writeReady"),
                (error: unknown) => failMilestone("writeReady", error),
              );
              void booted.bootSettled.then(
                () => markMilestone("bootSettled"),
                (error: unknown) => failMilestone("bootSettled", error),
              );
            }
            // Track the engine's monotonic `ready` edge exactly once, so a LATER attach acked after the
            // initial sync landed can resolve its `ready` straight from the ack (ADR-0032 FIX 3).
            if (!engineReadyFired) {
              // ADR-0041: `ready` can now reject if the background write/sync tail fails after the client was
              // handed out; swallow that here so it is not an unhandled rejection (the failure surfaces to
              // tabs via the `milestone-error` broadcast / the stage-error ack fold instead).
              void booted.ready.then(
                () => {
                  engineReadyFired = true;
                },
                () => undefined,
              );
            }
            // Ack AFTER the engine exists so the tab's subsequent traffic (rpc/subscribe) has a client to
            // hit; the ack fires AT `localReadReady` (Option B) and folds the current milestone set +
            // engine-ready edge for a late-joining tab (ADR-0041 / ADR-0032 FIX 3).
            postBridgeMessage(port, codec, "attach-ack", {
              alreadyBooted,
              ...(engineReadyFired ? { engineReady: true } : {}),
              ...milestoneAckFields(),
            });
            postBridgeMessage(port, codec, "event", { kind: "status", status: booted.status });
          },
          (error: unknown) => {
            // The engine boot rejected: tell THIS attaching tab so it rejects `attachSyncClient` instead of
            // hanging on the ack (ADR-0032 FIX 1), and clear `bootPromise` so a later attach retries the
            // boot. Do NOT clear `provisioned`: a resolved provisioned PGlite holds the only open handle on
            // that store, so a retry must adopt it (createSyncClient falls back internally if it rejected).
            if (!alreadyBooted) bootPromise = null;
            postBridgeMessage(port, codec, "attach-ack", {
              alreadyBooted,
              error: serializeError(error),
            });
          },
        );
        break;
      }
      case "token-push": {
        // The tab pushed a fresh token (auth state change) — update the cache and satisfy any in-flight pull.
        tokenCache.push(payload as AttachPayload["token"]);
        break;
      }
      case "token-response": {
        const response = payload as TokenResponsePayload;
        // First response for the current pull wins; a stale/duplicate requestId is ignored.
        tokenCache.respond(response.requestId, response.token);
        break;
      }
      case "rpc": {
        const { op, args } = payload as RpcPayload;
        const id = envelope.id;
        void (async () => {
          try {
            const active = client ?? (await bootPromise);
            if (!active) throw new Error("rpc before attach");
            const value = await dispatchRpc(active, op, args);
            // An export artefact (backup tarball or diagnostic SQL) crosses zero-copy: transfer its
            // `ArrayBuffer` (rebuilt into a `File` tab-side, ADR-0035). Every other op's value
            // structured-clones in place with no transfer list.
            const transfer =
              op === "exportStore" || op === "exportDiagnostics" || op === "exportData"
                ? [(value as ExportArtefactWire).buffer]
                : undefined;
            postBridgeMessage(port, codec, "rpc-result", { ok: true, value }, id, transfer);
          } catch (error) {
            postBridgeMessage(port, codec, "rpc-result", { ok: false, error: serializeError(error) }, id);
          }
        })();
        break;
      }
      case "subscribe": {
        const id = envelope.id;
        void handleSubscribe(port, id, payload as SubscribePayload).catch((error) => {
          postBridgeMessage(port, codec, "rpc-result", { ok: false, error: serializeError(error) }, id);
        });
        break;
      }
      case "unsubscribe": {
        const { queryId } = payload as { queryId: string };
        // Compose the SAME port-scoped key the subscribe used — a bare queryId lookup would collide with
        // another tab's identically-numbered subscription (see `subKeyFor`).
        const subKey = subKeyFor(port, queryId);
        const sub = liveSubs.get(subKey);
        if (sub) {
          // Non-blocking for the caller: the manager retains the teardown promise so `close()` awaits it.
          void sub.subscription.unsubscribe();
          liveSubs.delete(subKey);
        } else {
          // No live entry yet → the subscribe is still mid-await. Mark it cancelled so `handleSubscribe`
          // tears down the subscription it is about to create instead of recording it (ADR-0040 decision 1).
          const inFlight = pendingSubscribes.get(subKey);
          if (inFlight) inFlight.cancelled = true;
        }
        break;
      }
      case "wake": {
        // A tab forwarded online/visibilitychange (or a manual nudge): treat it as a convergence pass request
        // so a write flushes promptly without waiting for the worker's interval tick (decision 5 seam).
        // Suppressed while the Offline toggle is off — a wake must not flush a simulated-offline board.
        if (!convergenceSuppressed) void bootPromise?.then((active) => void active.flush());
        break;
      }
      default:
        break;
    }
  };

  const detachPort = (port: BridgePort) => {
    ports.delete(port);
    for (const [subKey, sub] of liveSubs) {
      if (sub.port === port) {
        // Non-blocking: the manager retains the teardown promise so `close()` awaits it (ADR-0040 decision 1).
        void sub.subscription.unsubscribe();
        liveSubs.delete(subKey);
      }
    }
    // Also cancel every subscribe for this port still mid-await — its `handleSubscribe` will tear down the
    // subscription it is about to create rather than record it for a detached port (ADR-0040 decision 1).
    for (const pending of pendingSubscribes.values()) {
      if (pending.port === port) pending.cancelled = true;
    }
  };

  const connect = (port: BridgePort) => {
    ports.add(port);
    const listener = (event: { data: unknown }) => {
      if (isBridgeEnvelope(event.data) && event.data.type === "detach") {
        detachPort(port);
        port.removeEventListener("message", listener);
        return;
      }
      onPortMessage(port, event.data);
    };
    port.addEventListener("message", listener);
    port.start?.();
  };

  const closeHost = async (): Promise<void> => {
    // Quiesce pending subscribes FIRST (ADR-0040 decision 1 — the pending-before-manager race): flip
    // `closing`, mark every mid-await subscribe cancelled, and await every in-flight `handleSubscribe` task.
    // This guarantees the manager exists (if any subscribe created one) BEFORE `dispose()` runs, and that no
    // subscribe can create a registration afterwards — each resumes into the `closing` early-bail instead.
    closing = true;
    for (const pending of pendingSubscribes.values()) pending.cancelled = true;
    await Promise.allSettled([...inFlightSubscribes]);
    // Dispose the manager BEFORE `active.stop()` (ADR-0040 decision 1): it tears down every remaining live
    // registration and awaits ALL teardowns, so no fire-and-forget unsubscribe is still in flight when the
    // engine closes (the close-vs-unsubscribe hang). No-op when nothing ever subscribed.
    liveSubs.clear();
    await liveManager?.dispose();
    ports.clear();
    setSyncDebugSink(undefined);
    const active = client ?? (bootPromise ? await bootPromise.catch(() => null) : null);
    await active?.stop();
  };

  // ─── Global-scope auto-binding (real worker only; tests inject ports via connect) ─────────────────
  // ADR-0049 D1: a SharedWorker scope routes through the PLACEMENT bootstrap — it decides its engine home once at
  // startup (an UNCONDITIONAL probe) and gates every `onconnect` port on that decision (SW-direct host connect vs
  // router-only `attachTab`). The ONE exception is a registry that DECLARES `backend: "idbfs"` (read below): no
  // probe runs and the engine boots in-SharedWorker on idbfs — the declared mode, not a fallback. A dedicated
  // engine worker still delegates to `bindGlobalScope` (the step-9 control plane); a plain test/Node scope is a no-op.
  //
  // The declared backend is read off the DEFAULT registry (placement is decided once at startup, before any
  // attach settles a role) — the same seam `provisionDurability` above reads. Storage is a data-contract property,
  // so role variants baked into one worker file share it.
  const declaredIdbfs = getSyncRegistryStorage(options.registry)?.backend === "idbfs";
  if (options.installGlobal === false) {
    // No global bootstrap runs (a plain host driven via `connect` in tests) — open the placement gate at once so
    // the first boot proceeds with no OPFS grant and no engine home (a plain scope has no browser placement).
    openPlacementGate();
  } else {
    bootstrapWorkerScope({
      connect,
      closeHost,
      peerCount: () => ports.size,
      // ADR-0049 D1: `backend: "idbfs"` is the one declared opt-out — no probe, no election, in-SW idbfs engine.
      declaredIdbfs,
      ...(options.executionLimit ? { executionLimit: options.executionLimit } : {}),
      onPlacement: (outcome) => {
        // The resolved OPFS grant + engine home for THIS scope: the SharedWorker placement decision (`shared-worker`
        // ⇒ granted in-scope engine, or a capability-absence idbfs fallback carrying `storageFallbackReason`), the
        // elected DEDICATED engine's OWN-scope probe (`elected-worker` carrying its real probe verdict), or a plain
        // test/Node scope (no home, no grant). Threaded into the boot's grant/BootReport and OPENS the boot gate.
        // ADR-0049 decision 12: `placementEngineHome` stamps the report; `placementFallbackReason` stamps the
        // capability-absence idbfs fallback's `storageFallbackReason`.
        placementOpfsAccess = outcome.opfsGranted;
        placementEngineHome = outcome.engineHome;
        placementFallbackReason = outcome.storageFallbackReason;
        openPlacementGate();
      },
    });
  }

  return {
    connect,
    whenBooted,
    close: closeHost,
  };
}

/** Serialize a thrown value into the bridge's `{message, detail}` error shape (detail only when structured). */
function serializeError(error: unknown): { message: string; detail?: unknown } {
  if (error instanceof ExecutionLimitMismatchError) {
    return { message: error.message, detail: executionLimitMismatchToWire(error) };
  }
  if (error instanceof Error) {
    const detail = (error as Error & { detail?: unknown }).detail;
    return { message: error.message, ...(detail !== undefined ? { detail } : {}) };
  }
  return { message: String(error) };
}

interface SharedWorkerConnectEvent {
  ports: BridgePort[];
}
/**
 * A message event that may carry transferred `MessagePort`s (the `ports` array). The engine-entry control plane
 * (ADR-0049 step 9) reads it for the delivered control channel and for each dynamically transferred pipe end.
 */
interface ScopeMessageEvent {
  data: unknown;
  ports?: readonly ControlPortLike[];
}
interface WorkerGlobalScopeLike {
  onconnect?: (event: SharedWorkerConnectEvent) => void;
  postMessage?: (message: unknown) => void;
  addEventListener?: (type: "message", listener: (event: ScopeMessageEvent) => void) => void;
  removeEventListener?: (type: "message", listener: (event: { data: unknown }) => void) => void;
  /** Present on a real `DedicatedWorkerGlobalScope` (`self.close()`); the entry self-closes on teardown. */
  close?: () => void;
}

/**
 * The structural `MessagePort` shape the engine-entry control plane needs: the control channel end delivered on
 * the implicit port, and each transferred pipe end wrapped into a {@link BridgePort}. No DOM lib — structural
 * typing only, matching the router's `RouterPort` discipline.
 */
interface ControlPortLike {
  postMessage: (message: unknown, transfer?: unknown[]) => void;
  addEventListener: (type: "message", listener: (event: ScopeMessageEvent) => void) => void;
  removeEventListener?: (type: "message", listener: (event: ScopeMessageEvent) => void) => void;
  start?: () => void;
}

/**
 * The literal key of the CONTROL-CHANNEL DELIVERY message (ADR-0049 step 9). The spawning coordinator's step-10
 * wiring posts `{ [CONTROL_PORT_DELIVERY_KEY]: true }` on the elected engine worker's IMPLICIT port WITH the
 * engine end of the announce control channel as a transferred `MessagePort`. The engine entry starts that port
 * and runs its control plane on it. Distinct namespace from the data-path bridge envelope and the `pgx0049`
 * control envelope, so it is unambiguous on the shared implicit-port transport.
 */
export const CONTROL_PORT_DELIVERY_KEY = "pgx0049ControlPort" as const;

/** Is this a control-channel DELIVERY message (`{ [CONTROL_PORT_DELIVERY_KEY]: true }`)? */
function isControlPortDelivery(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { [CONTROL_PORT_DELIVERY_KEY]?: unknown })[CONTROL_PORT_DELIVERY_KEY] === true
  );
}

/**
 * The elected-engine-worker CONTROL PLANE (ADR-0049 step 9) — grown on the dedicated-worker ENTRY, leaving the
 * engine CORE (`SyncWorkerHost.connect`) untouched. Runs on the delivered control channel:
 *
 * - `assign-identity` → remember it (gates every subsequent tagged message) and reply `engine-ready`. That
 *   signals CONTROL-plane readiness, NOT engine boot — the engine still boots lazily on the FIRST attach, as
 *   today (the first `connect-port` pipe's traffic drives `boot`).
 * - `connect-port` (matching identity) + a transferred port → wrap it into a {@link BridgePort} (started if it
 *   exposes `start()`, exactly as the implicit scope port is wrapped) and feed it to the SAME `connect(...)`
 *   the entry already uses N times — dynamic per-tab pipe acceptance (ADR D4).
 * - `control-ping` → reply `control-ack` with the assigned identity (or the ping's, pre-assignment) and the
 *   SAME `pingId`. Answered on the event loop, so a WASM-blocked engine cannot answer — which is exactly the
 *   execution-limit's liveness signal.
 * - `engine-retiring` (matching) → a no-op hook for now (flush opportunities are engine-CORE concerns wired in
 *   a later step).
 * - `engine-teardown` (matching) → reply `control-ack` with `pingId: -1` (the teardown ack the router relays)
 *   then self-close the scope AFTER a microtask, so the ack flushes before the worker goes.
 *
 * Stale (post-assignment mismatch) tagged messages are discarded via {@link shouldApplyControlMessage}.
 */
function startEngineControlPlane(
  controlPort: ControlPortLike,
  connect: (port: BridgePort) => void,
  closeScope: () => void,
): () => void {
  let assigned: EngineIdentity | undefined;
  const post = (message: EngineControlMessage): void => controlPort.postMessage(controlEnvelope(message));
  const listener = (event: ScopeMessageEvent): void => {
    const message = readControlEnvelope(event.data);
    if (message === undefined) return;
    switch (message.type) {
      case "assign-identity":
        assigned = message.identity;
        post({ type: "engine-ready", identity: message.identity });
        return;
      case "control-ping":
        post({ type: "control-ack", identity: assigned ?? message.identity, pingId: message.pingId });
        return;
      case "connect-port": {
        if (!shouldApplyControlMessage(assigned, message)) return; // stale → discard
        const transferred = event.ports?.[0];
        if (!transferred) return;
        connect(wrapControlPortAsBridge(transferred));
        return;
      }
      case "engine-retiring":
        // No-op hook for now (matching-identity only) — later steps wire the engine-core flush opportunity.
        void shouldApplyControlMessage(assigned, message);
        return;
      case "engine-teardown":
        if (!shouldApplyControlMessage(assigned, message)) return; // stale → discard
        post({ type: "control-ack", identity: message.identity, pingId: -1 });
        // Defer the close a microtask so the teardown ack flushes before the scope goes.
        void Promise.resolve().then(closeScope);
        return;
      default:
        return;
    }
  };
  controlPort.addEventListener("message", listener);
  controlPort.start?.();
  // Return a disposer that detaches THIS plane's listener, so a repeat control-port delivery (the keepalive
  // SW-reconstruction re-announce, step 11b follow-up 2) can REPLACE this channel and have the old one ignored.
  return () => controlPort.removeEventListener?.("message", listener);
}

/** Wrap a transferred raw port into the {@link BridgePort} the engine's `connect(...)` consumes (started if able). */
function wrapControlPortAsBridge(port: ControlPortLike): BridgePort {
  port.start?.();
  return {
    postMessage: (message, transfer) => port.postMessage(message, transfer),
    addEventListener: (type, listener) => port.addEventListener(type, listener),
    removeEventListener: (type, listener) => port.removeEventListener?.(type, listener),
  };
}

/**
 * Bind the running global scope to `connect`. A `SharedWorkerGlobalScope` exposes `onconnect` (one event per
 * tab, each carrying a port); a dedicated `DedicatedWorkerGlobalScope` has no `onconnect` but IS itself the
 * single implicit port (`self.postMessage`/`addEventListener`). Neither exists in a plain test/Node context,
 * where the host is driven via {@link SyncWorkerHost.connect} directly — so this is a no-op there.
 *
 * `globalScope` defaults to `globalThis` (the real worker binding); tests inject a fake scope to exercise the
 * dedicated-worker control-plane arm (ADR-0049 step 9) without a real Worker.
 */
export function bindGlobalScope(connect: (port: BridgePort) => void, globalScope: unknown = globalThis): void {
  const scope = globalScope as WorkerGlobalScopeLike;
  const hasSharedWorkerScope =
    typeof (globalScope as { SharedWorkerGlobalScope?: unknown }).SharedWorkerGlobalScope !== "undefined";
  const hasDedicatedWorkerScope =
    typeof (globalScope as { DedicatedWorkerGlobalScope?: unknown }).DedicatedWorkerGlobalScope !== "undefined";

  if (hasSharedWorkerScope) {
    scope.onconnect = (event: SharedWorkerConnectEvent) => {
      const port = event.ports[0];
      if (port) connect(port);
    };
    return;
  }
  if (hasDedicatedWorkerScope && scope.postMessage && scope.addEventListener && scope.removeEventListener) {
    // The dedicated worker's own global scope IS the single implicit port (the tab's engine port). Wrap it as a
    // bridge port and connect it — the same engine serves that one port for the worker's whole lifetime.
    const scopePort: BridgePort = {
      postMessage: (message: unknown) => scope.postMessage!(message),
      addEventListener: (type, listener) => scope.addEventListener!(type, listener),
      removeEventListener: (type, listener) => scope.removeEventListener!(type, listener),
    };
    connect(scopePort);
    // ADR-0049 step 9 (elected engine home): the implicit port ALSO carries the control-channel DELIVERY
    // message. On it, start the engine's control plane — dynamic pipe acceptance, probe replies, and
    // retirement/teardown — all identity-tagged. The engine CORE is untouched: transferred pipes flow into the
    // SAME `connect` above. The scope port's own baseline connect is unchanged.
    // A repeat delivery REPLACES the live control plane (ADR-0049 step 11b follow-up 2): when the leader-keepalive
    // reconstructs a dead SharedWorker it re-announces with a FRESH control channel and re-delivers this engine's
    // end. Dispose the previous plane's listener first so stale traffic on the dead old channel is ignored; the
    // engine CORE (`connect`) is untouched — pipes still flow into the same engine.
    let disposeControlPlane: (() => void) | undefined;
    scope.addEventListener("message", (event: ScopeMessageEvent) => {
      if (!isControlPortDelivery(event.data)) return;
      const controlPort = event.ports?.[0];
      if (!controlPort) return;
      disposeControlPlane?.();
      disposeControlPlane = startEngineControlPlane(controlPort, connect, () => scope.close?.());
    });
  }
}

// ─── ADR-0049 D1: the SharedWorker placement bootstrap ───────────────────────────────────────────────
// The SharedWorker arm decides its ENGINE HOME once at startup and gates each tab connection on that decision:
// `shared-worker` (SW-direct) connects the port to the in-scope engine host; `elected-worker` (router-only)
// hands the port to a `createEngineRouter` and NEVER boots the engine in-scope. The probe is UNCONDITIONAL —
// every scope runs `decideSwPlacement` — with ONE exception: a registry declaring `backend: "idbfs"`
// (`deps.declaredIdbfs`) skips the probe and binds the in-SW engine host on idbfs (the declared mode). Both modes
// answer a tab's PLACEMENT query and DESTROY peer-count query; SW-direct additionally answers `pgx0049` keepalive
// pings on each port (the router owns those in elected mode). A dedicated-worker scope (the elected engine worker)
// still routes through `bindGlobalScope` (the step-9 control plane), unchanged.

/**
 * The PLACEMENT-QUERY envelope key: a tab posts `{ [PLACEMENT_QUERY_KEY]: true }` on its SharedWorker
 * connection to learn the engine home; the SharedWorker replies `{ [PLACEMENT_RESULT_KEY]: PlacementQueryResult }`.
 * A distinct namespace from the data-path bridge envelope and the `pgx0049` control envelope, so it is
 * unambiguous on the shared tab↔SharedWorker transport (the attach client reads it off the raw message).
 */
export const PLACEMENT_QUERY_KEY = "pgx0049Placement" as const;
/** The reply to a {@link PLACEMENT_QUERY_KEY} query — carries the engine home, `electionRequired`, and SW id. */
export const PLACEMENT_RESULT_KEY = "pgx0049PlacementResult" as const;
/**
 * The DESTROY peer-count query key (ADR-0049 D8, plan fault row "`destroy()` with peers attached → refused").
 * A tab about to destroy the store posts `{ [DESTROY_QUERY_KEY]: true }`; the SharedWorker — which alone knows
 * the attached-tab count — replies `{ [DESTROY_VERDICT_KEY]: { peers } }`. `peers` INCLUDES the querying tab, so
 * `peers > 1` means other tabs still hold the store and destruction is refused.
 */
export const DESTROY_QUERY_KEY = "pgx0049DestroyQuery" as const;
/** The reply to a {@link DESTROY_QUERY_KEY} query — the attached-tab count (querying tab included). */
export const DESTROY_VERDICT_KEY = "pgx0049DestroyVerdict" as const;

/** The placement a tab learns from the SharedWorker (the reply payload under {@link PLACEMENT_RESULT_KEY}). */
export interface PlacementQueryResult {
  engineHome: SwPlacementResult["engineHome"];
  /** True in `elected-worker` mode — the tab's election coordinator must spawn the engine worker. */
  electionRequired: boolean;
  swInstanceId: string;
  /**
   * The SharedWorker's OWN script URL (`self.location.href`, ADR-0049 D5). In `elected-worker` mode the winning
   * tab constructs the elected engine as `new Worker(swScriptUrl, { type: "module" })` — the worker entry is
   * dual-scope (one file serves both homes), so no consumer wiring is needed; a `createEngineWorker` override is
   * only for entries that cannot be reconstructed from their URL as a module worker. Absent when the scope cannot
   * report its location (a plain test scope) — then a tab with no override fails attach with a typed wiring error.
   */
  swScriptUrl?: string;
}

/** The SharedWorker placement bootstrap's dependencies (all injected so it is unit-testable off-worker). */
export interface SharedWorkerBootstrapDeps {
  /** The engine host `connect` — used in SW-direct (`shared-worker`) placement to pipe a port to the in-scope engine. */
  connect: (port: BridgePort) => void;
  /** Quiesce and close the in-scope host before SW-direct destruction acknowledges handle release. */
  closeHost?: () => Promise<void>;
  /** Current attached-tab count for the DESTROY verdict in SW-direct mode (the host's own port set). */
  peerCount: () => number;
  /** The opt-in execution limit, threaded into the router in `elected-worker` (router-only) placement. */
  executionLimit?: ExecutionLimitConfig;
  /**
   * The registry declared `backend: "idbfs"` (ADR-0049 D1) — the ONE opt-out. TRUE: skip the probe entirely and
   * bind the in-SharedWorker engine host on the idbfs backend (the declared mode, not a fallback; the placement
   * query answers `electionRequired: false`). FALSE (the default, `backend: "opfs"`): run the UNCONDITIONAL
   * placement probe — a granted verdict boots the engine in-scope on OPFS-repacked, a denied one goes router-only
   * and each tab elects a dedicated engine worker.
   */
  declaredIdbfs?: boolean;
  /** Test seam: inject the placement decision (a fake probe result) instead of the real {@link decideSwPlacement}. */
  decidePlacement?: () => Promise<SwPlacementResult>;
  /** Defaults to `globalThis`; tests inject a fake SharedWorker scope. */
  globalScope?: unknown;
  /**
   * Notified once the placement grant for THIS scope resolves (SharedWorker decision, dedicated-engine probe, or
   * the plain-scope immediate settle). The entry threads `opfsGranted` into its `hasOpfsSyncAccess` boot grant and
   * `engineHome` into the BootReport, and opens its boot gate. `engineHome` is `undefined` for a plain test/Node
   * scope (no home) so the report omits it, exactly as before placement.
   */
  onPlacement?: (outcome: PlacementBootstrapOutcome) => void;
  /**
   * Test seam: inject the DEDICATED elected-engine scope's OPFS probe (a fake verdict) instead of the real
   * {@link probeOpfsSyncAccess}. Defaults to the real probe (invariant 8 — a real `createSyncAccessHandle` open in
   * the engine's own scope, per boot, never sniffed or cached).
   */
  probe?: () => Promise<PlacementProbeResult>;
}

/** The resolved placement grant for a worker scope, threaded to the entry's boot grant + BootReport engine home. */
export interface PlacementBootstrapOutcome {
  /** The engine home for this scope; `undefined` for a plain test/Node scope (the report then omits it). */
  engineHome: SwPlacementResult["engineHome"] | undefined;
  /** True when THIS scope actually holds OPFS sync-access (in-scope SW-direct, or the elected engine's own probe). */
  opfsGranted: boolean;
  /**
   * The verbatim reason this scope's engine opened IDBFS while OPFS was CAPABLE (ADR-0049 D1/D12, a
   * capability-absence fallback) — stamped into the boot's `storageFallbackReason`. Absent on a granted opfs boot
   * AND on the declared `backend: "idbfs"` mode (the contract, not a fallback).
   */
  storageFallbackReason?: string;
}

/** Is this a raw `{ [PLACEMENT_QUERY_KEY]: true }` placement query? */
function isPlacementQuery(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { [PLACEMENT_QUERY_KEY]?: unknown })[PLACEMENT_QUERY_KEY] === true
  );
}

/** Is this a raw `{ [DESTROY_QUERY_KEY]: true }` destroy peer-count query? */
function isDestroyQuery(data: unknown): boolean {
  return (
    typeof data === "object" && data !== null && (data as { [DESTROY_QUERY_KEY]?: unknown })[DESTROY_QUERY_KEY] === true
  );
}

/**
 * Bootstrap the running worker scope for ADR-0049 placement. A SharedWorker scope runs the placement decision
 * and gates every `onconnect` port on it ({@link wireSharedWorkerPlacement}); any other scope (the dedicated
 * elected-engine worker, or a plain test/Node scope) delegates to {@link bindGlobalScope} unchanged. Called by
 * `defineSyncWorker` in place of the old direct `bindGlobalScope(connect)`.
 */
export function bootstrapWorkerScope(deps: SharedWorkerBootstrapDeps): void {
  const globalScope = deps.globalScope ?? globalThis;
  const hasSharedWorkerScope =
    typeof (globalScope as { SharedWorkerGlobalScope?: unknown }).SharedWorkerGlobalScope !== "undefined";
  if (hasSharedWorkerScope) {
    if (deps.declaredIdbfs) {
      // ADR-0049 D1 declared opt-out (`backend: "idbfs"`): NEVER probe, NEVER go router-only — bind the in-SW
      // engine host on the idbfs backend (no OPFS grant). This is the store's DECLARED mode, not a fallback, so it
      // carries no `storageFallbackReason`. The meta listener answers the placement query `electionRequired: false`,
      // so a tab keeps the SW-port attach path.
      wireSharedWorkerPlacement(
        {
          ...deps,
          decidePlacement: () => Promise.resolve({ engineHome: "shared-worker", swInstanceId: crypto.randomUUID() }),
        },
        globalScope,
        false,
      );
    } else {
      // ADR-0049 D1 default (`backend: "opfs"`): run the UNCONDITIONAL placement probe. A granted probe boots the
      // engine in-SW on OPFS-repacked (SW-direct); a denied one goes router-only + election; a capability-absence
      // decision (`shared-worker` carrying `storageFallbackReason`) boots the in-SW idbfs fallback.
      wireSharedWorkerPlacement(deps, globalScope, true);
    }
    return;
  }
  const hasDedicatedWorkerScope =
    typeof (globalScope as { DedicatedWorkerGlobalScope?: unknown }).DedicatedWorkerGlobalScope !== "undefined";
  if (hasDedicatedWorkerScope) {
    // ADR-0049 D1 (elected engine self-probe): the elected DEDICATED engine holds OPFS access in its OWN scope, so
    // it probes THIS scope's real `createSyncAccessHandle` (invariant 8 — per boot, never sniffed/cached) and
    // threads the verdict as the `elected-worker` home's OPFS grant, opening the boot gate. The step-9 control plane
    // (dynamic pipe acceptance, probe replies, teardown) is still wired by `bindGlobalScope`, unchanged. A DENIED
    // dedicated probe is capability absence in this home: the engine opens idbfs, and the outcome carries a verbatim
    // `storageFallbackReason` so the boot's BootReport shows the fallback (decision 12) rather than a silent idb.
    bindGlobalScope(deps.connect, globalScope);
    const probe = deps.probe ?? probeOpfsSyncAccess;
    void probe().then(
      (result) =>
        deps.onPlacement?.({
          engineHome: "elected-worker",
          opfsGranted: result.granted,
          ...(result.granted
            ? {}
            : { storageFallbackReason: `elected engine OPFS probe denied (${result.error ?? "no attribution"})` }),
        }),
      // The probe answers (never rejects); this guard only protects against an injected fake that throws — still
      // open the gate with no grant so the boot cannot deadlock, falling back to the honest idb backend.
      () =>
        deps.onPlacement?.({
          engineHome: "elected-worker",
          opfsGranted: false,
          storageFallbackReason: "elected engine OPFS probe threw",
        }),
    );
    return;
  }
  // A plain test/Node scope: no engine home, no OPFS grant — settle the gate immediately (no browser placement).
  bindGlobalScope(deps.connect, globalScope);
  deps.onPlacement?.({ engineHome: undefined, opfsGranted: false });
}

/**
 * Wire the SharedWorker arm for placement (ADR-0049 D1). Decides the engine home ONCE, then per `onconnect` port:
 * installs a meta listener answering the placement + destroy-peer queries (and, on SW-direct, the `pgx0049`
 * keepalive ping), and routes the port to the engine host (`shared-worker`) or the router (`elected-worker`).
 * Ports that connect BEFORE the (async) decision resolves are buffered and drained on resolve — the engine host is
 * never touched in `elected-worker` mode until (and unless) the capability-absence fallback flips it to SW-direct.
 */
function wireSharedWorkerPlacement(
  deps: SharedWorkerBootstrapDeps,
  globalScope: unknown,
  /** Whether a GRANTED `shared-worker` home holds the OPFS grant — TRUE in the default probing mode (a granted
      probe placed the engine in-scope on OPFS-repacked), FALSE in the declared `backend: "idbfs"` mode (no probe
      ran). A capability-absence fallback (`shared-worker` carrying `storageFallbackReason`) is idbfs regardless. */
  opfsGrantedForSharedHome: boolean,
): void {
  const scope = globalScope as WorkerGlobalScopeLike;
  const decide = deps.decidePlacement ?? (() => decideSwPlacement());
  // The SharedWorker's own script URL (ADR-0049 D5) — reported in the placement reply so the winning tab can
  // construct the elected engine as `new Worker(swScriptUrl, { type: "module" })` with no consumer wiring. Absent
  // when the scope cannot report its location (a plain test scope); a tab with no override then fails attach typed.
  const swScriptUrl = (globalScope as { location?: { href?: string } }).location?.href;
  let placement: SwPlacementResult | undefined;
  let router: EngineRouter | undefined;
  const pendingPorts: BridgePort[] = [];
  let sharedHostTeardown: Promise<{ error?: { message: string; detail?: unknown } }> | undefined;

  const currentPeerCount = (): number =>
    placement?.engineHome === "elected-worker" ? (router?.tabCount() ?? 0) : deps.peerCount();

  const attachPort = (port: BridgePort): void => {
    const current = placement!;
    // The meta listener answers the placement + destroy-peer queries on EVERY port (both modes) and, per mode:
    //   - SW-direct: the `pgx0049` keepalive control-ping (the router owns that in elected mode).
    //   - elected: the tab's `engine-announce` — the SW-side translation into `router.announceEngine`, handing
    //     the transferred router-end control port to the router so it stamps an identity + pipes the tabs (the
    //     router itself does not react to `engine-announce`; the SharedWorker scope drives it).
    // It coexists with the host's / router's own listener on the same port: each ignores the other's traffic.
    const metaListener = (event: { data: unknown; ports?: readonly ControlPortLike[] }): void => {
      const data = event.data;
      if (isPlacementQuery(data)) {
        // Read `placement` LIVE (not the captured `current`): a capability-absence fallback can flip a router-only
        // scope to `shared-worker` after this port attached, and the reply must reflect the current home + carry
        // the SharedWorker's own script URL (ADR-0049 D5) for the tab's engine auto-derivation.
        const live = placement ?? current;
        port.postMessage({
          [PLACEMENT_RESULT_KEY]: {
            engineHome: live.engineHome,
            electionRequired: live.engineHome === "elected-worker",
            swInstanceId: live.swInstanceId,
            ...(swScriptUrl !== undefined ? { swScriptUrl } : {}),
          } satisfies PlacementQueryResult,
        });
        return;
      }
      if (isDestroyQuery(data)) {
        port.postMessage({ [DESTROY_VERDICT_KEY]: { peers: currentPeerCount() } });
        return;
      }
      const control = readControlEnvelope(data);
      if (current.engineHome === "shared-worker") {
        if (control?.type === "control-ping") {
          port.postMessage(
            controlEnvelope({ type: "control-ack", identity: control.identity, pingId: control.pingId }),
          );
          return;
        }
        if (control?.type === "engine-teardown") {
          const sharedIdentity: EngineIdentity = { swInstanceId: current.swInstanceId, generation: 0 };
          if (!shouldApplyControlMessage(sharedIdentity, control)) return;
          // SW-direct destruction is supervised by the tab, but the exclusive store handles live here. Close
          // the in-scope host first; only the reserved teardown ack proves that quiescence to the tab. The
          // SharedWorker scope then closes itself so a later attach starts a fresh, rebootable host even when
          // `extendedLifetime` would otherwise retain this closed scope.
          sharedHostTeardown ??= Promise.resolve()
            .then(() => deps.closeHost?.())
            .then(
              () => ({}),
              (error: unknown) => ({ error: serializeError(error) }),
            );
          void sharedHostTeardown.then((result) => {
            port.postMessage(
              controlEnvelope({
                type: "control-ack",
                identity: sharedIdentity,
                pingId: -1,
                ...(result.error ? { error: result.error } : {}),
              }),
            );
            // A task boundary, not merely a microtask: give the posted success/failure acknowledgement a delivery
            // turn before closing the SharedWorker global. A close failure poisons this lifetime just as surely as
            // a successful close retires it; never retain a rejected teardown promise in a live scope.
            globalThis.setTimeout(() => scope.close?.(), 0);
          });
        }
        return;
      }
      // elected-worker (router-only): the tab's coordinator drives leadership over this port.
      //   - `leader-granted`: the newly-granted leader is about to (re)spawn its engine. Open the router's handoff
      //     window NOW (fan `leader-granted` to EVERY tab) so in-flight ops settle by outcome and new ops QUEUE
      //     across the spawn→announce→pipe gap, then flush onto the fresh pipe (invariants 5 + 9). Without this the
      //     coordinator's `leader-granted` was DROPPED here, so on a leadership change (succession) a tab kept
      //     dispatching onto the DEAD engine's pipe until the replacement pipe arrived — the elected-flow gap the
      //     step-12 succession/relocation lanes surfaced (the router already owned `openHandoff`; nothing called it).
      //   - `engine-announce`: translate into `router.announceEngine`, handing the transferred router-end control
      //     port to the router so it stamps an identity + pipes the tabs (the router does not react to it itself).
      if (control?.type === "leader-granted") {
        router!.openHandoff("leader-granted");
        return;
      }
      if (control?.type === "engine-announce") {
        const announced = event.ports?.[0];
        if (announced) router!.announceEngine(announced as unknown as RouterPort);
        return;
      }
      // ADR-0049 D1 capability-absence fallback: the tab's elected DEDICATED engine probed its OWN scope and was
      // DENIED — no home on this platform can hold sync-access handles. Abandon election and boot the IN-SCOPE
      // idbfs engine here (with the registry-declared durability), stamping the reported reason into the fallback
      // boot's `storageFallbackReason` (decision 12). This tab's port is connected to the in-scope host now; other
      // tabs re-establish through their placement re-query on reconnect.
      if (control?.type === "engine-fallback") {
        fallBackToIdbfs(control.reason, port);
      }
    };
    port.addEventListener("message", metaListener);
    port.start?.();
    if (current.engineHome === "shared-worker") {
      deps.connect(port);
    } else {
      router!.attachTab(port as unknown as RouterPort);
    }
  };

  // ADR-0049 D1: flip a router-only (`elected-worker`) scope to the in-SharedWorker IDBFS fallback when the elected
  // engine reports its own probe was denied (capability absence in every home). Idempotent — the first report wins.
  // Re-threads the placement onto the entry (so the lazily-booting in-scope engine opens idbfs with the fallback
  // reason) and connects the reporting tab's port to the in-scope host. Peer tabs re-establish via placement re-query.
  let fellBack = false;
  const fallBackToIdbfs = (reason: string, reportingPort: BridgePort): void => {
    if (fellBack) return;
    fellBack = true;
    placement = { engineHome: "shared-worker", swInstanceId: placement?.swInstanceId ?? crypto.randomUUID() };
    deps.onPlacement?.({ engineHome: "shared-worker", opfsGranted: false, storageFallbackReason: reason });
    deps.connect(reportingPort);
  };

  void decide().then((result) => {
    placement = result;
    // `shared-worker` ⇒ the engine boots in-scope: holding OPFS access on a GRANTED probe, or on IDBFS with a
    // `storageFallbackReason` when the decision is a capability-absence fallback. `elected-worker` ⇒ router-only, no
    // in-scope grant (each tab's elected DEDICATED engine probes its own scope). Thread grant + home + fallback
    // reason, open the boot gate. The fallback is idbfs regardless of `opfsGrantedForSharedHome`.
    const isSharedFallback = result.engineHome === "shared-worker" && result.storageFallbackReason !== undefined;
    deps.onPlacement?.({
      engineHome: result.engineHome,
      opfsGranted: result.engineHome === "shared-worker" && opfsGrantedForSharedHome && !isSharedFallback,
      ...(isSharedFallback ? { storageFallbackReason: result.storageFallbackReason } : {}),
    });
    if (result.engineHome === "elected-worker") {
      router = createEngineRouter({
        swInstanceId: result.swInstanceId,
        ...(deps.executionLimit ? { executionLimit: deps.executionLimit } : {}),
      });
    }
    for (const port of pendingPorts) attachPort(port);
    pendingPorts.length = 0;
  });

  scope.onconnect = (event: SharedWorkerConnectEvent) => {
    const port = event.ports[0];
    if (!port) return;
    if (placement === undefined) pendingPorts.push(port);
    else attachPort(port);
  };
}
