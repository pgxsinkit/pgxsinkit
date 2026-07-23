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
import { bindGlobalScope, bootstrapWorkerScope } from "../../packages/client/src/worker/define-sync-worker";
import type { CoordinatorDeps } from "../../packages/client/src/worker/election-coordinator";
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
afterEach(() => {
  for (const channel of openChannels) {
    channel.port1.close();
    channel.port2.close();
  }
  openChannels = [];
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
  let provisionCount = 0;
  let bootCount = 0;
  const connect = (port: BridgePort) => {
    attachedPorts.push(port);
    port.addEventListener("message", (event) => {
      const data = (event as { data: unknown }).data;
      if (!isBridgeEnvelope(data)) return;
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
  return { core, worker };
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
