/* oxlint-disable typescript/await-thenable -- bun-types gap: .resolves/.rejects matchers return real promises typed as void */
import { describe, expect, it } from "bun:test";

import { createTokenRecovery, readShapeStream, STREAM_START, type StreamBatch } from "@pgxsinkit/client";
import type { StreamEnvelope } from "@pgxsinkit/contracts";

import { readShapeStreamWith, type StreamSourceOptions } from "../../packages/client/src/circuits/stream-source";

// pgxsinkit's own long-poll reader (ADR-0065 decision 6). Everything here runs against a scripted edge
// passed through `options.fetch`, and the backoff's wait and jitter are injected, so no test touches a
// timer: a retry schedule is asserted as the list of delays the reader asked to wait.

// The token-recovery policy (ADR-0055 decisions 6 + 10): one re-mint per rejection, and the second
// consecutive rejection is the answer. The reader applies it to every request; these pin the policy on
// its own, since a handler that always says "retry" turns a revoked token into a hot spin.

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

// ─── The scripted edge ───────────────────────────────────────────────────────────────────────────────

const STREAM_URL = "http://edge.test/stream/shape/s1";

const envelope = (key: string): StreamEnvelope => ({
  type: "public.widgets",
  key,
  headers: { operation: "upsert" },
  value: { id: key },
});

interface SeenRequest {
  url: URL;
  authorization: string | null;
  signal: AbortSignal | null;
}

type Answer = (request: SeenRequest) => Response | Promise<Response>;

interface Position {
  offset: string;
  upToDate?: boolean;
  cursor?: string;
  closed?: boolean;
}

function positionHeaders(position: Position): Record<string, string> {
  return {
    "Stream-Next-Offset": position.offset,
    ...(position.upToDate ? { "Stream-Up-To-Date": "true" } : {}),
    ...(position.cursor ? { "Stream-Cursor": position.cursor } : {}),
    ...(position.closed ? { "Stream-Closed": "true" } : {}),
  };
}

/** A 200 carrying envelopes, as durable-streams answers a JSON stream (PROTOCOL.md §9.1.5). */
const data =
  (envelopes: StreamEnvelope[], position: Position): Answer =>
  () =>
    new Response(JSON.stringify(envelopes), {
      status: 200,
      headers: { "content-type": "application/json", ...positionHeaders(position) },
    });

/** A long-poll that timed out with nothing new: 204, up to date (PROTOCOL.md §5.7). */
const timedOut =
  (position: Position): Answer =>
  () =>
    new Response(null, { status: 204, headers: positionHeaders({ upToDate: true, ...position }) });

const status =
  (code: number, headers: Record<string, string> = {}): Answer =>
  () =>
    new Response(JSON.stringify({ error: `status ${code}` }), { status: code, headers });

const networkFailure: Answer = () => {
  throw new TypeError("fetch failed");
};

/**
 * A durable-streams edge that answers from a script. Each request takes the next answer; a request with
 * none left HANGS — a long poll with nothing to say — until the reader aborts it, as a real one would.
 */
function scriptedEdge(answers: Answer[]) {
  const requests: SeenRequest[] = [];
  const arrivals: { count: number; resolve: () => void }[] = [];

  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: SeenRequest = {
      url: new URL(input instanceof Request ? input.url : input),
      authorization: new Headers(init?.headers).get("authorization"),
      signal: init?.signal ?? null,
    };
    requests.push(request);
    for (const arrival of arrivals) if (requests.length >= arrival.count) arrival.resolve();

    const answer = answers.shift();
    if (answer) return answer(request);
    return new Promise<Response>((_, reject) => {
      request.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    });
  }) as typeof fetch;

  return {
    fetch: fetchStub,
    requests,
    /** Resolves once the edge has seen `count` requests. */
    requested(count: number): Promise<void> {
      const arrival = Promise.withResolvers<void>();
      if (requests.length >= count) arrival.resolve();
      else arrivals.push({ count, resolve: arrival.resolve });
      return arrival.promise;
    },
    /** The query string of each request, as `key=value` pairs in the order they were sent. */
    queries(): string[][] {
      return requests.map((request) => [...request.url.searchParams].map(([key, value]) => `${key}=${value}`));
    },
  };
}

/**
 * Every pending microtask, settled: one macrotask turn. The reader touches no timer and no I/O between a
 * delivery and its end decision (the scripted edge answers synchronously), so after a drain anything it
 * was going to do next has either happened or is parked on a request — which is what "nothing more" means.
 */
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface ReadOptions extends Partial<StreamSourceOptions> {
  onBatch?: (batch: StreamBatch) => void | Promise<void>;
  /** The jitter source; 1 makes every delay its ceiling, so the schedule reads straight off. */
  random?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Open a read against a scripted edge and record everything it reports. */
function read(edge: ReturnType<typeof scriptedEdge>, options: ReadOptions = {}) {
  const { onBatch, random, wait, ...sourceOptions } = options;
  const events: string[] = [];
  const batches: StreamBatch[] = [];
  const waits: number[] = [];
  const ended = Promise.withResolvers<Error | null>();

  const opened = readShapeStreamWith(
    {
      random: random ?? (() => 1),
      wait:
        wait ??
        (async (ms) => {
          waits.push(ms);
        }),
    },
    { url: STREAM_URL, token: () => "t", fetch: edge.fetch, ...sourceOptions },
    (batch) => {
      batches.push(batch);
      events.push(`batch:${batch.offset}`);
      return onBatch?.(batch);
    },
    (error) => {
      events.push(error ? `error:${(error as Error & { status?: number }).status ?? error.message}` : "end");
      ended.resolve(error);
    },
  );

  return { opened, events, batches, waits, ended: ended.promise };
}

// ─── 1. Opening ──────────────────────────────────────────────────────────────────────────────────────

describe("readShapeStream opening", () => {
  it("resolves only once the first response has arrived", async () => {
    const first = Promise.withResolvers<Response>();
    const edge = scriptedEdge([() => first.promise]);
    const { opened } = read(edge);

    let resolved = false;
    void opened.then(() => {
      resolved = true;
    });
    await edge.requested(1);
    await drain();
    expect(resolved).toBe(false);

    first.resolve(await data([envelope("w1")], { offset: "A", upToDate: true })(edge.requests[0]!));
    (await opened).close();
    expect(resolved).toBe(true);
  });

  // The whole point of resolving on the first response: an auth failure at open rejects the call the
  // caller is awaiting, instead of dying on a loop nobody is watching.
  it("an immediate auth failure rejects the call, and no end is reported", async () => {
    const edge = scriptedEdge([status(403)]);
    const { opened, events } = read(edge);

    await expect(opened).rejects.toMatchObject({ status: 403 });
    await drain();
    expect(edge.requests).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("a caller that closes inside its first onBatch already holds its subscription", async () => {
    const edge = scriptedEdge([data([envelope("w1")], { offset: "A", upToDate: true })]);
    const events: string[] = [];

    const subscription = await readShapeStream(
      { url: STREAM_URL, token: () => "t", fetch: edge.fetch },
      (batch) => {
        events.push(`batch:${batch.offset}`);
        subscription.close();
      },
      (error) => events.push(error ? `error:${error.message}` : "end"),
    );
    await edge.requested(1);
    await drain();

    expect(events).toEqual(["batch:A"]);
    expect(edge.requests).toHaveLength(1);
  });

  it("an already-aborted signal rejects the call", async () => {
    const controller = new AbortController();
    controller.abort();
    const edge = scriptedEdge([]);

    await expect(read(edge, { signal: controller.signal }).opened).rejects.toThrow(/aborted/);
    await drain();
    expect(edge.requests).toHaveLength(0);
  });
});

// ─── 2. The token, re-resolved per request ───────────────────────────────────────────────────────────

describe("readShapeStream token", () => {
  // A live read outlives its token by design (ADR-0055: five-minute tokens, hours-long reads), so a
  // token captured at open would 403 the stream at the first TTL boundary.
  it("is resolved afresh for every request, retries included", async () => {
    const edge = scriptedEdge([
      status(503),
      data([envelope("w1")], { offset: "A" }),
      data([envelope("w2")], { offset: "B", upToDate: true }),
    ]);
    let minted = 0;
    const { opened, ended } = read(edge, { live: false, token: async () => `t${++minted}` });

    await opened;
    expect(await ended).toBeNull();
    expect(edge.requests.map((request) => request.authorization)).toEqual(["Bearer t1", "Bearer t2", "Bearer t3"]);
  });

  it("a token the caller cannot produce is terminal", async () => {
    const edge = scriptedEdge([]);
    const { opened } = read(edge, {
      token: () => {
        throw new Error("no stream token");
      },
    });

    await expect(opened).rejects.toThrow("no stream token");
    await drain();
    expect(edge.requests).toHaveLength(0);
  });
});

// ─── 3. A rejected token: one re-mint, then terminal ─────────────────────────────────────────────────

describe("readShapeStream token rejection", () => {
  it("re-mints once and retries with the fresh token", async () => {
    const rejected: number[] = [];
    const edge = scriptedEdge([status(403), data([envelope("w1")], { offset: "A", upToDate: true })]);
    const { opened, batches } = read(edge, {
      onTokenRejected: (code) => {
        rejected.push(code);
        return "fresh";
      },
    });

    const subscription = await opened;
    await edge.requested(3);
    subscription.close();

    expect(rejected).toEqual([403]);
    expect(edge.requests.slice(0, 2).map((request) => request.authorization)).toEqual(["Bearer t", "Bearer fresh"]);
    expect(batches.map((batch) => batch.offset)).toEqual(["A"]);
  });

  // The second consecutive rejection IS the answer: the token was refreshed and still refused, so this
  // is a revocation. Exactly two requests — never a spin.
  it("a second consecutive rejection is terminal, after exactly two requests", async () => {
    const rejected: number[] = [];
    const edge = scriptedEdge([status(403), status(403), data([], { offset: "A", upToDate: true })]);
    const { opened } = read(edge, {
      onTokenRejected: (code) => {
        rejected.push(code);
        return "fresh";
      },
    });

    await expect(opened).rejects.toMatchObject({ status: 403 });
    await drain();
    expect(edge.requests).toHaveLength(2);
    expect(rejected).toEqual([403]);
  });

  it("declining to re-mint is terminal", async () => {
    const edge = scriptedEdge([status(401), data([], { offset: "A", upToDate: true })]);
    const { opened } = read(edge, { onTokenRejected: () => null });

    await expect(opened).rejects.toMatchObject({ status: 401 });
    await drain();
    expect(edge.requests).toHaveLength(1);
  });

  it("without onTokenRejected a rejection is terminal", async () => {
    const edge = scriptedEdge([status(401)]);
    await expect(read(edge).opened).rejects.toMatchObject({ status: 401 });
    await drain();
    expect(edge.requests).toHaveLength(1);
  });

  // Every request of the session gets the same policy, and a success resets it: a long-lived read may
  // need many re-mints over its life, but never two in a row.
  it("holds for every request of the session, and the token thunk resumes after a recovery", async () => {
    const rejected: number[] = [];
    const edge = scriptedEdge([
      data([], { offset: "A", upToDate: true }),
      status(401),
      data([envelope("w1")], { offset: "B", upToDate: true }),
      status(403),
      status(403),
      data([], { offset: "C", upToDate: true }),
    ]);
    const { opened, ended, events } = read(edge, {
      onTokenRejected: (code) => {
        rejected.push(code);
        return `fresh-${rejected.length}`;
      },
    });

    await opened;
    expect(await ended).toMatchObject({ status: 403 });
    await drain();

    expect(rejected).toEqual([401, 403]);
    expect(edge.requests.map((request) => request.authorization)).toEqual([
      "Bearer t",
      "Bearer t",
      "Bearer fresh-1",
      "Bearer t",
      "Bearer fresh-2",
    ]);
    expect(events).toEqual(["batch:A", "batch:B", "error:403"]);
  });
});

// ─── 4. Retries and backoff ──────────────────────────────────────────────────────────────────────────

describe("readShapeStream retries", () => {
  // Full jitter under a ceiling of 100 ms × 1.3^(attempt-1), capped at 60 s. With the jitter pinned at
  // 1 each delay is its ceiling.
  it("retries 429 and 503 on the backoff schedule", async () => {
    const edge = scriptedEdge([
      status(503),
      status(429),
      status(503),
      data([envelope("w1")], { offset: "A", upToDate: true }),
    ]);
    const { opened, waits, ended } = read(edge, { live: false });

    await opened;
    expect(await ended).toBeNull();
    expect(edge.requests).toHaveLength(4);
    expect(waits).toEqual([100, 130, 169]);
  });

  it("jitters: each delay is a random share of its ceiling", async () => {
    const edge = scriptedEdge([status(503), status(503), data([], { offset: "A", upToDate: true })]);
    const { opened, waits, ended } = read(edge, { live: false, random: () => 0.5 });

    await opened;
    await ended;
    expect(waits).toEqual([50, 65]);
  });

  it("the ceiling stops growing at 60 s", async () => {
    const edge = scriptedEdge([
      ...Array.from({ length: 30 }, () => status(503)),
      data([], { offset: "A", upToDate: true }),
    ]);
    const { opened, waits, ended } = read(edge, { live: false });

    await opened;
    await ended;
    expect(waits).toHaveLength(30);
    expect(Math.max(...waits)).toBe(60_000);
    expect(waits.slice(-5)).toEqual([60_000, 60_000, 60_000, 60_000, 60_000]);
  });

  it("honours Retry-After as a floor under the backoff", async () => {
    const edge = scriptedEdge([
      status(429, { "Retry-After": "3" }),
      status(503, { "Retry-After": "0" }),
      data([], { offset: "A", upToDate: true }),
    ]);
    const { opened, waits, ended } = read(edge, { live: false });

    await opened;
    await ended;
    expect(waits).toEqual([3_000, 130]);
  });

  // Every 5xx is a server that may come back — a cold-starting edge function answers 502/504 — so they
  // back off like 503 does.
  it("retries every other 5xx", async () => {
    const edge = scriptedEdge([status(500), status(502), status(504), data([], { offset: "A", upToDate: true })]);
    const { opened, waits, ended } = read(edge, { live: false });

    await opened;
    expect(await ended).toBeNull();
    expect(waits).toEqual([100, 130, 169]);
  });

  it("retries network failures", async () => {
    const edge = scriptedEdge([networkFailure, networkFailure, data([], { offset: "A", upToDate: true })]);
    const { opened, waits, ended } = read(edge, { live: false });

    await opened;
    expect(await ended).toBeNull();
    expect(edge.requests).toHaveLength(3);
    expect(waits).toEqual([100, 130]);
  });

  it("starts the schedule again after a success", async () => {
    const edge = scriptedEdge([
      status(503),
      data([envelope("w1")], { offset: "A" }),
      status(503),
      data([envelope("w2")], { offset: "B", upToDate: true }),
    ]);
    const { opened, waits, ended } = read(edge, { live: false });

    await opened;
    await ended;
    expect(waits).toEqual([100, 100]);
  });

  // A 4xx is the server saying the request itself is wrong; repeating it cannot change the answer.
  // 404 and 410 mean the stream is gone (never created, or retired) and the caller must re-subscribe.
  for (const code of [400, 404, 405, 409, 410, 422]) {
    it(`a ${code} is terminal and reaches the caller without a retry`, async () => {
      const edge = scriptedEdge([status(code), data([], { offset: "A", upToDate: true })]);
      const { opened, waits } = read(edge, { onTokenRejected: () => "fresh" });

      await expect(opened).rejects.toMatchObject({ status: code });
      await drain();
      expect(edge.requests).toHaveLength(1);
      expect(waits).toEqual([]);
    });
  }

  it("a close during a backoff stops the read at once and reports nothing", async () => {
    const waiting = Promise.withResolvers<void>();
    const edge = scriptedEdge([data([], { offset: "A", upToDate: true }), status(503)]);
    const { opened, events } = read(edge, {
      wait: (_ms, signal) =>
        new Promise((resolve) => {
          waiting.resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    });

    const subscription = await opened;
    await waiting.promise;
    subscription.close();
    await drain();

    expect(edge.requests).toHaveLength(2);
    expect(events).toEqual(["batch:A"]);
  });
});

// ─── 5. Backpressure ─────────────────────────────────────────────────────────────────────────────────

describe("readShapeStream backpressure", () => {
  it("sends the next request only once onBatch has settled", async () => {
    const applied = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const edge = scriptedEdge([data([envelope("w1")], { offset: "A", upToDate: true })]);
    const { opened } = read(edge, {
      onBatch: () => {
        delivered.resolve();
        return applied.promise;
      },
    });

    const subscription = await opened;
    await delivered.promise;
    await drain();
    expect(edge.requests).toHaveLength(1);

    applied.resolve();
    await edge.requested(2);
    subscription.close();
  });
});

// ─── 6. What a batch says ────────────────────────────────────────────────────────────────────────────

describe("readShapeStream batches", () => {
  it("each batch carries its own resume offset and up-to-date flag", async () => {
    const edge = scriptedEdge([
      data([envelope("w1"), envelope("w2")], { offset: "A" }),
      data([envelope("w3")], { offset: "B", upToDate: true }),
    ]);
    const { opened, batches, ended } = read(edge, { live: false });

    await opened;
    await ended;
    expect(batches).toEqual([
      { envelopes: [envelope("w1"), envelope("w2")], offset: "A", upToDate: false },
      { envelopes: [envelope("w3")], offset: "B", upToDate: true },
    ]);
  });

  it("a long poll that times out is an empty up-to-date batch at the same offset", async () => {
    const edge = scriptedEdge([data([envelope("w1")], { offset: "A", upToDate: true }), timedOut({ offset: "A" })]);
    const { opened, batches } = read(edge);

    const subscription = await opened;
    await edge.requested(3);
    subscription.close();

    expect(batches).toEqual([
      { envelopes: [envelope("w1")], offset: "A", upToDate: true },
      { envelopes: [], offset: "A", upToDate: true },
    ]);
  });
});

// ─── 7. The end of a read ────────────────────────────────────────────────────────────────────────────

// The end of a read is reported off the batch that ends it. A caller that closes on `onEnd` must never
// lose that batch: the regression this guards was a `live: false` read of a populated stream returning
// nothing (found by emergent's first native-path integration run, 2026-08-26: every `materializeShape`
// returned `[]`).
describe("readShapeStream end ordering", () => {
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
    await drain();
    subscription.close();
    return events;
  }

  it("delivers a non-live read's final batch BEFORE reporting the end", async () => {
    expect(await readToEnd(upToDateResponse([envelope("w1")]), false)).toEqual(["batch:1:true", "end"]);
  });

  it("an empty non-live stream still delivers its (empty) up-to-date batch, then ends", async () => {
    expect(await readToEnd(upToDateResponse([]), false)).toEqual(["batch:0:true", "end"]);
  });

  // The harness pattern: resolve on the up-to-date batch and close. Our own close is not an end.
  it("a caller that closes on the final batch is handed the batch and hears no end", async () => {
    expect(await readToEnd(upToDateResponse([envelope("w1")]), true)).toEqual(["batch:1:true"]);
  });
});

describe("readShapeStream end", () => {
  it("Stream-Closed ends a live read, after its batch", async () => {
    const edge = scriptedEdge([
      data([envelope("w1")], { offset: "A", upToDate: true }),
      data([envelope("w2")], { offset: "B", upToDate: true, closed: true }),
    ]);
    const { opened, events, ended } = read(edge);

    await opened;
    expect(await ended).toBeNull();
    await drain();
    expect(events).toEqual(["batch:A", "batch:B", "end"]);
    expect(edge.requests).toHaveLength(2);
  });

  it("the EOF of a long poll (204 + Stream-Closed) ends the read", async () => {
    const edge = scriptedEdge([data([], { offset: "A", upToDate: true }), timedOut({ offset: "A", closed: true })]);
    const { opened, events, ended } = read(edge);

    await opened;
    expect(await ended).toBeNull();
    expect(events).toEqual(["batch:A", "batch:A", "end"]);
  });

  // The mid-session reset (ADR-0056 decision 7): the caller answers it with a re-subscribe.
  for (const code of [404, 410]) {
    it(`a ${code} mid-session ends the read with that error`, async () => {
      const edge = scriptedEdge([data([envelope("w1")], { offset: "A", upToDate: true }), status(code)]);
      const { opened, events, ended, waits } = read(edge);

      await opened;
      expect(await ended).toMatchObject({ status: code });
      await drain();
      expect(events).toEqual(["batch:A", `error:${code}`]);
      expect(edge.requests).toHaveLength(2);
      expect(waits).toEqual([]);
    });
  }

  it("an onBatch failure ends the read with its error", async () => {
    const edge = scriptedEdge([data([envelope("w1")], { offset: "A", upToDate: true })]);
    const { opened, ended } = read(edge, {
      onBatch: () => {
        throw new Error("apply failed");
      },
    });

    await opened;
    expect(await ended).toMatchObject({ message: "apply failed" });
    await drain();
    expect(edge.requests).toHaveLength(1);
  });

  it("the caller's own close() aborts the long poll and reports nothing", async () => {
    const edge = scriptedEdge([data([], { offset: "A", upToDate: true })]);
    const { opened, events } = read(edge);

    const subscription = await opened;
    await edge.requested(2);
    subscription.close();
    await drain();

    expect(edge.requests[1]!.signal?.aborted).toBe(true);
    expect(events).toEqual(["batch:A"]);
  });

  it("the caller's AbortSignal ends the read with onEnd(null)", async () => {
    const controller = new AbortController();
    const edge = scriptedEdge([data([], { offset: "A", upToDate: true })]);
    const { opened, events, ended } = read(edge, { signal: controller.signal });

    await opened;
    await edge.requested(2);
    controller.abort();

    expect(await ended).toBeNull();
    expect(edge.requests[1]!.signal?.aborted).toBe(true);
    expect(events).toEqual(["batch:A", "end"]);
  });

  it("onEnd fires at most once", async () => {
    const controller = new AbortController();
    const edge = scriptedEdge([data([], { offset: "A", upToDate: true }), status(410)]);
    const { opened, events, ended } = read(edge, { signal: controller.signal });

    const subscription = await opened;
    await ended;
    controller.abort();
    subscription.close();
    await drain();

    expect(events).toEqual(["batch:A", "error:410"]);
  });
});

// ─── 8. Live and non-live ────────────────────────────────────────────────────────────────────────────

describe("readShapeStream live modes", () => {
  it("live: false catches up without long-polling and stops at the tail", async () => {
    const edge = scriptedEdge([
      data([envelope("w1")], { offset: "A", cursor: "c1" }),
      data([envelope("w2")], { offset: "B", upToDate: true, cursor: "c2" }),
    ]);
    const { opened, ended } = read(edge, { live: false });

    await opened;
    expect(await ended).toBeNull();
    await drain();
    expect(edge.queries()).toEqual([["offset=-1"], ["offset=A", "cursor=c1"]]);
  });

  // The first request never long-polls, so a catch-up response stays cacheable; the reader switches to
  // `live=long-poll` only once a response says it is up to date, and echoes the latest cursor (§10.1).
  it("live (the default) long-polls the tail once caught up, echoing the cursor", async () => {
    const edge = scriptedEdge([
      data([envelope("w1")], { offset: "A", cursor: "c1" }),
      data([envelope("w2")], { offset: "B", upToDate: true, cursor: "c2" }),
      timedOut({ offset: "B", cursor: "c3" }),
      data([envelope("w3")], { offset: "C", upToDate: true }),
    ]);
    const { opened, events } = read(edge);

    const subscription = await opened;
    await edge.requested(5);
    subscription.close();

    expect(edge.queries()).toEqual([
      ["offset=-1"],
      ["offset=A", "cursor=c1"],
      ["offset=B", "live=long-poll", "cursor=c2"],
      ["offset=B", "live=long-poll", "cursor=c3"],
      ["offset=C", "live=long-poll", "cursor=c3"],
    ]);
    expect(events).toEqual(["batch:A", "batch:B", "batch:B", "batch:C"]);
  });

  it("resumes from the given offset and keeps the stream URL's own query", async () => {
    const edge = scriptedEdge([data([], { offset: "Z", upToDate: true })]);
    const { opened, ended } = read(edge, { url: `${STREAM_URL}?tenant=a`, offset: "Y", live: false });

    await opened;
    await ended;
    expect(edge.queries()).toEqual([["tenant=a", "offset=Y"]]);
  });
});

// ─── Protocol violations fail loudly ─────────────────────────────────────────────────────────────────

// Each of these is what a response looks like when an edge strips the protocol headers (a cross-origin
// mount that does not expose them) or a server does not speak the protocol. The reader cannot make
// progress on any of them, so it says so instead of re-asking the same question forever.
describe("readShapeStream protocol violations", () => {
  it("a response without Stream-Next-Offset is an error, not a hot loop", async () => {
    const edge = scriptedEdge([() => new Response("[]", { status: 200 })]);
    await expect(read(edge).opened).rejects.toThrow(/Stream-Next-Offset/);
    await drain();
    expect(edge.requests).toHaveLength(1);
  });

  it("a response that neither advances nor catches up is an error", async () => {
    const edge = scriptedEdge([data([], { offset: "Y" })]);
    await expect(read(edge, { offset: "Y" }).opened).rejects.toThrow(/neither advanced/);
    await drain();
    expect(edge.requests).toHaveLength(1);
  });

  it("a body that is not a JSON array is an error", async () => {
    const edge = scriptedEdge([
      () => new Response('{"not":"an array"}', { status: 200, headers: positionHeaders({ offset: "A" }) }),
    ]);
    await expect(read(edge).opened).rejects.toThrow(/JSON array/);
    await drain();
    expect(edge.requests).toHaveLength(1);
  });
});
