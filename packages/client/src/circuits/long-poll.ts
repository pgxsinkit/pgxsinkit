import type { StreamEnvelope } from "@pgxsinkit/contracts";

// The wire half of pgxsinkit's stream reader: one read request in the Durable Streams protocol's
// catch-up and long-poll modes, for JSON streams, and what its answer means. The protocol is
// PROTOCOL.md at pgxsinkit/durable-streams@a172acc389351cb3db6deb5cd60e3dec11e7ff39: reads §5.6–5.7,
// offsets §8, JSON mode §9.1, cursors and caching §10.1. Server-sent events (§5.8) are out of scope:
// pgxsinkit has never read that way. The session built on this — token recovery, backpressure, the end
// contract — is `stream-source.ts`.

/**
 * Every response header the reader reads.
 *
 * A cross-origin browser sees none of them unless the edge names them on
 * `Access-Control-Expose-Headers` (`STREAM_READ_EXPOSED_HEADERS` in `@pgxsinkit/server`, which a unit
 * test holds to this list). The first four steer the read; `retry-after` only refines a backoff.
 */
export const READ_RESPONSE_HEADERS = [
  "stream-next-offset",
  "stream-up-to-date",
  "stream-cursor",
  "stream-closed",
  "retry-after",
] as const;

/** Where the next request reads from. */
export interface ReadPosition {
  offset: string;
  /** The latest `Stream-Cursor`, echoed so a CDN can collapse identical polls (§10.1). */
  cursor: string | null;
  /** Hold the request open at the tail. Set once a live read has been told it is up to date. */
  longPoll: boolean;
}

/**
 * The request URL for a position: `offset`, then `live=long-poll`, then `cursor`, appended to whatever
 * query the stream URL already carries.
 *
 * A catch-up request never says `live`. It stays an ordinary, cacheable read of a fixed range; only the
 * request at the tail asks the server to wait.
 */
export function readRequestUrl(streamUrl: string, position: ReadPosition): string {
  const url = new URL(streamUrl);
  url.searchParams.set("offset", position.offset);
  if (position.longPoll) url.searchParams.set("live", "long-poll");
  if (position.cursor !== null) url.searchParams.set("cursor", position.cursor);
  return url.toString();
}

/** One successful response, read to the end. */
export interface ReadResponse {
  envelopes: StreamEnvelope[];
  /** `Stream-Next-Offset`: where the read resumes after this response. */
  offset: string;
  cursor: string | null;
  /** `Stream-Up-To-Date` is present: this response reached the tail as it stood when it was generated. */
  upToDate: boolean;
  /** `Stream-Closed: true`: the tail is final and nothing will ever follow (EOF). */
  closed: boolean;
}

/** A read that failed: a status the reader does not retry, or a response it cannot make sense of. */
export class StreamReadError extends Error {
  /** The HTTP status, when the failure was one. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "StreamReadError";
    this.status = status;
  }
}

/**
 * What a non-2xx status means for the request that got it.
 *
 * - 401 and 403: the token was refused. The session decides whether a fresh one is worth one retry.
 * - 429 and every 5xx: the server is overloaded, restarting or cold-starting, and the same request can
 *   succeed later. Retried with backoff.
 * - Everything else, 404 and 410 included: the request itself is wrong or the stream is gone (never
 *   created, or retired), and repeating it cannot change the answer.
 */
export function classifyStatus(status: number): "token-rejected" | "retry" | "terminal" {
  if (status === 401 || status === 403) return "token-rejected";
  if (status === 429 || status >= 500) return "retry";
  return "terminal";
}

/** The error for a response the reader will not retry, with the server's own reason when it gave one. */
export async function failedRead(response: Response, url: string): Promise<StreamReadError> {
  const body = (await response.text().catch(() => "")).trim();
  const reason = body.length > 200 ? `${body.slice(0, 200)}…` : body;
  return new StreamReadError(
    `[pgxsinkit] stream read failed: HTTP ${response.status} at ${url}${reason ? `: ${reason}` : ""}`,
    response.status,
  );
}

/**
 * Read a 2xx response: its envelopes and the position after them.
 *
 * Three answers are protocol violations and fail the read rather than being guessed around, because
 * each would otherwise re-ask the same question forever: no `Stream-Next-Offset` (the server MUST send
 * it, so its absence means an edge stripped it, typically a cross-origin mount that does not expose
 * it); a body that is not a JSON array (§9.1.5); and an empty response that neither moved the offset
 * nor reached the tail (the shape a stripped `Stream-Up-To-Date` takes at the tail).
 */
export async function readResponse(response: Response, url: string, requestedOffset: string): Promise<ReadResponse> {
  const headers = response.headers;
  const offset = headers.get("stream-next-offset");
  if (!offset) {
    throw new StreamReadError(
      `[pgxsinkit] stream response carried no Stream-Next-Offset (${url}). A cross-origin edge must expose ` +
        "the stream-* headers on Access-Control-Expose-Headers (STREAM_READ_EXPOSED_HEADERS).",
      response.status,
    );
  }

  const body = response.status === 204 ? "" : (await response.text()).trim();
  let envelopes: unknown = [];
  if (body !== "") {
    try {
      envelopes = JSON.parse(body);
    } catch {
      envelopes = null;
    }
  }
  if (!Array.isArray(envelopes)) {
    throw new StreamReadError(`[pgxsinkit] stream response body is not a JSON array (${url})`, response.status);
  }

  const upToDate = headers.has("stream-up-to-date");
  const closed = headers.get("stream-closed")?.toLowerCase() === "true";
  if (envelopes.length === 0 && offset === requestedOffset && !upToDate && !closed) {
    throw new StreamReadError(
      `[pgxsinkit] stream response neither advanced the offset nor reached the tail (${url}). Is the edge ` +
        "exposing Stream-Up-To-Date (STREAM_READ_EXPOSED_HEADERS)?",
      response.status,
    );
  }

  return { envelopes: envelopes as StreamEnvelope[], offset, cursor: headers.get("stream-cursor"), upToDate, closed };
}

/**
 * The backoff before retry `attempt` (1-based) of one request: full jitter, a random share of a ceiling
 * that starts at 100 ms and grows 1.3× per attempt up to 60 s, with the server's `Retry-After` as a floor.
 *
 * Jitter spreads a fleet that lost the same edge at the same moment, so its retries do not arrive
 * together. There is no attempt limit: a read waits out an outage or a lost network at one request a
 * minute rather than giving up, and the caller can always close it.
 */
export function retryDelayMs(attempt: number, retryAfterMs: number | null, random: () => number): number {
  const ceiling = Math.min(100 * 1.3 ** (attempt - 1), 60_000);
  return Math.round(Math.max(retryAfterMs ?? 0, random() * ceiling));
}

/** Wait `ms`, or less if `signal` aborts first. Never rejects: the caller checks the signal afterwards. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
