import { describe, expect, it } from "bun:test";

import { ShapeStream } from "@electric-sql/client";

import { createReadStreamStallProbe } from "../../packages/client/src/read-stream-stall";
import { startConfiguredSync } from "../../packages/client/src/shape-sync";

/**
 * The read path's OUTAGE signal (board ADR-0010 "offline return"). Every shape fetch runs inside
 * Electric's `createFetchWithBackoff`, which retries a rejected fetch forever (`maxRetries: Infinity`,
 * "clients may go offline and come back") and only re-throws a non-retryable 4xx. So on a real network
 * outage NOTHING ever reaches `ShapeStream.onError` — the runtime would report `syncing` for as long as
 * the machine stays offline. The only seam Electric offers inside that loop is
 * `backoffOptions.onFailedAttempt`, which is what these tests pin: against the REAL `ShapeStream` (the
 * root workspace depends on `@electric-sql/client`, so this exercises the actual retry loop, not a mock
 * of it), and through the real `startConfiguredSync` construction seam every read shape passes.
 */

/** Poll until `predicate` holds, or fail the test after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${message}`);
    await Bun.sleep(5);
  }
}

/** A settled microtask/timer turn — enough for Electric's fetch loop to run its catch handlers. */
const tick = () => Bun.sleep(20);

describe("read-stream stall probe (board ADR-0010)", () => {
  it("preserves Electric's own backoff timings — passing options must not silently change retry behaviour", () => {
    const probe = createReadStreamStallProbe({ onStalled: () => {} });

    // `ShapeStream` SPREADS `options.backoffOptions` over nothing (`?? BackoffDefaults`), so a partial
    // object would blank the timings. These are Electric's documented defaults, re-asserted here so a
    // drift in either direction is a test failure rather than a silent retry-behaviour change.
    expect(probe.backoffOptions.initialDelay).toBe(1_000);
    expect(probe.backoffOptions.maxDelay).toBe(32_000);
    expect(probe.backoffOptions.multiplier).toBe(2);
    expect(probe.backoffOptions.maxRetries).toBe(Infinity);
  });

  it("reports a stall when the shape fetch keeps rejecting — the signal `onError` never sees", async () => {
    let stalls = 0;
    let attempts = 0;
    const probe = createReadStreamStallProbe({
      onStalled: () => (stalls += 1),
      // The outage: `fetch` REJECTS (no HTTP status), exactly as a browser reports a dead network.
      fetchClient: async () => {
        attempts += 1;
        throw new TypeError("Failed to fetch");
      },
    });

    const aborter = new AbortController();
    const stream = new ShapeStream({
      url: "http://stalled.invalid/v1/shape",
      params: { table: "issue" },
      signal: aborter.signal,
      backoffOptions: probe.backoffOptions,
      fetchClient: probe.fetchClient,
    });
    let errors = 0;
    const unsubscribe = stream.subscribe(
      () => {},
      () => (errors += 1),
    );

    try {
      await waitUntil(() => stalls > 0, "the rejected shape fetch to report a stall");
      expect(attempts).toBeGreaterThan(0);
      // The whole point: the retry lives INSIDE the backoff wrapper, so the stream's own error channel
      // stays silent. Without the probe there is no signal at all.
      expect(errors).toBe(0);
    } finally {
      unsubscribe();
      aborter.abort();
      await tick();
    }
  });

  it("reports a stall for a 5xx — swallowed by the backoff loop, so no other seam can see it", async () => {
    let stalls = 0;
    const probe = createReadStreamStallProbe({
      onStalled: () => (stalls += 1),
      fetchClient: async () => new Response("upstream is down", { status: 503 }),
    });

    const aborter = new AbortController();
    const stream = new ShapeStream({
      url: "http://stalled.invalid/v1/shape",
      params: { table: "issue" },
      signal: aborter.signal,
      backoffOptions: probe.backoffOptions,
      fetchClient: probe.fetchClient,
    });
    const unsubscribe = stream.subscribe(
      () => {},
      () => {},
    );

    try {
      await waitUntil(() => stalls > 0, "the 503 to report a stall");
    } finally {
      unsubscribe();
      aborter.abort();
      await tick();
    }
  });

  it("does NOT report a stall for a 4xx — that ESCAPES the loop and `onError` owns it, with a real error", async () => {
    // The partition: anything Electric re-throws reaches `createShapeErrorHandler`, which already
    // classifies it (401/403 → `auth-needed`; 404/409/… → `onReadStreamError` → degraded with the actual
    // message). Reporting it here as well would let a rejected token flap through the coarser state.
    let stalls = 0;
    let errors = 0;
    const probe = createReadStreamStallProbe({
      onStalled: () => (stalls += 1),
      fetchClient: async () => new Response("nope", { status: 401 }),
    });

    const aborter = new AbortController();
    const stream = new ShapeStream({
      url: "http://forbidden.invalid/v1/shape",
      params: { table: "issue" },
      signal: aborter.signal,
      backoffOptions: probe.backoffOptions,
      fetchClient: probe.fetchClient,
      // The production wiring: `createShapeErrorHandler` occupies this seam and is what actually hears
      // the 4xx. Returning `undefined` (its structural-4xx branch) stops the stream, as it would.
      onError: () => {
        errors += 1;
        return undefined;
      },
    });
    const unsubscribe = stream.subscribe(
      () => {},
      () => {},
    );

    try {
      await waitUntil(() => errors > 0, "the 401 to reach the stream's error channel");
      expect(stalls).toBe(0);
    } finally {
      unsubscribe();
      aborter.abort();
      await tick();
    }
  });

  it("does NOT report a stall for a deliberate abort — teardown, visibility pause, or a nudge refresh", async () => {
    // Electric calls `onFailedAttempt` for EVERY rejection, including the AbortError it deliberately
    // causes itself: a stream teardown, a hidden tab (`PAUSE_STREAM`), a live-request timeout, a system
    // wake, and the live-tail nudge's `forceDisconnectAndRefresh` all abort the in-flight request. None
    // of those is an outage, so counting them would report "connection needed" for backgrounding a tab.
    let stalls = 0;
    const probe = createReadStreamStallProbe({
      onStalled: () => (stalls += 1),
      // A parked long-poll: it settles only when the request is aborted.
      fetchClient: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        }),
    });

    const aborter = new AbortController();
    const stream = new ShapeStream({
      url: "http://parked.invalid/v1/shape",
      params: { table: "issue" },
      signal: aborter.signal,
      backoffOptions: probe.backoffOptions,
      fetchClient: probe.fetchClient,
    });
    const unsubscribe = stream.subscribe(
      () => {},
      () => {},
    );

    try {
      await tick();
      aborter.abort();
      await tick();
      expect(stalls).toBe(0);
    } finally {
      unsubscribe();
      aborter.abort();
      await tick();
    }
  });
});

describe("read-stream stall wiring (startConfiguredSync)", () => {
  type CapturedShape = {
    shape: { backoffOptions?: { onFailedAttempt?: () => void }; fetchClient?: typeof fetch };
  };

  /**
   * Drive one captured shape's probe end to end: fail a fetch through the shape's own `fetchClient`, then
   * fire the `onFailedAttempt` Electric would fire next. An unparseable URL rejects with no socket opened,
   * so this stays hermetic while still exercising the real classification rather than asserting a shape.
   */
  async function failOneAttempt(shape: CapturedShape["shape"]): Promise<void> {
    await shape.fetchClient?.("::not a url::").catch(() => undefined);
    shape.backoffOptions?.onFailedAttempt?.();
  }

  /** A fake engine namespace capturing the per-shape stream options each group is started with. */
  function capturingNamespace(captured: Record<string, CapturedShape>) {
    return {
      initMetadataTables: async () => {},
      syncShapesToTables: async (opts: { shapes: Record<string, CapturedShape>; onInitialSync?: () => void }) => {
        Object.assign(captured, opts.shapes);
        opts.onInitialSync?.();
        return { unsubscribe: () => {}, isUpToDate: true, streams: {} };
      },
    };
  }

  it("carries the failed-attempt probe on EVERY read shape — eager, and a lazy group activated later", async () => {
    const captured: Record<string, CapturedShape> = {};
    const pg = { electric: capturingNamespace(captured) } as unknown as Parameters<typeof startConfiguredSync>[0];

    let stalls = 0;
    const result = await startConfiguredSync(pg, {
      // The engine is mocked here; an empty registry just passes through (ADR-0029 D1).
      registry: {},
      onReadStreamStalled: () => (stalls += 1),
      syncConfig: {
        electricUrl: "http://localhost:3000/v1/shape",
        localSchema: "app_local",
        tables: {
          issue: {
            mode: "readwrite",
            primaryKey: { columns: ["id"] },
            shape: { tableName: "issue", shapeKey: "issue-shape" },
          },
          message: {
            mode: "readonly",
            primaryKey: { columns: ["id"] },
            shape: { tableName: "message", shapeKey: "message-shape" },
            subscription: "lazy",
            retention: "ephemeral",
          },
        },
      },
    });

    // The eager boot shape carries it…
    const eager = captured["issue"]?.shape;
    expect(typeof eager?.backoffOptions?.onFailedAttempt).toBe("function");
    await failOneAttempt(eager!);
    expect(stalls).toBe(1);

    // …and so does a lazy group activated on demand long after boot: an outage while a chat channel is
    // being opened is exactly the case board ADR-0010 has to surface.
    expect(captured["message"]).toBeUndefined();
    await result.ensureGroupStarted("message-shape");
    const lazy = captured["message"]?.shape;
    expect(typeof lazy?.backoffOptions?.onFailedAttempt).toBe("function");
    await failOneAttempt(lazy!);
    expect(stalls).toBe(2);
  });

  it("leaves the shape options untouched when no consumer wants the signal", async () => {
    const captured: Record<string, CapturedShape> = {};
    const pg = { electric: capturingNamespace(captured) } as unknown as Parameters<typeof startConfiguredSync>[0];

    await startConfiguredSync(pg, {
      registry: {},
      syncConfig: {
        electricUrl: "http://localhost:3000/v1/shape",
        localSchema: "app_local",
        tables: {
          issue: {
            mode: "readwrite",
            primaryKey: { columns: ["id"] },
            shape: { tableName: "issue", shapeKey: "issue-shape" },
          },
        },
      },
    });

    // No callback → no backoff override and no fetch wrapper: Electric's own defaults, byte for byte.
    expect(captured["issue"]?.shape.backoffOptions).toBeUndefined();
    expect(captured["issue"]?.shape.fetchClient).toBeUndefined();
  });
});
