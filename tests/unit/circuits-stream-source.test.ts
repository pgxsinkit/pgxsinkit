import { describe, expect, it } from "bun:test";

import { createTokenRecovery } from "@pgxsinkit/client";

// The token-recovery handler (ADR-0055 decisions 6 + 10). This is the one piece of the read
// transport with real logic, and it sits on a sharp edge in `@durable-streams/client`: its onError
// retry loop re-enters immediately with no backoff of its own, while its backoff wrapper refuses to
// back off any 4xx except 429. So a handler that always says "retry" turns a rejected token into a
// hot spin — these pin the single-shot behaviour that stops it.

function authError(status: number): Error & { status?: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe("token recovery", () => {
  it("re-mints once on a rejected token", async () => {
    const recover = createTokenRecovery(() => "fresh-token");
    expect(await recover(authError(403))).toEqual({
      headers: { authorization: "Bearer fresh-token" },
    });
  });

  // The second consecutive rejection IS the answer: the token was refreshed and still refused, so
  // this is a revocation. Retrying again would spin.
  it("gives up when the fresh token is rejected too", async () => {
    let minted = 0;
    const recover = createTokenRecovery(() => `token-${++minted}`);

    expect(await recover(authError(403))).toBeDefined();
    expect(await recover(authError(403))).toBeUndefined();
    expect(minted).toBe(1);
  });

  it("gives up when the caller declines to re-mint", async () => {
    const recover = createTokenRecovery(() => null);
    expect(await recover(authError(403))).toBeUndefined();
  });

  // Anything that is not an auth rejection is not ours to recover; propagating lets the transport's
  // own backoff handle a 503 and lets a 404 surface as the must-refetch it is.
  it("propagates errors that are not token rejections", async () => {
    let called = 0;
    const recover = createTokenRecovery(() => {
      called += 1;
      return "unused";
    });

    expect(await recover(authError(503))).toBeUndefined();
    expect(await recover(authError(404))).toBeUndefined();
    expect(await recover(new Error("network down"))).toBeUndefined();
    expect(called).toBe(0);
  });
});
