import type { StreamEnvelope } from "@pgxsinkit/contracts";

import { parseRetryAfterMs } from "../retry-after";
import {
  classifyStatus,
  failedRead,
  readRequestUrl,
  readResponse,
  retryDelayMs,
  sleep,
  StreamReadError,
  type ReadPosition,
  type ReadResponse,
} from "./long-poll";

/** The resume position of a fresh subscription — the start of the stream. */
export const STREAM_START = "-1";

/** One delivery from a stream, with the position that acknowledges it. */
export interface StreamBatch {
  envelopes: readonly StreamEnvelope[];
  /**
   * The offset to resume from after THIS batch. Persist it **with** the applied rows in one
   * transaction: persisted ahead, a crash loses the envelopes between; persisted behind, they are
   * re-applied. The apply path is idempotent so the second is survivable and the first is not, which
   * is why this rides the batch rather than being read off the stream afterwards.
   */
  offset: string;
  /** Whether THIS batch reached the tail of the stream as it stood when the server answered. */
  upToDate: boolean;
}

export interface StreamSourceOptions {
  /** Absolute URL of the stream, through the edge — never durable-streams directly. */
  url: string;
  /** Where to resume. {@link STREAM_START} for a new subscription. */
  offset?: string;
  /**
   * The current stream token, re-resolved on **every** request rather than captured once.
   *
   * A live subscription outlives its token by design — the ADR-0055 default lifetime is five
   * minutes and a subscription runs for hours — so a token frozen at open would 403 the whole
   * stream at the first TTL boundary. This is the ADR-0013 read-path refresh seam. A token that
   * cannot be produced (the thunk throws) ends the read with that error.
   */
  token: () => string | Promise<string>;
  /**
   * Called when the edge rejects the current token (401/403). Return a fresh token to retry once
   * with it, or `null` to stop.
   *
   * Returning `null` is the *right* answer for a revoked entitlement, and the reason this hook
   * exists at all rather than a blanket retry — see {@link createTokenRecovery}.
   */
  onTokenRejected?: (status: number) => string | null | Promise<string | null>;
  /** Long-poll the tail after catching up. `false` reads to the tail and stops. */
  live?: boolean;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/**
 * The token-recovery policy as a function of a read error: resolves with the `authorization` header
 * to retry with, or `undefined` when the error must stand.
 */
export type StreamErrorHandler = (error: Error) => Promise<{ headers: { authorization: string } } | undefined>;

/**
 * The token-recovery policy the reader applies to every request: **one re-mint per rejection**.
 *
 * On a 401/403 the handler asks `onTokenRejected` for a fresh token and answers with it; if the
 * fresh token is refused too, it answers `undefined` and the error stands. The second consecutive
 * rejection is the answer — the token was refreshed and still refused, so this is a revocation, not
 * an expiry — and retrying past it would turn a revoked entitlement into a hot loop of refused
 * requests. A revocation must instead surface as an error the caller can act on: truncate the scope
 * and unsubscribe (ADR-0055 decision 6).
 *
 * Stateful and single-shot: one handler re-mints once. The reader makes a new one for each request, so
 * a read that lives for hours can re-mint many times, but no request is retried on a second rejection.
 * Errors that are not 401/403 are not the handler's to recover and answer `undefined`.
 */
export function createTokenRecovery(
  onTokenRejected: NonNullable<StreamSourceOptions["onTokenRejected"]>,
): StreamErrorHandler {
  let recovering = false;
  return async (error: Error & { status?: number }) => {
    const status = error.status;
    if (status !== 401 && status !== 403) return undefined;
    if (recovering) return undefined;

    recovering = true;
    const fresh = await onTokenRejected(status);
    if (fresh == null) return undefined;
    return { headers: { authorization: `Bearer ${fresh}` } };
  };
}

/** A running subscription. */
export interface ShapeStreamSubscription {
  /** Stop reading: abort the request in flight and release the connection. Reports nothing. */
  close(): void;
}

/** The reader's time and chance, injectable so a test can assert a retry schedule without waiting. */
export interface ReadInternals {
  /** Wait out a backoff. Must resolve early when `signal` aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The jitter source, uniform on [0, 1). */
  random: () => number;
}

/**
 * Read one Circuits shape stream, yielding envelopes in stream order.
 *
 * pgxsinkit's own long-poll reader of the Durable Streams protocol (ADR-0065 decision 6; the wire is
 * `long-poll.ts`). It catches up with plain reads from `offset` (so a catch-up response stays
 * cacheable), and once a response says it is up to date, a live read long-polls the tail, echoing the
 * server's cursor. `live: false` stops at the first up-to-date response instead.
 *
 * Resolves once the first response has arrived, so an immediate failure — a refused token, a stream
 * that does not exist — rejects this call rather than dying on a loop nobody is watching. The first
 * batch is delivered after that, never during the call: a caller that closes its subscription from
 * inside `onBatch` already holds it.
 *
 * Every successful response is one batch, an empty one included (a long poll that timed out delivers
 * the empty up-to-date batch at the same offset). **Backpressure, one response ahead:** the request
 * for the next response is sent when a batch is handed to `onBatch`, and the request after that not
 * until `onBatch` has settled. So the network wait and the apply overlap instead of adding up, which
 * is worth up to half the time of a catch-up that spans many responses, and a slow apply still
 * throttles the read: at most one response is ever held beyond the one being applied. One request is
 * in flight at a time, which is one connection per stream while it long-polls.
 *
 * **Failures, per request:**
 * - 401/403: one immediate retry with a token from `onTokenRejected` ({@link createTokenRecovery}); a
 *   second rejection of the same request, or no fresh token, is terminal. Every request of the session
 *   gets this, not only the opening one, so a read that lives for hours can re-mint many times, but a
 *   refused token never loops.
 * - 429 and every 5xx, and network failures (the request, or its body, cut off): retried with backoff
 *   until they succeed or the caller stops the read. A `Retry-After` is a floor under the backoff.
 * - Every other status is terminal, 404 and 410 (the stream was never created, or was retired)
 *   included, as is a response that breaks the protocol ({@link readResponse}).
 *
 * **The end of a read.** `onEnd` is not optional decoration: without it a read that dies mid-session
 * is silent — the rows stay, and nobody re-subscribes. It fires at most once:
 * - `onEnd(null)` after `onBatch` has been handed the batch that ends the read — the up-to-date batch
 *   of a `live: false` read, the `Stream-Closed` batch of any read — and has settled on it. A caller
 *   may close on `onEnd` without losing that batch.
 * - `onEnd(error)` for a terminal failure after the first response, and for an `onBatch` that throws.
 *   This is the mid-session reset (ADR-0056 decision 7) a caller answers with a re-subscribe.
 * - `onEnd(null)` when the caller's `signal` aborts.
 * - Nothing when the caller called {@link ShapeStreamSubscription.close}: a group tearing its streams
 *   down would otherwise hear K "the stream ended" reports and try to recover from a stop it ordered.
 * - Nothing for a failure before the first response: that rejects this call instead.
 *
 * The transport only. Everything above it — the fold, apply modes, the boot gate — is the engine's,
 * which is ADR-0009's precedent applied to a new substrate.
 */
export function readShapeStream(
  options: StreamSourceOptions,
  onBatch: (batch: StreamBatch) => void | Promise<void>,
  onEnd?: (error: Error | null) => void,
): Promise<ShapeStreamSubscription> {
  return readShapeStreamWith({}, options, onBatch, onEnd);
}

/** {@link readShapeStream} with its time and chance injected. Not public API. */
export function readShapeStreamWith(
  internals: Partial<ReadInternals>,
  options: StreamSourceOptions,
  onBatch: (batch: StreamBatch) => void | Promise<void>,
  onEnd?: (error: Error | null) => void,
): Promise<ShapeStreamSubscription> {
  const wait = internals.wait ?? sleep;
  const random = internals.random ?? Math.random;
  const send: (input: string, init: RequestInit) => Promise<Response> =
    options.fetch ?? ((input, init) => fetch(input, init));
  const live = options.live ?? true;

  // One controller stops everything in flight — the request, its body, a backoff — whichever of the
  // caller's close() or the caller's signal comes first.
  const stop = new AbortController();
  const signal = stop.signal;
  const forwardAbort = (): void => stop.abort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) stop.abort();

  let closedByCaller = false;
  let endReported = false;
  const reportEnd = (error: Error | null): void => {
    options.signal?.removeEventListener("abort", forwardAbort);
    if (endReported || closedByCaller) return;
    endReported = true;
    onEnd?.(error);
  };

  /**
   * One request, retried until it has an answer the session can use. `null` when the read was stopped
   * while it was in flight; throws when it failed for good.
   */
  async function request(position: ReadPosition): Promise<ReadResponse | null> {
    const url = readRequestUrl(options.url, position);
    const recover = options.onTokenRejected ? createTokenRecovery(options.onTokenRejected) : null;
    // The header a re-mint answered with. It carries exactly one retry; every other attempt asks the
    // token thunk again, so the session never freezes a token, even one it was just handed.
    let reminted: string | null = null;
    let attempt = 0;

    for (;;) {
      if (signal.aborted) return null;
      const authorization = reminted ?? `Bearer ${await options.token()}`;
      reminted = null;

      let response: Response;
      try {
        response = await send(url, { method: "GET", headers: { authorization }, signal });
        if (response.ok) return await readResponse(response, url, position.offset);
      } catch (error) {
        if (signal.aborted) return null;
        if (error instanceof StreamReadError) throw error;
        // The request or its body never arrived whole: the same read is safe to ask again.
        await wait(retryDelayMs(++attempt, null, random), signal);
        continue;
      }

      const verdict = classifyStatus(response.status);
      if (verdict === "retry") {
        await response.body?.cancel().catch(() => {});
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), Date.now());
        await wait(retryDelayMs(++attempt, retryAfterMs, random), signal);
        continue;
      }

      const failure = await failedRead(response, url);
      if (verdict === "token-rejected") {
        const retry = await recover?.(failure);
        if (retry) {
          reminted = retry.headers.authorization;
          continue;
        }
      }
      throw failure;
    }
  }

  let position: ReadPosition = { offset: options.offset ?? STREAM_START, cursor: null, longPoll: false };
  let first: ReadResponse | null = null;

  const subscription: ShapeStreamSubscription = {
    close: () => {
      closedByCaller = true;
      options.signal?.removeEventListener("abort", forwardAbort);
      stop.abort();
    },
  };

  const opened = (async () => {
    try {
      first = await request(position);
      if (first === null) {
        throw new StreamReadError(`[pgxsinkit] stream read of ${options.url} was aborted before its first response`);
      }
      return subscription;
    } catch (error) {
      options.signal?.removeEventListener("abort", forwardAbort);
      throw error;
    }
  })();

  /**
   * Deliver each batch while the next response is fetched, until the read ends. Resolves with what
   * `onEnd` reports.
   */
  async function deliver(): Promise<Error | null> {
    let response = first!;
    try {
      for (;;) {
        if (signal.aborted) return null;
        const last = response.closed || (!live && response.upToDate);

        // One response ahead: asked for now, awaited once this batch is applied. Its failure belongs
        // after this batch in the order of events, so it is held until then rather than thrown here.
        let ahead: Promise<ReadResponse | null> | null = null;
        if (!last) {
          position = {
            offset: response.offset,
            cursor: response.cursor ?? position.cursor,
            longPoll: live && response.upToDate,
          };
          ahead = request(position);
          ahead.catch(() => {});
        }

        await onBatch({ envelopes: response.envelopes, offset: response.offset, upToDate: response.upToDate });
        if (ahead === null) return null;

        const next = await ahead;
        if (next === null) return null;
        response = next;
      }
    } catch (error) {
      if (signal.aborted) return null;
      // A failed apply leaves the request that was sent ahead of it in flight; end it.
      stop.abort();
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  // Delivery starts one reaction BEHIND the caller's own `await` of the returned promise: reactions
  // run in the order they were registered, the caller's is registered when this function returns,
  // and the extra `then` puts ours after it. So the caller holds its subscription before the first
  // `onBatch`, and `opened` must be returned as it is, not wrapped by an `async` function.
  void opened
    .then(() => undefined)
    .then(
      async () => reportEnd(await deliver()),
      () => undefined,
    );
  return opened;
}
