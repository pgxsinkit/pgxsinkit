// The control-plane protocol (ADR-0049 step 5). This module defines the PURE types + rules the router
// (communication centre), the elected engine worker, and the attach client all share for engine placement
// and relocation. It is deliberately IO-FREE and worker-FREE — no `postMessage`, no MessagePort handling,
// no timers — so the whole control plane is unit-testable with no worker at all (the same discipline the
// bridge `protocol.ts` follows). Later steps wire these types into `protocol.ts`, the router, the attach
// client, and the engine entry; this file only owns the vocabulary.
//
// Bounded-context terms (CONTEXT.md § "Language — engine placement") are used exactly: engine identity,
// handoff window, engine home, communication centre, elected engine worker.

// ─── A. Engine identity (ADR D4, invariant 7; CONTEXT "Engine identity") ─────────

/** Namespaced wire key shared by every placement control-plane participant. */
export const ENGINE_CONTROL_ENVELOPE_KEY = "pgx0049" as const;

/** Wrap a control message in the namespaced envelope used beside the bridge protocol. */
export function wrapControlEnvelope(message: EngineControlMessage): {
  [ENGINE_CONTROL_ENVELOPE_KEY]: EngineControlMessage;
} {
  return { [ENGINE_CONTROL_ENVELOPE_KEY]: message };
}

/** Read a control message from its namespaced envelope, ignoring unrelated bridge traffic. */
export function readControlEnvelope(data: unknown): EngineControlMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = (data as { [ENGINE_CONTROL_ENVELOPE_KEY]?: unknown })[ENGINE_CONTROL_ENVELOPE_KEY];
  if (typeof message !== "object" || message === null) return undefined;
  if (typeof (message as { type?: unknown }).type !== "string") return undefined;
  return message as EngineControlMessage;
}

/**
 * The PAIR naming one announced engine: the SharedWorker instance that stamped it plus a generation
 * counter that is monotonic ONLY within that one SharedWorker instance (it resets with the SharedWorker).
 * Authority and staleness checks always compare the pair — never the bare counter — because two different
 * SharedWorker instances can each hold a generation `0`.
 */
export interface EngineIdentity {
  /** Opaque id of the SharedWorker instance that minted this identity. Scopes {@link generation}. */
  swInstanceId: string;
  /** Monotonic counter WITHIN one `swInstanceId`; resets to 0 under a new SharedWorker instance. */
  generation: number;
}

/** Two identities are equal only when BOTH fields match (the pair, never the bare counter). */
export function engineIdentityEquals(a: EngineIdentity, b: EngineIdentity): boolean {
  return a.swInstanceId === b.swInstanceId && a.generation === b.generation;
}

/**
 * Staleness rule (invariant 7): a tagged message is applied ONLY when its identity equals the CURRENT
 * identity exactly — the pair, never the bare counter (it resets with the SharedWorker). So a message is
 * STALE precisely when it is not `engineIdentityEquals` the current identity.
 */
export function isStaleIdentity(current: EngineIdentity, tagged: EngineIdentity): boolean {
  return !engineIdentityEquals(current, tagged);
}

/**
 * Mint the next identity that THIS SharedWorker instance (`swInstanceId`) should announce.
 *
 * - No `previous` → generation `0` (the first engine this SharedWorker announces).
 * - `previous` belongs to the SAME `swInstanceId` → `previous.generation + 1` (a succession within one
 *   SharedWorker: a fresh elected engine worker replacing the last).
 * - `previous` belongs to a DIFFERENT `swInstanceId` (a re-announce arriving at a NEW SharedWorker
 *   instance, after SharedWorker death recovery) → the counter RESTARTS at `0` under the new instance id.
 *   The generation is scoped to one SharedWorker instance, so it cannot carry across instances.
 */
export function mintEngineIdentity(swInstanceId: string, previous?: EngineIdentity): EngineIdentity {
  const sameInstance = previous !== undefined && previous.swInstanceId === swInstanceId;
  return { swInstanceId, generation: sameInstance ? previous.generation + 1 : 0 };
}

// ─── B. Control-plane message union (ADR D4; plan "Protocol changes") ────────────

/**
 * The identity-tagged control plane the communication centre, the elected engine worker, and the tab
 * coordinators exchange (distinct from the data-path bridge in `protocol.ts`; the SharedWorker never sees
 * RPC payloads). Payload interfaces mirror `protocol.ts` conventions: a discriminating `type`, typed
 * fields only, and MessagePorts travelling as transferables OUTSIDE the JSON body (see individual members).
 * Identity-tagged members carry the {@link EngineIdentity} they belong to so a stale one is discarded.
 */
export type EngineControlMessage =
  // ── untagged (no identity exists yet, or the SharedWorker stamps it) ──
  /**
   * SharedWorker → tab (the lock holder): the leader lock was granted; SPAWN the engine. Pre-spawn, so no
   * identity exists yet — it OPENS the handoff window on the attach side (a relocation notice, CONTEXT
   * "Handoff window"). Untagged: there is no engine identity to compare against before the engine exists.
   */
  | { type: "leader-granted" }
  /**
   * tab → SharedWorker: the freshly spawned engine's MessagePort is announced so the SharedWorker can
   * stamp it with a minted {@link EngineIdentity}. The announce ITSELF carries no identity (the SharedWorker
   * mints it on receipt). The engine's control MessagePort travels as a TRANSFERABLE outside this JSON body
   * (the same way `protocol.ts` transfers ports — never a serialized field), so nothing is typed here.
   */
  | { type: "engine-announce" }
  /**
   * tab → SharedWorker (ADR-0049 D8): this tab is detaching — UNREGISTER it from the router so `tabCount`
   * (the destroy peer-refusal input) falls. The platform fires no SharedWorker port-close event and the tab's
   * `detach` bridge envelope rides the per-tab PIPE (which the router never sees), so this control-plane signal
   * on the SW port is the only channel the router observes. Untagged + always-applied: it names no engine (it
   * concerns the tab's own registration), and a detaching tab must be dropped regardless of the current engine
   * generation. The router stays payload-blind — this is a `pgx0049` control message, never a bridge envelope.
   */
  | { type: "tab-detach" }
  /**
   * elected engine → SharedWorker (ADR-0049 D1, capability-absence fallback): the elected dedicated engine's
   * OWN-scope OPFS probe was DENIED (or the OPFS API is absent/throwing in the dedicated home too), so no home on
   * this platform can hold sync-access handles. The engine reports that here so the router-only SharedWorker
   * abandons election and boots the in-scope IDBFS engine instead (with the registry-declared durability) — the
   * declared-idbfs shape reached by capability detection rather than declaration. Untagged: it names no engine
   * (the engine never became authoritative — it is reporting that it cannot host), and the SharedWorker must act
   * on it regardless of the current generation. `reason` is the verbatim probe attribution stamped into the
   * fallback boot's `storageFallbackReason` (decision 12).
   */
  | { type: "engine-fallback"; reason: string }
  /**
   * SharedWorker → engine (ADR-0049 step 9): the identity the router just minted for this engine, handed to
   * the elected engine worker's control plane RIGHT AFTER the router stamps the `engine-announce` (before any
   * `connect-port`). Although it carries an {@link EngineIdentity}, it is ALWAYS-APPLIED — it is the ASSIGNMENT
   * itself, so it is never gated on the receiver's (still-absent or stale) current identity; every subsequent
   * tagged message the engine receives is compared against THIS assigned identity. The engine remembers it and
   * replies `engine-ready` (control-plane readiness, NOT engine boot — the engine still boots lazily on first
   * attach). Sits with the untagged members in {@link shouldApplyControlMessage}'s always-apply set.
   */
  | { type: "assign-identity"; identity: EngineIdentity }
  // ── identity-tagged ──
  /** SharedWorker → tab: the announced engine is live under this identity (the stamp fan-out). */
  | { type: "engine-ready"; identity: EngineIdentity }
  /**
   * SharedWorker → engine: accept a per-tab proxy pipe. The tab-end MessagePort is transferred ALONGSIDE
   * this message (outside the JSON body, as a transferable), fed into `SyncWorkerHost.connect` (ADR D4).
   */
  | { type: "connect-port"; identity: EngineIdentity }
  /**
   * A liveness probe request. Used BOTH as a tab↔SharedWorker keepalive (the leader keepalive) AND as a
   * SharedWorker↔engine control-channel probe (the execution-limit path). `pingId` correlates the ack.
   */
  | { type: "control-ping"; identity: EngineIdentity; pingId: number }
  /**
   * The answer to a {@link EngineControlMessage} `control-ping`; `pingId` echoes the request. ONE reserved
   * value: `pingId: -1` is the TEARDOWN ack by convention (ADR-0049 step 9) — the engine emits it in reply to
   * an `engine-teardown` (not to any real ping), the router RELAYS it to every tab, and the coordinator's
   * teardown wait settles on it. A `-1` therefore never correlates a probe ping (those start at 1).
   */
  | {
      type: "control-ack";
      identity: EngineIdentity;
      pingId: number;
      /** Present only when the reserved teardown acknowledgement reports that host close failed. Mirrors `protocol.ts`'s `BridgeErrorWire` (this module deliberately imports nothing from the bridge). */
      error?: { message: string; name?: string; detail?: unknown };
    }
  /**
   * tab → SharedWorker: an execution-limit report — a dispatch has been outstanding `elapsedMs` past the
   * configured limit (ADR D5). The SharedWorker then probes the engine's control channel; it is NOT itself
   * a death verdict (the limit CONVERTS slow to terminated only after the probe threshold).
   */
  | { type: "overdue-dispatch"; identity: EngineIdentity; elapsedMs: number }
  /**
   * The retirement notice that PRECEDES every DELIBERATE termination — last-claim teardown, BFCache exit,
   * and execution-limit termination all send it first (ADR D5), so the attach side opens the handoff window
   * and queues new calls instead of racing a dying engine.
   */
  | { type: "engine-retiring"; identity: EngineIdentity }
  /** The teardown handshake after a retirement notice; ack/timeout settles the lock callback. */
  | { type: "engine-teardown"; identity: EngineIdentity };

/** Discriminants that carry an {@link EngineIdentity} and are therefore staleness-gated. `assign-identity`
    carries one but is the ASSIGNMENT itself (always-applied), so it is excluded here alongside the untagged. */
type TaggedControlType = Exclude<
  EngineControlMessage,
  { type: "leader-granted" | "engine-announce" | "assign-identity" | "tab-detach" | "engine-fallback" }
>["type"];

const TAGGED_CONTROL_TYPES: ReadonlySet<TaggedControlType> = new Set<TaggedControlType>([
  "engine-ready",
  "connect-port",
  "control-ping",
  "control-ack",
  "overdue-dispatch",
  "engine-retiring",
  "engine-teardown",
]);

/**
 * Whether a received control message should be APPLIED given the receiver's current engine identity.
 *
 * - ALWAYS-APPLY members (`leader-granted`, `engine-announce`, `assign-identity`, `tab-detach`, `engine-fallback`)
 *   always apply — `leader-granted`/`engine-announce`/`tab-detach`/`engine-fallback` carry no identity to compare
 *   (they precede any engine, mint an identity, concern the tab's own registration, or report that no engine can
 *   host), and `assign-identity` IS the assignment, so it applies unconditionally.
 * - IDENTITY-TAGGED members apply only when `current` is set AND the identities match exactly (the pair,
 *   invariant 7). A tagged message with no current identity, or a stale identity, is discarded.
 *
 * The switch is exhaustive with a `never`-guard: a new union member fails to type-check until it is
 * classified here (the runtime exhaustiveness test pairs with this compile-time guard).
 */
export function shouldApplyControlMessage(current: EngineIdentity | undefined, message: EngineControlMessage): boolean {
  switch (message.type) {
    case "leader-granted":
    case "engine-announce":
    case "assign-identity":
    case "tab-detach":
    case "engine-fallback":
      return true;
    case "engine-ready":
    case "connect-port":
    case "control-ping":
    case "control-ack":
    case "overdue-dispatch":
    case "engine-retiring":
    case "engine-teardown":
      return current !== undefined && engineIdentityEquals(current, message.identity);
    default: {
      const unreachable: never = message;
      throw new Error(`[pgxsinkit] unclassified engine-control message: ${String(unreachable)}`);
    }
  }
}

/** Runtime companion to {@link shouldApplyControlMessage}'s compile-time guard: is this type staleness-gated? */
export function isTaggedControlType(type: EngineControlMessage["type"]): type is TaggedControlType {
  return TAGGED_CONTROL_TYPES.has(type as TaggedControlType);
}

// ─── C. Execution limit (ADR D5 — opt-in, elected-placement-only) ────────────────

/**
 * The opt-in execution limit (ADR D5). ONE engine-construction value; DISABLED BY DEFAULT — no finite
 * worst-case query duration exists, and the limit CONVERTS slow to terminated by policy, so enabling it
 * must be a deliberate consumer choice (the public contract). When enabled, the limit
 * CONVERTS slow to terminated after the control-probe threshold — it is NEVER claimed as death evidence.
 * This feature is ELECTED-PLACEMENT ONLY: on SharedWorker-direct placement (WebKit) the option is rejected
 * as unsupported — that rejection is wired in a later step; this module only defines the config + the
 * cross-tab mismatch rule.
 */
export interface ExecutionLimitConfig {
  /** ms; `undefined` = DISABLED (the default — preserves unbounded queries). */
  maxDispatchMs?: number;
}

/**
 * Thrown at attach when a tab's execution-limit value disagrees with the engine's construction value
 * (ADR D5): every tab must carry the SAME config. Named + `[pgxsinkit]`-prefixed like the repo's other
 * protocol errors so a consumer can `instanceof`-branch it.
 */
export class ExecutionLimitMismatchError extends Error {
  readonly engineValue: number | undefined;
  readonly attachValue: number | undefined;

  constructor(engineValue: number | undefined, attachValue: number | undefined) {
    super(
      `[pgxsinkit] execution-limit mismatch: this tab attaches with ${describeLimit(attachValue)} but the ` +
        `running engine was constructed with ${describeLimit(engineValue)} (ADR-0049 D5). The execution ` +
        "limit is ONE engine-construction value; every tab attaching to a store must carry the same value " +
        "(including both disabled). Align the tabs' configuration.",
    );
    this.name = "ExecutionLimitMismatchError";
    this.engineValue = engineValue;
    this.attachValue = attachValue;
  }
}

const EXECUTION_LIMIT_MISMATCH_CODE = "execution-limit-mismatch";

export function executionLimitMismatchToWire(error: ExecutionLimitMismatchError): {
  code: typeof EXECUTION_LIMIT_MISMATCH_CODE;
  engineValue?: number;
  attachValue?: number;
} {
  return {
    code: EXECUTION_LIMIT_MISMATCH_CODE,
    ...(error.engineValue !== undefined ? { engineValue: error.engineValue } : {}),
    ...(error.attachValue !== undefined ? { attachValue: error.attachValue } : {}),
  };
}

export function executionLimitMismatchFromWire(detail: unknown): ExecutionLimitMismatchError | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const candidate = detail as { code?: unknown; engineValue?: unknown; attachValue?: unknown };
  if (candidate.code !== EXECUTION_LIMIT_MISMATCH_CODE) return undefined;
  const engineValue = typeof candidate.engineValue === "number" ? candidate.engineValue : undefined;
  const attachValue = typeof candidate.attachValue === "number" ? candidate.attachValue : undefined;
  return new ExecutionLimitMismatchError(engineValue, attachValue);
}

function describeLimit(value: number | undefined): string {
  return value === undefined ? "the limit DISABLED (undefined)" : `maxDispatchMs=${value}`;
}

/**
 * Attach-time guard (ADR D5): every tab must carry the SAME execution-limit value as the running engine.
 * Any mismatch — including one side disabled (`undefined`) and the other set — throws
 * {@link ExecutionLimitMismatchError}. Equal values (both `undefined`, or the same number) pass.
 */
export function assertSameExecutionLimit(engineValue: number | undefined, attachValue: number | undefined): void {
  if (engineValue !== attachValue) {
    throw new ExecutionLimitMismatchError(engineValue, attachValue);
  }
}

// ─── D. EngineRelocatedError (ADR D10, invariant 5; CONTEXT "Handoff window") ─────

/**
 * The two honest relocation outcomes (ADR D10, invariant 5). There is deliberately NO blanket "retryable":
 * - `"not-dispatched"` — the call NEVER reached the engine (a queued call failed on the handoff queue's
 *   cap/deadline, or was never sent). SAFE TO RETRY.
 * - `"unknown"` — a DISPATCHED mutation whose response was lost to relocation. Its journal update MAY
 *   already exist and there is NO mutation-dedup key, so it must be inspected/reconciled, NEVER auto-retried.
 *
 * A dispatched READ that lost its response is NOT a third outcome: repeating a read is safe, so that is the
 * CALLER'S policy (repeat the read), not a distinct wire value.
 */
export type EngineRelocatedOutcome = "not-dispatched" | "unknown";

/** The stable clone-safe discriminator carried on the wire (ADR D10). Consumers branch on this, never prose. */
export const ENGINE_RELOCATED_CODE = "engine-relocated";

/**
 * The clone-safe wire form of a relocation failure (ADR D10). It travels inside the EXISTING bridge error
 * `detail` field — the `{ message, detail }` error shape in `protocol.ts` (~line 330, e.g.
 * `RpcResultPayload.error`) — so no new protocol field is needed. The attach side (step 7) calls
 * {@link engineRelocatedFromWire} on every bridge error `detail` to reconstruct the typed error.
 */
export interface EngineRelocatedWire {
  code: typeof ENGINE_RELOCATED_CODE;
  outcome: EngineRelocatedOutcome;
}

/**
 * The exported, consumer-visible relocation error (ADR D10, invariant 5). Consumers branch on `code` +
 * `outcome`, never on message prose — but the message NAMES the semantics so a developer hitting it in a
 * log understands immediately. `[pgxsinkit]`-prefixed like the repo's other errors.
 */
export class EngineRelocatedError extends Error {
  readonly code = ENGINE_RELOCATED_CODE;
  readonly outcome: EngineRelocatedOutcome;

  constructor(outcome: EngineRelocatedOutcome) {
    super(relocatedMessage(outcome));
    this.name = "EngineRelocatedError";
    this.outcome = outcome;
  }
}

function relocatedMessage(outcome: EngineRelocatedOutcome): string {
  if (outcome === "not-dispatched") {
    return (
      "[pgxsinkit] the call was not dispatched to the engine before it relocated (ADR-0049 D10). It never " +
      "reached the engine, so it is SAFE TO RETRY."
    );
  }
  return (
    "[pgxsinkit] a dispatched mutation's response was lost when the engine relocated (ADR-0049 D10, " +
    "outcome UNKNOWN). Its journal update may ALREADY exist and there is no mutation-dedup key, so " +
    "INSPECT/RECONCILE the store — NEVER auto-retry. (A dispatched READ, by contrast, is safe for the " +
    "caller to repeat.)"
  );
}

/** Encode a {@link EngineRelocatedError} to its clone-safe wire form for the bridge error `detail` field. */
export function engineRelocatedToWire(error: EngineRelocatedError): EngineRelocatedWire {
  return { code: ENGINE_RELOCATED_CODE, outcome: error.outcome };
}

/**
 * Reconstruct a typed {@link EngineRelocatedError} from a bridge error's `detail` (step 7 calls this on
 * every bridge error detail). STRICT shape check: returns `undefined` for anything that is not exactly the
 * `{ code: "engine-relocated", outcome }` wire form (a foreign/absent detail, a wrong code, a bogus or
 * missing outcome, a non-object) — so a non-relocation error is never misclassified.
 */
export function engineRelocatedFromWire(detail: unknown): EngineRelocatedError | undefined {
  if (typeof detail !== "object" || detail === null) return undefined;
  const candidate = detail as { code?: unknown; outcome?: unknown };
  if (candidate.code !== ENGINE_RELOCATED_CODE) return undefined;
  if (candidate.outcome !== "not-dispatched" && candidate.outcome !== "unknown") return undefined;
  return new EngineRelocatedError(candidate.outcome);
}
