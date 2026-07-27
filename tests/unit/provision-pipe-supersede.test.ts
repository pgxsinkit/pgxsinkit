import { describe, expect, it } from "bun:test";
// ADR-0053 R3 — the PROVISION PIPE contract in isolation: NEWEST PIPE WINS. Where
// `attach-placement-composed.test.ts` drives the real router/bootstrap end to end, this suite scripts the
// SharedWorker side (a payload-blind router that answers the placement query `electionRequired` and hands
// `connect-port` pipes on demand) so the two properties a real `MessageChannel` cannot show are observable:
//
//   - SUPERSEDE HYGIENE: a second `connect-port` for a NEW engine generation re-posts the provision on the new
//     pipe and CLOSES the superseded one, and the stash an adopting attach later takes holds the NEWEST pipe,
//     never the corpse.
//   - SAME-GENERATION COEXISTENCE: the router mints one pipe per CONNECTION, so two concurrent provisions of the
//     same store (StrictMode double-effects, two warms) are piped separately for the SAME generation. The newest
//     pipe still wins the stash, but the superseded one stays OPEN — its own caller's ack still rides it.
//   - POST-SETTLEMENT INERTNESS: once the provision has acked, a further `connect-port` posts nothing.
//
// The leader lock is held elsewhere throughout (a queued claim), so nothing here elects or spawns an engine —
// the pipes are the whole surface under test.

import { pgTable, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import { attachSyncClient, identityCodec, isBridgeEnvelope, postBridgeMessage } from "../../packages/client/src/index";
import { type ElectedEngineWorker, provisionSyncWorker } from "../../packages/client/src/worker/attach-sync-client";
import { PLACEMENT_QUERY_KEY, PLACEMENT_RESULT_KEY } from "../../packages/client/src/worker/define-sync-worker";
import type { CoordinatorDeps } from "../../packages/client/src/worker/election-coordinator";
import type { EngineControlMessage, EngineIdentity } from "../../packages/client/src/worker/engine-control";
import { ENGINE_CONTROL_ENVELOPE_KEY as KEY } from "../../packages/client/src/worker/engine-router";
import type { BridgePort } from "../../packages/client/src/worker/protocol";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const settle = async (n = 8) => {
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

/** Generation 1 and 2 under one SharedWorker instance: a second `connect-port` is always a NEW generation. */
const GEN1: EngineIdentity = { swInstanceId: "sw-prov", generation: 1 };
const GEN2: EngineIdentity = { swInstanceId: "sw-prov", generation: 2 };

/**
 * A scripted ROUTER-ONLY SharedWorker port: it answers the placement query with `electionRequired` (so provision
 * and attach both take the elected path), DROPS every bridge envelope posted on it (payload-blind, exactly as the
 * real router does), and lets the test deliver `connect-port` control messages with pipes of its choosing.
 */
function makeRouterPort(): {
  port: BridgePort;
  droppedBridgeTypes: string[];
  sendControl: (message: EngineControlMessage, ports?: readonly BridgePort[]) => void;
} {
  const listeners = new Set<(event: { data: unknown; ports?: readonly BridgePort[] }) => void>();
  const droppedBridgeTypes: string[] = [];
  const emit = (data: unknown, ports?: readonly BridgePort[]): void => {
    const event = ports !== undefined ? { data, ports } : { data };
    for (const listener of [...listeners]) listener(event);
  };
  const port: BridgePort = {
    postMessage: (message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>)[PLACEMENT_QUERY_KEY] === true
      ) {
        queueMicrotask(() =>
          emit({
            [PLACEMENT_RESULT_KEY]: {
              engineHome: "elected-worker",
              electionRequired: true,
              swInstanceId: GEN1.swInstanceId,
            },
          }),
        );
        return;
      }
      // The router never answers a bridge envelope — it cannot even read one. Record and drop.
      if (isBridgeEnvelope(message)) droppedBridgeTypes.push(message.type);
    },
    addEventListener: (_type, listener) => listeners.add(listener as (event: { data: unknown }) => void),
    removeEventListener: (_type, listener) => listeners.delete(listener as (event: { data: unknown }) => void),
    start: () => undefined,
    close: () => undefined,
  };
  return {
    port,
    droppedBridgeTypes,
    sendControl: (message, ports) => emit({ [KEY]: message }, ports),
  };
}

/**
 * A per-tab pipe whose lifecycle is fully observable: every bridge envelope type it carries, whether `close()`
 * was called, and whether posts kept flowing after it. `serves: false` models a pipe whose engine is GONE (a
 * dead-engine pipe: it accepts the post and acks nothing). A CLOSED pipe silently drops posts, as a real
 * `MessagePort` does — a re-post landing on a closed pipe would be a hygiene bug, so it is counted separately.
 *
 * `deferProvisionAck` holds the `provision-ack` back until {@link releaseProvisionAck}, modelling the real
 * round-trip gap between a pipe receiving the `provision` and the engine answering it. A CLOSED pipe delivers
 * nothing on release — a real `MessagePort` closed by its owner never surfaces the reply — which is exactly the
 * hazard a same-generation supersede must not create.
 */
function makePipe(opts: { serves: boolean; deferProvisionAck?: boolean }): {
  port: BridgePort;
  envelopes: string[];
  postsAfterClose: () => number;
  isClosed: () => boolean;
  releaseProvisionAck: () => void;
} {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const envelopes: string[] = [];
  const heldAcks: Array<() => void> = [];
  let closed = false;
  let postsAfterClose = 0;
  const emitPort: BridgePort = {
    postMessage: (message) => {
      for (const listener of [...listeners]) listener({ data: message });
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const port: BridgePort = {
    postMessage: (message) => {
      if (closed) {
        postsAfterClose += 1;
        return;
      }
      if (!isBridgeEnvelope(message)) return;
      envelopes.push(message.type);
      if (!opts.serves) return;
      if (message.type === "provision") {
        const ack = () => postBridgeMessage(emitPort, identityCodec, "provision-ack", { ok: true });
        if (opts.deferProvisionAck) heldAcks.push(ack);
        else queueMicrotask(ack);
      } else if (message.type === "attach") {
        queueMicrotask(() => {
          postBridgeMessage(emitPort, identityCodec, "attach-ack", { alreadyBooted: false });
          postBridgeMessage(emitPort, identityCodec, "event", {
            kind: "status",
            status: { phase: "ready", isRunning: true },
          });
        });
      }
    },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    start: () => undefined,
    close: () => {
      closed = true;
    },
  };
  return {
    port,
    envelopes,
    postsAfterClose: () => postsAfterClose,
    isClosed: () => closed,
    releaseProvisionAck: () => {
      const held = heldAcks.splice(0, heldAcks.length);
      // A closed pipe surfaces nothing — its owner tore the channel down before the engine answered.
      if (closed) return;
      for (const ack of held) ack();
    },
  };
}

/** The leader lock is held by another page: the claim QUEUES forever, so this tab elects and spawns nothing. */
function makeQueuedLocks(): CoordinatorDeps["locks"] {
  return { request: () => new Promise<void>(() => undefined) };
}

/** An engine factory that must never be invoked here (no grant ⇒ no spawn) — its call would fail the test. */
function unusedEngineFactory(calls: { count: number }): () => ElectedEngineWorker {
  return () => {
    calls.count += 1;
    return { terminate: () => undefined, onError: () => undefined, deliverControlPort: () => undefined };
  };
}

describe("provision pipe supersede hygiene (ADR-0053 R3)", () => {
  it("the newest pipe wins: the provision re-posts on it, the superseded pipe is CLOSED, and the stash holds the newest", async () => {
    const router = makeRouterPort();
    const spawns = { count: 0 };
    const storePath = "provision-supersede-hygiene";

    const provision = provisionSyncWorker({
      port: router.port,
      storePath,
      createEngineWorker: unusedEngineFactory(spawns),
      electionIo: { locks: makeQueuedLocks() },
    });
    void provision.catch(() => undefined);
    await settle();

    // Pipe 1: the engine behind it is gone (it acks nothing) — the provision cannot settle on it.
    const dead = makePipe({ serves: false });
    router.sendControl({ type: "connect-port", identity: GEN1 }, [dead.port]);
    await settle();
    expect(dead.envelopes).toEqual(["provision"]);

    // Pipe 2: a NEW generation — the previous pipe is superseded by construction, so the provision must ride
    // this one instead of latching on the first.
    const fresh = makePipe({ serves: true });
    router.sendControl({ type: "connect-port", identity: GEN2 }, [fresh.port]);
    await settle();

    expect(fresh.envelopes).toEqual(["provision"]);
    await provision; // resolves off the fresh pipe's ack
    // Supersede hygiene: the replaced pipe is closed exactly once, nothing was posted onto it afterwards, and
    // the live pipe stays open for the handover.
    expect(dead.isClosed()).toBe(true);
    expect(dead.postsAfterClose()).toBe(0);
    expect(fresh.isClosed()).toBe(false);
    expect(dead.envelopes).toEqual(["provision"]);

    // The stash holds the NEWEST pipe/identity: the adopting attach's handover lands on `fresh`, and no further
    // `connect-port` is delivered — the handover is the only route to the engine here.
    const client = await Promise.race([
      attachSyncClient({
        registry: attachRegistry,
        port: router.port,
        storePath,
        createEngineWorker: unusedEngineFactory(spawns),
        electionIo: { locks: makeQueuedLocks() },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("the adopting attach never received the superseding pipe")), 3_000),
      ),
    ]);
    await client.ready;
    await settle();

    expect(fresh.envelopes).toEqual(["provision", "attach"]);
    expect(dead.envelopes).toEqual(["provision"]); // never the corpse
    expect(spawns.count).toBe(0);
    // The router is payload-blind: it saw (and dropped) the elected-mode fire-and-forget attach, never a pipe op.
    expect(router.droppedBridgeTypes).not.toContain("rpc");

    await client.stop();
    await settle(2);
  });

  it("two concurrent provisions of the SAME generation both settle — the superseded pipe stays open for its own ack", async () => {
    // Two `provisionSyncWorker()` calls for one store (a React StrictMode double-effect firing the warm twice)
    // each hold their OWN SharedWorker connection, and the router pipes EACH connection — for the SAME engine
    // generation. A second pipe is therefore NOT proof of a new engine, so closing the first on identity-blind
    // "newest wins" kills the conduit the first caller's `provision-ack` must ride, and that promise never
    // settles (the expiry retires the claim, it does not settle the promise).
    const routerA = makeRouterPort();
    const routerB = makeRouterPort();
    const spawns = { count: 0 };
    const storePath = "provision-concurrent-same-generation";

    const provisionA = provisionSyncWorker({
      port: routerA.port,
      storePath,
      createEngineWorker: unusedEngineFactory(spawns),
      electionIo: { locks: makeQueuedLocks() },
    });
    const provisionB = provisionSyncWorker({
      port: routerB.port,
      storePath,
      createEngineWorker: unusedEngineFactory(spawns),
      electionIo: { locks: makeQueuedLocks() },
    });
    void provisionA.catch(() => undefined);
    void provisionB.catch(() => undefined);
    await settle();

    // Both pipes hold their ack back, exactly as a real engine round trip does: the second `connect-port`
    // lands while the first provision is still waiting on its own pipe.
    const pipeA = makePipe({ serves: true, deferProvisionAck: true });
    routerA.sendControl({ type: "connect-port", identity: GEN1 }, [pipeA.port]);
    await settle();
    expect(pipeA.envelopes).toEqual(["provision"]);

    const pipeB = makePipe({ serves: true, deferProvisionAck: true });
    routerB.sendControl({ type: "connect-port", identity: GEN1 }, [pipeB.port]);
    await settle();
    expect(pipeB.envelopes).toEqual(["provision"]);

    // ONE generation, two conduits: the stash takes the newest, but the first must NOT be closed under it.
    expect(pipeA.isClosed()).toBe(false);
    expect(pipeB.isClosed()).toBe(false);

    pipeA.releaseProvisionAck();
    pipeB.releaseProvisionAck();
    await Promise.race([
      Promise.all([provisionA, provisionB]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("a concurrent same-generation provision never settled")), 3_000),
      ),
    ]);

    // Neither pipe was re-posted onto after close, and no engine was spawned (the leader lock is held elsewhere).
    expect(pipeA.postsAfterClose()).toBe(0);
    expect(pipeB.postsAfterClose()).toBe(0);
    expect(spawns.count).toBe(0);

    // NEWEST WINS is unchanged: the adopting attach's handover lands on the last-stashed pipe.
    const client = await Promise.race([
      attachSyncClient({
        registry: attachRegistry,
        port: routerB.port,
        storePath,
        createEngineWorker: unusedEngineFactory(spawns),
        electionIo: { locks: makeQueuedLocks() },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("the adopting attach never received the stashed pipe")), 3_000),
      ),
    ]);
    await client.ready;
    await settle();

    expect(pipeB.envelopes).toEqual(["provision", "attach"]);
    expect(pipeA.envelopes).toEqual(["provision"]);

    await client.stop();
    await settle(2);
  });

  it("a connect-port arriving AFTER the provision settled posts nothing and leaves the handover pipe intact", async () => {
    const router = makeRouterPort();
    const spawns = { count: 0 };
    const storePath = "provision-post-settlement-pipe";

    const provision = provisionSyncWorker({
      port: router.port,
      storePath,
      createEngineWorker: unusedEngineFactory(spawns),
      electionIo: { locks: makeQueuedLocks() },
    });
    void provision.catch(() => undefined);
    await settle();

    const first = makePipe({ serves: true });
    router.sendControl({ type: "connect-port", identity: GEN1 }, [first.port]);
    await provision;
    expect(first.envelopes).toEqual(["provision"]);

    // A late `connect-port` (a fresh generation) after settlement: the provision is DONE — nothing is re-posted.
    const late = makePipe({ serves: true });
    router.sendControl({ type: "connect-port", identity: GEN2 }, [late.port]);
    await settle();
    expect(late.envelopes).toEqual([]);
    expect(first.envelopes).toEqual(["provision"]);
    expect(first.isClosed()).toBe(false);

    // …and the stashed handover pipe is still the one the provision acked on.
    const client = await Promise.race([
      attachSyncClient({
        registry: attachRegistry,
        port: router.port,
        storePath,
        createEngineWorker: unusedEngineFactory(spawns),
        electionIo: { locks: makeQueuedLocks() },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("the adopting attach never received the provision pipe")), 3_000),
      ),
    ]);
    await client.ready;
    await settle();

    expect(first.envelopes).toEqual(["provision", "attach"]);
    expect(late.envelopes).toEqual([]);
    expect(spawns.count).toBe(0);

    await client.stop();
    await settle(2);
  });
});
