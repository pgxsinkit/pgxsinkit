import { afterEach, describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) — the COMPOSED, END-TO-END-shaped placement path, run entirely
// off-worker over REAL `MessageChannel`s. Unlike `attach-placement.test.ts` (which hand-orchestrates a scripted
// SW/router side and manually feeds `connect-port`), this suite wires the REAL pieces together and lets them
// drive each other exactly as they do in a browser:
//
//   - the REAL SharedWorker placement bootstrap (`bootstrapWorkerScope` over a fake SharedWorker global scope,
//     probe DENIED ⇒ `elected-worker` / router-only) → a REAL `createEngineRouter` + the REAL meta listener,
//   - the REAL tab attach flow (`attachSyncClient`) with a REAL election coordinator (built internally on the
//     `electionRequired` reply) + a REAL `createEngineWorker` factory,
//   - a REAL dedicated-engine control plane (`bindGlobalScope`'s dedicated arm) behind a scripted engine core,
//
// so the composed sequence runs on its own: attach → placement query → `electionRequired` → election → announce
// → assign-identity → engine-ready → `connect-port` (transferred pipe) → attach handshake ON THE PIPE.
//
// This is the exact path the elected-mode deadlock hid in: `attachSyncClient` used to await the SW-port attach
// ack BEFORE posting the placement query, but a router-only SharedWorker DROPS the bridge attach — so the ack
// never came, the placement query never posted, election never started, and the attach hung forever. With the
// placement-query-FIRST ordering the flow completes off the elected engine's PIPE. Before the fix this suite
// DEADLOCKS (the attach `await` never settles); after it, it passes.

import { pgTable, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  identityCodec,
  isBridgeEnvelope,
  postBridgeMessage,
  provisionSyncWorker,
} from "../../packages/client/src/index";
import { type ElectedEngineWorker, wrapEngineWorker } from "../../packages/client/src/worker/attach-sync-client";
import {
  bindGlobalScope,
  bootstrapWorkerScope,
  DECLARATION_KEY,
  PLACEMENT_RESULT_KEY,
} from "../../packages/client/src/worker/define-sync-worker";
import type { CoordinatorDeps } from "../../packages/client/src/worker/election-coordinator";
import { readControlEnvelope, wrapControlEnvelope } from "../../packages/client/src/worker/engine-control";
import type { AttachPayload, BridgePort, RestoreArtefactWire } from "../../packages/client/src/worker/protocol";
import type { SwPlacementResult } from "../../packages/client/src/worker/sw-placement";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const settle = async (n = 30) => {
  for (let i = 0; i < n; i++) await tick();
};

const todos = pgTable("todos", { id: uuid("id").primaryKey() });
const attachRegistry = {
  todos: {
    table: todos,
    mode: "readonly",
    primaryKey: { columns: ["id"] },
    shape: { tableName: "todos", shapeKey: "todos-shape" },
    clientProjection: { syncedTable: "todos" },
  },
} as unknown as SyncTableRegistry;

// Every real MessageChannel opened here is torn down after each test — an open MessagePort keeps Bun's event
// loop alive, so a leak would hang the process (the same discipline `attach-placement.test.ts` follows).
let openChannels: MessageChannel[] = [];
const track = (channel: MessageChannel): MessageChannel => {
  openChannels.push(channel);
  return channel;
};
// Single ends kept alive by a listener (a channel whose OTHER end was transferred away) are closed the same way.
let openPorts: MessagePort[] = [];
const trackPort = (port: MessagePort): MessagePort => {
  openPorts.push(port);
  return port;
};
afterEach(() => {
  for (const channel of openChannels) {
    channel.port1.close();
    channel.port2.close();
  }
  for (const port of openPorts) port.close();
  openChannels = [];
  openPorts = [];
});

/** A fake SharedWorkerGlobalScope (the constructor marker the bootstrap detects + a settable `onconnect`). */
function makeFakeSharedScope() {
  const scope: { SharedWorkerGlobalScope: unknown; onconnect?: (event: { ports: BridgePort[] }) => void } = {
    SharedWorkerGlobalScope: class {},
  };
  return { scope, connect: (port: BridgePort) => scope.onconnect?.({ ports: [port] }) };
}

/** A fake DedicatedWorkerGlobalScope backed by a real MessagePort — its implicit engine port. */
function makeFakeDedicatedScope(implicitPort: MessagePort) {
  let closed = false;
  const scope = {
    DedicatedWorkerGlobalScope: class {},
    postMessage: (message: unknown) => implicitPort.postMessage(message),
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      implicitPort.addEventListener(type as "message", listener as EventListener),
    removeEventListener: (type: string, listener: (event: unknown) => void) =>
      implicitPort.removeEventListener(type as "message", listener as EventListener),
    close: () => {
      closed = true;
    },
  };
  implicitPort.start();
  return { scope, isClosed: () => closed };
}

/**
 * A scripted engine CORE (the engine-router/coordinator/attach are the REAL pieces under test; the engine core is
 * not what the placement bug is about). It acks `attach` + emits phase `ready`, and answers each `rpc` with
 * `rpcValue`. Fed to `bindGlobalScope`'s dedicated arm, so a transferred `connect-port` pipe flows into it exactly
 * as the real engine host's `connect` would.
 */
function scriptedEngineCore(rpcValue: unknown) {
  const attachedPorts: BridgePort[] = [];
  const restoreAttaches: RestoreArtefactWire[] = [];
  const bridgeArrivals: string[] = [];
  let provisionCount = 0;
  let bootCount = 0;
  const connect = (port: BridgePort) => {
    attachedPorts.push(port);
    port.addEventListener("message", (event) => {
      const data = (event as { data: unknown }).data;
      if (!isBridgeEnvelope(data)) return;
      if (data.type === "provision" || data.type === "attach") bridgeArrivals.push(data.type);
      if (data.type === "provision") {
        // Pre-spawn (initdb only) once; a fresh attach ADOPTS it (never a second initdb).
        provisionCount += 1;
        postBridgeMessage(port, identityCodec, "provision-ack", { ok: true });
      } else if (data.type === "attach") {
        bootCount += 1; // one engine boot, whether fresh or adopting the pre-spawned store
        // Record any restore artifact that actually REACHED the engine (the elected-restore regression seam).
        const attach = identityCodec.decode(data.payload) as AttachPayload;
        if (attach.restore != null) restoreAttaches.push(attach.restore);
        postBridgeMessage(port, identityCodec, "attach-ack", { alreadyBooted: false });
        postBridgeMessage(port, identityCodec, "event", {
          kind: "status",
          status: { phase: "ready", isRunning: true },
        });
      } else if (data.type === "rpc") {
        postBridgeMessage(port, identityCodec, "rpc-result", { ok: true, value: rpcValue }, data.id);
      }
    });
    port.start?.();
  };
  return {
    connect,
    attachedPorts,
    restoreAttaches,
    bridgeArrivals,
    provisionCount: () => provisionCount,
    bootCount: () => bootCount,
  };
}

const deniedPlacement = (): Promise<SwPlacementResult> =>
  Promise.resolve({ engineHome: "elected-worker", swInstanceId: "sw-composed", probeError: "NotAllowedError" });

/** A leader lock that GRANTS immediately: invoking the coordinator's callback holds the lock (never resolved). */
function makeGrantingLocks(): { locks: CoordinatorDeps["locks"]; requested: string[] } {
  const requested: string[] = [];
  return {
    locks: {
      request: (name, _options, callback) => {
        requested.push(name);
        return callback(); // grant — the callback's returned promise HOLDS the lock (stays pending here)
      },
    },
    requested,
  };
}

/**
 * A leader lock ALREADY HELD by another page: the request is recorded and QUEUES forever — the callback never
 * runs, so this tab elects nothing and spawns no engine (the multi-tab shape: the router pipes this tab to the
 * HOLDER's engine, and no `engine-ready` fan-out is coming to re-pipe it).
 */
function makeQueuedLocks(): { locks: CoordinatorDeps["locks"]; requested: string[] } {
  const requested: string[] = [];
  return {
    locks: {
      request: (name) => {
        requested.push(name);
        return new Promise<void>(() => undefined); // queued behind the holder — never granted in this tab
      },
    },
    requested,
  };
}

/** A recording spy over a real port — every bridge envelope type it carries (to prove the SW is not in the data path). */
function bridgeTypesOn(port: MessagePort): string[] {
  const seen: string[] = [];
  port.addEventListener("message", (event) => {
    const data = (event as MessageEvent).data;
    if (isBridgeEnvelope(data)) seen.push(data.type);
  });
  return seen;
}

/** Build a real elected dedicated engine (bindGlobalScope control plane + scripted core) behind an ElectedEngineWorker. */
function makeElectedEngine(rpcValue: unknown) {
  const engineChan = track(new MessageChannel());
  const core = scriptedEngineCore(rpcValue);
  const dedicated = makeFakeDedicatedScope(engineChan.port2);
  bindGlobalScope(core.connect, dedicated.scope);
  engineChan.port1.start();
  const worker: ElectedEngineWorker = wrapEngineWorker({
    postMessage: (message, transfer) => engineChan.port1.postMessage(message as never, (transfer ?? []) as never),
    addEventListener: (type, listener) =>
      engineChan.port1.addEventListener(type as "message", listener as unknown as EventListener),
    removeEventListener: (type, listener) =>
      engineChan.port1.removeEventListener(type as "message", listener as unknown as EventListener),
    terminate: () => undefined,
  });
  return { core, dedicated, worker };
}

/**
 * Register (via a tab port's `engine-announce`) an engine whose WORKER IS GONE — the Chromium
 * `extendedLifetime` warm-reopen shape (ADR-0053, the 2026-07-26 trace). The SharedWorker and its router state
 * OUTLIVE the tab that spawned the dedicated engine, and nothing clears `engineReady`, so the router keeps
 * piping fresh connections to a corpse. The fake completes exactly the announce handshake that makes the router
 * treat it as pipe-able (`assign-identity` → `engine-ready`) and then services NOTHING: every pipe it is handed
 * is counted and dropped, so a `provision`/`attach` posted into it is never acked.
 */
function announceDeadEngine(tabPort: MessagePort): { pipesDropped: () => number } {
  const control = new MessageChannel();
  const engineEnd = trackPort(control.port1);
  let pipes = 0;
  engineEnd.addEventListener("message", (event) => {
    const message = readControlEnvelope((event as MessageEvent).data);
    if (message === undefined) return;
    if (message.type === "assign-identity") {
      engineEnd.postMessage(wrapControlEnvelope({ type: "engine-ready", identity: message.identity }));
    } else if (message.type === "connect-port") {
      pipes += 1; // handed a pipe it will never serve — the dead-engine signature
    }
  });
  engineEnd.start();
  tabPort.postMessage(wrapControlEnvelope({ type: "engine-announce" }), [control.port2]);
  return { pipesDropped: () => pipes };
}

/**
 * Register a LIVE elected engine on another page's behalf: mint the announce control channel, deliver its ENGINE
 * end to the engine worker (exactly what the coordinator's spawn adapter does) and transfer its ROUTER end to
 * the SharedWorker over `tabPort`. Used to stand up the peer tab that HOLDS the leader lock.
 */
function announceLiveEngine(tabPort: MessagePort, engine: ElectedEngineWorker): void {
  const control = new MessageChannel();
  engine.deliverControlPort(control.port2);
  tabPort.postMessage(wrapControlEnvelope({ type: "engine-announce" }), [control.port1]);
}

/** Declare a bare (client-less) tab connection so the SharedWorker's placement decision starts and it is routed. */
function declareBareTab(tabPort: MessagePort): void {
  tabPort.start();
  tabPort.postMessage({ [DECLARATION_KEY]: {} });
}

/** Bounded settlement probe: a HUNG promise must fail a test, never hang the suite. */
function boundedOutcome<T>(promise: Promise<T>, label: string, ms = 2_000): Promise<T | string> {
  return Promise.race([promise, new Promise<string>((resolve) => setTimeout(() => resolve(`pending: ${label}`), ms))]);
}

/** Bounded await for a value: a hung boot rejects with `label` instead of stalling the runner. */
function boundedValue<T>(promise: Promise<T>, label: string, ms = 3_000): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(label)), ms))]);
}

describe("composed elected placement path — attach → placement query → election → pipe handshake (ADR-0049)", () => {
  it("a router-only SharedWorker elects a dedicated engine and the attach completes over the transferred pipe", async () => {
    // ── The SharedWorker side: real bootstrap → real router + real meta listener (probe DENIED ⇒ elected). ──
    const swHostConnects: BridgePort[] = [];
    const { scope: swScope, connect: swOnConnect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: (port) => swHostConnects.push(port), // NEVER called in elected mode (router-only)
      peerCount: () => 0,
      decidePlacement: deniedPlacement,
      globalScope: swScope,
    });

    // ── The tab ↔ SharedWorker transport (a real channel; the tab attaches on port1, the SW gets port2). ──
    const tabSw = track(new MessageChannel());
    const swSeenFromTab = bridgeTypesOn(tabSw.port2); // what the tab posts to the SW port
    swOnConnect(tabSw.port2 as unknown as BridgePort);

    // ── The elected dedicated engine: a real control plane (bindGlobalScope dedicated arm) + scripted core. ──
    const engineChan = track(new MessageChannel());
    const core = scriptedEngineCore(1234);
    const dedicated = makeFakeDedicatedScope(engineChan.port2); // the engine's implicit scope port
    bindGlobalScope(core.connect, dedicated.scope);
    engineChan.port1.start();
    const electedWorker: ElectedEngineWorker = wrapEngineWorker({
      postMessage: (message, transfer) => engineChan.port1.postMessage(message as never, (transfer ?? []) as never),
      addEventListener: (type, listener) =>
        engineChan.port1.addEventListener(type as "message", listener as unknown as EventListener),
      removeEventListener: (type, listener) =>
        engineChan.port1.removeEventListener(type as "message", listener as unknown as EventListener),
      terminate: () => undefined,
    });

    const grantingLocks = makeGrantingLocks();

    // ── The composed attach: this used to DEADLOCK (SW-port ack awaited before the placement query). ──
    const client = await attachSyncClient({
      registry: attachRegistry,
      worker: { port: tabSw.port1 as unknown as BridgePort } as unknown as never,
      createEngineWorker: (): ElectedEngineWorker => electedWorker,
      electionIo: { locks: grantingLocks.locks },
    });
    await client.ready;
    await settle();

    // The leader lock was taken (election ran) and the engine received its attach over the PIPE (not the SW port).
    expect(grantingLocks.requested).toHaveLength(1);
    expect(grantingLocks.requested[0]).toContain("pgx-leader-");
    expect(core.attachedPorts.length).toBeGreaterThan(0);
    expect(swHostConnects).toHaveLength(0); // the in-scope host is NEVER booted in router-only mode

    // A read round-trips over the elected engine's pipe.
    const rows = (await client.rawQuery("SELECT 1", [])) as unknown;
    expect(rows).toBe(1234);

    // Invariant 6: the SW port carried the (dropped) initial attach + the pgx0049 control plane, but NEVER an rpc.
    expect(swSeenFromTab).not.toContain("rpc");

    await client.stop();
    await settle(4);
  });

  it("a restore artifact reaches the ELECTED engine over the pipe — never dropped with the payload-blind router", async () => {
    // The bug this pins: the ONLY restore-bearing handshake used to be posted on the SW port, which a
    // router-only SharedWorker silently drops — transferring (detaching) the artifact's ArrayBuffer into the
    // void. The elected engine then booted a PLAIN store: registry tables filled from sync, artifact-only
    // content never existed (the transcrobes empty-`word` boots). The fix routes a restore-bearing attach by
    // the placement reply: withheld from the SW port in elected mode, carried on the FIRST pipe handshake.
    const { scope: swScope, connect: swOnConnect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: () => undefined, // NEVER called in elected mode (router-only)
      peerCount: () => 0,
      decidePlacement: deniedPlacement,
      globalScope: swScope,
    });

    const tabSw = track(new MessageChannel());
    // Record every attach ENVELOPE the SW port carries, so we can prove none of them held the restore.
    const swAttachPayloads: AttachPayload[] = [];
    tabSw.port2.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      if (isBridgeEnvelope(data) && data.type === "attach") {
        swAttachPayloads.push(identityCodec.decode(data.payload) as AttachPayload);
      }
    });
    swOnConnect(tabSw.port2 as unknown as BridgePort);

    const { core, worker: electedWorker } = makeElectedEngine(7);
    const grantingLocks = makeGrantingLocks();

    const restoreBytes = new TextEncoder().encode("pgdata-backup-tarball");
    const client = await attachSyncClient({
      registry: attachRegistry,
      worker: { port: tabSw.port1 as unknown as BridgePort } as unknown as never,
      createEngineWorker: (): ElectedEngineWorker => electedWorker,
      electionIo: { locks: grantingLocks.locks },
      restoreFrom: new Blob([restoreBytes], { type: "application/x-gzip" }),
    });
    await client.ready;
    await settle();

    // Exactly ONE attach carried the restore, at the ENGINE, with the artifact's bytes intact.
    expect(core.restoreAttaches).toHaveLength(1);
    const delivered = core.restoreAttaches[0]!;
    expect(new Uint8Array(delivered.buffer)).toEqual(restoreBytes);
    expect(delivered.mimeType).toBe("application/x-gzip");
    // The SW-port handshake (router-dropped in this mode) never held it — the buffer was never destroyed.
    expect(swAttachPayloads.every((attach) => attach.restore == null)).toBe(true);

    await client.stop();
    await settle(4);
  });

  it("elected provision then attach on one tab ADOPTS the grant — one lock, one engine, one initdb (Gap C)", async () => {
    // ── Shared SharedWorker scope: real bootstrap → real router (probe DENIED ⇒ elected, router-only). ──
    const { scope: swScope, connect: swOnConnect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: () => undefined,
      peerCount: () => 0,
      decidePlacement: deniedPlacement,
      globalScope: swScope,
    });

    // ── ONE elected engine, spawned by PROVISION's factory; attach must NOT spawn a second. ──
    const { core, worker } = makeElectedEngine(7);
    let factoryCalls = 0;
    const factory = (): ElectedEngineWorker => {
      factoryCalls += 1;
      return worker;
    };
    const grantingLocks = makeGrantingLocks();
    const storePath = "composed-provision-adopt";

    // ── Provision connection (P1) → drives the PROVISION CLAIM → elects → provisions over the pipe. ──
    const provSw = track(new MessageChannel());
    swOnConnect(provSw.port2 as unknown as BridgePort);
    await provisionSyncWorker({
      worker: { port: provSw.port1 as unknown as BridgePort } as unknown as never,
      storePath,
      createEngineWorker: factory,
      electionIo: { locks: grantingLocks.locks },
    });

    // The provision elected an engine and pre-spawned the store over its pipe.
    expect(factoryCalls).toBe(1);
    expect(grantingLocks.requested).toHaveLength(1); // ONE lock request
    expect(core.provisionCount()).toBe(1);
    expect(core.bootCount()).toBe(0); // provision is initdb-only — no boot yet

    // ── Attach connection (P2) on the SAME store → ADOPTS the provision grant (no second lock / engine). ──
    const attSw = track(new MessageChannel());
    swOnConnect(attSw.port2 as unknown as BridgePort);
    const client = await attachSyncClient({
      registry: attachRegistry,
      worker: { port: attSw.port1 as unknown as BridgePort } as unknown as never,
      storePath,
      createEngineWorker: factory, // must NOT be called — attach adopts the provision coordinator
      electionIo: { locks: grantingLocks.locks },
    });
    await client.ready;
    await settle();

    // Invariant 2 + "no second engine, no double initdb": still ONE lock request, ONE engine, ONE initdb.
    expect(factoryCalls).toBe(1);
    expect(grantingLocks.requested).toHaveLength(1);
    expect(core.provisionCount()).toBe(1);
    expect(core.bootCount()).toBe(1); // the single adopting boot
    // The one engine served BOTH the provision pipe and the attach pipe.
    expect(core.attachedPorts.length).toBeGreaterThanOrEqual(2);

    const rows = (await client.rawQuery("SELECT 1", [])) as unknown;
    expect(rows).toBe(7);

    await client.stop();
    await settle(4);
  });

  it("a FIRE-AND-FORGET provision with an immediate same-port attach still reaches the engine BEFORE the attach", async () => {
    // The app prewarm reality (emergent learner main.tsx, ADR-0032 optimisation B): `void provisionSyncWorker(...)`
    // at bootstrap, `attachSyncClient(...)` on the SAME port moments later — the provision is never awaited first.
    // For the accelerator to land, the provision envelope must arrive at the engine BEFORE the attach, so the
    // boot's `provisionAttempt` sample sees it; otherwise the boot silently degrades to a fresh openOwnedStore
    // create (observed on every emergent warm reopen, 2026-07-26 measurements).
    const { scope: swScope, connect: swOnConnect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: () => undefined,
      peerCount: () => 0,
      decidePlacement: deniedPlacement,
      globalScope: swScope,
    });

    const { core, worker } = makeElectedEngine(11);
    let factoryCalls = 0;
    const factory = (): ElectedEngineWorker => {
      factoryCalls += 1;
      return worker;
    };
    const grantingLocks = makeGrantingLocks();
    const storePath = "composed-provision-fire-and-forget";

    const sharedSw = track(new MessageChannel());
    swOnConnect(sharedSw.port2 as unknown as BridgePort);
    // NOT awaited — the app pattern under test.
    const provision = provisionSyncWorker({
      worker: { port: sharedSw.port1 as unknown as BridgePort } as unknown as never,
      storePath,
      createEngineWorker: factory,
      electionIo: { locks: grantingLocks.locks },
    });
    const client = await Promise.race([
      attachSyncClient({
        registry: attachRegistry,
        worker: { port: sharedSw.port1 as unknown as BridgePort } as unknown as never,
        storePath,
        createEngineWorker: factory,
        electionIo: { locks: grantingLocks.locks },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("attach did not complete alongside a fire-and-forget provision")), 2_000),
      ),
    ]);
    await client.ready;
    await provision.catch(() => undefined);
    await settle();

    // The accelerator LANDS: provision reached the engine, and BEFORE the attach envelope.
    expect(core.provisionCount()).toBe(1);
    expect(core.bridgeArrivals).toEqual(["provision", "attach"]);
    // Adoption invariants: one lock, one engine.
    expect(factoryCalls).toBe(1);
    expect(grantingLocks.requested).toHaveLength(1);
    expect(core.bootCount()).toBe(1);

    await client.stop();
    await settle(4);
  });

  it("elected provision then attach on the SAME SharedWorker port completes — the provision pipe is handed over", async () => {
    // The board's real contract (apps/board store-registry-default): provision and the later attach share ONE
    // SharedWorker instance/port so their messages stay ordered. The router mints that port's proxy pipe ONCE
    // (at the provision-time engine-ready fan-out); without the handover the adopting attach waits forever for a
    // `connect-port` that will never be re-sent — the login "Starting local database…" stall.
    const { scope: swScope, connect: swOnConnect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: () => undefined,
      peerCount: () => 0,
      decidePlacement: deniedPlacement,
      globalScope: swScope,
    });

    const { core, worker } = makeElectedEngine(41);
    let factoryCalls = 0;
    const factory = (): ElectedEngineWorker => {
      factoryCalls += 1;
      return worker;
    };
    const grantingLocks = makeGrantingLocks();
    const storePath = "composed-provision-adopt-same-port";

    // ONE tab↔SW connection, used first by the provision …
    const sharedSw = track(new MessageChannel());
    swOnConnect(sharedSw.port2 as unknown as BridgePort);
    await provisionSyncWorker({
      worker: { port: sharedSw.port1 as unknown as BridgePort } as unknown as never,
      storePath,
      createEngineWorker: factory,
      electionIo: { locks: grantingLocks.locks },
    });
    expect(core.provisionCount()).toBe(1);

    // … then by the adopting attach ON THE SAME PORT. Before the handover fix this deadlocks (no second
    // `connect-port` is ever minted for an already-piped tab); the bounded race turns the hang into a failure.
    const attach = attachSyncClient({
      registry: attachRegistry,
      worker: { port: sharedSw.port1 as unknown as BridgePort } as unknown as never,
      storePath,
      createEngineWorker: factory,
      electionIo: { locks: grantingLocks.locks },
    });
    const client = await Promise.race([
      attach,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("attach did not complete on the shared provision port")), 2_000),
      ),
    ]);
    await client.ready;
    await settle();

    // Adoption invariants hold on the shared port too: one lock, one engine, one initdb, one boot.
    expect(factoryCalls).toBe(1);
    expect(grantingLocks.requested).toHaveLength(1);
    expect(core.provisionCount()).toBe(1);
    expect(core.bootCount()).toBe(1);

    const rows = (await client.rawQuery("SELECT 1", [])) as unknown;
    expect(rows).toBe(41);

    await client.stop();
    await settle(4);
  });
});

describe("provision pipe under a SURVIVING SharedWorker — newest pipe wins (ADR-0053 R3)", () => {
  it("a pre-placement pipe to a DEAD engine is SUPERSEDED by the election's pipe: the provision lands the accelerator", async () => {
    // The live-traced warm-reopen hang (2026-07-26, emergent learner-web on Chromium `extendedLifetime`):
    //   1044 connect-port (the DEAD engine's pipe) — BEFORE any placement result
    //   1336 placement result {electionRequired: true} → 1432 leader-granted → a FRESH engine
    //   2414 connect-port (the fresh pipe) → the provision flow BAILED on its terminal `piped` flag
    // so the provision envelope only ever reached the corpse, the provision promise never settled, and the
    // adopting boot fell back to `openOwnedStore` — the accelerator forfeited on EVERY warm reopen.
    const { scope: swScope, connect: swOnConnect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: () => undefined,
      peerCount: () => 0,
      decidePlacement: deniedPlacement,
      globalScope: swScope,
    });

    // ── The PREVIOUS page: it declared, elected, and registered an engine that died with it. The SharedWorker
    //    survives, so the router still holds that dead registration as `engineReady`.
    const staleTab = track(new MessageChannel());
    swOnConnect(staleTab.port2 as unknown as BridgePort);
    declareBareTab(staleTab.port1);
    await settle();
    const dead = announceDeadEngine(staleTab.port1);
    await settle();
    staleTab.port1.postMessage(wrapControlEnvelope({ type: "tab-detach" })); // the page closed; the SW did not
    await settle();

    // ── The warm reopen: ONE fresh connection carrying emergent's prewarm shape — a fire-and-forget
    //    `provisionSyncWorker` with the real `attachSyncClient` on the SAME port moments later.
    const { core, worker } = makeElectedEngine(101);
    let factoryCalls = 0;
    const factory = (): ElectedEngineWorker => {
      factoryCalls += 1;
      return worker;
    };
    const grantingLocks = makeGrantingLocks();
    const storePath = "composed-dead-engine-supersede";

    const tabSw = track(new MessageChannel());
    swOnConnect(tabSw.port2 as unknown as BridgePort);
    // Record the arrival ORDER of the two control messages — the trace's precondition is the dead pipe FIRST.
    const controlArrivals: string[] = [];
    tabSw.port1.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      if (readControlEnvelope(data)?.type === "connect-port") controlArrivals.push("connect-port");
      else if (typeof data === "object" && data !== null && PLACEMENT_RESULT_KEY in data) {
        controlArrivals.push("placement-result");
      }
    });
    tabSw.port1.start();

    const provision = provisionSyncWorker({
      worker: { port: tabSw.port1 as unknown as BridgePort } as unknown as never,
      storePath,
      createEngineWorker: factory,
      electionIo: { locks: grantingLocks.locks },
    });
    void provision.catch(() => undefined);
    const client = await boundedValue(
      attachSyncClient({
        registry: attachRegistry,
        worker: { port: tabSw.port1 as unknown as BridgePort } as unknown as never,
        storePath,
        createEngineWorker: factory,
        electionIo: { locks: grantingLocks.locks },
      }),
      "attach did not complete behind a dead-engine pipe",
    );
    await client.ready;
    await settle();

    // The trace shape was reproduced: the corpse was piped BEFORE the placement reply, and it swallowed a pipe.
    expect(controlArrivals[0]).toBe("connect-port");
    expect(controlArrivals.indexOf("placement-result")).toBe(1);
    expect(dead.pipesDropped()).toBeGreaterThanOrEqual(1);

    // And the provision RESOLVED — the fresh election's pipe superseded the corpse's and carried the envelope.
    expect(
      await boundedOutcome(
        provision.then(() => "resolved"),
        "provision",
      ),
    ).toBe("resolved");
    // The accelerator LANDS at the fresh engine: provision first, then the boot attach that adopts it.
    expect(core.provisionCount()).toBe(1);
    expect(core.bridgeArrivals).toEqual(["provision", "attach"]);
    // One election, one engine, one boot — the recovery spawned no extras.
    expect(factoryCalls).toBe(1);
    expect(grantingLocks.requested).toHaveLength(1);
    expect(core.bootCount()).toBe(1);
    expect((await client.rawQuery("SELECT 1", [])) as unknown).toBe(101);

    await client.stop();
    await settle(4);
  });

  it("the adopting attach's HANDOVER receives the FRESH pipe, never the superseded dead one", async () => {
    // Same surviving-SharedWorker precondition, but the provision is AWAITED before the attach (the board's
    // ordered contract). The attach then gets NO `connect-port` of its own — its port is already routed and no
    // further `engine-ready` fan-out is coming — so the ONLY way it reaches the engine is the provision-pipe
    // handover. If the stash still held the dead pipe, this attach would hang exactly as the pre-fix one did.
    const { scope: swScope, connect: swOnConnect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: () => undefined,
      peerCount: () => 0,
      decidePlacement: deniedPlacement,
      globalScope: swScope,
    });

    const staleTab = track(new MessageChannel());
    swOnConnect(staleTab.port2 as unknown as BridgePort);
    declareBareTab(staleTab.port1);
    await settle();
    announceDeadEngine(staleTab.port1);
    await settle();
    staleTab.port1.postMessage(wrapControlEnvelope({ type: "tab-detach" }));
    await settle();

    const { core, worker } = makeElectedEngine(202);
    let factoryCalls = 0;
    const factory = (): ElectedEngineWorker => {
      factoryCalls += 1;
      return worker;
    };
    const grantingLocks = makeGrantingLocks();
    const storePath = "composed-dead-engine-handover";

    const tabSw = track(new MessageChannel());
    swOnConnect(tabSw.port2 as unknown as BridgePort);
    const provision = provisionSyncWorker({
      worker: { port: tabSw.port1 as unknown as BridgePort } as unknown as never,
      storePath,
      createEngineWorker: factory,
      electionIo: { locks: grantingLocks.locks },
    });
    void provision.catch(() => undefined);
    expect(
      await boundedOutcome(
        provision.then(() => "resolved"),
        "provision",
      ),
    ).toBe("resolved");
    expect(core.provisionCount()).toBe(1);
    expect(core.bootCount()).toBe(0); // still initdb-only — nothing has attached yet

    const client = await boundedValue(
      attachSyncClient({
        registry: attachRegistry,
        worker: { port: tabSw.port1 as unknown as BridgePort } as unknown as never,
        storePath,
        createEngineWorker: factory,
        electionIo: { locks: grantingLocks.locks },
      }),
      "the adopting attach never received the fresh provision pipe",
    );
    await client.ready;
    await settle();

    // The handover carried the LIVE pipe: the attach reached the same engine that acked the provision.
    expect(core.bridgeArrivals).toEqual(["provision", "attach"]);
    expect(factoryCalls).toBe(1);
    expect(grantingLocks.requested).toHaveLength(1);
    expect(core.provisionCount()).toBe(1);
    expect(core.bootCount()).toBe(1);
    expect((await client.rawQuery("SELECT 1", [])) as unknown).toBe(202);

    await client.stop();
    await settle(4);
  });

  it("a pre-placement pipe to the SharedWorker's still-LIVE engine survives into the attach handover", async () => {
    // Defect 2 in isolation, on the multi-tab shape: a peer page HOLDS the leader lock, so this tab's claim only
    // QUEUES — it elects nothing, announces nothing, and therefore NEVER receives a second `connect-port`. The
    // one pipe it gets is the late-joiner pipe the router mints at declaration time, i.e. BEFORE the placement
    // reply registers the shared coordinator. Pre-fix `stashProvisionPipe` no-opped there (no entry yet), so the
    // pipe was lost and the adopting attach waited on a `connect-port` that was never coming.
    const { scope: swScope, connect: swOnConnect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: () => undefined,
      peerCount: () => 0,
      decidePlacement: deniedPlacement,
      globalScope: swScope,
    });

    // ── The peer page that holds the lock: it announces the LIVE engine every tab is piped to. ──
    const { core, worker } = makeElectedEngine(303);
    const leaderTab = track(new MessageChannel());
    swOnConnect(leaderTab.port2 as unknown as BridgePort);
    declareBareTab(leaderTab.port1);
    await settle();
    announceLiveEngine(leaderTab.port1, worker);
    await settle();

    let factoryCalls = 0;
    const factory = (): ElectedEngineWorker => {
      factoryCalls += 1;
      return worker;
    };
    const queuedLocks = makeQueuedLocks();
    const storePath = "composed-live-engine-early-pipe";

    const tabSw = track(new MessageChannel());
    swOnConnect(tabSw.port2 as unknown as BridgePort);
    const provision = provisionSyncWorker({
      worker: { port: tabSw.port1 as unknown as BridgePort } as unknown as never,
      storePath,
      createEngineWorker: factory,
      electionIo: { locks: queuedLocks.locks },
    });
    void provision.catch(() => undefined);
    // The early pipe reaches a LIVE engine, so the provision itself settles even pre-fix.
    expect(
      await boundedOutcome(
        provision.then(() => "resolved"),
        "provision",
      ),
    ).toBe("resolved");
    expect(core.provisionCount()).toBe(1);

    const client = await boundedValue(
      attachSyncClient({
        registry: attachRegistry,
        worker: { port: tabSw.port1 as unknown as BridgePort } as unknown as never,
        storePath,
        createEngineWorker: factory,
        electionIo: { locks: queuedLocks.locks },
      }),
      "the adopting attach never received the pre-placement provision pipe",
    );
    await client.ready;
    await settle();

    // The stashed early pipe carried the boot attach to the peer's engine — no election, no second engine.
    expect(core.bridgeArrivals).toEqual(["provision", "attach"]);
    expect(core.bootCount()).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(queuedLocks.requested).toHaveLength(1); // this tab queued once and was never granted
    expect((await client.rawQuery("SELECT 1", [])) as unknown).toBe(303);

    await client.stop();
    await settle(4);
  });
});
