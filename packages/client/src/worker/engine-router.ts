// The ROUTER (ADR-0049 step 6): the SharedWorker-side placement machinery — the "communication centre"
// (CONTEXT.md § "Language — engine placement"). This module runs INSIDE the SharedWorker and is the single
// role that never moves whatever the engine's home is. It owns exactly five things:
//   - the ATTACH REGISTRY (every tab's bridge port),
//   - the CURRENT engine identity + the engine CONTROL CHANNEL,
//   - relocation-notice FAN-OUT to every tab,
//   - execution-limit PROBE FORWARDING (tab-reported overdue dispatch → control-channel pings → verdict), and
//   - ENGINE LIVENESS: a registered engine must stay PROVEN LIVE. The router state can outlive an engine —
//     `extendedLifetime` keeps the SharedWorker (and this module's state) alive past the last tab, while an
//     elected DEDICATED engine dies with the tab that spawned it — so a registration is never trusted on age.
//     On the DEFAULT configuration the retirement signals are the ones that carry actual EVIDENCE of death:
//     the engine control port's `close` event (MessagePort `close` is Baseline, so this covers every current
//     browser), the reported paths owned above this module (worker `error`, spawn failure, tab death), and
//     the teardown handshake. SILENCE IS NEVER A VERDICT HERE (ADR-0049 D5): PGlite's synchronous WASM work
//     blocks the engine's event loop, so a legitimate long import stalls the control channel exactly as a
//     corpse does. Timing therefore lives entirely behind the OPT-IN execution limit — with it enabled, an
//     unacked `connect-port` and a tab-reported overdue dispatch both hand the question to the probe loop,
//     which lands on the SAME `retireCurrentEngine` path. RESIDUAL, stated honestly: on a hypothetical
//     platform with no MessagePort `close` event AND the limit disabled, a silently-dead piped engine is not
//     detected by this module — that is the ADR's posture ("the limit is never claimed as death evidence"),
//     not an oversight.
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
  engineIdentityEquals,
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
   * Engine-construction execution limit (`undefined`/absent `maxDispatchMs` = DISABLED, ADR D5). This one
   * option gates ALL of the router's timing machinery: tab-reported overdue dispatches are forwarded into
   * control-channel probes, and delivered pipes are covered by the {@link connectAckTimeoutMs} window, only
   * when it is enabled. Disabled (the default) → overdue reports are ignored, no window is armed, and no
   * amount of engine silence ever produces a verdict.
   */
  executionLimit?: ExecutionLimitConfig;
  /**
   * Probe pings that each went a FULL {@link probeIntervalMs} unanswered before an engine-loss verdict
   * (default 3). Counting is per-ping, never per-tick: the threshold-th ping owns its own whole interval, so
   * the effective silence before a verdict is `probeMissThreshold × probeIntervalMs` (plus the ack window
   * where the probe started there).
   */
  probeMissThreshold?: number;
  /** Injectable pipe factory (default `() => new MessageChannel()`) so tests can observe both minted ends. */
  createPipe?: () => { port1: RouterPort; port2: RouterPort };
  /** Injectable timers for probe scheduling (default `globalThis`) for deterministic tests. */
  timers?: RouterTimers;
  /** Milliseconds between probe pings once a dispatch is reported overdue (default 2000). */
  probeIntervalMs?: number;
  /**
   * Milliseconds a delivered `connect-port` may go unacknowledged by the engine before its liveness is
   * QUESTIONED (default 3000). ONLY armed when {@link executionLimit} is enabled — silence is not evidence of
   * death (ADR-0049 D5), so the default configuration never starts this clock. Where it is armed, expiry is
   * still not a verdict: it starts the {@link probeMissThreshold} probe loop, so a live-but-busy engine
   * answers a ping and survives while a corpse is retired.
   */
  connectAckTimeoutMs?: number;
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
   * listener/probe is cleared first (this does not itself fan a notice). The announced port is also WATCHED for
   * liveness from here on: its `close` (where the platform has that event) retires this engine.
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
  const connectAckTimeoutMs = options.connectAckTimeoutMs ?? 3000;
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
  /** A `close`-event listener on the CONTROL port, present only where the platform has that event (as for tabs). */
  let controlCloseListener: (() => void) | undefined;
  let engineReady = false;

  // Engine liveness. `teardownForwarded` remembers the identity whose `engine-teardown` this router relayed: the
  // engine acks that and SELF-CLOSES its control end, so that one close is EXPECTED and must stay silent — the
  // coordinator that asked for the teardown owns the retirement. `connectAckHandle` is ONE router-wide window
  // that exists only under the opt-in execution limit (`undefined` on the default configuration); its
  // per-engine — deliberately NOT per-delivery — contract is spelled out on `armConnectAckWindow`.
  let teardownForwarded: EngineIdentity | undefined;
  let connectAckHandle: unknown;

  /** ADR-0049 D5: every timing-based path in this module (ack window + probe loop) is gated on this opt-in. */
  const executionLimitEnabled = executionLimit?.maxDispatchMs !== undefined;

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

  /**
   * Mint a fresh proxy pipe: engine end → the control channel, tab end → the tab (both TRANSFERRED). The
   * bounded liveness window over this delivery is armed ONLY under the opt-in execution limit (ADR-0049 D5);
   * with the limit disabled a delivery starts no clock, so a blocked-but-healthy engine is never condemned by
   * a second tab attaching mid-import. The engine still posts `connect-port-ack` either way — harmless, and
   * the handler simply clears a window that was never armed.
   */
  function deliverPipe(tab: TabEntry): void {
    if (currentIdentity === undefined || controlPort === undefined) return;
    const { port1, port2 } = createPipe();
    controlPort.postMessage(envelope({ type: "connect-port", identity: currentIdentity }), [port1]);
    tab.port.postMessage(envelope({ type: "connect-port", identity: currentIdentity }), [port2]);
    if (executionLimitEnabled) armConnectAckWindow(currentIdentity);
  }

  function clearConnectAckWindow(): void {
    if (connectAckHandle !== undefined) {
      timers.clearTimeout(connectAckHandle);
      connectAckHandle = undefined;
    }
  }

  /**
   * Arm (or RE-arm) the bounded `connect-port-ack` window — reached ONLY under the opt-in execution limit
   * (ADR-0049 D5; the caller gates it). A delivered pipe is the router's one chance to hear from the engine's
   * realm: a live engine acks it immediately, a corpse says nothing — but so does an engine whose event loop
   * is blocked by a long synchronous query, which is exactly why this is not a default-configuration signal.
   * Expiry is deliberately NOT a verdict either — it hands the question to {@link startProbe}, so a
   * live-but-busy engine answers a ping and keeps its registration while a dead one misses
   * `probeMissThreshold` pings and is retired through the same recovery path.
   *
   * ONE WINDOW PER ROUTER, NOT PER DELIVERED PIPE — the deliberate contract (maintainer ruling, review
   * 2026-07-27), which is why re-arming (an `engine-ready` fan-out to N tabs arms it N times, last wins) and
   * an identity-only ack are correct rather than sloppy:
   *   - The question this window asks is per-ENGINE — "is that realm processing its control port?" — not
   *     per-pipe, so ANY identity-matched `connect-port-ack` answers it and no per-delivery correlation id is
   *     carried.
   *   - Cross-delivery clearing is SOUND because every `connect-port` rides ONE ordered control port: an
   *     engine that acked delivery N is, at that instant, processing a queue that already contains delivery
   *     N+1 — the ack is evidence for the whole queued batch, not just its own message.
   *   - ACCEPTED RESIDUAL: the engine realm dying SILENTLY (no worker `error`, no MessagePort `close`) in the
   *     instants BETWEEN processing consecutive queued deliveries, on a platform without the `close` event,
   *     with the execution limit enabled — the later tab then rides a dead pipe with no armed window. That
   *     window is vanishingly narrow, the primary wedge (an ALREADY-dead engine being piped — no ack ever
   *     arrives, so this window expires and the probe loop retires it) is fully covered, and per-delivery
   *     correlation was judged not worth the machinery.
   */
  function armConnectAckWindow(armedFor: EngineIdentity): void {
    clearConnectAckWindow();
    connectAckHandle = timers.setTimeout(() => {
      connectAckHandle = undefined;
      // The engine went away or was superseded between arming and expiry — the question is already answered.
      if (currentIdentity === undefined || !engineIdentityEquals(currentIdentity, armedFor)) return;
      startProbe();
    }, connectAckTimeoutMs);
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

  /** Detach the engine control channel + probe/liveness state WITHOUT fanning any notice (announce/handoff/death). */
  function clearEngine(): void {
    resetProbe();
    clearConnectAckWindow();
    if (controlPort !== undefined) {
      if (controlListener !== undefined) controlPort.removeEventListener("message", controlListener);
      // Symmetric with the message listener: an announce replaces this port, so leaving its `close` listener
      // attached would leak one per announce AND let a superseded port's close speak for its successor.
      if (controlCloseListener !== undefined) {
        (controlPort as unknown as ClosableRouterPort).removeEventListener?.("close", controlCloseListener);
      }
    }
    controlPort = undefined;
    controlListener = undefined;
    controlCloseListener = undefined;
    teardownForwarded = undefined;
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

  /**
   * One tick of the probe loop (execution-limit paths only). A MISS is "a ping that was already posted went a
   * FULL `probeIntervalMs` unanswered" — counted at the START of the tick that finds it outstanding, never in
   * the same tick that posts it. So the first tick posts ping 1 and counts nothing, and the threshold-th ping
   * gets its own whole interval to be answered before the tick that condemns it. `control-ack` for
   * {@link pendingPingId} stops the loop through {@link resetProbe} at any point in between.
   */
  function scheduleProbe(): void {
    probeHandle = timers.setTimeout(() => {
      probeHandle = undefined;
      // The engine went away between ticks (handoff/verdict) — abandon the loop silently.
      if (currentIdentity === undefined || controlPort === undefined) {
        resetProbe();
        return;
      }
      if (pendingPingId !== undefined) {
        missCount += 1;
        if (missCount >= probeMissThreshold) {
          // Threshold pings, each unanswered for a full interval → ENGINE-LOSS VERDICT. No further ping is
          // posted (the router never terminates anything; the leader coordinator reacts to `engine-retiring`).
          resetProbe();
          retireCurrentEngine();
          return;
        }
      }
      const pingId = ++pingSeq;
      pendingPingId = pingId;
      controlPort.postMessage(envelope({ type: "control-ping", identity: currentIdentity, pingId }));
      scheduleProbe();
    }, probeIntervalMs);
  }

  /**
   * Start the probe loop. BOTH of its entry points — a tab-reported `overdue-dispatch` and the expiry of the
   * `connect-port-ack` window — exist only while the opt-in execution limit is enabled (ADR-0049 D5), so this
   * is unreachable on the default configuration. Idempotent while a loop is already running.
   */
  function startProbe(): void {
    if (probeRunning) return;
    probeRunning = true;
    missCount = 0;
    pendingPingId = undefined; // no ping is outstanding at the start of a loop — the first tick counts no miss
    scheduleProbe();
  }

  /**
   * The engine control port CLOSED. For the CURRENT engine that is DEATH: the control channel's far end lives in
   * the engine's realm, so its close means that realm is gone (the dedicated engine died with its spawning tab
   * while this SharedWorker survived it). Retire, so the coordinators recover and no new connection is ever piped
   * into the corpse. Two closes are NOT death and must stay silent: one for a port a later announce already
   * SUPERSEDED (identity/port checked, never assumed), and the engine's own close after the teardown handshake
   * this router forwarded — that retirement belongs to the coordinator that asked for it.
   */
  function onControlPortClose(port: RouterPort, announced: EngineIdentity): void {
    if (controlPort !== port) return; // superseded: a later announce owns the registration now
    if (currentIdentity === undefined || !engineIdentityEquals(currentIdentity, announced)) return;
    if (teardownForwarded !== undefined && engineIdentityEquals(teardownForwarded, announced)) {
      clearEngine();
      return;
    }
    retireCurrentEngine();
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
      case "connect-port-ack":
        // The engine's realm answered for the pipe it was just handed — the liveness question is settled until
        // the next delivery. Identity-gated: a stale generation's ack never speaks for the current engine. With
        // the execution limit disabled no window was ever armed, so this is simply a no-op.
        if (shouldApplyControlMessage(currentIdentity, message)) clearConnectAckWindow();
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
        // Remember it: the self-close that follows is the EXPECTED end of this handshake, not engine death, so
        // the close listener clears the registration silently instead of fanning a retirement notice.
        teardownForwarded = message.identity;
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
    // Engine-death detection, feature-detected exactly as `attachTab` does for a tab port: this end's far side
    // lives in the engine's realm, so its `close` is the platform telling us that realm is gone. This is the
    // load-bearing signal (MessagePort `close` is Baseline across current browsers). RESIDUAL: where the event
    // is UNSUPPORTED, the `connect-port-ack` window covers a silently-dead engine only if the opt-in execution
    // limit is enabled — with it disabled, silence is deliberately not read as death (ADR-0049 D5).
    const closable = port as unknown as ClosableRouterPort;
    if ("onclose" in closable) {
      const closeListener = () => onControlPortClose(port, minted);
      controlCloseListener = closeListener;
      closable.addEventListener("close", closeListener);
    }
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
