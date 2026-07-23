import { describe, expect, it } from "bun:test";

import { createAuthTransitionCoordinator } from "../../apps/board/src/auth/auth-transition";

describe("board auth transition coordinator", () => {
  it("does not let an older signed-out navigation clear a newer authenticated session", () => {
    const transition = createAuthTransitionCoordinator();
    const oldEpoch = transition.beginSignedOut();
    expect(oldEpoch).not.toBeNull();

    transition.acceptAuthenticated();

    expect(transition.completeSignedOut(oldEpoch!)).toBe(false);
    expect(transition.beginSignedOut()).not.toBeNull();
  });

  it("coalesces duplicate signed-out events and completes the current transition once", () => {
    const transition = createAuthTransitionCoordinator();
    const epoch = transition.beginSignedOut();

    expect(epoch).not.toBeNull();
    expect(transition.beginSignedOut()).toBeNull();
    expect(transition.completeSignedOut(epoch!)).toBe(true);
    expect(transition.completeSignedOut(epoch!)).toBe(false);
  });
});
