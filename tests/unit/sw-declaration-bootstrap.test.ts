import { describe, expect, it } from "bun:test";
// ADR-0050 (storage declaration transport): the SharedWorker bootstrap's PRE-PLACEMENT declaration message.
// The worker name carries the store path ONLY; the tab posts one declaration message on every port BEFORE its
// placement query, and the bootstrap DEFERS the placement decision until the first one arrives — because
// `backend: "idbfs"` selects SW-direct and skips the probe, so the decision cannot run before the declaration
// is known. These tests drive `bootstrapWorkerScope` with a FAKE SharedWorker scope + injected decisions (no
// real worker, no OPFS), the same discipline as sw-placement-bootstrap.test.ts. The matrix:
//   - registry-silent: NO decision (no probe, no routing, queries queued) until the first declaration message
//   - wire {} → the probe runs (capability default); wire `idbfs` → NO probe, SW-direct idbfs
//   - first arrival binds; an equal later declaration is idempotent; an explicit conflict is a typed refusal
//   - registry-static (`staticStorage`) decides IMMEDIATELY (no wait); wire {} never conflicts with it;
//     an explicit wire mismatch against it is refused
//   - an engine-bound bridge envelope on a port that has not declared is a protocol violation → refused,
//     never routed to the engine host
//   - a DECLARED port's engine-bound/control traffic while placement is still pending is QUEUED and
//     redelivered after routing ("declaration first, then anything" — the reconnect/reconstruction contract)

import {
  bootstrapWorkerScope,
  DECLARATION_KEY,
  DECLARATION_REFUSED_KEY,
  PLACEMENT_QUERY_KEY,
  PLACEMENT_RESULT_KEY,
} from "../../packages/client/src/worker/define-sync-worker";
import { readControlEnvelope, wrapControlEnvelope } from "../../packages/client/src/worker/engine-control";
import { BRIDGE_CHANNEL, type BridgePort } from "../../packages/client/src/worker/protocol";
import type { SwPlacementResult } from "../../packages/client/src/worker/sw-placement";

type Listener = (event: { data: unknown; ports?: readonly unknown[] }) => void;

/** A BridgePort-shaped fake: records posts and can `emit` inbound messages (sw-placement-bootstrap's harness).
 * `dispatchEvent` fans a redelivered event to every registered listener — the EventTarget surface the
 * bootstrap's queued-traffic replay dispatches real `MessageEvent`s through. */
function makeFakePort() {
  const listeners = new Set<Listener>();
  const sent: { message: unknown; transfer?: unknown[] }[] = [];
  const port = {
    postMessage: (message: unknown, transfer?: unknown[]) =>
      sent.push(transfer !== undefined ? { message, transfer } : { message }),
    addEventListener: (_type: string, l: unknown) => listeners.add(l as Listener),
    removeEventListener: (_type: string, l: unknown) => listeners.delete(l as Listener),
    start: () => undefined,
    close: () => undefined,
    dispatchEvent: (event: { data: unknown; ports?: readonly unknown[] }) => {
      for (const l of [...listeners]) l(event);
      return true;
    },
  } as unknown as BridgePort;
  return {
    port,
    sent,
    emit: (data: unknown, ports?: readonly unknown[]) => {
      for (const l of [...listeners]) l(ports !== undefined ? { data, ports } : { data });
    },
  };
}

/** A fake SharedWorkerGlobalScope (the constructor marker + settable onconnect). */
function makeFakeSharedScope() {
  const scope: { SharedWorkerGlobalScope: unknown; onconnect?: (event: { ports: BridgePort[] }) => void } = {
    SharedWorkerGlobalScope: class {},
  };
  return { scope, connect: (port: BridgePort) => scope.onconnect?.({ ports: [port] }) };
}

const settle = async (n = 3) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const grantedPlacement = (): Promise<SwPlacementResult> =>
  Promise.resolve({ engineHome: "shared-worker", swInstanceId: "sw-test" });

const declare = (storage: Record<string, unknown>) => ({ [DECLARATION_KEY]: storage });
const placementReplyOf = (sent: { message: unknown }[]) =>
  sent.find((s) => (s.message as Record<string, unknown>)[PLACEMENT_RESULT_KEY])?.message as
    | Record<string, unknown>
    | undefined;
const refusalOf = (sent: { message: unknown }[]) =>
  sent.find((s) => (s.message as Record<string, unknown>)[DECLARATION_REFUSED_KEY])?.message as
    | Record<string, unknown>
    | undefined;

// ─── 1. Registry-silent: the decision WAITS for the first declaration message ────────────────────────

describe("bootstrap — registry-silent placement defers to the first declaration message (ADR-0050)", () => {
  it("no declaration → no probe, no routing, the placement query stays queued", async () => {
    let probed = false;
    let hostConnects = 0;
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: () => hostConnects++,
      peerCount: () => 0,
      decidePlacement: () => {
        probed = true;
        return grantedPlacement();
      },
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    tab.emit({ [PLACEMENT_QUERY_KEY]: true });
    await settle();

    expect(probed).toBe(false); // the decision cannot run before the declaration is known
    expect(hostConnects).toBe(0);
    expect(placementReplyOf(tab.sent)).toBeUndefined(); // queued, not answered
  });

  it("wire {} → the probe runs (capability default); the queued placement query is answered; the port routes to the host", async () => {
    let probed = false;
    const connected: BridgePort[] = [];
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      decidePlacement: () => {
        probed = true;
        return grantedPlacement();
      },
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    tab.emit(declare({}));
    tab.emit({ [PLACEMENT_QUERY_KEY]: true });
    await settle();

    expect(probed).toBe(true);
    expect(connected).toEqual([tab.port]);
    expect(placementReplyOf(tab.sent)?.[PLACEMENT_RESULT_KEY]).toMatchObject({
      engineHome: "shared-worker",
      electionRequired: false,
    });
  });

  it("wire backend idbfs → NEVER probes; SW-direct on idbfs with no OPFS grant", async () => {
    let probed = false;
    const connected: BridgePort[] = [];
    const outcomes: { engineHome: string | undefined; opfsGranted: boolean }[] = [];
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      decidePlacement: () => {
        probed = true;
        return grantedPlacement();
      },
      onPlacement: (outcome) => outcomes.push({ engineHome: outcome.engineHome, opfsGranted: outcome.opfsGranted }),
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    tab.emit(declare({ backend: "idbfs" }));
    tab.emit({ [PLACEMENT_QUERY_KEY]: true });
    await settle();

    expect(probed).toBe(false); // declared idbfs skips the probe entirely
    expect(connected).toEqual([tab.port]);
    expect(outcomes).toEqual([{ engineHome: "shared-worker", opfsGranted: false }]);
    expect(placementReplyOf(tab.sent)?.[PLACEMENT_RESULT_KEY]).toMatchObject({
      engineHome: "shared-worker",
      electionRequired: false,
    });
  });

  it("concurrent first attaches: the first declaration binds; an equal second is idempotent — both ports route", async () => {
    const connected: BridgePort[] = [];
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      decidePlacement: grantedPlacement,
      globalScope: scope,
    });

    const tabA = makeFakePort();
    const tabB = makeFakePort();
    connect(tabA.port);
    connect(tabB.port);
    tabA.emit(declare({ durability: "strict" }));
    tabB.emit(declare({ durability: "strict" }));
    await settle();

    expect(connected).toEqual([tabA.port, tabB.port]);
    expect(refusalOf(tabA.sent)).toBeUndefined();
    expect(refusalOf(tabB.sent)).toBeUndefined();
  });

  it("a later declaration explicitly conflicting with the bound one is refused on ITS port; the first port is unaffected", async () => {
    const connected: BridgePort[] = [];
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      decidePlacement: grantedPlacement,
      globalScope: scope,
    });

    const tabA = makeFakePort();
    const tabB = makeFakePort();
    connect(tabA.port);
    connect(tabB.port);
    tabA.emit(declare({ durability: "strict" }));
    await settle();
    tabB.emit(declare({ durability: "relaxed" })); // explicit mismatch with the bound declaration
    await settle();

    expect(connected).toEqual([tabA.port]); // the conflicting port is never routed
    expect(refusalOf(tabA.sent)).toBeUndefined();
    const refusal = refusalOf(tabB.sent)?.[DECLARATION_REFUSED_KEY] as { message?: string } | undefined;
    expect(refusal?.message).toContain("durability");
  });

  it("a later EMPTY declaration {} never conflicts with the bound one — the port routes", async () => {
    const connected: BridgePort[] = [];
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      decidePlacement: grantedPlacement,
      globalScope: scope,
    });

    const tabA = makeFakePort();
    const tabB = makeFakePort();
    connect(tabA.port);
    connect(tabB.port);
    tabA.emit(declare({ backend: "idbfs", durability: "strict" }));
    await settle();
    tabB.emit(declare({}));
    await settle();

    expect(connected).toEqual([tabA.port, tabB.port]);
    expect(refusalOf(tabB.sent)).toBeUndefined();
  });
});

// ─── 2. Registry-static (`staticStorage`) is authoritative: decides at startup, no wait ──────────────

describe("bootstrap — a registry-static declaration decides immediately; wire declarations only confirm (ADR-0050)", () => {
  it("staticStorage idbfs: no probe, placement answerable BEFORE any declaration arrives", async () => {
    let probed = false;
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: () => undefined,
      peerCount: () => 0,
      staticStorage: { backend: "idbfs" },
      decidePlacement: () => {
        probed = true;
        return grantedPlacement();
      },
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    tab.emit({ [PLACEMENT_QUERY_KEY]: true }); // no declaration yet — the static declaration already decided
    await settle();

    expect(probed).toBe(false);
    expect(placementReplyOf(tab.sent)?.[PLACEMENT_RESULT_KEY]).toMatchObject({
      engineHome: "shared-worker",
      electionRequired: false,
    });
  });

  it("static idbfs + wire {} → routed, never refused (the static-declaring consumer's tab has no opinion)", async () => {
    const connected: BridgePort[] = [];
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      staticStorage: { backend: "idbfs" },
      decidePlacement: grantedPlacement,
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    tab.emit(declare({}));
    await settle();

    expect(connected).toEqual([tab.port]);
    expect(refusalOf(tab.sent)).toBeUndefined();
  });

  it("static idbfs + wire EXPLICIT opfs → typed refusal; the port never routes", async () => {
    const connected: BridgePort[] = [];
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      staticStorage: { backend: "idbfs" },
      decidePlacement: grantedPlacement,
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    tab.emit(declare({ backend: "opfs" }));
    await settle();

    expect(connected).toEqual([]);
    const refusal = refusalOf(tab.sent)?.[DECLARATION_REFUSED_KEY] as { message?: string } | undefined;
    expect(refusal?.message).toContain("backend");
  });
});

// ─── 3. Protocol violation: engine-bound traffic before the port's declaration ───────────────────────

describe("bootstrap — an engine-bound envelope before the port's declaration is refused (ADR-0050)", () => {
  it("a bridge attach envelope on an undeclared port is refused and never reaches the engine host", async () => {
    const connected: BridgePort[] = [];
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      staticStorage: { backend: "idbfs" }, // placement is already decided — the violation is per-PORT
      decidePlacement: grantedPlacement,
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    tab.emit({ ch: BRIDGE_CHANNEL, v: 1, type: "attach", id: "a1", payload: {} });
    await settle();

    expect(connected).toEqual([]); // never routed
    const refusal = refusalOf(tab.sent)?.[DECLARATION_REFUSED_KEY] as { message?: string } | undefined;
    expect(refusal?.message).toContain("declaration");

    // The port is not poisoned: a declaration after the refusal still routes it (a fresh, conforming attach).
    tab.emit(declare({}));
    await settle();
    expect(connected).toEqual([tab.port]);
  });
});

// ─── 4. Queued declared-port traffic: "declaration first, then anything" (ADR-0050) ──────────────────
// A bridge-silence reconnect and a keepalive SW reconstruction post declaration + attach/announce
// back-to-back with NO placement round-trip. The bootstrap must queue a DECLARED port's engine-bound and
// control traffic while the placement decision is pending and redeliver it after routing — never drop it
// (the pre-0050 unstarted port buffered this implicitly; started-immediately ports must do it explicitly).

describe("bootstrap — a DECLARED port's pending-placement traffic is queued and redelivered after routing", () => {
  it("declaration + attach envelope back-to-back: the attach reaches the engine host after routing, unrefused", async () => {
    const hostSeen: unknown[] = [];
    const connected: BridgePort[] = [];
    let resolveDecision: (result: SwPlacementResult) => void = () => undefined;
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: (port) => {
        connected.push(port);
        // The engine host installs its own listener at connect — replay must land on it.
        port.addEventListener("message", ((event: { data: unknown }) => hostSeen.push(event.data)) as never);
      },
      peerCount: () => connected.length,
      decidePlacement: () =>
        new Promise<SwPlacementResult>((resolve) => {
          resolveDecision = resolve;
        }),
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    const attachEnvelope = { ch: BRIDGE_CHANNEL, v: 1, type: "attach", id: "a1", payload: {} };
    tab.emit(declare({}));
    tab.emit(attachEnvelope); // placement pending — the DECLARED port's envelope queues, never refused
    expect(refusalOf(tab.sent)).toBeUndefined();
    expect(hostSeen).toEqual([]); // nothing delivered before routing
    resolveDecision({ engineHome: "shared-worker", swInstanceId: "sw-test" });
    await settle();

    expect(connected).toEqual([tab.port]);
    expect(refusalOf(tab.sent)).toBeUndefined();
    expect(hostSeen).toEqual([attachEnvelope]); // redelivered onto the routed port
  });

  it("a queued engine-announce control envelope (keepalive SW reconstruction) reaches the router with its transferred port", async () => {
    let resolveDecision: (result: SwPlacementResult) => void = () => undefined;
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: () => undefined,
      peerCount: () => 0,
      decidePlacement: () =>
        new Promise<SwPlacementResult>((resolve) => {
          resolveDecision = resolve;
        }),
      globalScope: scope,
    });

    const coordinator = makeFakePort();
    connect(coordinator.port);
    const channel = new MessageChannel();
    coordinator.emit(declare({})); // declaration first — the reconstruction wrapper's contract
    coordinator.emit(wrapControlEnvelope({ type: "engine-announce" }), [channel.port1]); // queued with its port
    resolveDecision({ engineHome: "elected-worker", swInstanceId: "sw-test" });
    await settle();

    // The router received the replayed announce: it stamps an identity on the transferred control port.
    const assigned = await new Promise<unknown>((resolve) => {
      channel.port2.onmessage = (event) => resolve(event.data);
      setTimeout(() => resolve(undefined), 500);
    });
    expect(readControlEnvelope(assigned)?.type).toBe("assign-identity");
    channel.port1.close();
    channel.port2.close();
  });
});
