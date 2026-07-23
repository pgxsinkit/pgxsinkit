import { describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) step 6: the ROUTER — the SharedWorker-side placement
// machinery (the "communication centre", CONTEXT.md § "Language — engine placement"). These unit tests
// drive the whole behavior contract over hand-rolled recording ports, an injectable pipe factory, and
// injected timers — no real worker, no MessageChannel, no real sleeps (deterministic). The router NEVER
// sees RPC payloads (invariant 6): it owns the attach registry, the current engine identity + control
// channel, relocation-notice fan-out, and execution-limit probe forwarding.

import type { EngineControlMessage, EngineIdentity } from "../../packages/client/src/worker/engine-control";
import {
  createEngineRouter,
  ENGINE_CONTROL_ENVELOPE_KEY as KEY,
  type RouterPort,
} from "../../packages/client/src/worker/engine-router";

// ─── Recording-port + timer + pipe fakes ────────────────────────────────────────

interface SentRecord {
  message: { [KEY]: EngineControlMessage };
  transfer?: unknown[] | undefined;
}

interface RecordingPort {
  port: RouterPort;
  sent: SentRecord[];
  /** Simulate the other end delivering a message to this port. */
  emit: (data: unknown) => void;
  removed: boolean;
}

function makePort(): RecordingPort {
  const sent: SentRecord[] = [];
  const rec: RecordingPort = {
    sent,
    removed: false,
    emit: () => {},
    port: {} as RouterPort,
  };
  let listener: ((event: { data: unknown }) => void) | undefined;
  rec.port = {
    postMessage(message: unknown, transfer?: unknown[]) {
      sent.push({ message: message as SentRecord["message"], transfer });
    },
    addEventListener(_type: "message", l: (event: { data: unknown }) => void) {
      listener = l;
    },
    removeEventListener(_type: "message", l: (event: { data: unknown }) => void) {
      if (listener === l) {
        listener = undefined;
        rec.removed = true;
      }
    },
    start() {},
  };
  rec.emit = (data: unknown) => listener?.({ data });
  return rec;
}

let pipeSeq = 0;
interface FakePipeFactory {
  create: () => { port1: RouterPort; port2: RouterPort };
  pipes: { port1: RouterPort; port2: RouterPort }[];
}
function makePipeFactory(): FakePipeFactory {
  const pipes: { port1: RouterPort; port2: RouterPort }[] = [];
  return {
    pipes,
    create() {
      const id = pipeSeq++;
      // Bare identity objects — the router only ever TRANSFERS these ends, never calls methods on them.
      const pipe = {
        port1: { __pipe: id, __end: 1 } as unknown as RouterPort,
        port2: { __pipe: id, __end: 2 } as unknown as RouterPort,
      };
      pipes.push(pipe);
      return pipe;
    },
  };
}

interface FakeTimers {
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  /** Run the single currently-pending timer (the probe loop schedules exactly one at a time). */
  tick: () => void;
  pendingCount: () => number;
}
function makeTimers(): FakeTimers {
  const scheduled: { fn: () => void; handle: number }[] = [];
  let handleSeq = 0;
  return {
    timers: {
      setTimeout(fn: () => void) {
        const handle = handleSeq++;
        scheduled.push({ fn, handle });
        return handle;
      },
      clearTimeout(handle: unknown) {
        const i = scheduled.findIndex((s) => s.handle === handle);
        if (i >= 0) scheduled.splice(i, 1);
      },
    },
    tick() {
      const next = scheduled.shift();
      next?.fn();
    },
    pendingCount: () => scheduled.length,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const controlOf = (rec: SentRecord): EngineControlMessage => rec.message[KEY];
const ofType = (sent: SentRecord[], type: EngineControlMessage["type"]) =>
  sent.filter((s) => controlOf(s).type === type);
const lastControl = (sent: SentRecord[]): EngineControlMessage => controlOf(sent[sent.length - 1]!);
const envelope = (message: EngineControlMessage) => ({ [KEY]: message });

// ─── 1. Grant fan-out: attach → announce → engine-ready → per-tab pipes ─────────

describe("router pipe minting on engine-ready (invariant 6 — one direct pipe per tab)", () => {
  it("stamps gen 0, and on engine-ready pipes EVERY attached tab (pairwise-distinct ends)", () => {
    const tabA = makePort();
    const tabB = makePort();
    const engine = makePort();
    const factory = makePipeFactory();
    const router = createEngineRouter({ swInstanceId: "sw-1", createPipe: factory.create });

    router.attachTab(tabA.port);
    router.attachTab(tabB.port);
    expect(router.tabCount()).toBe(2);

    const id = router.announceEngine(engine.port);
    expect(id).toEqual({ swInstanceId: "sw-1", generation: 0 });
    // Nothing is piped before engine-ready.
    expect(ofType(engine.sent, "connect-port")).toHaveLength(0);
    expect(ofType(tabA.sent, "connect-port")).toHaveLength(0);

    engine.emit(envelope({ type: "engine-ready", identity: id }));

    // Each tab received exactly one connect-port envelope WITH a transferred pipe end tagged the identity.
    for (const tab of [tabA, tabB]) {
      const connects = ofType(tab.sent, "connect-port");
      expect(connects).toHaveLength(1);
      expect(connects[0]!.transfer).toHaveLength(1);
      const msg = controlOf(connects[0]!);
      expect(msg.type === "connect-port" && msg.identity).toEqual(id);
    }
    // The engine control channel received EXACTLY two connect-port + transfers (one per tab).
    const engineConnects = ofType(engine.sent, "connect-port");
    expect(engineConnects).toHaveLength(2);
    expect(engineConnects.every((s) => s.transfer?.length === 1)).toBe(true);

    // Pipes are pairwise distinct (invariant 6): 2 engine ends + 2 tab ends = 4 distinct objects.
    const engineEnds = engineConnects.map((s) => s.transfer![0]);
    const tabEnds = [tabA, tabB].map((t) => ofType(t.sent, "connect-port")[0]!.transfer![0]);
    expect(new Set([...engineEnds, ...tabEnds]).size).toBe(4);
    expect(factory.pipes).toHaveLength(2);
  });

  it("a LATE-attaching tab (after engine-ready) is piped immediately; the engine gets a third connect-port", () => {
    const tabA = makePort();
    const tabB = makePort();
    const engine = makePort();
    const router = createEngineRouter({ swInstanceId: "sw-1", createPipe: makePipeFactory().create });
    router.attachTab(tabA.port);
    router.attachTab(tabB.port);
    const id = router.announceEngine(engine.port);
    engine.emit(envelope({ type: "engine-ready", identity: id }));
    expect(ofType(engine.sent, "connect-port")).toHaveLength(2);

    const tabC = makePort();
    router.attachTab(tabC.port);

    expect(ofType(tabC.sent, "connect-port")).toHaveLength(1);
    expect(ofType(engine.sent, "connect-port")).toHaveLength(3);
    expect(router.tabCount()).toBe(3);
  });
});

// ─── 2. Handoff + succession + staleness ────────────────────────────────────────

describe("router handoff, succession, and identity staleness (ADR D4, invariant 7)", () => {
  it("engine-retiring fans the notice, clears the identity, and a stale engine-ready is discarded", () => {
    const tabA = makePort();
    const tabB = makePort();
    const engine0 = makePort();
    const router = createEngineRouter({ swInstanceId: "sw-1", createPipe: makePipeFactory().create });
    router.attachTab(tabA.port);
    router.attachTab(tabB.port);
    const id0 = router.announceEngine(engine0.port);
    engine0.emit(envelope({ type: "engine-ready", identity: id0 }));

    router.openHandoff("engine-retiring");

    // Both tabs got the retirement notice, tagged with the retired identity.
    for (const tab of [tabA, tabB]) {
      const retiring = lastControl(tab.sent);
      expect(retiring.type).toBe("engine-retiring");
      expect(retiring.type === "engine-retiring" && retiring.identity).toEqual(id0);
    }
    expect(router.currentIdentity()).toBeUndefined();

    // The next generation under the SAME SharedWorker instance.
    const engine1 = makePort();
    const id1 = router.announceEngine(engine1.port);
    expect(id1).toEqual({ swInstanceId: "sw-1", generation: 1 });
    expect(router.currentIdentity()).toEqual(id1);

    // A STALE engine-ready carrying the gen-0 identity is IGNORED (no pipes).
    engine1.emit(envelope({ type: "engine-ready", identity: id0 }));
    expect(ofType(engine1.sent, "connect-port")).toHaveLength(0);

    // The CURRENT gen-1 engine-ready delivers pipes.
    engine1.emit(envelope({ type: "engine-ready", identity: id1 }));
    expect(ofType(engine1.sent, "connect-port")).toHaveLength(2);
  });

  it("leader-granted fans an untagged notice and clears the current identity", () => {
    const tabA = makePort();
    const router = createEngineRouter({ swInstanceId: "sw-1", createPipe: makePipeFactory().create });
    router.attachTab(tabA.port);
    const id0 = router.announceEngine(makePort().port);
    engineReadyNoop();
    router.openHandoff("leader-granted");
    const notice = lastControl(tabA.sent);
    expect(notice.type).toBe("leader-granted");
    expect(router.currentIdentity()).toBeUndefined();
    // gen 0 was minted, so the next announce is gen 1 (same instance).
    expect(id0.generation).toBe(0);
    function engineReadyNoop() {}
  });

  it("mints monotonic generations 0,1,2 across two handoffs on one SharedWorker instance", () => {
    const router = createEngineRouter({ swInstanceId: "sw-1", createPipe: makePipeFactory().create });
    const id0 = router.announceEngine(makePort().port);
    router.openHandoff("engine-retiring");
    const id1 = router.announceEngine(makePort().port);
    router.openHandoff("engine-retiring");
    const id2 = router.announceEngine(makePort().port);
    expect([id0, id1, id2]).toEqual([
      { swInstanceId: "sw-1", generation: 0 },
      { swInstanceId: "sw-1", generation: 1 },
      { swInstanceId: "sw-1", generation: 2 },
    ]);
  });
});

// ─── 3. Keepalive ───────────────────────────────────────────────────────────────

describe("router keepalive — immediate ack echoing the ping identity", () => {
  it("a tab control-ping is answered immediately with a matching control-ack", () => {
    const tabA = makePort();
    const router = createEngineRouter({ swInstanceId: "sw-1", createPipe: makePipeFactory().create });
    router.attachTab(tabA.port);
    const identity: EngineIdentity = { swInstanceId: "sw-1", generation: 0 };
    tabA.emit(envelope({ type: "control-ping", identity, pingId: 7 }));
    const ack = lastControl(tabA.sent);
    expect(ack.type).toBe("control-ack");
    if (ack.type === "control-ack") {
      expect(ack.pingId).toBe(7);
      expect(ack.identity).toEqual(identity); // echoes the PING's identity
    }
  });
});

// ─── 4. Execution limit — probe forwarding + verdict ────────────────────────────

describe("router execution-limit probe forwarding (ADR D5, opt-in)", () => {
  function bootLimited(missThreshold?: number) {
    const tabA = makePort();
    const tabB = makePort();
    const engine = makePort();
    const clock = makeTimers();
    const router = createEngineRouter({
      swInstanceId: "sw-1",
      executionLimit: { maxDispatchMs: 5000 },
      probeMissThreshold: missThreshold ?? 3,
      timers: clock.timers,
      createPipe: makePipeFactory().create,
    });
    router.attachTab(tabA.port);
    router.attachTab(tabB.port);
    const id = router.announceEngine(engine.port);
    engine.emit(envelope({ type: "engine-ready", identity: id }));
    return { tabA, tabB, engine, clock, router, id };
  }

  it("an overdue-dispatch report probes the engine channel; an ack STOPS the loop with no verdict", () => {
    const { tabA, engine, clock, router, id } = bootLimited();
    tabA.emit(envelope({ type: "overdue-dispatch", identity: id, elapsedMs: 9000 }));

    clock.tick(); // ping 1
    clock.tick(); // ping 2
    const pings = ofType(engine.sent, "control-ping");
    expect(pings).toHaveLength(2);

    const ping2 = controlOf(pings[1]!);
    expect(ping2.type).toBe("control-ping");
    const ping2Id = ping2.type === "control-ping" ? ping2.pingId : -1;
    engine.emit(envelope({ type: "control-ack", identity: id, pingId: ping2Id }));

    // The loop is stopped: no further probes, no verdict, engine still current.
    clock.tick();
    expect(ofType(engine.sent, "control-ping")).toHaveLength(2);
    expect(clock.pendingCount()).toBe(0);
    expect(router.currentIdentity()).toEqual(id);
  });

  it("threshold consecutive unanswered pings → engine-loss verdict: engine-retiring to all tabs + cleared", () => {
    const { tabA, tabB, engine, clock, router, id } = bootLimited(3);
    tabA.emit(envelope({ type: "overdue-dispatch", identity: id, elapsedMs: 9000 }));

    clock.tick(); // ping 1
    clock.tick(); // ping 2
    clock.tick(); // ping 3 → verdict

    expect(ofType(engine.sent, "control-ping")).toHaveLength(3);
    for (const tab of [tabA, tabB]) {
      const retiring = lastControl(tab.sent);
      expect(retiring.type).toBe("engine-retiring");
      expect(retiring.type === "engine-retiring" && retiring.identity).toEqual(id);
    }
    expect(router.currentIdentity()).toBeUndefined();
    expect(clock.pendingCount()).toBe(0);
  });

  it("with the limit DISABLED, an overdue-dispatch report is ignored — no probes ever sent", () => {
    const tabA = makePort();
    const engine = makePort();
    const clock = makeTimers();
    const router = createEngineRouter({
      swInstanceId: "sw-1",
      timers: clock.timers,
      createPipe: makePipeFactory().create,
    });
    router.attachTab(tabA.port);
    const id = router.announceEngine(engine.port);
    engine.emit(envelope({ type: "engine-ready", identity: id }));

    tabA.emit(envelope({ type: "overdue-dispatch", identity: id, elapsedMs: 9000 }));
    clock.tick();
    expect(ofType(engine.sent, "control-ping")).toHaveLength(0);
    expect(clock.pendingCount()).toBe(0);
  });

  it("a stale overdue-dispatch (superseded identity) never starts a probe", () => {
    const { tabA, engine, clock } = bootLimited();
    tabA.emit(
      envelope({ type: "overdue-dispatch", identity: { swInstanceId: "sw-1", generation: 99 }, elapsedMs: 9000 }),
    );
    clock.tick();
    expect(ofType(engine.sent, "control-ping")).toHaveLength(0);
  });
});

// ─── 4b. Control-plane forwarding (ADR-0049 step 9) ─────────────────────────────

describe("router control-plane forwarding (ADR-0049 step 9 — engine-entry control plane)", () => {
  it("announceEngine posts assign-identity to the engine control channel FIRST (before any connect-port)", () => {
    const tabA = makePort();
    const engine = makePort();
    const router = createEngineRouter({ swInstanceId: "sw-1", createPipe: makePipeFactory().create });
    router.attachTab(tabA.port);

    const id = router.announceEngine(engine.port);

    // The engine channel's very first message is the assignment stamp (identity handed to the engine).
    const assign = controlOf(engine.sent[0]!);
    expect(assign.type).toBe("assign-identity");
    expect(assign.type === "assign-identity" && assign.identity).toEqual(id);
    // It precedes any pipe: no connect-port until engine-ready fans out.
    expect(ofType(engine.sent, "connect-port")).toHaveLength(0);

    engine.emit(envelope({ type: "engine-ready", identity: id }));
    const connectIdx = engine.sent.findIndex((s) => controlOf(s).type === "connect-port");
    expect(connectIdx).toBeGreaterThan(0); // assign-identity came first
  });

  it("forwards a tab engine-teardown for the CURRENT identity verbatim to the engine control channel", () => {
    const tabA = makePort();
    const engine = makePort();
    const router = createEngineRouter({ swInstanceId: "sw-1", createPipe: makePipeFactory().create });
    router.attachTab(tabA.port);
    const id = router.announceEngine(engine.port);
    engine.emit(envelope({ type: "engine-ready", identity: id }));

    const before = ofType(engine.sent, "engine-teardown").length;
    tabA.emit(envelope({ type: "engine-teardown", identity: id }));
    const forwarded = ofType(engine.sent, "engine-teardown");
    expect(forwarded).toHaveLength(before + 1);
    expect(controlOf(forwarded[forwarded.length - 1]!)).toEqual({ type: "engine-teardown", identity: id });
  });

  it("DISCARDS a stale tab engine-teardown (superseded identity) — never forwarded to the engine", () => {
    const tabA = makePort();
    const engine = makePort();
    const router = createEngineRouter({ swInstanceId: "sw-1", createPipe: makePipeFactory().create });
    router.attachTab(tabA.port);
    const id = router.announceEngine(engine.port);
    engine.emit(envelope({ type: "engine-ready", identity: id }));

    tabA.emit(envelope({ type: "engine-teardown", identity: { swInstanceId: "sw-1", generation: 99 } }));
    expect(ofType(engine.sent, "engine-teardown")).toHaveLength(0);
  });

  it("relays an engine control-ack (pingId -1, the teardown ack) to ALL tabs — no probe running", () => {
    const tabA = makePort();
    const tabB = makePort();
    const engine = makePort();
    const router = createEngineRouter({ swInstanceId: "sw-1", createPipe: makePipeFactory().create });
    router.attachTab(tabA.port);
    router.attachTab(tabB.port);
    const id = router.announceEngine(engine.port);
    engine.emit(envelope({ type: "engine-ready", identity: id }));

    engine.emit(envelope({ type: "control-ack", identity: id, pingId: -1 }));

    for (const tab of [tabA, tabB]) {
      const ack = lastControl(tab.sent);
      expect(ack.type).toBe("control-ack");
      expect(ack).toEqual({ type: "control-ack", identity: id, pingId: -1 });
    }
  });

  it("still CONSUMES a probe ack (matching pendingPingId) — never relayed to tabs", () => {
    const tabA = makePort();
    const engine = makePort();
    const clock = makeTimers();
    const router = createEngineRouter({
      swInstanceId: "sw-1",
      executionLimit: { maxDispatchMs: 5000 },
      probeMissThreshold: 3,
      timers: clock.timers,
      createPipe: makePipeFactory().create,
    });
    router.attachTab(tabA.port);
    const id = router.announceEngine(engine.port);
    engine.emit(envelope({ type: "engine-ready", identity: id }));

    tabA.emit(envelope({ type: "overdue-dispatch", identity: id, elapsedMs: 9000 }));
    clock.tick(); // ping 1
    const pings = ofType(engine.sent, "control-ping");
    const ping1 = controlOf(pings[0]!);
    const ping1Id = ping1.type === "control-ping" ? ping1.pingId : -1;

    const tabAcksBefore = ofType(tabA.sent, "control-ack").length;
    engine.emit(envelope({ type: "control-ack", identity: id, pingId: ping1Id }));

    // The probe ack is consumed (loop stopped), NOT relayed to the tab.
    expect(ofType(tabA.sent, "control-ack")).toHaveLength(tabAcksBefore);
    expect(clock.pendingCount()).toBe(0);
  });
});

// ─── 5. Unregister ──────────────────────────────────────────────────────────────

describe("router unregister — the removed tab receives no later fan-outs", () => {
  it("drops the tab from the registry and stops delivering to it", () => {
    const tabA = makePort();
    const tabB = makePort();
    const router = createEngineRouter({ swInstanceId: "sw-1", createPipe: makePipeFactory().create });
    const unregisterA = router.attachTab(tabA.port);
    router.attachTab(tabB.port);
    expect(router.tabCount()).toBe(2);

    unregisterA();
    expect(router.tabCount()).toBe(1);
    expect(tabA.removed).toBe(true);

    const before = tabA.sent.length;
    router.openHandoff("leader-granted");
    expect(tabA.sent.length).toBe(before); // no new fan-out to the removed tab
    expect(lastControl(tabB.sent).type).toBe("leader-granted");
  });
});

// ─── Gap A: peer-departure detection (ADR-0049 D8 — destroy peer-refusal input) ──

describe("router tab-detach — a detaching tab is unregistered so tabCount falls (D8)", () => {
  it("a tab-detach control message drops the sending tab from tabCount", () => {
    const tabA = makePort();
    const tabB = makePort();
    const router = createEngineRouter({ swInstanceId: "sw-1", createPipe: makePipeFactory().create });
    router.attachTab(tabA.port);
    router.attachTab(tabB.port);
    expect(router.tabCount()).toBe(2);

    // tabB posts the `tab-detach` control envelope on its SW port (the router's only view of a departure —
    // the `detach` bridge envelope rides the pipe, invisible here). Its registration is dropped.
    tabB.emit(envelope({ type: "tab-detach" }));
    expect(router.tabCount()).toBe(1);
    expect(tabB.removed).toBe(true);

    // A subsequent fan-out reaches only the surviving tab.
    router.openHandoff("leader-granted");
    expect(lastControl(tabA.sent).type).toBe("leader-granted");
  });

  it("belt-and-braces: a MessagePort `close` event drops a crashed tab that never sent tab-detach", () => {
    // A port exposing `onclose` + a `close` listener slot — the feature-detected crashed-tab path.
    let closeListener: (() => void) | undefined;
    let messageListener: ((event: { data: unknown }) => void) | undefined;
    const closablePort = {
      onclose: null,
      postMessage: () => {},
      addEventListener: (type: string, l: (event: { data: unknown }) => void) => {
        if (type === "close") closeListener = l as unknown as () => void;
        else messageListener = l;
      },
      removeEventListener: (type: string) => {
        if (type === "close") closeListener = undefined;
        else messageListener = undefined;
      },
      start: () => {},
    };
    const tabB = makePort();
    const router = createEngineRouter({ swInstanceId: "sw-1", createPipe: makePipeFactory().create });
    router.attachTab(closablePort as unknown as RouterPort);
    router.attachTab(tabB.port);
    expect(router.tabCount()).toBe(2);
    expect(typeof closeListener).toBe("function"); // the router feature-detected `close` and subscribed
    void messageListener;

    // The tab's agent is destroyed → the platform fires `close` → the router drops the crashed tab.
    closeListener!();
    expect(router.tabCount()).toBe(1);
  });
});
