import { describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) step 10b: the SharedWorker PLACEMENT BOOTSTRAP + the pure
// placement DECISION. These unit tests drive `bootstrapWorkerScope` directly with a FAKE SharedWorker global
// scope + a FAKE probe (no real worker, no real OPFS) — the same discipline the router / engine-entry tests
// follow. Two modes, gated on the (injected) probe verdict:
//   - GRANTED (`shared-worker`, SW-direct): every `onconnect` port is connected to the engine HOST (spy); the
//     port answers the placement query (`electionRequired: false`) and the `pgx0049` keepalive control-ping.
//   - DENIED (`elected-worker`, router-only): the host is NEVER connected (spy); the port answers the placement
//     query (`electionRequired: true`); a fake tab announce drives the router to pipe the tab (a `connect-port`).

import {
  bootstrapWorkerScope,
  DESTROY_QUERY_KEY,
  DESTROY_VERDICT_KEY,
  PLACEMENT_QUERY_KEY,
  PLACEMENT_RESULT_KEY,
} from "../../packages/client/src/worker/define-sync-worker";
import type { EngineControlMessage, EngineIdentity } from "../../packages/client/src/worker/engine-control";
import { ENGINE_CONTROL_ENVELOPE_KEY as KEY } from "../../packages/client/src/worker/engine-router";
import type { BridgePort } from "../../packages/client/src/worker/protocol";
import { decideSwPlacement, type SwPlacementResult } from "../../packages/client/src/worker/sw-placement";

type Listener = (event: { data: unknown; ports?: readonly unknown[] }) => void;
const envelope = (message: EngineControlMessage) => ({ [KEY]: message });
const controlOf = (message: unknown): EngineControlMessage | undefined =>
  (message as { [KEY]?: EngineControlMessage })[KEY];

/** A BridgePort-shaped fake: records posts (with any transfer list) and can `emit` inbound messages/ports. */
function makeFakePort() {
  const listeners = new Set<Listener>();
  const sent: { message: unknown; transfer?: unknown[] }[] = [];
  let started = false;
  const port: BridgePort = {
    postMessage: (message: unknown, transfer?: unknown[]) =>
      sent.push(transfer !== undefined ? { message, transfer } : { message }),
    addEventListener: (_type, l) => listeners.add(l as Listener),
    removeEventListener: (_type, l) => listeners.delete(l as Listener),
    start: () => {
      started = true;
    },
    close: () => undefined,
  };
  return {
    port,
    sent,
    isStarted: () => started,
    emit: (data: unknown, ports?: readonly unknown[]) => {
      for (const l of [...listeners]) l(ports !== undefined ? { data, ports } : { data });
    },
  };
}

/** A fake SharedWorkerGlobalScope: the constructor marker `bindGlobalScope`/`bootstrapWorkerScope` detects + a settable `onconnect`. */
function makeFakeSharedScope() {
  const scope: { SharedWorkerGlobalScope: unknown; onconnect?: (event: { ports: BridgePort[] }) => void } = {
    SharedWorkerGlobalScope: class {},
  };
  return { scope, connect: (port: BridgePort) => scope.onconnect?.({ ports: [port] }) };
}

/** A fake DedicatedWorkerGlobalScope: the marker the dedicated arm detects + the implicit-port method surface. */
function makeFakeDedicatedScope() {
  const listeners = new Set<Listener>();
  const scope = {
    DedicatedWorkerGlobalScope: class {},
    postMessage: () => undefined,
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    close: () => undefined,
  };
  return { scope };
}

const ID: EngineIdentity = { swInstanceId: "sw-test", generation: 0 };
const settle = async (n = 3) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const grantedPlacement = (): Promise<SwPlacementResult> =>
  Promise.resolve({ engineHome: "shared-worker", swInstanceId: "sw-test" });
const deniedPlacement = (): Promise<SwPlacementResult> =>
  Promise.resolve({ engineHome: "elected-worker", swInstanceId: "sw-test", probeError: "NotAllowedError: denied" });

// ─── 1. The pure decision ────────────────────────────────────────────────────

describe("decideSwPlacement — the pure engine-home decision (ADR-0049 D1)", () => {
  it("granted probe → shared-worker, no probeError, minted swInstanceId", async () => {
    const result = await decideSwPlacement({
      probe: () => Promise.resolve({ granted: true, ms: 1 }),
      mintInstanceId: () => "sw-abc",
    });
    expect(result).toEqual({ engineHome: "shared-worker", swInstanceId: "sw-abc" });
  });

  it("denied probe → elected-worker carrying the verbatim probeError", async () => {
    const result = await decideSwPlacement({
      probe: () => Promise.resolve({ granted: false, error: "NotAllowedError: nope", ms: 2 }),
      mintInstanceId: () => "sw-xyz",
    });
    expect(result).toEqual({
      engineHome: "elected-worker",
      swInstanceId: "sw-xyz",
      probeError: "NotAllowedError: nope",
    });
  });
});

// ─── 2. GRANTED (shared-worker / SW-direct) ──────────────────────────────────

describe("bootstrap — granted placement connects ports to the engine host (SW-direct)", () => {
  it("each onconnect port is connected to the host, and the placement query replies electionRequired:false", async () => {
    const connected: BridgePort[] = [];
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      decidePlacement: grantedPlacement,
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    await settle();

    // The host received the port (SW-direct engine home in-scope).
    expect(connected).toHaveLength(1);
    expect(connected[0]).toBe(tab.port);

    // The placement query is answered with electionRequired:false.
    tab.emit({ [PLACEMENT_QUERY_KEY]: true });
    const reply = tab.sent.find((s) => (s.message as Record<string, unknown>)[PLACEMENT_RESULT_KEY]);
    expect(reply).toBeDefined();
    expect((reply!.message as Record<string, unknown>)[PLACEMENT_RESULT_KEY]).toEqual({
      engineHome: "shared-worker",
      electionRequired: false,
      swInstanceId: "sw-test",
    });
  });

  it("answers the pgx0049 keepalive control-ping on the port (keepalive works on SW-direct too)", async () => {
    const connected: BridgePort[] = [];
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      decidePlacement: grantedPlacement,
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    await settle();

    tab.emit(envelope({ type: "control-ping", identity: ID, pingId: 7 }));
    const ack = tab.sent.map((s) => controlOf(s.message)).find((m) => m?.type === "control-ack");
    expect(ack).toEqual({ type: "control-ack", identity: ID, pingId: 7 });
  });

  it("the destroy peer-count query replies with the host's attached-tab count", async () => {
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
    await settle();

    tabA.emit({ [DESTROY_QUERY_KEY]: true });
    const verdict = tabA.sent.find((s) => (s.message as Record<string, unknown>)[DESTROY_VERDICT_KEY]);
    expect((verdict!.message as Record<string, unknown>)[DESTROY_VERDICT_KEY]).toEqual({ peers: 2 });
  });
});

// ─── 3. DENIED (elected-worker / router-only) ────────────────────────────────

describe("bootstrap — denied placement is router-only; the engine host is never booted", () => {
  it("the host is NEVER connected; the placement query replies electionRequired:true", async () => {
    let hostConnects = 0;
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: () => hostConnects++,
      peerCount: () => 0,
      decidePlacement: deniedPlacement,
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    await settle();

    expect(hostConnects).toBe(0); // the engine host is NEVER booted in router-only mode

    tab.emit({ [PLACEMENT_QUERY_KEY]: true });
    const reply = tab.sent.find((s) => (s.message as Record<string, unknown>)[PLACEMENT_RESULT_KEY]);
    expect((reply!.message as Record<string, unknown>)[PLACEMENT_RESULT_KEY]).toEqual({
      engineHome: "elected-worker",
      electionRequired: true,
      swInstanceId: "sw-test",
    });
  });

  it("a fake tab announce drives the router to pipe the tab (a connect-port arrives)", async () => {
    let hostConnects = 0;
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: () => hostConnects++,
      peerCount: () => 0,
      decidePlacement: deniedPlacement,
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    await settle();

    // The tab's coordinator announces its freshly-spawned engine: engine-announce carries the ROUTER-END control
    // port as a transferred port. The SW bootstrap translates this into `router.announceEngine`.
    const routerEnd = makeFakePort();
    tab.emit(envelope({ type: "engine-announce" }), [routerEnd.port]);
    await settle();

    // The router stamped an identity and handed it to the engine's control plane (assign-identity on the router end).
    const assign = routerEnd.sent.map((s) => controlOf(s.message)).find((m) => m?.type === "assign-identity");
    expect(assign?.type).toBe("assign-identity");

    // The engine replies engine-ready → the router pipes every tab: a connect-port (with a transferred pipe) lands on the tab.
    routerEnd.emit(envelope({ type: "engine-ready", identity: (assign as { identity: EngineIdentity }).identity }));
    await settle();

    const connectPort = tab.sent.find((s) => controlOf(s.message)?.type === "connect-port");
    expect(connectPort).toBeDefined();
    expect(connectPort!.transfer).toHaveLength(1); // the transferred proxy pipe end
    expect(hostConnects).toBe(0); // still never booted the in-scope host
  });
});

// ─── 3b. Default ALWAYS probes; declared `backend: "idbfs"` NEVER probes (ADR-0049 D1) ────────────────
//
// Capability placement is THE behavior: the probe is UNCONDITIONAL for the default `backend: "opfs"`, so a denied
// probe flips the SharedWorker router-only. The ONE opt-out is a registry declaring `backend: "idbfs"`
// (`declaredIdbfs: true`): no probe runs and the in-SW engine host binds on idbfs (the declared mode, not a
// fallback), answering the placement query `electionRequired:false`.

describe("bootstrap — default ALWAYS probes; declared idbfs never probes (ADR-0049 D1)", () => {
  it("default (no declaration): a DENIED probe flips the scope router-only (the probe is unconditional)", async () => {
    let hostConnects = 0;
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: () => hostConnects++,
      peerCount: () => 0,
      // No `declaredIdbfs` → the probe runs; a denied verdict goes router-only (elected-worker).
      decidePlacement: deniedPlacement,
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    await settle();

    expect(hostConnects).toBe(0); // router-only — the in-scope host is never booted on a denied probe
    tab.emit({ [PLACEMENT_QUERY_KEY]: true });
    const reply = tab.sent.find((s) => (s.message as Record<string, unknown>)[PLACEMENT_RESULT_KEY]);
    expect((reply!.message as Record<string, unknown>)[PLACEMENT_RESULT_KEY]).toMatchObject({
      engineHome: "elected-worker",
      electionRequired: true,
    });
  });

  it("declaredIdbfs: NEVER probes — binds the in-SW host on idbfs, electionRequired:false, no OPFS grant", async () => {
    const connected: BridgePort[] = [];
    const outcomes: { engineHome: SwPlacementResult["engineHome"] | undefined; opfsGranted: boolean }[] = [];
    const { scope, connect } = makeFakeSharedScope();
    let probed = false;
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      declaredIdbfs: true,
      // The injected decision would flip router-only IF consulted — declaredIdbfs must ignore it (no probe runs).
      decidePlacement: () => {
        probed = true;
        return deniedPlacement();
      },
      onPlacement: (outcome) => outcomes.push(outcome),
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    await settle();

    expect(probed).toBe(false); // the declared-idbfs mode never runs the probe
    // The in-SW engine host IS connected on idbfs — never router-only.
    expect(connected).toHaveLength(1);
    expect(connected[0]).toBe(tab.port);

    tab.emit({ [PLACEMENT_QUERY_KEY]: true });
    const reply = tab.sent.find((s) => (s.message as Record<string, unknown>)[PLACEMENT_RESULT_KEY]);
    expect((reply!.message as Record<string, unknown>)[PLACEMENT_RESULT_KEY]).toMatchObject({
      engineHome: "shared-worker",
      electionRequired: false,
    });
    // The gate opened with NO OPFS grant (idbfs) and NO fallback reason (this is the declared mode, not a fallback).
    expect(outcomes).toEqual([{ engineHome: "shared-worker", opfsGranted: false }]);
  });
});

// ─── 3c. Capability-absence fallback → in-SW idbfs with a fallback reason (ADR-0049 D1/D12) ───────────
//
// When no home on the platform can hold sync-access handles, the decision is a `shared-worker` home carrying a
// `storageFallbackReason` — the engine boots in-SharedWorker on idbfs (the declared-idbfs shape reached by
// capability detection). The fallback is OBSERVABLE: the outcome threads the verbatim reason for the BootReport.

describe("bootstrap — capability-absence fallback boots in-SW idbfs with a reason (ADR-0049 D1/D12)", () => {
  it("a shared-worker decision carrying storageFallbackReason connects the host on idbfs + threads the reason", async () => {
    const connected: BridgePort[] = [];
    const outcomes: {
      engineHome: SwPlacementResult["engineHome"] | undefined;
      opfsGranted: boolean;
      storageFallbackReason?: string;
    }[] = [];
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      // Capability absence: OPFS is capable in principle but no home can hold handles → in-SW idbfs fallback.
      decidePlacement: () =>
        Promise.resolve({
          engineHome: "shared-worker",
          swInstanceId: "sw-fallback",
          storageFallbackReason: "NotAllowedError: every home denied",
        }),
      onPlacement: (outcome) => outcomes.push(outcome),
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    await settle();

    // The engine host boots in-scope (idbfs), never router-only.
    expect(connected).toHaveLength(1);
    // The outcome opens the gate with NO OPFS grant AND the verbatim fallback reason for the BootReport (decision 12).
    expect(outcomes).toEqual([
      { engineHome: "shared-worker", opfsGranted: false, storageFallbackReason: "NotAllowedError: every home denied" },
    ]);

    // The placement query answers electionRequired:false (the fallback is the in-SW host, no election).
    tab.emit({ [PLACEMENT_QUERY_KEY]: true });
    const reply = tab.sent.find((s) => (s.message as Record<string, unknown>)[PLACEMENT_RESULT_KEY]);
    expect((reply!.message as Record<string, unknown>)[PLACEMENT_RESULT_KEY]).toMatchObject({
      engineHome: "shared-worker",
      electionRequired: false,
    });
  });

  it("elected engine reports engine-fallback → the router-only scope flips to the in-SW idbfs host", async () => {
    const connected: BridgePort[] = [];
    const outcomes: {
      engineHome: SwPlacementResult["engineHome"] | undefined;
      opfsGranted: boolean;
      storageFallbackReason?: string;
    }[] = [];
    const { scope, connect } = makeFakeSharedScope();
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      decidePlacement: deniedPlacement, // router-only first
      onPlacement: (outcome) => outcomes.push(outcome),
      globalScope: scope,
    });

    const tab = makeFakePort();
    connect(tab.port);
    await settle();
    expect(connected).toHaveLength(0); // router-only — no in-scope host yet

    // The elected engine reports its OWN-scope probe was denied → the SharedWorker abandons election and hosts idbfs.
    tab.emit(envelope({ type: "engine-fallback", reason: "NotAllowedError: dedicated home denied" }));
    await settle();

    expect(connected).toHaveLength(1);
    expect(connected[0]).toBe(tab.port);
    // The second onPlacement re-threads the in-SW idbfs fallback with the reported reason.
    expect(outcomes.at(-1)).toEqual({
      engineHome: "shared-worker",
      opfsGranted: false,
      storageFallbackReason: "NotAllowedError: dedicated home denied",
    });
  });
});

// ─── 4. The elected DEDICATED engine self-probes its OWN scope (ADR-0049 bug 2) ─────────────────────
//
// The elected engine runs in a dedicated `Worker` whose `defineSyncWorker` scope used to delegate straight to
// `bindGlobalScope` and NEVER learn its OPFS grant — so it would boot `idbfs` even though it holds sync-access.
// The fix: the dedicated arm PROBES its own scope (invariant 8 — a real open, per boot, never sniffed/cached) and
// threads the verdict as the `elected-worker` home's grant. These tests drive that arm with a fake dedicated scope
// + an injected probe (no real Worker, no real OPFS) and assert the grant is threaded — the engine host is still
// wired unchanged.

describe("bootstrap — the elected DEDICATED engine probes its OWN scope for the OPFS grant (ADR-0049 bug 2)", () => {
  it("a GRANTED dedicated-scope probe threads engineHome=elected-worker + opfsGranted=true; the host is still wired", async () => {
    const connected: BridgePort[] = [];
    const outcomes: { engineHome: SwPlacementResult["engineHome"] | undefined; opfsGranted: boolean }[] = [];
    const { scope } = makeFakeDedicatedScope();
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      probe: () => Promise.resolve({ granted: true, ms: 1 }),
      onPlacement: (outcome) => outcomes.push(outcome),
      globalScope: scope,
    });

    // The engine CORE is hosted immediately on the implicit scope port (the step-9 control plane is unchanged).
    expect(connected).toHaveLength(1);

    // The probe resolves → the grant is threaded so the boot opens the OPFS-repacked backend it actually holds.
    await settle();
    expect(outcomes).toEqual([{ engineHome: "elected-worker", opfsGranted: true }]);
  });

  it("a DENIED dedicated-scope probe threads opfsGranted=false + a fallback reason (honest idb fallback, never a virgin opfs mint)", async () => {
    const connected: BridgePort[] = [];
    const outcomes: {
      engineHome: SwPlacementResult["engineHome"] | undefined;
      opfsGranted: boolean;
      storageFallbackReason?: string;
    }[] = [];
    const { scope } = makeFakeDedicatedScope();
    bootstrapWorkerScope({
      connect: (port) => connected.push(port),
      peerCount: () => connected.length,
      probe: () => Promise.resolve({ granted: false, error: "NotAllowedError: denied", ms: 1 }),
      onPlacement: (outcome) => outcomes.push(outcome),
      globalScope: scope,
    });

    expect(connected).toHaveLength(1);
    await settle();
    // Capability absence in the dedicated home: idbfs, with the verbatim probe attribution for the BootReport (D12).
    expect(outcomes).toEqual([
      {
        engineHome: "elected-worker",
        opfsGranted: false,
        storageFallbackReason: "elected engine OPFS probe denied (NotAllowedError: denied)",
      },
    ]);
  });
});
