import { describe, expect, it } from "bun:test";
// ADR-0049 (capability-driven engine placement) step 5: the CONTROL-PLANE protocol types. This slice's
// unit test covers four PURE concerns of `engine-control.ts` (no IO, no workers):
//   A. ENGINE IDENTITY — the pair `(swInstanceId, generation)` (ADR D4, invariant 7; CONTEXT "Engine
//      identity"): equality, the staleness rule, and minting within / across SharedWorker instances.
//   B. The identity-tagged CONTROL-PLANE message union and `shouldApplyControlMessage`.
//   C. The opt-in EXECUTION LIMIT config (ADR D5, disabled by default) + the attach-time mismatch rule.
//   D. `EngineRelocatedError` (ADR D10, invariant 5; CONTEXT "Handoff window") — code + outcome, and the
//      `{ code, outcome }` wire form that travels in the existing bridge error `detail` field.

import {
  assertSameExecutionLimit,
  ENGINE_RELOCATED_CODE,
  EngineRelocatedError,
  engineIdentityEquals,
  engineRelocatedFromWire,
  engineRelocatedToWire,
  ExecutionLimitMismatchError,
  isStaleIdentity,
  mintEngineIdentity,
  shouldApplyControlMessage,
  type EngineControlMessage,
  type EngineIdentity,
  type EngineRelocatedOutcome,
  type ExecutionLimitConfig,
} from "../../packages/client/src/worker/engine-control";

// ─── A. Engine identity ────────────────────────────────────────────────────────

describe("engine identity — the pair (ADR D4, invariant 7)", () => {
  const A0: EngineIdentity = { swInstanceId: "sw-a", generation: 0 };
  const A1: EngineIdentity = { swInstanceId: "sw-a", generation: 1 };
  const B0: EngineIdentity = { swInstanceId: "sw-b", generation: 0 };

  it("equals compares BOTH fields across all four combinations", () => {
    // same pair
    expect(engineIdentityEquals(A0, { swInstanceId: "sw-a", generation: 0 })).toBe(true);
    // same instance, different generation
    expect(engineIdentityEquals(A0, A1)).toBe(false);
    // different instance, same generation (the bare counter would falsely match)
    expect(engineIdentityEquals(A0, B0)).toBe(false);
    // both differ
    expect(engineIdentityEquals(A0, { swInstanceId: "sw-b", generation: 1 })).toBe(false);
  });

  it("isStaleIdentity is the exact-pair negation of equals", () => {
    expect(isStaleIdentity(A0, { swInstanceId: "sw-a", generation: 0 })).toBe(false);
    expect(isStaleIdentity(A0, A1)).toBe(true);
    expect(isStaleIdentity(A0, B0)).toBe(true);
    expect(isStaleIdentity(A0, { swInstanceId: "sw-b", generation: 1 })).toBe(true);
  });

  it("mint from nothing → generation 0", () => {
    expect(mintEngineIdentity("sw-a")).toEqual({ swInstanceId: "sw-a", generation: 0 });
    expect(mintEngineIdentity("sw-a", undefined)).toEqual({ swInstanceId: "sw-a", generation: 0 });
  });

  it("mint from a SAME-instance previous → generation + 1", () => {
    expect(mintEngineIdentity("sw-a", A0)).toEqual({ swInstanceId: "sw-a", generation: 1 });
    expect(mintEngineIdentity("sw-a", A1)).toEqual({ swInstanceId: "sw-a", generation: 2 });
  });

  it("mint from a FOREIGN-instance previous → counter restarts at 0 under the new instance id", () => {
    // A re-announce arriving at a NEW SharedWorker instance: the generation counter is scoped to one
    // SharedWorker and resets with it (invariant 7 / CONTEXT "Engine identity").
    expect(mintEngineIdentity("sw-b", A1)).toEqual({ swInstanceId: "sw-b", generation: 0 });
    expect(mintEngineIdentity("sw-b", { swInstanceId: "sw-a", generation: 99 })).toEqual({
      swInstanceId: "sw-b",
      generation: 0,
    });
  });
});

// ─── B. Control-plane message union ────────────────────────────────────────────

describe("shouldApplyControlMessage — staleness gating (ADR D4)", () => {
  const current: EngineIdentity = { swInstanceId: "sw-a", generation: 2 };

  // One SAMPLE per union member — the loop below is the runtime exhaustiveness assertion (paired with the
  // compile-time never-guard inside `shouldApplyControlMessage`). `assign-identity` (ADR-0049 step 9) is
  // ALWAYS-APPLIES (SW→engine, the assignment itself) even though it carries an identity, so it sits with the
  // untagged members in the always-apply set rather than the staleness-gated `tagged` set.
  const untagged: EngineControlMessage[] = [
    { type: "leader-granted" },
    { type: "engine-announce" },
    { type: "assign-identity", identity: current },
  ];
  const tagged = (identity: EngineIdentity): EngineControlMessage[] => [
    { type: "engine-ready", identity },
    { type: "connect-port", identity },
    { type: "control-ping", identity, pingId: 7 },
    { type: "control-ack", identity, pingId: 7 },
    { type: "overdue-dispatch", identity, elapsedMs: 9000 },
    { type: "engine-retiring", identity },
    { type: "engine-teardown", identity },
  ];

  it("untagged members always apply — current set OR undefined", () => {
    for (const message of untagged) {
      expect(shouldApplyControlMessage(current, message)).toBe(true);
      expect(shouldApplyControlMessage(undefined, message)).toBe(true);
    }
  });

  it("assign-identity ALWAYS applies — even against a mismatched current identity (it IS the assignment)", () => {
    // The SW stamps the identity and hands it to the engine as `assign-identity`; because it is the
    // assignment itself, it applies unconditionally — never gated on the receiver's (possibly stale or
    // absent) current identity.
    const assign: EngineControlMessage = { type: "assign-identity", identity: current };
    expect(shouldApplyControlMessage(undefined, assign)).toBe(true);
    expect(shouldApplyControlMessage({ swInstanceId: "sw-b", generation: 99 }, assign)).toBe(true);
    expect(shouldApplyControlMessage({ swInstanceId: "sw-a", generation: 1 }, assign)).toBe(true);
  });

  it("tagged members apply only on an EXACT current-identity match", () => {
    for (const message of tagged(current)) {
      expect(shouldApplyControlMessage(current, message)).toBe(true);
    }
    // stale generation
    for (const message of tagged({ swInstanceId: "sw-a", generation: 1 })) {
      expect(shouldApplyControlMessage(current, message)).toBe(false);
    }
    // stale instance
    for (const message of tagged({ swInstanceId: "sw-b", generation: 2 })) {
      expect(shouldApplyControlMessage(current, message)).toBe(false);
    }
  });

  it("tagged members with NO current identity → never apply", () => {
    for (const message of tagged(current)) {
      expect(shouldApplyControlMessage(undefined, message)).toBe(false);
    }
  });

  it("covers EVERY union member (exhaustiveness)", () => {
    const all = [...untagged, ...tagged(current)];
    const seen = new Set(all.map((m) => m.type));
    // The full member set of EngineControlMessage["type"]; keep in lockstep with the union.
    expect(seen).toEqual(
      new Set([
        "leader-granted",
        "engine-announce",
        "assign-identity",
        "engine-ready",
        "connect-port",
        "control-ping",
        "control-ack",
        "overdue-dispatch",
        "engine-retiring",
        "engine-teardown",
      ]),
    );
  });
});

// ─── C. Execution limit (opt-in, ADR D5) ────────────────────────────────────────

describe("execution limit — disabled by default, same-across-tabs (ADR D5)", () => {
  it("undefined is the disabled default (unbounded queries preserved)", () => {
    const config: ExecutionLimitConfig = {};
    expect(config.maxDispatchMs).toBeUndefined();
  });

  it("same values pass — both disabled, or both the same number", () => {
    expect(() => assertSameExecutionLimit(undefined, undefined)).not.toThrow();
    expect(() => assertSameExecutionLimit(5000, 5000)).not.toThrow();
  });

  it("any mismatch throws ExecutionLimitMismatchError — including one side disabled", () => {
    expect(() => assertSameExecutionLimit(5000, undefined)).toThrow(ExecutionLimitMismatchError);
    expect(() => assertSameExecutionLimit(undefined, 5000)).toThrow(ExecutionLimitMismatchError);
    expect(() => assertSameExecutionLimit(5000, 6000)).toThrow(ExecutionLimitMismatchError);
  });

  it("the mismatch message is [pgxsinkit]-prefixed and names both values", () => {
    try {
      assertSameExecutionLimit(5000, 6000);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionLimitMismatchError);
      const message = (error as Error).message;
      expect(message).toContain("[pgxsinkit]");
      expect(message).toContain("5000");
      expect(message).toContain("6000");
    }
  });
});

// ─── D. EngineRelocatedError (ADR D10, invariant 5) ─────────────────────────────

describe("EngineRelocatedError — outcome-honest relocation (ADR D10)", () => {
  const outcomes: EngineRelocatedOutcome[] = ["not-dispatched", "unknown"];

  it("instances carry the stable code and their outcome", () => {
    for (const outcome of outcomes) {
      const error = new EngineRelocatedError(outcome);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(ENGINE_RELOCATED_CODE);
      expect(error.outcome).toBe(outcome);
      expect(error.name).toBe("EngineRelocatedError");
    }
  });

  it("toWire → fromWire round-trips both outcomes to an instanceof with the same outcome", () => {
    for (const outcome of outcomes) {
      const wire = engineRelocatedToWire(new EngineRelocatedError(outcome));
      expect(wire).toEqual({ code: ENGINE_RELOCATED_CODE, outcome });
      const rebuilt = engineRelocatedFromWire(wire);
      expect(rebuilt).toBeInstanceOf(EngineRelocatedError);
      expect(rebuilt?.outcome).toBe(outcome);
    }
  });

  it("fromWire returns undefined for anything that is not this exact wire shape", () => {
    expect(engineRelocatedFromWire(null)).toBeUndefined();
    expect(engineRelocatedFromWire(undefined)).toBeUndefined();
    expect(engineRelocatedFromWire({})).toBeUndefined();
    expect(engineRelocatedFromWire({ code: "other", outcome: "unknown" })).toBeUndefined();
    expect(engineRelocatedFromWire({ code: ENGINE_RELOCATED_CODE, outcome: "bogus" })).toBeUndefined();
    expect(engineRelocatedFromWire({ code: ENGINE_RELOCATED_CODE })).toBeUndefined();
    expect(engineRelocatedFromWire("engine-relocated")).toBeUndefined();
  });

  it('the "unknown" message names inspect/reconcile and forbids auto-retry', () => {
    const message = new EngineRelocatedError("unknown").message;
    expect(message).toContain("[pgxsinkit]");
    expect(message.toLowerCase()).toContain("inspect");
    expect(message.toLowerCase()).toContain("reconcile");
    expect(message.toLowerCase()).toContain("never auto-retry");
  });

  it('the "not-dispatched" message states it is safe to retry', () => {
    const message = new EngineRelocatedError("not-dispatched").message;
    expect(message).toContain("[pgxsinkit]");
    expect(message.toLowerCase()).toContain("safe to retry");
  });
});
