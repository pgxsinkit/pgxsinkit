import { stream, type StreamErrorHandler } from "@durable-streams/client";

import type { StreamEnvelope } from "@pgxsinkit/contracts";

/** The resume position of a fresh subscription — the start of the stream. */
export const STREAM_START = "-1";

/** One delivery from a stream, with the position that acknowledges it. */
export interface StreamBatch {
  envelopes: readonly StreamEnvelope[];
  /**
   * The offset to resume from. Persist it **with** the applied rows in one transaction: persisted
   * ahead, a crash loses the envelopes between; persisted behind, they are re-applied. The apply
   * path is idempotent so the second is survivable and the first is not, which is why this rides
   * the batch rather than being read off the response afterwards.
   */
  offset: string;
  /** Whether the stream has delivered everything it held when the response was generated. */
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
   * stream at the first TTL boundary. This is the ADR-0013 read-path refresh seam, and
   * `@durable-streams/client` supports it directly: header values may be async thunks, resolved
   * afresh per request.
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
 * The `onError` handler for a read.
 *
 * `@durable-streams/client`'s retry loop has a sharp edge that a naive handler falls straight off.
 * Returning `{}` re-enters `streamInternal` **immediately** — a bare `while (true) { … continue }`
 * with no backoff of its own — while its backoff wrapper deliberately refuses to back off on any
 * 4xx except 429 (`fetch.ts`: client errors "cannot be backed off on"). So `onError: () => ({})`
 * against a persistently-rejected token is a hot spin, not a slow retry.
 *
 * This handler is therefore **stateful and single-shot**: one re-mint per rejection, and if the
 * fresh token is rejected too, it returns undefined and the error propagates. A revoked entitlement
 * must surface as an error the caller can act on — truncate the scope and unsubscribe (ADR-0055
 * decision 6) — not as a stream that spins.
 */
export function createTokenRecovery(
  onTokenRejected: NonNullable<StreamSourceOptions["onTokenRejected"]>,
): StreamErrorHandler {
  let recovering = false;
  return async (error: Error & { status?: number }) => {
    const status = error.status;
    if (status !== 401 && status !== 403) return undefined;
    // The second consecutive rejection is the answer: the token was refreshed and still refused, so
    // this is a revocation, not an expiry.
    if (recovering) return undefined;

    recovering = true;
    const fresh = await onTokenRejected(status);
    if (fresh == null) return undefined;
    return { headers: { authorization: `Bearer ${fresh}` } };
  };
}

/** A running subscription. `subscribeJson` is backpressure-aware, so a slow apply throttles reads. */
export interface ShapeStreamSubscription {
  /** Stop reading and release the connection. */
  close(): void;
}

/**
 * Read one Circuits shape stream, yielding envelopes in stream order.
 *
 * Resolves once the first response has arrived (so an immediate auth failure surfaces here rather
 * than silently on a background loop) and hands back a subscription that keeps delivering until
 * closed.
 *
 * The transport only. Everything above it — the fold, apply modes, the boot gate — stays
 * pgxsinkit's, which is ADR-0009's precedent applied to a new substrate: keep the transport,
 * internalize the semantics.
 */
export async function readShapeStream(
  options: StreamSourceOptions,
  onBatch: (batch: StreamBatch) => void | Promise<void>,
): Promise<ShapeStreamSubscription> {
  const response = await stream<StreamEnvelope>({
    url: options.url,
    offset: options.offset ?? STREAM_START,
    live: options.live ?? true,
    headers: { authorization: async () => `Bearer ${await options.token()}` },
    ...(options.onTokenRejected ? { onError: createTokenRecovery(options.onTokenRejected) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const unsubscribe = response.subscribeJson(async (batch) => {
    await onBatch({
      // The server flattens arrays onto the stream (PROTOCOL.md §9.1.2), so a batch's items are
      // already individual envelopes rather than the arrays a producer appended.
      envelopes: batch.items,
      offset: String(batch.offset),
      // `batch.upToDate`, NOT `response.upToDate`. They answer the same question at different times:
      // the batch's flag describes THIS batch ("ends at the current end of the stream"), while the
      // response's is documented as updated *after* each chunk is delivered to the consumer — i.e.
      // after this callback returns. Reading the response's here yields the PREVIOUS batch's answer,
      // which on the first catch-up batch is always `false`. Nothing downstream can recover from
      // that: the commit gate waits for every shape to report up-to-date, so a group whose first
      // batch is misreported never commits and `ready` never resolves, with the rows sitting in the
      // inbox and no error anywhere.
      upToDate: batch.upToDate,
    });
  });

  return { close: unsubscribe };
}
