import { describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) step 8: the ELECTION COORDINATOR — the tab-side, one-per-tab
// -per-store owner of leader participation (CONTEXT.md § "Language — engine placement": Election coordinator,
// Leader lock, Leader keepalive, Elected engine worker). These unit tests drive the whole behavior contract
// over FAKE deps — a controllable `navigator.locks`-shaped `locks`, a recording SW bridge port, a fake engine
// -worker spawner, an injectable control-channel factory, and deterministic injected timers. No real worker,
// no real `navigator.locks`, no real MessageChannel, no real sleeps.
//
// Invariants exercised: ONE lock request per tab, claims own the lifecycle (invariant 2); deliberate
// retirement opens the handoff window first (notice → teardown → ack/timeout → settle the lock); the single
// leader keepalive with SharedWorker reconstruction; engine-loss respawn and the execution-limit verdict's
// deliberate-termination sequence; BFCache release + reclaim.

import { resolvedOwnershipRelease } from "../../packages/client/src/worker/attach-sync-client";
import {
  createElectionCoordinator,
  leaderLockName,
  LEADER_LOCK_PREFIX,
  type CoordinatorDeps,
} from "../../packages/client/src/worker/election-coordinator";
import type { EngineControlMessage, EngineIdentity } from "../../packages/client/src/worker/engine-control";
import { ENGINE_CONTROL_ENVELOPE_KEY as KEY } from "../../packages/client/src/worker/engine-router";

// ─── Fake control-channel port objects (bare identities — only ever TRANSFERRED) ─

let chSeq = 0;
interface FakeChannel {
  port1: unknown;
  port2: unknown;
}
function makeChannelFactory() {
  const channels: FakeChannel[] = [];
  const createControlChannel = (): FakeChannel => {
    const id = chSeq++;
    const ch: FakeChannel = { port1: { __ch: id, __end: 1 }, port2: { __ch: id, __end: 2 } };
    channels.push(ch);
    return ch;
  };
  return { channels, createControlChannel };
}

// ─── Fake SW bridge port (records posts into a shared event log; can emit inbound) ─

interface Sent {
  message: { [KEY]: EngineControlMessage };
  transfer?: unknown[] | undefined;
}
interface FakeSwPort {
  port: CoordinatorDeps["swPort"];
  sent: Sent[];
  emit: (message: EngineControlMessage) => void;
}
function makeSwPort(events: string[], label: string): FakeSwPort {
  const sent: Sent[] = [];
  let listener: ((event: { data: unknown }) => void) | undefined;
  const port: CoordinatorDeps["swPort"] = {
    postMessage(message: unknown, transfer?: unknown[]) {
      const record = message as Sent["message"];
      sent.push({ message: record, transfer });
      events.push(`${label}:${record[KEY].type}`);
    },
    addEventListener(_type: "message", l: (event: { data: unknown }) => void) {
      listener = l;
    },
    removeEventListener(_type: "message", l: (event: { data: unknown }) => void) {
      if (listener === l) listener = undefined;
    },
  };
  return { port, sent, emit: (message) => listener?.({ data: { [KEY]: message } }) };
}

const control = (rec: Sent): EngineControlMessage => rec.message[KEY];
const ofType = (sent: Sent[], type: EngineControlMessage["type"]) => sent.filter((s) => control(s).type === type);

// ─── Fake locks (records requests; the TEST drives grant by invoking the callback) ─

interface LockRequest {
  name: string;
  signal: AbortSignal | undefined;
  callback: () => Promise<void>;
}
interface GrantHandle {
  settled: boolean;
}
function makeLocks() {
  const reqs: LockRequest[] = [];
  const locks: CoordinatorDeps["locks"] = {
    request(name, options, callback) {
      reqs.push({ name, signal: options.signal, callback });
      // The real navigator.locks outer promise settles only on release/abort; the coordinator never keys
      // state off it, so a never-resolving promise faithfully models "queued until granted".
      return new Promise<void>(() => {});
    },
  };
  // Invoke the grant callback (the browser's job) and track when its holding promise settles (lock released).
  const grant = (index = reqs.length - 1): GrantHandle => {
    const handle: GrantHandle = { settled: false };
    void reqs[index]!.callback().then(() => {
      handle.settled = true;
    });
    return handle;
  };
  return { reqs, locks, grant };
}

// ─── Fake engine-worker spawner ──────────────────────────────────────────────────

interface SpawnedEngine {
  terminated: boolean;
  errorListeners: ((message: string) => void)[];
}
function makeSpawner(events: string[]) {
  const spawned: SpawnedEngine[] = [];
  const spawnEngineWorker: CoordinatorDeps["spawnEngineWorker"] = () => {
    const engine: SpawnedEngine = { terminated: false, errorListeners: [] };
    spawned.push(engine);
    events.push("spawn");
    return {
      terminate() {
        engine.terminated = true;
      },
      onError(listener) {
        engine.errorListeners.push(listener);
      },
    };
  };
  const fireError = (index: number, message: string) => {
    for (const l of spawned[index]!.errorListeners) l(message);
  };
  return { spawned, spawnEngineWorker, fireError };
}

// ─── Fake timers (multiple concurrent timers; fire earliest-live or by duration) ──

interface Scheduled {
  fn: () => void;
  ms: number;
  handle: number;
  live: boolean;
}
function makeTimers() {
  const scheduled: Scheduled[] = [];
  let seq = 0;
  const timers: CoordinatorDeps["timers"] = {
    setTimeout(fn, ms) {
      const handle = seq++;
      scheduled.push({ fn, ms, handle, live: true });
      return handle;
    },
    clearTimeout(handle) {
      const t = scheduled.find((s) => s.handle === handle);
      if (t) t.live = false;
    },
  };
  const fire = (pred: (s: Scheduled) => boolean): boolean => {
    const t = scheduled.find((s) => s.live && pred(s));
    if (!t) return false;
    t.live = false;
    t.fn();
    return true;
  };
  return {
    timers,
    liveCount: () => scheduled.filter((s) => s.live).length,
    tick: () => fire(() => true), // earliest-scheduled live timer
    tickMs: (ms: number) => fire((s) => s.ms === ms),
  };
}

// ─── Deferred (drives awaitOwnershipRelease) ──────────────────────────────────────

function makeDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ─── The harness ─────────────────────────────────────────────────────────────────

const KEEPALIVE_MS = 1000;
const TEARDOWN_MS = 3000;

interface Harness {
  events: string[];
  locks: ReturnType<typeof makeLocks>;
  sw: FakeSwPort;
  reconstructedSw: FakeSwPort;
  reconstructCalls: () => number;
  spawner: ReturnType<typeof makeSpawner>;
  channels: FakeChannel[];
  timers: ReturnType<typeof makeTimers>;
  ownership: { deferreds: ReturnType<typeof makeDeferred>[] };
  pageHide: (persisted: boolean) => void;
  pageShow: () => void;
}

function makeHarness(opts?: {
  withReconstruct?: boolean;
  withPageLifecycle?: boolean;
  keepaliveMissThreshold?: number;
}): { deps: CoordinatorDeps; h: Harness } {
  const events: string[] = [];
  const locks = makeLocks();
  const sw = makeSwPort(events, "post");
  const reconstructedSw = makeSwPort(events, "post");
  const spawner = makeSpawner(events);
  const channelFactory = makeChannelFactory();
  const timers = makeTimers();
  const ownership = { deferreds: [] as ReturnType<typeof makeDeferred>[] };
  let reconstructCalls = 0;

  let pageHideListener: ((persisted: boolean) => void) | undefined;
  let pageShowListener: (() => void) | undefined;

  const deps: CoordinatorDeps = {
    locks: locks.locks,
    spawnEngineWorker: spawner.spawnEngineWorker,
    createControlChannel: channelFactory.createControlChannel,
    swPort: sw.port,
    awaitOwnershipRelease: () => {
      const d = makeDeferred();
      ownership.deferreds.push(d);
      return d.promise;
    },
    timers: timers.timers,
    ...(opts?.withReconstruct
      ? {
          reconstructSw: () => {
            reconstructCalls += 1;
            return reconstructedSw.port;
          },
        }
      : {}),
    ...(opts?.withPageLifecycle
      ? {
          pageLifecycle: {
            onPageHide(listener) {
              pageHideListener = listener;
            },
            onPageShow(listener) {
              pageShowListener = listener;
            },
          },
        }
      : {}),
  };

  const h: Harness = {
    events,
    locks,
    sw,
    reconstructedSw,
    reconstructCalls: () => reconstructCalls,
    spawner,
    channels: channelFactory.channels,
    timers,
    ownership,
    pageHide: (persisted) => pageHideListener?.(persisted),
    pageShow: () => pageShowListener?.(),
  };
  return { deps, h };
}

const OPTIONS = {
  storePath: "my-store",
  keepaliveIntervalMs: KEEPALIVE_MS,
  keepaliveMissThreshold: 2,
  teardownAckTimeoutMs: TEARDOWN_MS,
};

const ID: EngineIdentity = { swInstanceId: "sw-1", generation: 0 };

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

// ─── 0. Lock name ─────────────────────────────────────────────────────────────

describe("leaderLockName — the per-store Web Lock name (injective encoding, D11)", () => {
  it("prefixes the injective store-identity component", () => {
    expect(leaderLockName("foo/bar")).toBe(`${LEADER_LOCK_PREFIX}foo%2Fbar`);
    expect(leaderLockName("foo/bar")).toBe("pgx-leader-foo%2Fbar");
    expect(leaderLockName("my-store")).toBe("pgx-leader-my-store");
  });
});

// ─── 1. Claim counting (invariant 2): ONE lock request per tab ──────────────────

describe("claims (invariant 2) — one lock request, claim-counted", () => {
  it("two claims issue exactly ONE locks.request; releasing one keeps it queued", () => {
    const { deps, h } = makeHarness();
    const coordinator = createElectionCoordinator(deps, OPTIONS);

    const releaseA = coordinator.claimForProvision();
    const releaseB = coordinator.claimForAttach();
    expect(h.locks.reqs).toHaveLength(1);
    expect(h.locks.reqs[0]!.name).toBe(leaderLockName("my-store"));

    releaseA();
    expect(h.locks.reqs).toHaveLength(1);
    expect(h.locks.reqs[0]!.signal?.aborted).toBe(false);
    void releaseB;
  });

  it("releasing the LAST claim while QUEUED aborts the request via its AbortSignal", () => {
    const { deps, h } = makeHarness();
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    const releaseA = coordinator.claimForAttach();
    const releaseB = coordinator.claimForAttach();

    releaseA();
    releaseB();
    expect(h.locks.reqs[0]!.signal?.aborted).toBe(true);
    expect(coordinator.isLeader()).toBe(false);
  });
});

// ─── 2. Grant duties: leader-granted BEFORE spawn; announce (transferred) AFTER ──

describe("grant duties — leader-granted → spawn → engine-announce (control port transferred)", () => {
  it("posts leader-granted before spawn, then engine-announce with the fresh control port transferred", () => {
    const { deps, h } = makeHarness();
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    coordinator.claimForAttach();

    h.locks.grant();

    // Order: leader-granted OPENS the router window pre-spawn; spawn; then the announce.
    expect(h.events).toEqual(["post:leader-granted", "spawn", "post:engine-announce"]);
    expect(coordinator.isLeader()).toBe(true);
    expect(coordinator.hasEngine()).toBe(true);

    // The engine-announce transferred exactly the ROUTER end (port1) of a freshly-minted control channel.
    const announces = ofType(h.sw.sent, "engine-announce");
    expect(announces).toHaveLength(1);
    expect(announces[0]!.transfer).toEqual([h.channels[0]!.port1]);
    expect(h.channels).toHaveLength(1);
  });
});

// ─── 3. Last-claim retirement: notice → teardown → ack/timeout → settle the lock ──

describe("retirement on last-claim release while granted (D2, D5)", () => {
  it("posts engine-retiring → engine-teardown; the teardown ACK terminates + settles the lock callback", async () => {
    const { deps, h } = makeHarness();
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    const release = coordinator.claimForAttach();
    const grant = h.locks.grant();

    // Learn the engine identity from a router fan-out (connect-port carries the current identity).
    h.sw.emit({ type: "connect-port", identity: ID });

    release();
    // Retirement notice precedes teardown (attach side opens its handoff window before the engine goes).
    const retiring = ofType(h.sw.sent, "engine-retiring");
    const teardown = ofType(h.sw.sent, "engine-teardown");
    expect(retiring).toHaveLength(1);
    expect(teardown).toHaveLength(1);
    const rMsg = control(retiring[0]!);
    expect(rMsg.type === "engine-retiring" && rMsg.identity).toEqual(ID);
    // engine-retiring is posted BEFORE engine-teardown.
    expect(h.sw.sent.map((s) => control(s).type)).toEqual([
      "leader-granted",
      "engine-announce",
      "engine-retiring",
      "engine-teardown",
    ]);
    // Not yet terminated — still awaiting the teardown ack.
    expect(h.spawner.spawned[0]!.terminated).toBe(false);

    h.sw.emit({ type: "control-ack", identity: ID, pingId: 999 });
    await flush();

    expect(h.spawner.spawned[0]!.terminated).toBe(true);
    expect(grant.settled).toBe(true); // the lock callback promise resolved → lock released
    expect(coordinator.isLeader()).toBe(false);
  });

  it("with NO ack, the teardown TIMEOUT drives the same completion (terminate + settle)", async () => {
    const { deps, h } = makeHarness();
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    const release = coordinator.claimForAttach();
    const grant = h.locks.grant();

    release();
    expect(ofType(h.sw.sent, "engine-retiring")).toHaveLength(1);
    expect(ofType(h.sw.sent, "engine-teardown")).toHaveLength(1);
    expect(h.spawner.spawned[0]!.terminated).toBe(false);

    // Keepalive was stopped at retirement start, so the only live timer is the teardown-ack timeout.
    expect(h.timers.tickMs(TEARDOWN_MS)).toBe(true);
    await flush();

    expect(h.spawner.spawned[0]!.terminated).toBe(true);
    expect(grant.settled).toBe(true);
  });
});

// ─── 3b. retireEngine — explicit destroy-path retirement + ownership barrier (D8) ─

describe("retireEngine (destroy path) — retire + AWAIT the ownership release before resolving (D8)", () => {
  it("retires the engine (notice→teardown→ack→terminate) then resolves only AFTER awaitOwnershipRelease", async () => {
    const { deps, h } = makeHarness();
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    coordinator.claimForAttach();
    const grant = h.locks.grant();
    h.sw.emit({ type: "connect-port", identity: ID }); // learn the current engine identity

    let resolved = false;
    const retire = coordinator.retireEngine().then(() => {
      resolved = true;
    });

    // The graceful retirement handshake fired (notice precedes teardown); not yet terminated (awaiting the ack).
    expect(ofType(h.sw.sent, "engine-retiring")).toHaveLength(1);
    expect(ofType(h.sw.sent, "engine-teardown")).toHaveLength(1);
    expect(h.spawner.spawned[0]!.terminated).toBe(false);

    // The teardown ack drives terminate + lock settle.
    h.sw.emit({ type: "control-ack", identity: ID, pingId: 999 });
    await flush();
    expect(h.spawner.spawned[0]!.terminated).toBe(true);
    expect(grant.settled).toBe(true);

    // Still PENDING: retireEngine awaits the ownership-release seam — the provable handle-release barrier the
    // destroy path gates deleteBackendStore on (so the OPFS delete never races the async handle release).
    expect(resolved).toBe(false);
    h.ownership.deferreds[0]!.resolve();
    await retire;
    expect(resolved).toBe(true);
    expect(coordinator.isLeader()).toBe(false);
  });

  it("is a no-op (resolves at once, no teardown) when this tab holds no engine", async () => {
    const { deps, h } = makeHarness();
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    coordinator.claimForAttach(); // queued, never granted → no engine held
    await coordinator.retireEngine();
    expect(ofType(h.sw.sent, "engine-teardown")).toHaveLength(0);
    expect(h.ownership.deferreds).toHaveLength(0); // never reached the ownership barrier
  });
});

// ─── 4. Provision expiry: an abandoned warmed provision retires + releases ────────

describe("provision claim expiry (abandoned warmed provision, D2)", () => {
  it("claimForProvision({expiryMs}) auto-releases on the timer → full retirement", async () => {
    const { deps, h } = makeHarness();
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    coordinator.claimForProvision({ expiryMs: 5000 });
    const grant = h.locks.grant();
    expect(coordinator.isLeader()).toBe(true);

    // Fire the provision expiry timer (5000ms) — distinct from the keepalive interval (1000ms).
    expect(h.timers.tickMs(5000)).toBe(true);

    // Last claim gone while granted → retirement sequence.
    expect(ofType(h.sw.sent, "engine-retiring")).toHaveLength(1);
    expect(ofType(h.sw.sent, "engine-teardown")).toHaveLength(1);

    // Complete via the teardown timeout.
    expect(h.timers.tickMs(TEARDOWN_MS)).toBe(true);
    await flush();
    expect(h.spawner.spawned[0]!.terminated).toBe(true);
    expect(grant.settled).toBe(true);
  });
});

// ─── 5. Keepalive — the one standing timer; reconstruction on missed acks ─────────

describe("leader keepalive (the one standing timer)", () => {
  it("pings at the interval; a matching ack keeps it alive (no reconstruction, no verdict)", () => {
    const { deps, h } = makeHarness({ withReconstruct: true });
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    coordinator.claimForAttach();
    h.locks.grant();

    h.timers.tickMs(KEEPALIVE_MS); // ping 1
    const pings = ofType(h.sw.sent, "control-ping");
    expect(pings).toHaveLength(1);
    const ping1 = control(pings[0]!);
    const pingId1 = ping1.type === "control-ping" ? ping1.pingId : -1;

    // Ack it (pingId-matched — the keepalive identity is a coordinator-local nonce, matched by pingId only).
    h.sw.emit({ type: "control-ack", identity: { swInstanceId: "keepalive", generation: 0 }, pingId: pingId1 });

    h.timers.tickMs(KEEPALIVE_MS); // ping 2
    expect(ofType(h.sw.sent, "control-ping")).toHaveLength(2);
    // Still leader, no reconstruction, engine intact.
    expect(coordinator.isLeader()).toBe(true);
    expect(h.reconstructCalls()).toBe(0);
  });

  it("threshold consecutive missed acks WITH a factory → reconstruct once, re-announce, resume", () => {
    const { deps, h } = makeHarness({ withReconstruct: true });
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    coordinator.claimForAttach();
    h.locks.grant();
    expect(h.channels).toHaveLength(1); // the grant-time announce

    h.timers.tickMs(KEEPALIVE_MS); // ping 1, miss 1
    h.timers.tickMs(KEEPALIVE_MS); // ping 2, miss 2 → threshold → reconstruct

    expect(h.reconstructCalls()).toBe(1);
    // The NEW SW port received a re-announce with a FRESH control channel transferred.
    const reAnnounces = ofType(h.reconstructedSw.sent, "engine-announce");
    expect(reAnnounces).toHaveLength(1);
    expect(h.channels.length).toBe(2);
    expect(reAnnounces[0]!.transfer).toEqual([h.channels[1]!.port1]);

    // Keepalive resumed on the new port: the next tick pings the reconstructed port.
    h.timers.tickMs(KEEPALIVE_MS);
    expect(ofType(h.reconstructedSw.sent, "control-ping")).toHaveLength(1);
  });

  it("threshold missed acks WITHOUT a factory → keepalive stops, degraded, no crash", () => {
    const { deps, h } = makeHarness({ withReconstruct: false });
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    coordinator.claimForAttach();
    h.locks.grant();

    h.timers.tickMs(KEEPALIVE_MS); // miss 1
    h.timers.tickMs(KEEPALIVE_MS); // miss 2 → threshold, no factory

    // No further keepalive timer scheduled (degraded, risk item 3); engine + leadership intact.
    expect(h.timers.liveCount()).toBe(0);
    expect(coordinator.isLeader()).toBe(true);
    expect(coordinator.hasEngine()).toBe(true);
  });
});

// ─── 6. Engine loss (reported): worker error → terminate + respawn under the grant ─

describe("engine-worker error (reported death) — respawn under the SAME grant", () => {
  it("terminates the dead worker and respawns + re-announces, with no new lock request", () => {
    const { deps, h } = makeHarness();
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    coordinator.claimForAttach();
    h.locks.grant();
    expect(h.spawner.spawned).toHaveLength(1);

    h.spawner.fireError(0, "uncaught");

    expect(h.spawner.spawned[0]!.terminated).toBe(true);
    expect(h.spawner.spawned).toHaveLength(2); // respawn
    expect(ofType(h.sw.sent, "engine-announce")).toHaveLength(2); // fresh announce
    expect(h.locks.reqs).toHaveLength(1); // grant still held — never re-queued
    expect(coordinator.isLeader()).toBe(true);
  });
});

// ─── 7. Execution-limit verdict: engine-retiring → deliberate terminate → respawn ─

describe("execution-limit verdict (incoming engine-retiring for the current engine, D5)", () => {
  it("terminates, awaits VFS ownership release, then respawns + re-announces", async () => {
    const { deps, h } = makeHarness();
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    coordinator.claimForAttach();
    h.locks.grant();
    h.sw.emit({ type: "connect-port", identity: ID }); // learn the current identity

    h.sw.emit({ type: "engine-retiring", identity: ID }); // the router's verdict for our engine
    expect(h.spawner.spawned[0]!.terminated).toBe(true);
    // Respawn waits for the ownership release deferred.
    expect(h.spawner.spawned).toHaveLength(1);
    expect(h.ownership.deferreds).toHaveLength(1);

    h.ownership.deferreds[0]!.resolve();
    await flush();

    expect(h.spawner.spawned).toHaveLength(2); // respawned after ownership release
    expect(ofType(h.sw.sent, "engine-announce")).toHaveLength(2);
    expect(coordinator.isLeader()).toBe(true);
  });

  // ADR-0049 step 11b follow-up 1: the DEFAULT ownership-release wait is the documented NO-OP
  // `resolvedOwnershipRelease` (the OPFS-repacked VFS uses exclusive sync-access handles, not a Web Lock, so the
  // bounded wait lives in the SUCCESSOR'S OPEN PATH — `createOpfsRepacked` retries on `StoreOwnedError`). With the
  // no-op the coordinator respawns immediately after a deliberate terminate — it never blocks on ownership here.
  it("with the default no-op ownership release → respawns immediately (the open path is the real gate)", async () => {
    const { deps, h } = makeHarness();
    // Prove the wrapper itself resolves (no hang) and use it as the coordinator's ownership-release seam.
    expect(await resolvedOwnershipRelease()).toBeUndefined();
    deps.awaitOwnershipRelease = resolvedOwnershipRelease;
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    coordinator.claimForAttach();
    h.locks.grant();
    h.sw.emit({ type: "connect-port", identity: ID });

    h.sw.emit({ type: "engine-retiring", identity: ID });
    await flush();

    // No external resolve needed — the no-op unblocks the respawn (the bounded retry is the VFS open, not here).
    expect(h.spawner.spawned[0]!.terminated).toBe(true);
    expect(h.spawner.spawned).toHaveLength(2);
    expect(ofType(h.sw.sent, "engine-announce")).toHaveLength(2);
    expect(coordinator.isLeader()).toBe(true);
  });
});

// ─── 8. BFCache: persisted pagehide retires; pageshow re-queues (claims preserved) ─

describe("BFCache lifecycle (D2) — persisted pagehide releases authority, pageshow reclaims", () => {
  it("persisted pagehide runs full retirement; pageshow re-issues the lock request, claims preserved", async () => {
    const { deps, h } = makeHarness({ withPageLifecycle: true });
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    coordinator.claimForAttach();
    h.locks.grant();
    expect(coordinator.isLeader()).toBe(true);

    h.pageHide(true);
    // Full retirement sequence.
    expect(ofType(h.sw.sent, "engine-retiring")).toHaveLength(1);
    expect(ofType(h.sw.sent, "engine-teardown")).toHaveLength(1);
    h.timers.tickMs(TEARDOWN_MS); // no ack → timeout
    await flush();
    expect(h.spawner.spawned[0]!.terminated).toBe(true);
    expect(coordinator.isLeader()).toBe(false);
    // Only ONE lock request so far (the original) — retirement released it structurally via the callback.
    expect(h.locks.reqs).toHaveLength(1);

    h.pageShow();
    // Re-queued: a SECOND lock request, with the claim count preserved (never decremented on BFCache).
    expect(h.locks.reqs).toHaveLength(2);
    expect(h.locks.reqs[1]!.name).toBe(leaderLockName("my-store"));
  });

  it("non-persisted pagehide does nothing special (lock released structurally on teardown)", () => {
    const { deps, h } = makeHarness({ withPageLifecycle: true });
    const coordinator = createElectionCoordinator(deps, OPTIONS);
    coordinator.claimForAttach();
    h.locks.grant();

    h.pageHide(false);
    expect(ofType(h.sw.sent, "engine-retiring")).toHaveLength(0);
    expect(coordinator.isLeader()).toBe(true);
  });
});
