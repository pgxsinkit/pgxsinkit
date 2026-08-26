import { describe, expect, it } from "bun:test";

import { createTokenRecovery, readShapeStream, STREAM_START } from "@pgxsinkit/client";
import type { StreamEnvelope } from "@pgxsinkit/contracts";

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

// The end of a read is reported off the batch that ends it, never off the transport's `closed`.
// `@durable-streams/client` settles `closed` when its fetch loop is done — for a `live: false` read
// whose first response is already up-to-date that is inside `stream()`, before any subscriber has
// consumed the queued response. A caller closing on `onEnd` then aborted the subscriber loop with the
// batch undelivered, and a populated stream read as empty (found by emergent's first native-path
// integration run, 2026-08-26: every `materializeShape` returned `[]`).
describe("readShapeStream end ordering", () => {
  const envelope: StreamEnvelope = {
    type: "public.widgets",
    key: "w1",
    headers: { operation: "upsert" },
    value: { id: "w1" },
  };

  function upToDateResponse(envelopes: StreamEnvelope[]): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(envelopes), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "Stream-Next-Offset": "0000000000000000_0000000000000042",
          "Stream-Up-To-Date": "true",
        },
      })) as unknown as typeof fetch;
  }

  async function readToEnd(fetchStub: typeof fetch, closeOnBatch: boolean): Promise<string[]> {
    const events: string[] = [];
    const ended = Promise.withResolvers<void>();
    const subscription = await readShapeStream(
      {
        url: "http://edge.test/stream/shape/s1",
        offset: STREAM_START,
        token: () => "t",
        live: false,
        fetch: fetchStub,
      },
      (batch) => {
        events.push(`batch:${batch.envelopes.length}:${batch.upToDate}`);
        if (closeOnBatch) {
          subscription.close();
          ended.resolve();
        }
      },
      (error) => {
        events.push(error ? `error:${error.message}` : "end");
        ended.resolve();
      },
    );
    await ended.promise;
    // Anything that would still fire late shows up here rather than after the assertion.
    await new Promise((resolve) => setTimeout(resolve, 20));
    subscription.close();
    return events;
  }

  it("delivers a non-live read's final batch BEFORE reporting the end", async () => {
    expect(await readToEnd(upToDateResponse([envelope]), false)).toEqual(["batch:1:true", "end"]);
  });

  it("an empty non-live stream still delivers its (empty) up-to-date batch, then ends", async () => {
    expect(await readToEnd(upToDateResponse([]), false)).toEqual(["batch:0:true", "end"]);
  });

  // The harness pattern: resolve on the up-to-date batch and close. Our own close is not an end.
  it("a caller that closes on the final batch is handed the batch and hears no end", async () => {
    expect(await readToEnd(upToDateResponse([envelope]), true)).toEqual(["batch:1:true"]);
  });
});
