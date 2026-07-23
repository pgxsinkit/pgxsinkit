// The ELECTION COORDINATOR (ADR-0049 step 8): the TAB-SIDE, one-per-tab-per-store owner of leader
// participation — the "election coordinator" of CONTEXT.md § "Language — engine placement". Exactly one lives
// per tab per store; both pre-attach provisioning and attach flow through it so a tab NEVER queues behind
// itself on the leader lock (invariant 2). It owns:
//   - the LEADER LOCK claim lifecycle (claim-counted: first claim queues the lock ONCE; last-claim release
//     retires the engine and settles the lock),
//   - the GRANT DUTIES on election (leader-granted → spawn the elected engine worker → engine-announce),
//   - the LEADER KEEPALIVE (the ONE standing timer) with SharedWorker reconstruction on missed acks,
//   - engine-loss handling (reported worker error → respawn; the router's execution-limit verdict →
//     deliberate terminate → VFS ownership release → respawn), and
//   - the BFCache release/reclaim hooks.
//
// It is fully IO-injected — `navigator.locks`, the engine-worker spawner, the control-channel factory, the SW
// bridge port, timers, and the page-lifecycle subscription are all deps — so the whole contract is unit-
// testable with no real worker, no real `navigator.locks`, and no real sleeps (the same discipline the router
// and `engine-control.ts` follow). It speaks the SAME namespaced control envelope the router does
// (`{ [ENGINE_CONTROL_ENVELOPE_KEY]: <EngineControlMessage> }`, `pgx0049`), so it coexists with the data-path
// bridge (`protocol.ts`) untouched.
//
// WIRE NOTES (envelope-shape choices this step pins down):
//   - IDENTITY LEARNING. The router's `announceEngine` mints the engine identity SW-side; the tab learns it
//     from the next identity-tagged fan-out it observes (`engine-ready` / `connect-port`). That learned
//     identity tags the retirement notice + teardown and gates the execution-limit verdict.
//   - KEEPALIVE IDENTITY. The leader keepalive is a liveness check of the SharedWorker ITSELF, not of any
//     engine, so its `control-ping` carries a coordinator-local nonce identity ({@link KEEPALIVE_IDENTITY}) and
//     acks are matched by `pingId` ALONE (the router echoes the ping's identity verbatim). No magic sentinel
//     is compared — the identity field is deliberately irrelevant here.
//   - TEARDOWN ACK. The teardown handshake awaits a `control-ack` carrying the RETIRING engine's identity (the
//     same identity stamped on the `engine-teardown`). The keepalive is stopped at the START of retirement, so
//     no keepalive ack competes; when the identity was never learned the teardown uses a placeholder and any
//     `control-ack` settles it. Either way the `teardownAckTimeoutMs` timer guarantees completion.

import { storeIdentityComponent } from "../store-path";
import {
  engineIdentityEquals,
  type EngineControlMessage,
  type EngineIdentity,
  readControlEnvelope as readEnvelope,
  wrapControlEnvelope as envelope,
} from "./engine-control";

/** The prefix every per-store leader lock name carries (CONTEXT "Leader lock"). */
export const LEADER_LOCK_PREFIX = "pgx-leader-";

/**
 * The per-store leader-lock name: {@link LEADER_LOCK_PREFIX} + the injective store-identity component (D11,
 * invariant 10). Using {@link storeIdentityComponent} keeps the lock name on the SAME one canonical encoding as
 * every other browser-side identity surface (OPFS namespaces, the meta record key, the SharedWorker name), so
 * two distinct store paths can never collapse to one lock (e.g. `"foo/bar"` → `pgx-leader-foo%2Fbar`).
 */
export function leaderLockName(storePath: string): string {
  return LEADER_LOCK_PREFIX + storeIdentityComponent(storePath);
}

/** A minimal MessagePort-shaped end — only ever TRANSFERRED across the SW bridge, never called on here. */
type ControlChannel = { port1: unknown; port2: unknown };

/** The tab's SW bridge port (control plane): where the coordinator posts `pgx0049` envelopes and reads acks. */
export interface SwBridgePort {
  postMessage(message: unknown, transfer?: unknown[]): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface CoordinatorDeps {
  /** navigator.locks-shaped, injectable: `request(name, {signal}, callback)` — the callback's returned promise
      HOLDS the lock; resolving it releases the lock, aborting the signal cancels a still-queued request. */
  locks: {
    request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>): Promise<void>;
  };
  /** Spawn the elected engine worker; returns a handle with `terminate()` and an error-event subscription. */
  spawnEngineWorker: () => { terminate(): void; onError(listener: (message: string) => void): void };
  /** Create the engine control MessageChannel; default `() => new MessageChannel()` — injectable so tests see
      both ends. The ROUTER end (`port1`) is transferred to the SharedWorker via `engine-announce`; the ENGINE
      end (`port2`) is wired to the elected engine worker in step 9. */
  createControlChannel?: () => ControlChannel;
  /** The tab's SW bridge port (control plane): the coordinator posts `pgx0049` envelopes (leader-granted,
      engine-announce with the transferred control port, engine-retiring, engine-teardown, control-ping) and
      receives control-acks + relocation notices on it. */
  swPort: SwBridgePort;
  /** Reconstruct the SharedWorker via the attach worker FACTORY (ADR-0049 D5) → the NEW swPort. Absent only for a
      bare-instance attach input, where a SharedWorker cannot be rebuilt from itself: keepalive recovery is then
      structurally unavailable (the still-live engine + grant are untouched; recovery narrows to leader-op-or-reload). */
  reconstructSw?: () => SwBridgePort;
  /** Await the VFS ownership release after a deliberate terminate (step 10 wires the real wait; tests fake it). */
  awaitOwnershipRelease: () => Promise<void>;
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  /** Page-lifecycle subscription seam (BFCache): `pagehide`/`pageshow`; injectable. */
  pageLifecycle?: { onPageHide(listener: (persisted: boolean) => void): void; onPageShow(listener: () => void): void };
}

export interface ElectionCoordinatorOptions {
  storePath: string;
  /** ms between leader-keepalive pings (default 20000). */
  keepaliveIntervalMs?: number;
  /** consecutive unanswered keepalive pings before SharedWorker reconstruction (default 2). */
  keepaliveMissThreshold?: number;
  /** ms to wait for the teardown ack before terminating anyway (default 3000). */
  teardownAckTimeoutMs?: number;
}

export interface ElectionCoordinator {
  /** Claim for a pre-attach provision (optionally expiry-bounded — an abandoned warmed provision retires
      itself when the timer fires). Returns an idempotent release fn (invariant 2). */
  claimForProvision(opts?: { expiryMs?: number }): () => void;
  /** Claim for one attachment. Returns an idempotent release fn (invariant 2). */
  claimForAttach(): () => void;
  /** True while this tab holds the granted leader lock. */
  isLeader(): boolean;
  /** True while an elected engine worker handle is held. */
  hasEngine(): boolean;
  /**
   * Deliberately RETIRE this tab's elected engine and resolve once its teardown handshake has completed — the
   * point at which the engine's EXCLUSIVE OPFS sync-access handle is provably released (ADR-0049 D8). The
   * destroy supervisor awaits this BEFORE deleting the backend store so `deleteBackendStore` never races the
   * engine's async handle release (which surfaced as `NoModificationAllowedError`). Runs the retirement notice →
   * `engine-teardown` → ack/timeout → terminate → lock-settle sequence, then awaits the ownership-release seam.
   * A no-op (resolves at once) when this tab holds no engine (not the leader). Idempotent.
   */
  retireEngine(): Promise<void>;
}

/** The keepalive's nonce identity: the ping probes the SharedWorker's liveness, NOT an engine — acks are
    matched by `pingId` alone, so this identity is deliberately never compared for staleness. */
const KEEPALIVE_IDENTITY: EngineIdentity = { swInstanceId: "keepalive", generation: 0 };

/** The identity a retirement uses when the engine identity was never learned (no fan-out observed yet). The
    notice/teardown still fire so the attach side opens its handoff window; there is at most one engine under a
    grant, so identity precision is unnecessary. */
const RETIRE_UNKNOWN_IDENTITY: EngineIdentity = { swInstanceId: "", generation: -1 };

type LockState = "idle" | "queued" | "granted";

interface EngineHandle {
  terminate(): void;
  onError(listener: (message: string) => void): void;
}

interface TeardownWait {
  identity: EngineIdentity;
  finish: () => void;
}

export function createElectionCoordinator(
  deps: CoordinatorDeps,
  options: ElectionCoordinatorOptions,
): ElectionCoordinator {
  const lockName = leaderLockName(options.storePath);
  const keepaliveIntervalMs = options.keepaliveIntervalMs ?? 20000;
  const keepaliveMissThreshold = options.keepaliveMissThreshold ?? 2;
  const teardownAckTimeoutMs = options.teardownAckTimeoutMs ?? 3000;
  const createControlChannel = deps.createControlChannel ?? (() => new MessageChannel() as unknown as ControlChannel);

  // ── claim + lock lifecycle ──
  let claimCount = 0;
  let lockState: LockState = "idle";
  let abortController: AbortController | undefined;
  let grantSettle: (() => void) | undefined; // resolving this releases the held lock

  // ── SW bridge + engine state ──
  let swPort = deps.swPort;
  let engineHandle: EngineHandle | undefined;
  let currentIdentity: EngineIdentity | undefined;
  let retiring = false;
  let teardownWait: TeardownWait | undefined;
  let bfcacheSuspended = false;

  // ── keepalive state (the one standing timer) ──
  let keepaliveHandle: unknown;
  let keepaliveMisses = 0;
  let pendingKeepalivePingId: number | undefined;
  let pingSeq = 0;

  function post(message: EngineControlMessage, transfer?: unknown[]): void {
    swPort.postMessage(envelope(message), transfer);
  }

  // ─── SW bridge inbound ──────────────────────────────────────────────────────
  const onSwMessage = (event: { data: unknown }): void => {
    const message = readEnvelope(event.data);
    if (message !== undefined) handleControlMessage(message);
  };
  function attachSwListener(): void {
    swPort.addEventListener("message", onSwMessage);
  }
  function detachSwListener(): void {
    swPort.removeEventListener("message", onSwMessage);
  }

  function handleControlMessage(message: EngineControlMessage): void {
    switch (message.type) {
      case "control-ack":
        // Teardown ack (matches the retiring engine's identity) settles the teardown wait; keepalive is
        // stopped during retirement, so no keepalive ack competes. Otherwise it is a keepalive ack —
        // identity-irrelevant, matched by pingId only.
        if (teardownWait !== undefined && teardownAckMatches(message.identity)) {
          teardownWait.finish();
          return;
        }
        if (message.pingId === pendingKeepalivePingId) {
          keepaliveMisses = 0;
          pendingKeepalivePingId = undefined;
        }
        return;
      case "engine-retiring":
        // The router's execution-limit verdict for OUR current engine (tagged with the retired identity).
        if (isLeader() && currentIdentity !== undefined && engineIdentityEquals(currentIdentity, message.identity)) {
          void onExecutionLimitVerdict();
        }
        return;
      case "engine-ready":
      case "connect-port":
        // The identity-tagged fan-out that teaches the coordinator its current engine identity.
        currentIdentity = message.identity;
        return;
      default:
        // leader-granted / engine-announce are outbound-only from the tab; control-ping / overdue-dispatch
        // are never received here. Nothing to apply.
        return;
    }
  }

  function teardownAckMatches(acked: EngineIdentity): boolean {
    if (teardownWait === undefined) return false;
    // Identity never learned → the teardown carried the placeholder; accept any ack (no other ack source
    // once keepalive is stopped).
    if (engineIdentityEquals(teardownWait.identity, RETIRE_UNKNOWN_IDENTITY)) return true;
    return engineIdentityEquals(teardownWait.identity, acked);
  }

  // ─── lock lifecycle ─────────────────────────────────────────────────────────
  function queueLock(): void {
    if (lockState !== "idle") return;
    lockState = "queued";
    const controller = new AbortController();
    abortController = controller;
    const callback = (): Promise<void> =>
      new Promise<void>((resolve) => {
        abortController = undefined;
        lockState = "granted";
        grantSettle = resolve;
        // Queue→grant race: every claim vanished while queued — settle immediately, never spawn an engine.
        if (claimCount === 0) {
          settleGrant();
          return;
        }
        onGranted();
      });
    void deps.locks.request(lockName, { signal: controller.signal }, callback);
  }

  function settleGrant(): void {
    const resolve = grantSettle;
    grantSettle = undefined;
    lockState = "idle";
    resolve?.();
  }

  function addClaim(): () => void {
    claimCount += 1;
    if (claimCount === 1) queueLock();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseClaim();
    };
  }

  function releaseClaim(): void {
    if (claimCount === 0) return;
    claimCount -= 1;
    if (claimCount > 0) return;
    if (lockState === "queued") {
      // Queued non-leader: cancel the pending request via its AbortSignal (fault row "queued non-leaders
      // cancel via AbortSignal").
      abortController?.abort();
      abortController = undefined;
      lockState = "idle";
    } else if (lockState === "granted") {
      void runRetirement();
    }
  }

  // ─── grant duties ───────────────────────────────────────────────────────────
  function onGranted(): void {
    // leader-granted FIRST — it opens the router's handoff window pre-spawn (the attach side queues new calls).
    post({ type: "leader-granted" });
    spawnEngine();
    announce();
    startKeepalive();
  }

  function spawnEngine(): void {
    engineHandle = deps.spawnEngineWorker();
    engineHandle.onError((message) => onEngineError(message));
  }

  function announce(): void {
    // Fresh control channel every announce: the ROUTER end (port1) is transferred to the SharedWorker (→
    // router.announceEngine); the ENGINE end (port2) is wired to the elected engine worker in step 9.
    const channel = createControlChannel();
    post({ type: "engine-announce" }, [channel.port1]);
  }

  // ─── the single leader keepalive ────────────────────────────────────────────
  function startKeepalive(): void {
    keepaliveMisses = 0;
    pendingKeepalivePingId = undefined;
    scheduleKeepalive();
  }

  function scheduleKeepalive(): void {
    keepaliveHandle = deps.timers.setTimeout(() => {
      keepaliveHandle = undefined;
      const pingId = ++pingSeq;
      pendingKeepalivePingId = pingId;
      post({ type: "control-ping", identity: KEEPALIVE_IDENTITY, pingId });
      keepaliveMisses += 1;
      if (keepaliveMisses >= keepaliveMissThreshold) {
        onKeepaliveThreshold();
      } else {
        scheduleKeepalive();
      }
    }, keepaliveIntervalMs);
  }

  function stopKeepalive(): void {
    if (keepaliveHandle !== undefined) {
      deps.timers.clearTimeout(keepaliveHandle);
      keepaliveHandle = undefined;
    }
    keepaliveMisses = 0;
    pendingKeepalivePingId = undefined;
  }

  function onKeepaliveThreshold(): void {
    stopKeepalive();
    if (deps.reconstructSw === undefined) {
      // A bare-instance attach input has no factory to rebuild the SharedWorker from, so keepalive recovery is
      // structurally unavailable here: stop the keepalive and do nothing else (the still-live engine + grant are
      // untouched — recovery narrows to a leader op or a page reload). A factory input never reaches this branch.
      return;
    }
    // SharedWorker-death recovery is the LOCK HOLDER's causal duty: reconstruct via the factory, move the
    // control plane to the new port, re-announce the still-live engine (a fresh control channel), and resume.
    detachSwListener();
    swPort = deps.reconstructSw();
    attachSwListener();
    announce();
    startKeepalive();
  }

  // ─── engine loss ────────────────────────────────────────────────────────────
  function onEngineError(_message: string): void {
    if (!isLeader()) return;
    // Reported worker death: respawn under the SAME grant (respawn, not re-queue — the leader lock is still
    // held; failover cost is one cold engine boot, ADR D3).
    engineHandle?.terminate();
    currentIdentity = undefined;
    spawnEngine();
    announce();
  }

  async function onExecutionLimitVerdict(): Promise<void> {
    // The router's execution-limit verdict: DELIBERATE termination (idempotent) → await the VFS ownership
    // release that agent termination guarantees → respawn under the still-held grant (ADR D5).
    engineHandle?.terminate();
    engineHandle = undefined;
    currentIdentity = undefined;
    await deps.awaitOwnershipRelease();
    if (!isLeader()) return; // the grant may have been released while awaiting
    spawnEngine();
    announce();
  }

  // ─── deliberate retirement (last-claim / BFCache) ───────────────────────────
  async function runRetirement(): Promise<void> {
    if (retiring) return;
    retiring = true;
    const identity = currentIdentity ?? RETIRE_UNKNOWN_IDENTITY;
    // Stop the keepalive FIRST so no keepalive ack competes with the teardown ack.
    stopKeepalive();
    // The retirement notice PRECEDES the teardown — the attach side opens its handoff window and queues new
    // calls before the engine goes (ADR D5, "deliberate retirement opens the window first").
    post({ type: "engine-retiring", identity });
    post({ type: "engine-teardown", identity });
    await awaitTeardownAck(identity);
    engineHandle?.terminate();
    engineHandle = undefined;
    currentIdentity = undefined;
    retiring = false;
    settleGrant(); // resolve the lock-holding promise → release the leader lock
  }

  function awaitTeardownAck(identity: EngineIdentity): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        if (teardownWait === undefined) return;
        teardownWait = undefined;
        deps.timers.clearTimeout(timeoutHandle);
        resolve();
      };
      const timeoutHandle = deps.timers.setTimeout(finish, teardownAckTimeoutMs);
      teardownWait = { identity, finish };
    });
  }

  // ─── BFCache hooks ──────────────────────────────────────────────────────────
  deps.pageLifecycle?.onPageHide((persisted) => {
    // Persisted freeze (BFCache entry, D2): release leader authority + retire the engine, but PRESERVE the
    // claim count so pageshow can re-queue. A non-persisted pagehide is ordinary navigation — the lock is
    // released structurally on agent teardown, nothing special here.
    if (persisted && lockState === "granted") {
      bfcacheSuspended = true;
      void runRetirement();
    }
  });
  deps.pageLifecycle?.onPageShow(() => {
    if (!bfcacheSuspended) return;
    bfcacheSuspended = false;
    // Claims were never decremented across the freeze, so a surviving claim re-queues the leader lock.
    if (claimCount > 0) queueLock();
  });

  attachSwListener();

  function isLeader(): boolean {
    return lockState === "granted";
  }

  return {
    claimForProvision(opts) {
      const release = addClaim();
      if (opts?.expiryMs === undefined) return release;
      // Abandoned warmed provision (D2): auto-release this claim when the expiry fires (which, if it is the
      // last claim while granted, runs the retirement sequence).
      const handle = deps.timers.setTimeout(() => release(), opts.expiryMs);
      return () => {
        deps.timers.clearTimeout(handle);
        release();
      };
    },
    claimForAttach() {
      return addClaim();
    },
    isLeader,
    hasEngine() {
      return engineHandle !== undefined;
    },
    async retireEngine() {
      // Nothing to retire when this tab holds no engine (not the leader): the store's OPFS handle, if any, is
      // held by another tab's engine — the peer-refusal gate already covered that (destroy refuses with peers).
      if (!isLeader() || engineHandle === undefined) return;
      // Run the graceful retirement (notice → teardown → ack/timeout → terminate → lock settle); `runRetirement`
      // awaits the teardown ack (the release point) before terminating. Then await the ownership-release seam so
      // a consumer/test can gate on the agent actually dropping the exclusive handle (default: resolved).
      await runRetirement();
      await deps.awaitOwnershipRelease();
    },
  };
}
