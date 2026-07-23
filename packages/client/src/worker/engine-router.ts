// The ROUTER (ADR-0049 step 6): the SharedWorker-side placement machinery — the "communication centre"
// (CONTEXT.md § "Language — engine placement"). This module runs INSIDE the SharedWorker and is the single
// role that never moves whatever the engine's home is. It owns exactly four things:
//   - the ATTACH REGISTRY (every tab's bridge port),
//   - the CURRENT engine identity + the engine CONTROL CHANNEL,
//   - relocation-notice FAN-OUT to every tab, and
//   - execution-limit PROBE FORWARDING (tab-reported overdue dispatch → control-channel pings → verdict).
//
// It deliberately does NOT: spawn workers, decide leadership, or ever inspect RPC payloads. Per attached tab
// it mints a proxy pipe and TRANSFERS one end to the engine and the other to the tab; from then on that tab's
// RPC/live-query traffic flows tab↔engine DIRECTLY on the pipe (invariant 6 — the SharedWorker is not in the
// data path). Because it is transport-agnostic (a `RouterPort`, never a real `SharedWorker`/`Worker`), the
// whole thing is unit-testable over hand-rolled recording ports with no worker at all — the same discipline
// `protocol.ts` and `engine-control.ts` follow.
//
// WIRE ENVELOPE. The control plane shares the same tab↔SharedWorker transport as today's data-path bridge
// (`protocol.ts`). To coexist WITHOUT touching `protocol.ts`, every control message travels inside a
// NAMESPACED envelope `{ [ENGINE_CONTROL_ENVELOPE_KEY]: <EngineControlMessage> }` (`pgx0049`). A bridge
// envelope (`{ ch: "pgxsinkit-bridge", … }`) has no such key and is ignored here; a control envelope has no
// `ch`/`v` and is ignored by the bridge router. Step 7's attach client speaks this SAME envelope.

import {
  mintEngineIdentity,
  readControlEnvelope,
  shouldApplyControlMessage,
  type EngineControlMessage,
  type EngineIdentity,
  type ExecutionLimitConfig,
  wrapControlEnvelope as envelope,
} from "./engine-control";

/**
 * The namespaced key under which every ADR-0049 control message rides the tab↔SharedWorker transport, so the
 * control plane coexists with the data-path bridge envelope (`protocol.ts`) without any change to it. The tab
 * side (step 7) sends/reads the identical envelope.
 */
export { ENGINE_CONTROL_ENVELOPE_KEY } from "./engine-control";

/**
 * The minimal MessagePort-shaped transport the router needs — the intersection of a real `MessagePort`, a
 * `SharedWorker` connection port, and the pipe ends it mints. Modeled on `protocol.ts`'s `BridgePort` (kept
 * local, not imported, because the router's transfer list is plain `unknown[]` and it never `close()`s a tab
 * port). Injected everywhere so the router is exercised with plain recording ports (no worker) in tests.
 */
export interface RouterPort {
  postMessage: (message: unknown, transfer?: unknown[]) => void;
  addEventListener: (type: "message", listener: (event: { data: unknown }) => void) => void;
  removeEventListener: (type: "message", listener: (event: { data: unknown }) => void) => void;
  start?: () => void;
}

/** The setTimeout/clearTimeout pair the probe loop schedules on — injectable for deterministic tests. */
export interface RouterTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EngineRouterOptions {
  /** The opaque id of THIS SharedWorker instance — scopes every minted {@link EngineIdentity}'s generation. */
  swInstanceId: string;
  /**
   * Engine-construction execution limit (`undefined`/absent `maxDispatchMs` = DISABLED, ADR D5). The router
   * only FORWARDS tab-reported overdue dispatches into control-channel probes when enabled; the verdict
   * threshold is {@link probeMissThreshold}. Disabled → overdue reports are ignored entirely.
   */
  executionLimit?: ExecutionLimitConfig;
  /** Consecutive unanswered probe pings before an engine-loss verdict (default 3). */
  probeMissThreshold?: number;
  /** Injectable pipe factory (default `() => new MessageChannel()`) so tests can observe both minted ends. */
  createPipe?: () => { port1: RouterPort; port2: RouterPort };
  /** Injectable timers for probe scheduling (default `globalThis`) for deterministic tests. */
  timers?: RouterTimers;
  /** Milliseconds between probe pings once a dispatch is reported overdue (default 2000). */
  probeIntervalMs?: number;
}

export interface EngineRouter {
  /**
   * Register a tab's bridge port. Returns an unregister fn. If an engine is CURRENT and already ready, this
   * late joiner is piped IMMEDIATELY; otherwise it is piped when the current engine's `engine-ready` fans out.
   */
  attachTab(tabPort: RouterPort): () => void;
  /**
   * tab→SW: the leader coordinator announces a fresh engine control channel. Stamps the next
   * {@link EngineIdentity} ({@link mintEngineIdentity}), stores the control channel, and returns the identity.
   * On the engine's `engine-ready` for THIS identity it pipes every attached tab. Any prior engine's control
   * listener/probe is cleared first (this does not itself fan a notice).
   */
  announceEngine(controlPort: RouterPort): EngineIdentity;
  /**
   * Fan a relocation notice to every tab: `leader-granted` (untagged) or `engine-retiring` (tagged with the
   * retired identity). BOTH clear the current identity + control channel. Engine-loss verdicts fan
   * `engine-retiring` internally the same way.
   */
  openHandoff(reason: "leader-granted" | "engine-retiring"): void;
  /** The current identity, or `undefined` before the first announce / while relocating. */
  currentIdentity(): EngineIdentity | undefined;
  /** Total attached-tab count (used later for destroy peer-refusal). */
  tabCount(): number;
}

interface TabEntry {
  port: RouterPort;
  listener: (event: { data: unknown }) => void;
  /** A `close`-event listener, present only where the platform supports the MessagePort `close` event (D8). */
  closeListener?: () => void;
}

/** The optional MessagePort `close`-event surface — feature-detected, not part of the structural {@link RouterPort}. */
interface ClosableRouterPort {
  onclose?: unknown;
  addEventListener: (type: "close", listener: () => void) => void;
  removeEventListener?: (type: "close", listener: () => void) => void;
}

export function createEngineRouter(options: EngineRouterOptions): EngineRouter {
  const { swInstanceId, executionLimit } = options;
  const probeMissThreshold = options.probeMissThreshold ?? 3;
  const probeIntervalMs = options.probeIntervalMs ?? 2000;
  const createPipe =
    options.createPipe ?? (() => new MessageChannel() as unknown as { port1: RouterPort; port2: RouterPort });
  const timers: RouterTimers = options.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  };

  const tabs = new Set<TabEntry>();

  // Current engine state. `lastMinted` survives a handoff (unlike `currentIdentity`) so the next announce mints
  // the SUCCESSOR generation (gen+1) under this SharedWorker instance, per mintEngineIdentity's contract.
  let currentIdentity: EngineIdentity | undefined;
  let lastMinted: EngineIdentity | undefined;
  let controlPort: RouterPort | undefined;
  let controlListener: ((event: { data: unknown }) => void) | undefined;
  let engineReady = false;

  // Execution-limit probe loop (one timer at a time; the whole loop keys on `currentIdentity`).
  let probeRunning = false;
  let probeHandle: unknown;
  let missCount = 0;
  let pingSeq = 0;
  let pendingPingId: number | undefined;

  function fanToTabs(message: EngineControlMessage): void {
    for (const tab of tabs) {
      tab.port.postMessage(envelope(message));
    }
  }

  /** Mint a fresh proxy pipe: engine end → the control channel, tab end → the tab (both TRANSFERRED). */
  function deliverPipe(tab: TabEntry): void {
    if (currentIdentity === undefined || controlPort === undefined) return;
    const { port1, port2 } = createPipe();
    controlPort.postMessage(envelope({ type: "connect-port", identity: currentIdentity }), [port1]);
    tab.port.postMessage(envelope({ type: "connect-port", identity: currentIdentity }), [port2]);
  }

  function resetProbe(): void {
    probeRunning = false;
    missCount = 0;
    pendingPingId = undefined;
    if (probeHandle !== undefined) {
      timers.clearTimeout(probeHandle);
      probeHandle = undefined;
    }
  }

  /** Detach the engine control channel + probe state WITHOUT fanning any notice (used by announce/handoff). */
  function clearEngine(): void {
    resetProbe();
    if (controlPort !== undefined && controlListener !== undefined) {
      controlPort.removeEventListener("message", controlListener);
    }
    controlPort = undefined;
    controlListener = undefined;
    currentIdentity = undefined;
    engineReady = false;
  }

  /** The engine-loss path: capture the retiring identity, tear down, and fan `engine-retiring` to every tab. */
  function retireCurrentEngine(): void {
    const retiring = currentIdentity;
    clearEngine();
    if (retiring !== undefined) {
      fanToTabs({ type: "engine-retiring", identity: retiring });
    }
  }

  function scheduleProbe(): void {
    probeHandle = timers.setTimeout(() => {
      probeHandle = undefined;
      // The engine went away between ticks (handoff/verdict) — abandon the loop silently.
      if (currentIdentity === undefined || controlPort === undefined) {
        resetProbe();
        return;
      }
      const pingId = ++pingSeq;
      pendingPingId = pingId;
      controlPort.postMessage(envelope({ type: "control-ping", identity: currentIdentity, pingId }));
      missCount += 1;
      if (missCount >= probeMissThreshold) {
        // Threshold consecutive unanswered pings → ENGINE-LOSS VERDICT (the router never terminates anything;
        // the leader coordinator reacts to the fanned `engine-retiring`).
        resetProbe();
        retireCurrentEngine();
      } else {
        scheduleProbe();
      }
    }, probeIntervalMs);
  }

  function startProbe(): void {
    if (probeRunning) return;
    probeRunning = true;
    missCount = 0;
    scheduleProbe();
  }

  // ─── Engine control-channel inbound ──────────────────────────────────────────
  function onControlMessage(data: unknown): void {
    const message = readControlEnvelope(data);
    if (message === undefined) return;
    switch (message.type) {
      case "engine-ready":
        // Gate on the exact identity pair — a stale engine-ready from a superseded generation is discarded.
        if (shouldApplyControlMessage(currentIdentity, message)) {
          engineReady = true;
          for (const tab of tabs) deliverPipe(tab);
        }
        return;
      case "control-ack":
        // A live-but-slow engine answered the PROBE: reset the miss count and STOP the loop (below-threshold
        // probing is never a verdict). Only the pending ping's id for the current identity counts — that ack
        // is CONSUMED here (never fanned to tabs).
        if (shouldApplyControlMessage(currentIdentity, message) && message.pingId === pendingPingId) {
          resetProbe();
          return;
        }
        // Any OTHER engine ack (pingId mismatch or no probe loop running) is the engine's teardown ack
        // (`pingId: -1`, ADR-0049 step 9) — relay it VERBATIM to every tab so the coordinator's identity-matched
        // teardown wait settles. The router never inspects it beyond forwarding.
        fanToTabs(message);
        return;
      default:
        // The engine control channel emits nothing else the router acts on here.
        return;
    }
  }

  // ─── Tab bridge-port inbound ──────────────────────────────────────────────────
  function onTabMessage(tab: TabEntry, data: unknown): void {
    const message = readControlEnvelope(data);
    if (message === undefined) return;
    switch (message.type) {
      case "control-ping":
        // Keepalive: reply IMMEDIATELY on the same tab, echoing the PING's identity (there may be no current
        // engine yet, and the keepalive is a liveness check of the SharedWorker itself, not of an engine).
        tab.port.postMessage(envelope({ type: "control-ack", identity: message.identity, pingId: message.pingId }));
        return;
      case "overdue-dispatch":
        // Execution limit (ADR D5): only when enabled AND the report is for the CURRENT engine identity.
        if (executionLimit?.maxDispatchMs === undefined) return; // disabled → ignored entirely
        if (!shouldApplyControlMessage(currentIdentity, message)) return; // stale / no engine
        startProbe();
        return;
      case "engine-teardown":
        // The coordinator's teardown handshake (ADR-0049 step 9): forward it VERBATIM to the engine's control
        // channel for the CURRENT identity, so the engine acks + self-closes. A stale teardown is discarded.
        if (!shouldApplyControlMessage(currentIdentity, message)) return;
        controlPort?.postMessage(envelope(message));
        return;
      case "tab-detach":
        // The tab is detaching (ADR-0049 D8): unregister it so `tabCount` (the destroy peer-refusal input) falls.
        // The `detach` bridge envelope rides the tab's pipe (invisible here), so this control signal on the SW
        // port is the router's only view of the departure. Its minted pipe end is simply dropped.
        removeTab(tab);
        return;
      default:
        // Any other control type from a tab is not the router's concern.
        return;
    }
  }

  /** Unregister a tab: drop it from the registry and detach its listeners (the minted pipe end is dropped). */
  function removeTab(entry: TabEntry): void {
    if (!tabs.has(entry)) return;
    tabs.delete(entry);
    entry.port.removeEventListener("message", entry.listener);
    if (entry.closeListener !== undefined) {
      (entry.port as unknown as ClosableRouterPort).removeEventListener?.("close", entry.closeListener);
    }
  }

  function attachTab(tabPort: RouterPort): () => void {
    const entry: TabEntry = {
      port: tabPort,
      listener: (event) => onTabMessage(entry, event.data),
    };
    tabPort.addEventListener("message", entry.listener);
    tabPort.start?.();
    // Belt-and-braces peer-departure detection (ADR-0049 D8): where the platform supports the MessagePort
    // `close` event, a CRASHED tab that never sent `tab-detach` is still dropped (its port closes on agent
    // teardown). Feature-detected via `onclose` so the structural `RouterPort` (and unit fakes) need not expose
    // it. RESIDUAL: where the `close` event is UNSUPPORTED, a crashed peer that never sent `tab-detach` leaves a
    // stale `tabCount` until the SharedWorker restarts — a `destroy()` then stays refused; the caller resolves it
    // with `destroy({ force: true })` (the documented escape). A clean `stop()`/`pagehide` always sends `tab-detach`.
    const closable = tabPort as unknown as ClosableRouterPort;
    if ("onclose" in closable) {
      const closeListener = () => removeTab(entry);
      entry.closeListener = closeListener;
      closable.addEventListener("close", closeListener);
    }
    tabs.add(entry);
    // Late joiner: an already-ready engine pipes this tab immediately; otherwise it is piped on engine-ready.
    if (currentIdentity !== undefined && engineReady) {
      deliverPipe(entry);
    }
    return () => removeTab(entry);
  }

  function announceEngine(port: RouterPort): EngineIdentity {
    clearEngine(); // detach any prior engine's listener/probe (no notice fanned by an announce).
    const minted = mintEngineIdentity(swInstanceId, lastMinted);
    lastMinted = minted;
    currentIdentity = minted;
    controlPort = port;
    controlListener = (event) => onControlMessage(event.data);
    port.addEventListener("message", controlListener);
    port.start?.();
    engineReady = false;
    // ADR-0049 step 9: hand the freshly-minted identity to the engine's control plane FIRST — before any
    // `connect-port` pipe. The engine remembers it (gating every subsequent tagged message) and replies
    // `engine-ready`, which drives the pipe fan-out below.
    port.postMessage(envelope({ type: "assign-identity", identity: minted }));
    return minted;
  }

  function openHandoff(reason: "leader-granted" | "engine-retiring"): void {
    if (reason === "engine-retiring") {
      retireCurrentEngine();
      return;
    }
    // leader-granted: a fresh engine is about to be spawned — clear the current one and open the window.
    clearEngine();
    fanToTabs({ type: "leader-granted" });
  }

  return {
    attachTab,
    announceEngine,
    openHandoff,
    currentIdentity: () => currentIdentity,
    tabCount: () => tabs.size,
  };
}
