import { afterEach, describe, expect, it } from "bun:test";
// The BOUNDED SETTLEMENT WINDOW of `provisionSyncWorker`. A provision settles on a `provision-ack`, a storage
// declaration refusal, or an unconstructible elected engine — and if the SharedWorker connection dies before any
// of those arrive (the SW crashed, the port was never serviced, the elected engine never came up) the promise
// used to hang FOREVER: the elected path's expiry retired the CLAIM but never settled the caller. One deadline
// (`provisionExpiryMs`, default 60000) now settles the promise typed in BOTH modes:
//
//   - ELECTED (router-only SW, `electionRequired`): no pipe at all, or a piped but dead engine that never acks.
//   - SW-DIRECT (placement says no election): the `provision` is posted on the SW port and the ack never comes.
//
// The two elected timers are deliberately SEPARATE and armed at the same deadline: the claim expiry owns the
// contract cleanup (release the provision claim + the shared-coordinator ref), this one owns the promise. Both
// are asserted here, including the consequence a GRANTED claim release carries — last-claim retirement, so the
// elected engine and the attempt inside it are torn down and terminated. The first block scripts the
// SharedWorker side (as `provision-pipe-supersede.test.ts` does) and injects timers with a manual `advance` (as
// `attach-placement.test.ts` does), so nothing waits on a real clock.
//
// The SECOND block pins the BOUNDARY of that guarantee on the SW-DIRECT side against the REAL worker (what the
// deadline does NOT do there) — see its own comment.

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import {
  attachSyncClient,
  type ClientPGlite,
  defineSyncWorker,
  identityCodec,
  isBridgeEnvelope,
  postBridgeMessage,
  type SyncWorkerHost,
} from "../../packages/client/src/index";
import { memoryStoreForTests } from "../../packages/client/src/testing";
import {
  type ElectedEngineWorker,
  ProvisionExpiredError,
  provisionSyncWorker,
} from "../../packages/client/src/worker/attach-sync-client";
import { PLACEMENT_QUERY_KEY, PLACEMENT_RESULT_KEY } from "../../packages/client/src/worker/define-sync-worker";
import type { CoordinatorDeps } from "../../packages/client/src/worker/election-coordinator";
import {
  type EngineControlMessage,
  type EngineIdentity,
  readControlEnvelope,
} from "../../packages/client/src/worker/engine-control";
import { ENGINE_CONTROL_ENVELOPE_KEY as KEY } from "../../packages/client/src/worker/engine-router";
import type { BridgePort } from "../../packages/client/src/worker/protocol";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};

const GEN1: EngineIdentity = { swInstanceId: "sw-expiry", generation: 1 };

/** Injectable timers with a deadline-aware `advance` — the `attach-placement.test.ts` pattern plus `ms`. */
function makeTimers(): {
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  advance: (ms: number) => void;
  pending: () => number;
  delays: () => number[];
} {
  const scheduled: { fn: () => void; ms: number; handle: number }[] = [];
  let seq = 0;
  return {
    timers: {
      setTimeout(fn, ms) {
        const handle = seq++;
        scheduled.push({ fn, ms, handle });
        return handle;
      },
      clearTimeout(handle) {
        const i = scheduled.findIndex((s) => s.handle === handle);
        if (i >= 0) scheduled.splice(i, 1);
      },
    },
    // Fire every timer whose deadline has passed, in scheduling order. Snapshotted, so a timer armed by a
    // callback is left for the next advance (never an unbounded loop).
    advance(ms) {
      const due = scheduled.filter((s) => s.ms <= ms);
      for (const entry of due) {
        const i = scheduled.indexOf(entry);
        if (i >= 0) scheduled.splice(i, 1);
        entry.fn();
      }
    },
    pending: () => scheduled.length,
    delays: () => scheduled.map((s) => s.ms),
  };
}

/**
 * A scripted SharedWorker-side port. `electionRequired: true` models the ROUTER-ONLY SW (bridge envelopes are
 * payload-blind and DROPPED, so the provision must ride a pipe); `false` models SW-DIRECT, where the `provision`
 * lands here and `ack()` is the only thing that can settle the caller — withheld unless the test sends it.
 */
function makeSwPort(opts: { electionRequired: boolean }): {
  port: BridgePort;
  envelopes: string[];
  /** The `pgx0049` control traffic the TAB posted here — the coordinator's grant/retirement rail. */
  controls: EngineControlMessage[];
  sendControl: (message: EngineControlMessage, ports?: readonly BridgePort[]) => void;
  ack: () => void;
} {
  const listeners = new Set<(event: { data: unknown; ports?: readonly BridgePort[] }) => void>();
  const envelopes: string[] = [];
  const controls: EngineControlMessage[] = [];
  const emit = (data: unknown, ports?: readonly BridgePort[]): void => {
    const event = ports !== undefined ? { data, ports } : { data };
    for (const listener of [...listeners]) listener(event);
  };
  const emitPort: BridgePort = {
    postMessage: (message) => emit(message),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
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
              engineHome: opts.electionRequired ? "elected-worker" : "shared-worker",
              electionRequired: opts.electionRequired,
              swInstanceId: GEN1.swInstanceId,
            },
          }),
        );
        return;
      }
      if (isBridgeEnvelope(message)) envelopes.push(message.type);
      const control = readControlEnvelope(message);
      if (control !== undefined) controls.push(control);
    },
    addEventListener: (_type, listener) => listeners.add(listener as (event: { data: unknown }) => void),
    removeEventListener: (_type, listener) => listeners.delete(listener as (event: { data: unknown }) => void),
    start: () => undefined,
    close: () => undefined,
  };
  return {
    port,
    envelopes,
    controls,
    sendControl: (message, ports) => emit({ [KEY]: message }, ports),
    ack: () => postBridgeMessage(emitPort, identityCodec, "provision-ack", { ok: true }),
  };
}

/** A per-tab pipe whose engine is GONE when `serves: false` — it takes the `provision` and acks nothing. */
function makePipe(opts: { serves: boolean }): {
  port: BridgePort;
  envelopes: string[];
  isClosed: () => boolean;
  ack: () => void;
} {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const envelopes: string[] = [];
  let closed = false;
  const emitPort: BridgePort = {
    postMessage: (message) => {
      for (const listener of [...listeners]) listener({ data: message });
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const port: BridgePort = {
    postMessage: (message) => {
      if (closed || !isBridgeEnvelope(message)) return;
      envelopes.push(message.type);
      if (opts.serves && message.type === "provision") {
        queueMicrotask(() => postBridgeMessage(emitPort, identityCodec, "provision-ack", { ok: true }));
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
    isClosed: () => closed,
    ack: () => postBridgeMessage(emitPort, identityCodec, "provision-ack", { ok: true }),
  };
}

/** The leader lock is held by another page: the claim QUEUES forever, so this tab elects and spawns nothing. */
function makeQueuedLocks(): CoordinatorDeps["locks"] {
  return { request: () => new Promise<void>(() => undefined) };
}

/** The leader lock is FREE: the claim is granted at once, so this tab really elects, spawns, and holds it. */
function makeGrantingLocks(): CoordinatorDeps["locks"] {
  return { request: (_name, _options, callback) => callback() };
}

/** An engine factory that must never be invoked here (no grant ⇒ no spawn) — its call would fail the test. */
function unusedEngineFactory(calls: { count: number }): () => ElectedEngineWorker {
  return () => {
    calls.count += 1;
    return { terminate: () => undefined, onError: () => undefined, deliverControlPort: () => undefined };
  };
}

/** A recording elected-engine factory: how many engines were spawned, and how many were TERMINATED. */
function makeEngineFactory(): { create: () => ElectedEngineWorker; spawns: () => number; terminations: () => number } {
  let spawns = 0;
  let terminations = 0;
  return {
    create: () => {
      spawns += 1;
      return {
        terminate: () => {
          terminations += 1;
        },
        onError: () => undefined,
        deliverControlPort: () => undefined,
      };
    },
    spawns: () => spawns,
    terminations: () => terminations,
  };
}

/**
 * Settle-or-pending probe — the whole point of the RED case. Races the promise (a provision, or the attach in the
 * boundary block below) against a fixed run of ticks and reports what it did: the string `"resolved"`, the
 * rejection REASON, or `"pending"` when it did neither (a plain `await` there would never return).
 */
async function outcomeOf(promise: Promise<unknown>): Promise<unknown> {
  const pending = Symbol("pending");
  const raced = await Promise.race([
    promise.then(
      () => "resolved" as const,
      (error: unknown) => error,
    ),
    settle().then(() => pending),
  ]);
  return raced === pending ? "pending" : raced;
}

describe("provisionSyncWorker settles at the expiry deadline — it never hangs forever", () => {
  it("ELECTED: no pipe ever arrives → the promise REJECTS with ProvisionExpiredError at the deadline", async () => {
    const sw = makeSwPort({ electionRequired: true });
    const timers = makeTimers();
    const spawns = { count: 0 };
    const storePath = "provision-expiry-elected-no-pipe";

    const provision = provisionSyncWorker({
      port: sw.port,
      storePath,
      createEngineWorker: unusedEngineFactory(spawns),
      electionIo: { locks: makeQueuedLocks() },
      timers: timers.timers,
      provisionExpiryMs: 30_000,
    });
    void provision.catch(() => undefined);
    await settle();

    // Before the deadline the provision is legitimately pending — the pipe may still be minted.
    expect(await outcomeOf(provision)).toBe("pending");
    // Two timers at ONE deadline: the claim expiry (contract cleanup) and the settlement window (the promise).
    expect(timers.delays()).toEqual([30_000, 30_000]);

    timers.advance(30_000);
    const outcome = await outcomeOf(provision);
    expect(outcome).toBeInstanceOf(ProvisionExpiredError);
    expect((outcome as ProvisionExpiredError).storePath).toBe(storePath);
    expect((outcome as ProvisionExpiredError).expiryMs).toBe(30_000);
    expect((outcome as Error).message).toContain("30000");
    expect(spawns.count).toBe(0);
  });

  it("ELECTED: a piped but DEAD engine that never acks → the same typed rejection, and the claim/ref still release", async () => {
    const sw = makeSwPort({ electionRequired: true });
    const timers = makeTimers();
    const spawns = { count: 0 };
    const storePath = "provision-expiry-elected-dead-pipe";

    const provision = provisionSyncWorker({
      port: sw.port,
      storePath,
      createEngineWorker: unusedEngineFactory(spawns),
      electionIo: { locks: makeQueuedLocks() },
      timers: timers.timers,
      provisionExpiryMs: 45_000,
    });
    void provision.catch(() => undefined);
    await settle();

    const dead = makePipe({ serves: false });
    sw.sendControl({ type: "connect-port", identity: GEN1 }, [dead.port]);
    await settle();
    expect(dead.envelopes).toEqual(["provision"]);
    expect(await outcomeOf(provision)).toBe("pending");

    timers.advance(45_000);
    const outcome = await outcomeOf(provision);
    expect(outcome).toBeInstanceOf(ProvisionExpiredError);
    expect((outcome as ProvisionExpiredError).storePath).toBe(storePath);
    // The CLAIM-expiry half is unchanged: the shared-coordinator ref dropped to zero, which is what closes the
    // never-adopted handover pipe. Nothing here is a consequence of the promise settling.
    expect(dead.isClosed()).toBe(true);
    expect(spawns.count).toBe(0);
  });

  it("SW-DIRECT: the ack never comes → the same typed rejection at the deadline", async () => {
    const sw = makeSwPort({ electionRequired: false });
    const timers = makeTimers();
    const storePath = "provision-expiry-sw-direct";

    const provision = provisionSyncWorker({
      port: sw.port,
      storePath,
      timers: timers.timers,
      provisionExpiryMs: 15_000,
    });
    void provision.catch(() => undefined);
    await settle();

    // SW-direct posts the provision on the SW port and elects nothing — ONE timer, the settlement window.
    expect(sw.envelopes).toEqual(["provision"]);
    expect(timers.delays()).toEqual([15_000]);
    expect(await outcomeOf(provision)).toBe("pending");

    timers.advance(15_000);
    const outcome = await outcomeOf(provision);
    expect(outcome).toBeInstanceOf(ProvisionExpiredError);
    expect((outcome as ProvisionExpiredError).storePath).toBe(storePath);
  });

  it("SW-DIRECT: an ack BEFORE the deadline resolves and CLEARS the expiry timer — no stray timer, no late rejection", async () => {
    const sw = makeSwPort({ electionRequired: false });
    const timers = makeTimers();
    const storePath = "provision-expiry-sw-direct-acked";

    const provision = provisionSyncWorker({
      port: sw.port,
      storePath,
      timers: timers.timers,
      provisionExpiryMs: 15_000,
    });
    await settle();
    expect(timers.pending()).toBe(1);

    sw.ack();
    expect(await outcomeOf(provision)).toBe("resolved");
    // The settlement window is torn down with the listeners: nothing is left to fire.
    expect(timers.pending()).toBe(0);
    timers.advance(15_000);
    expect(await outcomeOf(provision)).toBe("resolved");
  });

  it("ELECTED: an ack before the deadline resolves; only the CLAIM expiry remains armed, and it never rejects", async () => {
    const sw = makeSwPort({ electionRequired: true });
    const timers = makeTimers();
    const spawns = { count: 0 };
    const storePath = "provision-expiry-elected-acked";

    const provision = provisionSyncWorker({
      port: sw.port,
      storePath,
      createEngineWorker: unusedEngineFactory(spawns),
      electionIo: { locks: makeQueuedLocks() },
      timers: timers.timers,
      provisionExpiryMs: 20_000,
    });
    await settle();

    const live = makePipe({ serves: true });
    sw.sendControl({ type: "connect-port", identity: GEN1 }, [live.port]);
    expect(await outcomeOf(provision)).toBe("resolved");

    // Exactly ONE timer survives the ack — the claim expiry, which owns the contract cleanup, not the promise.
    expect(timers.pending()).toBe(1);
    timers.advance(20_000);
    expect(await outcomeOf(provision)).toBe("resolved");
    expect(spawns.count).toBe(0);
  });

  it("ELECTED under a GRANTED lock: the deadline rejects the promise AND the claim release retires + terminates the engine", async () => {
    const sw = makeSwPort({ electionRequired: true });
    const timers = makeTimers();
    const engines = makeEngineFactory();
    const storePath = "provision-expiry-elected-granted";

    const provision = provisionSyncWorker({
      port: sw.port,
      storePath,
      createEngineWorker: engines.create,
      electionIo: { locks: makeGrantingLocks() },
      timers: timers.timers,
      // Under the 20000ms leader-keepalive interval, so the deadline fires with no keepalive noise behind it.
      provisionExpiryMs: 15_000,
    });
    void provision.catch(() => undefined);
    await settle();

    // The provision claim ELECTED: one engine spawned, the grant rail posted on the SW control port.
    expect(engines.spawns()).toBe(1);
    expect(sw.controls.map((message) => message.type)).toEqual(["leader-granted", "engine-announce"]);

    // The router pipes this connection to that engine; the engine is stuck inside its open and acks nothing.
    const dead = makePipe({ serves: false });
    sw.sendControl({ type: "connect-port", identity: GEN1 }, [dead.port]);
    await settle();
    expect(dead.envelopes).toEqual(["provision"]);
    expect(await outcomeOf(provision)).toBe("pending");

    timers.advance(15_000);
    expect(await outcomeOf(provision)).toBeInstanceOf(ProvisionExpiredError);

    // THE ELECTED HALF of the contract. The SAME deadline released the provision CLAIM, and it was the last
    // claim on this coordinator: the retirement opened (notice BEFORE teardown, tagged with the piped engine's
    // identity) and the shared-coordinator ref dropped to zero, closing the never-adopted handover pipe.
    expect(sw.controls.map((message) => message.type)).toEqual([
      "leader-granted",
      "engine-announce",
      "engine-retiring",
      "engine-teardown",
    ]);
    const teardown = sw.controls.find((message) => message.type === "engine-teardown");
    expect(teardown?.type === "engine-teardown" && teardown.identity).toEqual(GEN1);
    expect(dead.isClosed()).toBe(true);
    // The engine is still up while the teardown handshake runs — retirement never terminates before its ack.
    expect(engines.terminations()).toBe(0);

    // The teardown ack (here its 3000ms timeout) TERMINATES the elected engine, and the stuck open goes with
    // it — agent termination releases the VFS ownership, so a later attach elects a FRESH engine and opens the
    // store again rather than waiting on this attempt. The ordering of that sequence is pinned in
    // `election-coordinator.test.ts` § "provision claim expiry"; what is pinned HERE is that an expired
    // `provisionSyncWorker` drives it.
    timers.advance(3_000);
    await settle();
    expect(engines.terminations()).toBe(1);
    expect(engines.spawns()).toBe(1);
  });

  it("an ack AFTER the deadline is INERT — the settled guard holds and the rejection stands", async () => {
    const sw = makeSwPort({ electionRequired: true });
    const timers = makeTimers();
    const spawns = { count: 0 };
    const storePath = "provision-expiry-late-ack";

    const provision = provisionSyncWorker({
      port: sw.port,
      storePath,
      createEngineWorker: unusedEngineFactory(spawns),
      electionIo: { locks: makeQueuedLocks() },
      timers: timers.timers,
      provisionExpiryMs: 10_000,
    });
    void provision.catch(() => undefined);
    await settle();

    const slow = makePipe({ serves: false });
    sw.sendControl({ type: "connect-port", identity: GEN1 }, [slow.port]);
    await settle();

    timers.advance(10_000);
    expect(await outcomeOf(provision)).toBeInstanceOf(ProvisionExpiredError);

    // The engine finally answers, and a late `connect-port` arrives behind it: both are structurally unseen
    // (`settle` removed every listener) and neither can re-settle the promise.
    slow.ack();
    sw.sendControl({ type: "connect-port", identity: { swInstanceId: GEN1.swInstanceId, generation: 2 } }, [
      makePipe({ serves: true }).port,
    ]);
    await settle();
    expect(await outcomeOf(provision)).toBeInstanceOf(ProvisionExpiredError);
    expect(slow.envelopes).toEqual(["provision"]);
    expect(spawns.count).toBe(0);
  });
});

// ─── The BOUNDARY of that guarantee, SW-DIRECT: what the deadline does NOT do ──────────────────────
// The expiry settles the CALLER'S promise; where the engine runs in the SharedWorker itself, the worker-side
// create attempt is deliberately left running (an in-flight store open cannot be safely abandoned — a second
// open against the same store is an ownership conflict). So the composed behaviour for a genuinely STUCK store
// open is: the provision rejects typed at the deadline, a later attach on the same port WAITS on that same
// attempt rather than booting fresh, and a retried provision re-acks against it instead of starting a second
// open. That is exactly what `ProvisionExpiredError` documents for this placement, and it is pinned here against
// the REAL `defineSyncWorker` (over a `MessageChannel`, no Worker) with a `createPglite` that never settles —
// the scripted-SW harness above has no worker-side attempt to model. The ELECTED half of the split — the same
// deadline releasing the provision claim, and a last-claim release retiring and TERMINATING the engine with its
// attempt inside it — is the granted-lock case in the first block.
//
// The OTHER half of the doc's claim — a create that COMPLETES is adopted by the next attach — is the
// provision→adopt lane in `worker-provision-offline.test.ts`; nothing here needs a real engine.

const todosRegistry = defineSyncRegistry({
  todos: defineSyncTable({
    tableName: "todos",
    makeColumns: () => ({
      id: uuid("id").primaryKey(),
      title: varchar("title", { length: 200 }).notNull(),
      done: boolean("done").notNull(),
      updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
    }),
    mode: "readwrite",
    conflictPolicy: "last-write-wins",
    governance: {
      managedFields: [{ column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" }],
    },
  }),
});
type TodosRegistry = typeof todosRegistry;

let hosts: SyncWorkerHost<TodosRegistry>[] = [];
let channels: MessageChannel[] = [];

afterEach(async () => {
  for (const host of hosts) await host.close().catch(() => undefined);
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  hosts = [];
  channels = [];
});

/** The tab's end of the real channel, RECORDING the bridge envelopes it posts (placement/declaration are not). */
function recordingPort(port: MessagePort): { port: BridgePort; posted: string[] } {
  const posted: string[] = [];
  // The DOM listener each BridgePort listener was wrapped in, so `removeEventListener` still detaches it.
  const wrapped = new Map<(event: { data: unknown }) => void, (event: Event) => void>();
  return {
    posted,
    port: {
      postMessage: (message: unknown, transfer?: unknown) => {
        if (isBridgeEnvelope(message)) posted.push(message.type);
        (port as unknown as { postMessage: (m: unknown, t?: unknown) => void }).postMessage(message, transfer);
      },
      addEventListener: (type, listener) => {
        const forward = (event: Event) => listener({ data: (event as MessageEvent).data });
        wrapped.set(listener, forward);
        port.addEventListener(type, forward);
      },
      removeEventListener: (type, listener) => {
        const forward = wrapped.get(listener);
        if (forward !== undefined) port.removeEventListener(type, forward);
      },
      start: () => port.start(),
      close: () => port.close(),
    },
  };
}

/** The ACK envelopes the worker posted back (its forwarded debug rail rides `event` envelopes — noise here). */
function ackRecorder(port: MessagePort): () => string[] {
  const seen: string[] = [];
  port.addEventListener("message", (event) => {
    const data = (event as MessageEvent).data;
    if (isBridgeEnvelope(data) && data.type.endsWith("-ack")) seen.push(data.type);
  });
  port.start();
  return () => seen;
}

describe("the expiry bounds the PROMISE, not the worker-side create attempt", () => {
  it("a STUCK create: the provision expires, a later attach waits on it, and a retry re-acks the same attempt", async () => {
    const storePath = "provision-expiry-stuck-create";
    const opens = { count: 0 };
    const host = defineSyncWorker({
      registry: todosRegistry,
      controlPlaneUrl: "http://127.0.0.1:1",
      streamBaseUrl: "http://127.0.0.1:1/v1/stream",
      batchWriteUrl: "http://127.0.0.1:1/api/mutations",
      syncEnabled: false,
      installGlobal: false,
      convergenceIntervalMs: 10_000_000,
      // The genuinely stuck storage open: the create this provision asks for NEVER settles.
      createPglite: () => {
        opens.count += 1;
        return new Promise<ClientPGlite>(() => undefined);
      },
    });
    hosts.push(host);

    const channel = new MessageChannel();
    channels.push(channel);
    host.connect(channel.port1 as unknown as BridgePort);
    const tab = recordingPort(channel.port2);
    const acks = ackRecorder(channel.port2);

    const provisionTimers = makeTimers();
    const provision = provisionSyncWorker({
      port: tab.port,
      ...memoryStoreForTests(storePath),
      timers: provisionTimers.timers,
      provisionExpiryMs: 30_000,
    });
    void provision.catch(() => undefined);
    await settle(20);

    // The worker took the provision and is stuck INSIDE the create — one open started, nothing acked.
    expect(tab.posted).toEqual(["provision"]);
    expect(opens.count).toBe(1);
    expect(acks()).toEqual([]);
    expect(await outcomeOf(provision)).toBe("pending");

    provisionTimers.advance(30_000);
    expect(await outcomeOf(provision)).toBeInstanceOf(ProvisionExpiredError);

    // THE BOUNDARY. The promise settled; the worker-side attempt did not. A later attach on the same port
    // reaches the worker (the envelope is posted) and then WAITS on that attempt — it neither boots fresh nor
    // acks, and generous fake-timer advancement changes nothing.
    const attachTimers = makeTimers();
    const attach = attachSyncClient({
      registry: todosRegistry,
      port: tab.port,
      ...memoryStoreForTests(storePath),
      timers: attachTimers.timers,
      getToken: async () => ({ accessToken: "t", expiresAt: Date.now() + 3_600_000 }),
    });
    void attach.catch(() => undefined);
    await settle(20);
    expect(tab.posted).toEqual(["provision", "attach"]);
    attachTimers.advance(10 * 60_000);
    expect(await outcomeOf(attach)).toBe("pending");
    expect(opens.count).toBe(1);
    expect(acks()).toEqual([]);

    // Retrying the provision after the expiry is safe and acks ok — against the SAME in-flight attempt, so no
    // second open is ever started.
    const retryTimers = makeTimers();
    const retry = provisionSyncWorker({
      port: tab.port,
      ...memoryStoreForTests(storePath),
      timers: retryTimers.timers,
      provisionExpiryMs: 30_000,
    });
    expect(await outcomeOf(retry)).toBe("resolved");
    expect(opens.count).toBe(1);
    expect(acks()).toEqual(["provision-ack"]);
    // …and the attach is still waiting on the stuck open behind it.
    expect(await outcomeOf(attach)).toBe("pending");
  });
});
