import { describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) step 9: the ELECTED-ENGINE-WORKER control plane, grown on the
// dedicated-worker ENTRY (the engine CORE — `defineSyncWorker`/`SyncWorkerHost.connect` — is untouched; only
// the entry's `bindGlobalScope` dedicated arm gains the control-channel listener). These unit tests drive that
// arm directly through the exported {@link bindGlobalScope}, injecting a FAKE dedicated-worker global scope (no
// real Worker, no real MessagePort) — the same discipline the router + engine-control tests follow. The control
// channel is delivered on the implicit scope port as `{ [CONTROL_PORT_DELIVERY_KEY]: true }` with a transferred
// port; on it the entry: takes its identity assignment (→ posts `engine-ready`), accepts dynamically
// transferred pipes into the SAME `connect(...)` the entry already uses, answers liveness probes, and acks +
// self-closes on teardown. Stale (post-assignment mismatch) tagged messages are discarded.

import type { BridgePort } from "../../packages/client/src/index";
import { bindGlobalScope, CONTROL_PORT_DELIVERY_KEY } from "../../packages/client/src/worker/define-sync-worker";
import type { EngineControlMessage, EngineIdentity } from "../../packages/client/src/worker/engine-control";
import { ENGINE_CONTROL_ENVELOPE_KEY as KEY } from "../../packages/client/src/worker/engine-router";

// ─── fakes ─────────────────────────────────────────────────────────────────────

type Listener = (event: { data: unknown; ports?: readonly unknown[] }) => void;
const envelope = (message: EngineControlMessage) => ({ [KEY]: message });
const controlOf = (record: { message: unknown }): EngineControlMessage =>
  (record.message as { [KEY]: EngineControlMessage })[KEY];

/** A minimal MessagePort-shaped fake (control channel end / a transferred pipe end). */
function makePort() {
  const listeners = new Set<Listener>();
  const sent: { message: unknown; transfer?: unknown[] }[] = [];
  let started = false;
  const port = {
    postMessage: (message: unknown, transfer?: unknown[]) =>
      sent.push(transfer !== undefined ? { message, transfer } : { message }),
    addEventListener: (_type: "message", l: Listener) => listeners.add(l),
    removeEventListener: (_type: "message", l: Listener) => listeners.delete(l),
    start: () => {
      started = true;
    },
  };
  return {
    port,
    sent,
    isStarted: () => started,
    emit: (data: unknown, ports?: readonly unknown[]) => {
      for (const l of [...listeners]) l(ports !== undefined ? { data, ports } : { data });
    },
    controls: () => sent.map(controlOf),
    controlsOfType: (type: EngineControlMessage["type"]) => sent.map(controlOf).filter((m) => m.type === type),
  };
}

/** A fake DedicatedWorkerGlobalScope: the implicit engine port + the identity constructor marker + `close()`. */
function makeFakeScope() {
  const listeners = new Set<Listener>();
  const posted: unknown[] = [];
  let closed = false;
  const scope = {
    // The presence of this constructor is how `bindGlobalScope` detects the dedicated-worker arm.
    DedicatedWorkerGlobalScope: class {},
    postMessage: (message: unknown) => posted.push(message),
    addEventListener: (_type: "message", l: Listener) => listeners.add(l),
    removeEventListener: (_type: "message", l: Listener) => listeners.delete(l),
    close: () => {
      closed = true;
    },
  };
  return {
    scope,
    posted,
    isClosed: () => closed,
    /** Deliver a message on the implicit scope port (all registered scope listeners). */
    deliver: (data: unknown, ports?: readonly unknown[]) => {
      for (const l of [...listeners]) l(ports !== undefined ? { data, ports } : { data });
    },
  };
}

function bootEntry() {
  const connected: BridgePort[] = [];
  const fake = makeFakeScope();
  bindGlobalScope((port) => connected.push(port), fake.scope);
  // Today's implicit-port connect fires immediately (baseline unchanged).
  const implicitConnects = connected.length;
  const control = makePort();
  fake.deliver({ [CONTROL_PORT_DELIVERY_KEY]: true }, [control.port]);
  return { connected, fake, control, implicitConnects };
}

const ID: EngineIdentity = { swInstanceId: "sw-1", generation: 0 };
const STALE: EngineIdentity = { swInstanceId: "sw-1", generation: 99 };

// ─── tests ───────────────────────────────────────────────────────────────────

describe("engine entry control plane — the dedicated-worker arm (ADR-0049 step 9)", () => {
  it("still connects the implicit scope port (baseline unchanged) and starts the delivered control channel", () => {
    const { connected, control, implicitConnects } = bootEntry();
    expect(implicitConnects).toBe(1); // the scope's own implicit port connected as today
    expect(connected).toHaveLength(1);
    expect(control.isStarted()).toBe(true); // the control channel is start()ed on delivery
  });

  it("assign-identity → remembers it and posts engine-ready back on the control channel", () => {
    const { control } = bootEntry();
    control.emit(envelope({ type: "assign-identity", identity: ID }));
    const ready = control.controlsOfType("engine-ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]).toEqual({ type: "engine-ready", identity: ID });
  });

  it("connect-port (matching identity) + transferred port → connect() gets a wrapped, started port", () => {
    const { connected, control } = bootEntry();
    control.emit(envelope({ type: "assign-identity", identity: ID }));
    const pipe = makePort();
    control.emit(envelope({ type: "connect-port", identity: ID }), [pipe.port]);

    // A SECOND connect (beyond the implicit scope port) — the dynamically transferred pipe.
    expect(connected).toHaveLength(2);
    expect(pipe.isStarted()).toBe(true); // the wrap start()ed the transferred port
    // The wrap delegates to the transferred port: posting through the BridgePort lands on the raw port.
    connected[1]!.postMessage({ hello: "world" });
    expect(pipe.sent.at(-1)!.message).toEqual({ hello: "world" });
  });

  it("connect-port with a STALE identity (post-assignment mismatch) → connect() is NOT called", () => {
    const { connected, control } = bootEntry();
    control.emit(envelope({ type: "assign-identity", identity: ID }));
    const before = connected.length;
    const pipe = makePort();
    control.emit(envelope({ type: "connect-port", identity: STALE }), [pipe.port]);
    expect(connected).toHaveLength(before); // discarded via shouldApplyControlMessage
    expect(pipe.isStarted()).toBe(false);
  });

  it("control-ping → replies control-ack with the SAME pingId (probe answered on the event loop)", () => {
    const { control } = bootEntry();
    control.emit(envelope({ type: "assign-identity", identity: ID }));
    control.emit(envelope({ type: "control-ping", identity: ID, pingId: 42 }));
    const ack = control.controlsOfType("control-ack").at(-1)!;
    expect(ack.type).toBe("control-ack");
    expect(ack.type === "control-ack" && ack.pingId).toBe(42);
    expect(ack.type === "control-ack" && ack.identity).toEqual(ID);
  });

  it("engine-teardown (matching) → acks pingId -1 then self-closes the scope after a microtask", async () => {
    const { fake, control } = bootEntry();
    control.emit(envelope({ type: "assign-identity", identity: ID }));
    control.emit(envelope({ type: "engine-teardown", identity: ID }));

    // The ack flushes synchronously; the close is deferred a microtask so the ack lands first.
    const ack = control.controlsOfType("control-ack").at(-1)!;
    expect(ack).toEqual({ type: "control-ack", identity: ID, pingId: -1 });
    expect(fake.isClosed()).toBe(false);
    await Promise.resolve();
    expect(fake.isClosed()).toBe(true);
  });

  it("engine-teardown with a STALE identity → no ack, no close (discarded)", async () => {
    const { fake, control } = bootEntry();
    control.emit(envelope({ type: "assign-identity", identity: ID }));
    const acksBefore = control.controlsOfType("control-ack").length;
    control.emit(envelope({ type: "engine-teardown", identity: STALE }));
    await Promise.resolve();
    expect(control.controlsOfType("control-ack")).toHaveLength(acksBefore);
    expect(fake.isClosed()).toBe(false);
  });

  // ─── ADR-0049 step 11b follow-up 2: a repeat control-port delivery REPLACES the old channel ────────────
  it("a SECOND control-port delivery (keepalive SW-reconstruction re-announce) replaces the channel — the new one is live, the OLD one is ignored", () => {
    const { connected, fake, control: oldControl } = bootEntry();
    oldControl.emit(envelope({ type: "assign-identity", identity: ID }));
    expect(oldControl.controlsOfType("engine-ready")).toHaveLength(1);

    // The leader reconstructs the dead SharedWorker and re-delivers a FRESH control channel (a second delivery
    // on the SAME implicit scope port). The entry must bind the new channel and detach the old one.
    const newControl = makePort();
    fake.deliver({ [CONTROL_PORT_DELIVERY_KEY]: true }, [newControl.port]);
    expect(newControl.isStarted()).toBe(true);

    // The NEW channel is live: assign-identity → engine-ready comes back on it, and a connect-port lands a pipe.
    newControl.emit(envelope({ type: "assign-identity", identity: ID }));
    expect(newControl.controlsOfType("engine-ready")).toHaveLength(1);
    const before = connected.length;
    const pipe = makePort();
    newControl.emit(envelope({ type: "connect-port", identity: ID }), [pipe.port]);
    expect(connected).toHaveLength(before + 1);
    expect(pipe.isStarted()).toBe(true);

    // The OLD channel is IGNORED: a ping on it produces NO new control-ack (its listener was disposed on replace).
    const oldAcksBefore = oldControl.controlsOfType("control-ack").length;
    oldControl.emit(envelope({ type: "control-ping", identity: ID, pingId: 7 }));
    expect(oldControl.controlsOfType("control-ack")).toHaveLength(oldAcksBefore);
  });
});
