import { afterEach, describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) step 7: the ATTACH-CLIENT PLACEMENT SEAMS. The attach client
// "owns the handoff window" (CONTEXT.md § "Language — engine placement"). These unit tests drive the additive
// behavior WITHOUT any real worker: a scripted fake SW/router side (the `{ pgx0049 }` control envelope), real
// `MessageChannel` pipes for the elected-engine data path, and injected timers for the queue deadline + the
// bridge-silence reconnect. The guarantee under test is layered:
//   - NO pgx0049 traffic → today's behavior is byte-identical (SW-direct / no-SW fallback).
//   - `connect-port` (with a transferred pipe) swaps the data path off the SW port onto the pipe.
//   - a relocation notice opens the handoff window: in-flight ops settle by OUTCOME (invariant 5), new ops queue
//     (invariant 9); the replacement pipe flushes + re-subscribes.
//   - the bridge-silence deadline reconnects ONCE via the worker factory (D5).
//   - a relocation error crossing the bridge reconstructs as the typed `EngineRelocatedError` (D10).

import { pgTable, uuid } from "drizzle-orm/pg-core";

import type { SyncTableRegistry } from "@pgxsinkit/contracts";

import { attachSyncClient, identityCodec, isBridgeEnvelope, postBridgeMessage } from "../../packages/client/src/index";
import {
  ElectedEngineUnconstructibleError,
  type ElectedEngineWorker,
} from "../../packages/client/src/worker/attach-sync-client";
import { PLACEMENT_QUERY_KEY, PLACEMENT_RESULT_KEY } from "../../packages/client/src/worker/define-sync-worker";
import type { CoordinatorDeps } from "../../packages/client/src/worker/election-coordinator";
import {
  type EngineControlMessage,
  EngineRelocatedError,
  engineRelocatedToWire,
  type EngineIdentity,
} from "../../packages/client/src/worker/engine-control";
import { ENGINE_CONTROL_ENVELOPE_KEY as KEY } from "../../packages/client/src/worker/engine-router";
import type { BridgePort } from "../../packages/client/src/worker/protocol";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const settle = async (n = 4) => {
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

const ID0: EngineIdentity = { swInstanceId: "sw-1", generation: 0 };
const ID1: EngineIdentity = { swInstanceId: "sw-1", generation: 1 };

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

interface Received {
  type: string;
  id: string | undefined;
  payload: unknown;
}

/**
 * A recorded engine responder on a REAL port (a `MessageChannel` end): acks `attach`, drives phase "ready", and
 * — when `autoAnswerRpc` — answers every `rpc` with `rpcValue`. Used both as the initial SW-direct engine and,
 * behind a pipe, as an elected engine. Withholding rpc replies (default) leaves an op in-flight for settlement.
 */
function engineOn(
  port: MessagePort,
  opts: { autoAnswerRpc?: boolean; rpcValue?: unknown } = {},
): {
  received: Received[];
  answer: (id: string, value?: unknown) => void;
  reject: (id: string, error: { message: string; detail?: unknown }) => void;
} {
  const received: Received[] = [];
  const p = port as unknown as BridgePort;
  port.addEventListener("message", (event) => {
    const data = (event as MessageEvent).data;
    if (!isBridgeEnvelope(data)) return;
    received.push({ type: data.type, id: data.id, payload: identityCodec.decode(data.payload) });
    if (data.type === "attach") {
      postBridgeMessage(p, identityCodec, "attach-ack", { alreadyBooted: false });
      postBridgeMessage(p, identityCodec, "event", {
        kind: "status",
        status: { phase: "ready", isRunning: true },
      });
    } else if (data.type === "rpc" && opts.autoAnswerRpc) {
      postBridgeMessage(p, identityCodec, "rpc-result", { ok: true, value: opts.rpcValue ?? null }, data.id);
    }
  });
  port.start?.();
  return {
    received,
    answer: (id, value) => postBridgeMessage(p, identityCodec, "rpc-result", { ok: true, value }, id),
    reject: (id, error) => postBridgeMessage(p, identityCodec, "rpc-result", { ok: false, error }, id),
  };
}

/**
 * A CONTROLLABLE SharedWorker-side port: the tab attaches to `port`. It records the tab's bridge posts and, on
 * `attach`, emits the ack + ready. `sendControl` delivers a `{ pgx0049 }` envelope (with an optional
 * pseudo-transferred `ports` array — a real `MessagePort` passed BY REFERENCE, so we can spy on `close()`).
 */
function makeSwPort(): {
  port: BridgePort;
  received: Received[];
  sendControl: (message: EngineControlMessage, ports?: readonly BridgePort[]) => void;
  answer: (id: string, value?: unknown) => void;
  reject: (id: string, error: { message: string; detail?: unknown }) => void;
} {
  const listeners = new Set<(event: { data: unknown; ports?: readonly BridgePort[] }) => void>();
  const received: Received[] = [];
  const emit = (data: unknown, ports?: readonly BridgePort[]) => {
    const event = ports !== undefined ? { data, ports } : { data };
    for (const l of [...listeners]) l(event);
  };
  const emitPort: BridgePort = {
    postMessage: (message) => emit(message),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const port: BridgePort = {
    postMessage: (message) => {
      if (isBridgeEnvelope(message)) {
        received.push({ type: message.type, id: message.id, payload: identityCodec.decode(message.payload) });
        if (message.type === "attach") {
          queueMicrotask(() => {
            postBridgeMessage(emitPort, identityCodec, "attach-ack", { alreadyBooted: false });
            postBridgeMessage(emitPort, identityCodec, "event", {
              kind: "status",
              status: { phase: "ready", isRunning: true },
            });
          });
        }
      }
    },
    addEventListener: (_type, l) => listeners.add(l as (event: { data: unknown }) => void),
    removeEventListener: (_type, l) => listeners.delete(l as (event: { data: unknown }) => void),
    start: () => undefined,
    close: () => undefined,
  };
  return {
    port,
    received,
    sendControl: (message, ports) => emit({ [KEY]: message }, ports),
    answer: (id, value) => postBridgeMessage(emitPort, identityCodec, "rpc-result", { ok: true, value }, id),
    reject: (id, error) => postBridgeMessage(emitPort, identityCodec, "rpc-result", { ok: false, error }, id),
  };
}

/** Injectable timers with a manual `tick` (the router-test pattern) — deterministic queue-deadline / silence. */
function makeTimers(): {
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  tick: () => void;
  pending: () => number;
} {
  const scheduled: { fn: () => void; handle: number }[] = [];
  let seq = 0;
  return {
    timers: {
      setTimeout(fn) {
        const handle = seq++;
        scheduled.push({ fn, handle });
        return handle;
      },
      clearTimeout(handle) {
        const i = scheduled.findIndex((s) => s.handle === handle);
        if (i >= 0) scheduled.splice(i, 1);
      },
    },
    tick() {
      scheduled.shift()?.fn();
    },
    pending: () => scheduled.length,
  };
}

// ─── 1. Guard: no pgx0049 traffic → today's behavior, byte-identical ─────────────

describe("no pgx0049 traffic — the SW-direct / no-SW baseline is unchanged", () => {
  it("a plain attach + rpc round-trips exactly as before", async () => {
    const channel = track(new MessageChannel());
    const engine = engineOn(channel.port1, { autoAnswerRpc: true, rpcValue: 42 });

    const client = await attachSyncClient({ registry: attachRegistry, port: channel.port2 as unknown as never });
    await client.ready;

    await client.flush();
    // The rpc was answered on the SAME port the client attached to — no pipe, no control traffic ever.
    expect(engine.received.map((m) => m.type)).toEqual(["attach", "rpc"]);
  });
});

// ─── 2. connect-port pipe swap — the data path moves onto the pipe ───────────────

describe("connect-port swaps the data path onto the transferred pipe (invariant 6)", () => {
  it("subsequent rpc flows over the PIPE; the SW port sees no data-path traffic after the swap", async () => {
    const sw = makeSwPort();
    const timers = makeTimers();
    const client = await attachSyncClient({
      registry: attachRegistry,
      port: sw.port as unknown as never,
      timers: timers.timers,
    });
    await client.ready;

    const pipe = track(new MessageChannel());
    const engine = engineOn(pipe.port1, { autoAnswerRpc: true });
    sw.sendControl({ type: "connect-port", identity: ID0 }, [pipe.port2 as unknown as BridgePort]);
    await settle();

    await client.flush();

    // The engine BEHIND the pipe received the re-attach + the rpc; the SW port never saw an rpc.
    expect(engine.received.some((m) => m.type === "attach")).toBe(true);
    expect(engine.received.some((m) => m.type === "rpc")).toBe(true);
    expect(sw.received.filter((m) => m.type === "rpc")).toHaveLength(0);

    await client.stop();
  });
});

// ─── 3. Relocation notice — in-flight settlement by outcome (invariant 5) ────────

describe("a relocation notice settles in-flight ops by outcome (invariant 5)", () => {
  it("mutation → EngineRelocatedError unknown; read → not-dispatched; both instanceof", async () => {
    const sw = makeSwPort();
    const timers = makeTimers();
    const client = await attachSyncClient({
      registry: attachRegistry,
      port: sw.port as unknown as never,
      timers: timers.timers,
    });
    await client.ready;

    // Three in-flight ops the SW never answers: a MUTATION (flush), a READ (rawQuery), and the WRITE-CAPABLE
    // `rawExec` — its lost response is UNKNOWN too (a write it issued may have applied locally; never retry-safe).
    let mutErr: unknown;
    let readErr: unknown;
    let execErr: unknown;
    const mut = client.flush().catch((error: unknown) => {
      mutErr = error;
    });
    const read = client.rawQuery("select 1", []).catch((error: unknown) => {
      readErr = error;
    });
    const exec = client.rawExec("insert into t values (1)").catch((error: unknown) => {
      execErr = error;
    });
    await settle(1);

    sw.sendControl({ type: "engine-retiring", identity: ID0 });
    await Promise.all([mut, read, exec]);

    expect(mutErr).toBeInstanceOf(EngineRelocatedError);
    expect((mutErr as EngineRelocatedError).outcome).toBe("unknown");
    expect(readErr).toBeInstanceOf(EngineRelocatedError);
    expect((readErr as EngineRelocatedError).outcome).toBe("not-dispatched");
    expect(execErr).toBeInstanceOf(EngineRelocatedError);
    expect((execErr as EngineRelocatedError).outcome).toBe("unknown");

    await client.stop();
  });
});

// ─── 4. Handoff window — queue then flush in order on re-attach (invariant 9) ────

describe("the handoff window queues new ops and flushes them in order after re-attach", () => {
  it("two rpcs issued after the notice are held (nothing posted), then flush in order over the new pipe", async () => {
    const sw = makeSwPort();
    const timers = makeTimers();
    const client = await attachSyncClient({
      registry: attachRegistry,
      port: sw.port as unknown as never,
      timers: timers.timers,
    });
    await client.ready;

    // Open the window (untagged leader-granted always applies).
    sw.sendControl({ type: "leader-granted" });
    await settle(1);

    // Two reads issued while the window is open — QUEUED, nothing posted to the SW port.
    const r1 = client.rawQuery("q1", []);
    const r2 = client.rawQuery("q2", []);
    await settle(1);
    expect(sw.received.filter((m) => m.type === "rpc")).toHaveLength(0);

    // The replacement pipe + handshake flushes the queue in order.
    const pipe = track(new MessageChannel());
    const engine = engineOn(pipe.port1, { autoAnswerRpc: true });
    sw.sendControl({ type: "connect-port", identity: ID0 }, [pipe.port2 as unknown as BridgePort]);

    await Promise.all([r1, r2]);
    const rpcs = engine.received.filter((m) => m.type === "rpc");
    expect(rpcs).toHaveLength(2);
    expect((rpcs[0]!.payload as { args: unknown[] }).args[0]).toBe("q1");
    expect((rpcs[1]!.payload as { args: unknown[] }).args[0]).toBe("q2");

    await client.stop();
  });
});

// ─── 5. Bounded queue — cap overflow + deadline expiry both "not-dispatched" ─────

describe("the handoff queue is bounded (invariant 9)", () => {
  it("cap overflow fails the excess queued op with not-dispatched", async () => {
    const sw = makeSwPort();
    const timers = makeTimers();
    const client = await attachSyncClient({
      registry: attachRegistry,
      port: sw.port as unknown as never,
      timers: timers.timers,
      handoffQueue: { cap: 1 },
    });
    await client.ready;

    sw.sendControl({ type: "leader-granted" });
    await settle(1);

    const first = client.rawQuery("q1", []).catch(() => "first-settled-by-stop");
    let capErr: unknown;
    const second = client.rawQuery("q2", []).catch((error: unknown) => {
      capErr = error;
    });
    await Promise.resolve();

    expect(capErr).toBeInstanceOf(EngineRelocatedError);
    expect((capErr as EngineRelocatedError).outcome).toBe("not-dispatched");

    await client.stop();
    await Promise.all([first, second]);
  });

  it("deadline expiry (injected timer) fails queued ops with not-dispatched", async () => {
    const sw = makeSwPort();
    const timers = makeTimers();
    const client = await attachSyncClient({
      registry: attachRegistry,
      port: sw.port as unknown as never,
      timers: timers.timers,
      handoffQueue: { deadlineMs: 1000 },
    });
    await client.ready;

    sw.sendControl({ type: "leader-granted" });
    await settle(1);

    let err: unknown;
    const queued = client.rawQuery("q1", []).catch((error: unknown) => {
      err = error;
    });
    await settle(1);

    // Fire the queue-deadline timer.
    timers.tick();
    await queued;
    expect(err).toBeInstanceOf(EngineRelocatedError);
    expect((err as EngineRelocatedError).outcome).toBe("not-dispatched");

    await client.stop();
  });
});

// ─── 6. Pipe replacement — old-pipe settlement + close, new pipe live ────────────

describe("a second connect-port under a newer identity replaces the pipe (invariant 5)", () => {
  it("old-pipe in-flight mutation settles unknown, the old pipe is closed, new rpc flows on the new pipe", async () => {
    const sw = makeSwPort();
    const timers = makeTimers();
    const client = await attachSyncClient({
      registry: attachRegistry,
      port: sw.port as unknown as never,
      timers: timers.timers,
    });
    await client.ready;

    // First pipe (ID0) — withholds rpc replies so the mutation stays in-flight on the old pipe.
    const pipe1 = track(new MessageChannel());
    engineOn(pipe1.port1);
    let closedOld = false;
    const originalClose = pipe1.port2.close.bind(pipe1.port2);
    (pipe1.port2 as unknown as { close: () => void }).close = () => {
      closedOld = true;
      originalClose();
    };
    sw.sendControl({ type: "connect-port", identity: ID0 }, [pipe1.port2 as unknown as BridgePort]);
    await settle();

    let mutErr: unknown;
    const mut = client.flush().catch((error: unknown) => {
      mutErr = error;
    });
    await settle(1);

    // Second pipe (ID1) — newer identity → replacement.
    const pipe2 = track(new MessageChannel());
    const engine2 = engineOn(pipe2.port1, { autoAnswerRpc: true });
    sw.sendControl({ type: "connect-port", identity: ID1 }, [pipe2.port2 as unknown as BridgePort]);

    await mut;
    expect(mutErr).toBeInstanceOf(EngineRelocatedError);
    expect((mutErr as EngineRelocatedError).outcome).toBe("unknown");
    expect(closedOld).toBe(true);

    await settle();
    await client.reconcile("todos" as never);
    expect(engine2.received.some((m) => m.type === "rpc")).toBe(true);

    await client.stop();
  });
});

// ─── 7. Bridge-silence reconnect via the worker factory (D5) ─────────────────────

describe("the bridge-silence deadline reconnects once via the worker factory (D5)", () => {
  it("silence past the deadline with a pending op constructs one worker and re-runs the attach handshake", async () => {
    const sw = makeSwPort();
    const timers = makeTimers();

    const reconnectChannel = track(new MessageChannel());
    const reEngine = engineOn(reconnectChannel.port1, { autoAnswerRpc: true });
    let createCount = 0;
    const createWorker = () => {
      createCount++;
      return reconnectChannel.port2 as unknown as never;
    };

    const client = await attachSyncClient({
      registry: attachRegistry,
      port: sw.port as unknown as never,
      timers: timers.timers,
      bridgeSilenceMs: 1000,
      // Factory-first (ADR-0049 D5): the initial transport is `port`; the `worker` FACTORY is what reconstruction uses.
      worker: createWorker,
    });
    await client.ready;

    // An in-flight op the SW never answers arms the silence timer.
    const inflight = client.flush().catch(() => "settled-on-reconnect");
    await Promise.resolve();
    expect(timers.pending()).toBeGreaterThan(0);

    // Fire the silence timer → reconnect ONCE.
    timers.tick();
    await settle();

    expect(createCount).toBe(1);
    expect(reEngine.received.some((m) => m.type === "attach")).toBe(true);

    await client.stop();
    await inflight;
  });

  it("a bare port input has no reconnect — reconstruction is structurally unavailable (ADR-0049 D5)", async () => {
    const sw = makeSwPort();
    const timers = makeTimers();
    const client = await attachSyncClient({
      registry: attachRegistry,
      // A bare `port` (not a `worker` factory) cannot be reconstructed — a SharedWorker cannot be rebuilt from itself.
      port: sw.port as unknown as never,
      timers: timers.timers,
      bridgeSilenceMs: 1000,
    });
    await client.ready;

    const inflight = client.rawQuery("q1", []);
    await Promise.resolve();
    // No factory → the silence timer is never even armed (nothing to reconnect to).
    expect(timers.pending()).toBe(0);

    // The client stays on the SW port: the pending op resolves off a normal answer, proving no reconnect happened.
    const id = sw.received.find((m) => m.type === "rpc")!.id!;
    sw.answer(id, 7);
    const resolved = (await inflight) as unknown;
    expect(resolved).toBe(7);

    await client.stop();
  });
});

// ─── 8. Wire round-trip — a relocation bridge error reconstructs as the typed error (D10) ──

describe("a relocation error crossing the bridge reconstructs as EngineRelocatedError (D10)", () => {
  it("an rpc error whose detail is engineRelocatedToWire reconstructs with the right outcome", async () => {
    const channel = track(new MessageChannel());
    const p = channel.port1 as unknown as BridgePort;
    channel.port1.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      if (!isBridgeEnvelope(data)) return;
      if (data.type === "attach") {
        postBridgeMessage(p, identityCodec, "attach-ack", { alreadyBooted: false });
        postBridgeMessage(p, identityCodec, "event", {
          kind: "status",
          status: { phase: "ready", isRunning: true },
        });
      } else if (data.type === "rpc") {
        postBridgeMessage(
          p,
          identityCodec,
          "rpc-result",
          {
            ok: false,
            error: {
              message: "engine relocated",
              detail: engineRelocatedToWire(new EngineRelocatedError("unknown")),
            },
          },
          data.id,
        );
      }
    });
    channel.port1.start?.();

    const client = await attachSyncClient({ registry: attachRegistry, port: channel.port2 as unknown as never });
    await client.ready;

    let err: unknown;
    await client.flush().catch((error: unknown) => {
      err = error;
    });
    expect(err).toBeInstanceOf(EngineRelocatedError);
    expect((err as EngineRelocatedError).outcome).toBe("unknown");

    await client.stop();
  });
});

// ─── 9. Election handshake — the placement reply drives the coordinator (ADR-0049 step 10b) ──

/** A fake Web Locks surface: records each request + its abort signal; NEVER grants (the callback is not called). */
function makeFakeLocks(): { locks: CoordinatorDeps["locks"]; requests: { name: string; signal?: AbortSignal }[] } {
  const requests: { name: string; signal?: AbortSignal }[] = [];
  return {
    locks: {
      request: (name: string, options: { signal?: AbortSignal }) => {
        requests.push({ name, ...(options.signal ? { signal: options.signal } : {}) });
        // Queued forever (never granted) — the claim stays queued so a stop() aborts its signal.
        return new Promise<void>(() => undefined);
      },
    },
    requests,
  };
}

/**
 * An SW port that ALSO answers the placement query with a router-only (`electionRequired: true`) verdict. When
 * `swScriptUrl` is given the reply carries it (ADR-0049 D5), so the tab auto-derives the elected engine; without it
 * the reply has no derivable URL, so a tab with no `createEngineWorker` override fails attach typed.
 */
function makeElectingSwPort(swScriptUrl?: string): { port: BridgePort } {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const emit = (data: unknown) => {
    for (const l of [...listeners]) l({ data });
  };
  const emitPort: BridgePort = {
    postMessage: (message) => emit(message),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const port: BridgePort = {
    postMessage: (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>)[PLACEMENT_QUERY_KEY] === true
      ) {
        emit({
          [PLACEMENT_RESULT_KEY]: {
            engineHome: "elected-worker",
            electionRequired: true,
            swInstanceId: "sw-9",
            ...(swScriptUrl !== undefined ? { swScriptUrl } : {}),
          },
        });
        return;
      }
      if (!isBridgeEnvelope(message)) return;
      if (message.type === "attach") {
        queueMicrotask(() => {
          postBridgeMessage(emitPort, identityCodec, "attach-ack", { alreadyBooted: false });
          postBridgeMessage(emitPort, identityCodec, "event", {
            kind: "status",
            status: { phase: "ready", isRunning: true },
          });
        });
      }
    },
    addEventListener: (_type, l) => listeners.add(l as (event: { data: unknown }) => void),
    removeEventListener: (_type, l) => listeners.delete(l as (event: { data: unknown }) => void),
    start: () => undefined,
    close: () => undefined,
  };
  return { port };
}

const noopEngineWorker = (): ElectedEngineWorker => ({
  terminate: () => undefined,
  onError: () => undefined,
  deliverControlPort: () => undefined,
});

describe("an electionRequired placement reply creates the coordinator (ADR-0049 step 10b)", () => {
  it("with a createEngineWorker factory → the leader lock is requested; stop() releases the claim (aborts it)", async () => {
    const sw = makeElectingSwPort();
    const fakeLocks = makeFakeLocks();
    const timers = makeTimers();
    const client = await attachSyncClient({
      registry: attachRegistry,
      port: sw.port as unknown as never,
      timers: timers.timers,
      createEngineWorker: noopEngineWorker,
      electionIo: { locks: fakeLocks.locks },
    });
    await client.ready;
    await settle();

    // The coordinator's single attach claim queued the per-store leader lock exactly once.
    expect(fakeLocks.requests).toHaveLength(1);
    expect(fakeLocks.requests[0]!.name).toContain("pgx-leader-");
    expect(fakeLocks.requests[0]!.signal?.aborted).toBe(false);

    await client.stop();
    // Releasing the last claim aborts the still-queued lock request (invariant 2).
    expect(fakeLocks.requests[0]!.signal?.aborted).toBe(true);
  });

  it("keepalive SW-reconstruction re-announce re-delivers a FRESH control port to the live engine (step 11b follow-up 2)", async () => {
    const sw = makeElectingSwPort();
    const timers = makeTimers();

    // A recording elected engine: capture every control port delivered to the LIVE engine.
    const delivered: unknown[] = [];
    const createEngineWorker = (): ElectedEngineWorker => ({
      terminate: () => undefined,
      onError: () => undefined,
      deliverControlPort: (port) => delivered.push(port),
    });
    // The worker factory the coordinator uses to reconstruct a dead SharedWorker — a minimal inert bridge port.
    const reconstructedPort: BridgePort = {
      postMessage: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      start: () => undefined,
    };
    let reconstructs = 0;
    const createWorker = () => {
      reconstructs++;
      return { port: reconstructedPort } as unknown as never;
    };

    // Grant-capable locks: the coordinator's callback returned-promise HOLDS the lock; invoking it grants.
    const reqs: { callback: () => Promise<void> }[] = [];
    const grantingLocks: CoordinatorDeps["locks"] = {
      request: (_name, _options, callback) => {
        reqs.push({ callback });
        return new Promise<void>(() => undefined);
      },
    };

    const client = await attachSyncClient({
      registry: attachRegistry,
      port: sw.port as unknown as never,
      timers: timers.timers,
      createEngineWorker,
      // Factory-first (ADR-0049 D5): the `worker` factory is what the keepalive uses to reconstruct a dead SharedWorker.
      worker: createWorker,
      electionIo: { locks: grantingLocks },
    });
    await client.ready;
    await settle();

    // Grant the leader lock → spawn (deliverControlPort #1) → announce → keepalive scheduled.
    expect(reqs).toHaveLength(1);
    void reqs[0]!.callback();
    await settle();
    expect(delivered).toHaveLength(1);

    // Fire the keepalive to its miss threshold (default 2, unanswered by the inert SW) → reconstruction.
    // Only the keepalive timer is scheduled (no in-flight ops, no bridge-silence), so `tick` fires it.
    timers.tick(); // ping 1, miss 1 → reschedule
    timers.tick(); // ping 2, miss 2 → threshold → reconstruct + re-announce (WITHOUT a respawn)
    await settle();

    expect(reconstructs).toBe(1);
    // The re-announce re-delivered a SECOND, DISTINCT control port to the STILL-LIVE engine (the fix): the engine
    // that outlived the dead SharedWorker rebinds its control plane onto the reconstructed one.
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).not.toBe(delivered[0]);

    await client.stop();
  });

  it("no override but a derivable script URL → auto-derivation builds the coordinator + requests the lock (ADR-0049 D5)", async () => {
    // The SharedWorker reports its own script URL → the tab constructs `new Worker(url, { type: "module" })` itself,
    // with NO `createEngineWorker` override. The derived factory builds the coordinator, so the leader lock is requested
    // (the actual `new Worker` only runs on grant, which never happens under these never-granting locks).
    const sw = makeElectingSwPort("https://example.test/engine.worker.js");
    const fakeLocks = makeFakeLocks();
    const timers = makeTimers();
    const client = await attachSyncClient({
      registry: attachRegistry,
      port: sw.port as unknown as never,
      timers: timers.timers,
      electionIo: { locks: fakeLocks.locks },
    });
    await client.ready;
    await settle();

    // The URL-derived engine factory built the coordinator, which queued the per-store leader lock exactly once.
    expect(fakeLocks.requests).toHaveLength(1);
    expect(fakeLocks.requests[0]!.name).toContain("pgx-leader-");

    await client.stop();
    expect(fakeLocks.requests[0]!.signal?.aborted).toBe(true);
  });

  it("no override AND no derivable URL → attach fails with the typed ElectedEngineUnconstructibleError (WIRING failure)", async () => {
    // A handle-denied home requires election, but the SharedWorker reports no derivable URL and no override is given —
    // a WIRING defect (the capability is present). Attach FAILS typed; never a silent no-engine attach (ADR-0049 D1).
    const sw = makeElectingSwPort(); // no swScriptUrl
    const fakeLocks = makeFakeLocks();
    const timers = makeTimers();
    let caught: unknown;
    await attachSyncClient({
      registry: attachRegistry,
      port: sw.port as unknown as never,
      timers: timers.timers,
      electionIo: { locks: fakeLocks.locks },
    }).catch((error: unknown) => {
      caught = error;
    });

    expect(caught).toBeInstanceOf(ElectedEngineUnconstructibleError);
    expect(fakeLocks.requests).toHaveLength(0); // never elected — no coordinator, no lock
  });
});

// ─── 10. Execution-limit overdue-dispatch reporting (ADR-0049 D5, tab side) ───────

/** A recording SW port that captures CONTROL envelopes the client posts (not just bridge envelopes) + acks attach. */
function makeControlRecordingSwPort(): {
  port: BridgePort;
  controlPosts: EngineControlMessage[];
  emit: (data: unknown, ports?: readonly BridgePort[]) => void;
} {
  const controlPosts: EngineControlMessage[] = [];
  const listeners = new Set<(event: { data: unknown; ports?: readonly BridgePort[] }) => void>();
  const emit = (data: unknown, ports?: readonly BridgePort[]) => {
    for (const l of [...listeners]) l(ports !== undefined ? { data, ports } : { data });
  };
  const emitPort: BridgePort = {
    postMessage: (m) => emit(m),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const port: BridgePort = {
    postMessage: (message: unknown) => {
      const control = (message as { [k: string]: unknown } | null)?.[KEY];
      if (control && typeof control === "object" && "type" in (control as object)) {
        controlPosts.push(control as EngineControlMessage);
      }
      if (isBridgeEnvelope(message) && message.type === "attach") {
        queueMicrotask(() => {
          postBridgeMessage(emitPort, identityCodec, "attach-ack", { alreadyBooted: false });
          postBridgeMessage(emitPort, identityCodec, "event", {
            kind: "status",
            status: { phase: "ready", isRunning: true },
          });
        });
      }
    },
    addEventListener: (_type, l) => listeners.add(l as (event: { data: unknown }) => void),
    removeEventListener: (_type, l) => listeners.delete(l as (event: { data: unknown }) => void),
    start: () => undefined,
    close: () => undefined,
  };
  return { port, controlPosts, emit };
}

describe("execution-limit overdue-dispatch reporting (ADR-0049 D5, tab side)", () => {
  it("a dispatch outstanding past maxDispatchMs posts an identity-tagged overdue-dispatch on the control port", async () => {
    const sw = makeControlRecordingSwPort();
    const timers = makeTimers();
    const client = await attachSyncClient({
      registry: attachRegistry,
      port: sw.port as unknown as never,
      timers: timers.timers,
      executionLimit: { maxDispatchMs: 1000 },
    });
    await client.ready;

    // Establish a per-tab pipe + engine identity (connect-port). The engine behind the pipe WITHHOLDS rpc replies
    // so the dispatch stays outstanding and the overdue timer fires.
    const pipe = track(new MessageChannel());
    engineOn(pipe.port1);
    sw.emit({ [KEY]: { type: "connect-port", identity: ID0 } }, [pipe.port2 as unknown as BridgePort]);
    await settle();

    // Dispatch a slow read (never answered) → arms the overdue timer on the injected `timers`.
    const slow = client.rawQuery("select slow", []).catch(() => "settled-on-stop");
    await settle(1);

    // Fire the overdue timer → an identity-tagged overdue-dispatch is posted on the control port (the router's view).
    timers.tick();
    const overdue = sw.controlPosts.find((m) => m.type === "overdue-dispatch");
    expect(overdue).toEqual({ type: "overdue-dispatch", identity: ID0, elapsedMs: 1000 });

    await client.stop();
    await slow;
  });

  it("without executionLimit, no overdue timer is ever armed and no overdue-dispatch is posted (default)", async () => {
    const sw = makeControlRecordingSwPort();
    const timers = makeTimers();
    const client = await attachSyncClient({
      registry: attachRegistry,
      port: sw.port as unknown as never,
      timers: timers.timers,
    });
    await client.ready;

    const pipe = track(new MessageChannel());
    engineOn(pipe.port1);
    sw.emit({ [KEY]: { type: "connect-port", identity: ID0 } }, [pipe.port2 as unknown as BridgePort]);
    await settle();

    const slow = client.rawQuery("select slow", []).catch(() => "settled-on-stop");
    await settle(1);

    // No executionLimit → no overdue timer scheduled at all (bridge-silence is also off — no factory).
    expect(timers.pending()).toBe(0);
    expect(sw.controlPosts.some((m) => m.type === "overdue-dispatch")).toBe(false);

    await client.stop();
    await slow;
  });
});
