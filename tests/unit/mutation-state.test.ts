import { describe, expect, it } from "bun:test";

import {
  assertValidMutationTransition,
  isValidMutationTransition,
  MUTATION_TRANSITIONS,
} from "../../packages/client/src/mutation-state";

// The one named definition of the mutation-journal transitions (ADR-0005).

describe("mutation state machine (ADR-0005)", () => {
  it("allows the journal lifecycle transitions", () => {
    expect(isValidMutationTransition("pending", "sending")).toBe(true);
    expect(isValidMutationTransition("sending", "acked")).toBe(true);
    expect(isValidMutationTransition("sending", "failed")).toBe(true);
    expect(isValidMutationTransition("sending", "pending")).toBe(true); // recoverSending
    expect(isValidMutationTransition("failed", "pending")).toBe(true); // retryFailed
  });

  it("rejects illegal transitions", () => {
    expect(isValidMutationTransition("pending", "acked")).toBe(false);
    expect(isValidMutationTransition("acked", "pending")).toBe(false);
    expect(isValidMutationTransition("failed", "acked")).toBe(false);
    expect(() => assertValidMutationTransition("acked", "sending")).toThrow(/Illegal mutation-journal transition/);
  });

  it("treats acked as terminal at the journal level (cleared by reconcile, not a transition)", () => {
    expect(MUTATION_TRANSITIONS.acked).toEqual([]);
  });
});
