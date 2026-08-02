/**
 * The **Event lane**'s client half (ADR-0053 decisions 2, 3, 4 and 8): the Outbox runtime, its flush loop,
 * and the two observation surfaces.
 *
 * The lane sits beside the sync rail and is deliberately NOT the mutation path. An event is a
 * fire-and-forget fact: nothing echoes back, nothing is overlaid, nothing converges, and there is no
 * conflict. What the client owns is exactly three things — validate + durably stage an append, drain the
 * Outbox in batches to the ingestion endpoint, and apply the server's per-event verdicts. Everything past
 * the endpoint (queue, consumer runner, dead-letter) is the server's half.
 *
 * Two invariants carry the design:
 *
 * 1. **Everything in the Outbox is well-formed.** `appendEvent` validates against the Event stream's
 *    registered zod schema and the contracts-level payload-size cap AT THE CALL SITE and throws — a
 *    malformed payload is a call-site bug, not a runtime condition. The flush loop and any app-authored
 *    best-guess view lean on that.
 * 2. **The client never discards an event without a server verdict.** There is NO attempt cap and NO
 *    client-side quarantine (ADR-0053 decision 4): terminal deletion happens only on `acked`/`refused`/
 *    `rejected`. A batch that keeps failing backs off at a ceiling, observably, while the Outbox keeps
 *    absorbing appends — it is designed to hold offline weeks.
 */

import { and, asc, eq, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  batchEventAckSchema,
  batchEventErrorSchema,
  batchEventPaths,
  getSyncRegistryStreams,
  isZodSchema,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENT_REQUEST_BYTES,
  MAX_EVENTS_PER_BATCH,
  type EventAck,
  type EventAckStatus,
  type EventEnvelope,
  type EventStreamEntry,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import { syncDebug } from "./debug";
import { getOutboxTable } from "./local-tables";

/** The raw local-store seam the Event lane executes through (structurally PGlite; mirrors `MutationDb`). */
export interface EventLaneDb {
  query: <TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: TRow[] }>;
}

/** Max events assembled into one flush batch when the consumer sets nothing. Clamped to {@link MAX_EVENTS_PER_BATCH}. */
export const DEFAULT_EVENT_BATCH_SIZE = 200;
/**
 * The event-lane flush driver's fallback interval. Deliberately slower than the convergence driver's: an
 * append NUDGES a pass (and reconnect/boot run one), so the interval only has to catch retries and recovery.
 */
export const DEFAULT_EVENT_FLUSH_INTERVAL_MS = 5_000;
/** First retry delay of the jittered exponential backoff (per-row deferred AND batch-level). */
export const DEFAULT_EVENT_BACKOFF_BASE_MS = 1_000;
/**
 * The backoff ceiling (ADR-0053 decision 4: "backs off at the ceiling, observably"). Five minutes: long
 * enough that a hard outage costs almost nothing, short enough that a recovered server drains promptly even
 * if no append or online signal nudges the lane.
 */
export const DEFAULT_EVENT_BACKOFF_CEILING_MS = 300_000;

/** Jittered exponential backoff tuning, shared by the per-row deferred backoff and the batch-level one. */
export interface EventBackoffOptions {
  /** The first delay, doubled per attempt. Defaults to {@link DEFAULT_EVENT_BACKOFF_BASE_MS}. */
  baseMs?: number;
  /** The delay ceiling. Defaults to {@link DEFAULT_EVENT_BACKOFF_CEILING_MS}. */
  ceilingMs?: number;
}

/** Per-Event-stream flush overrides (ADR-0053 consequences: cadence is client config, never registry). */
export interface EventStreamFlushOptions {
  /**
   * Cap on how many events of THIS Event stream ride one batch. The lane assembles one mixed batch ordered
   * by `seq` across every stream, so this is the knob that stops one chatty stream from filling every batch
   * ahead of a quieter one. Absent → only the batch-wide {@link EventLaneOptions.batchSize} applies.
   *
   * The cap is applied IN the selection query (each stream's eligible rows are ranked by `seq` and the
   * over-cap ones dropped BEFORE the global order/limit), so it genuinely yields the batch slots it frees to
   * other streams rather than just shrinking the request. Must be an integer >= 1 — a `0`/negative/`NaN` cap
   * would hold every row of the stream back forever, so it is refused at construction.
   */
  batchSize?: number;
  /** Backoff tuning for THIS stream's `deferred` rows (e.g. a stream mid-rollout wanting a shorter retry). */
  backoff?: EventBackoffOptions;
}

/**
 * The Event lane's client-level flush policy (ADR-0053 consequences). It lives on
 * `createSyncClient`/`defineSyncWorker`, NEVER on the registry: the registry is the contract, cadence is
 * deployment tuning, and a batch-size tweak must not surface as a registry diff. Client batching is
 * additionally clamped by the contracts-level request-shape limits, which the server enforces independently.
 */
export interface EventLaneOptions {
  /** Events per flush batch. Defaults to {@link DEFAULT_EVENT_BATCH_SIZE}; clamped to {@link MAX_EVENTS_PER_BATCH}. */
  batchSize?: number;
  /** The flush driver's fallback interval. Defaults to {@link DEFAULT_EVENT_FLUSH_INTERVAL_MS}. */
  intervalMs?: number;
  /** Backoff tuning for deferred rows and for batch-level faults. */
  backoff?: EventBackoffOptions;
  /** Per-Event-stream overrides, keyed by Event-stream name. */
  streams?: Record<string, EventStreamFlushOptions>;
}

/** What `appendEvent` resolves with once the event is durably staged: the library's stamps + the local ordinal. */
export interface EventAppendResult {
  /** The library-stamped uuid — the wire identity, and the key every {@link EventLaneVerdict} reports under. */
  eventId: string;
  /** The library-stamped append time in microseconds (decimal string). */
  occurredAtUs: string;
  /** The local append ordinal (decimal string). Local machinery: never transmitted. */
  seq: string;
}

/**
 * The **drain signal** (ADR-0053 decision 2): whether the Outbox is empty. Deliberately no count — a count
 * that updates only on transitions is stale by construction, and a count updated per append is a worse live
 * query. Richer detail is a query against the Outbox table.
 */
export interface OutboxStatus {
  empty: boolean;
}

/** One server-issued per-event verdict, as surfaced on the report. */
export interface EventLaneVerdict {
  eventId: string;
  /** The Event-stream name the event was appended under. */
  stream: string;
  status: EventAckStatus;
  reason?: string;
}

/** A batch-level backoff transition (ADR-0053 decision 4) — the lane entering or leaving its retry backoff. */
export interface EventLaneBackoffTransition {
  state: "entered" | "cleared";
  /** How long the lane will hold off, in ms. Present when `entered`. */
  retryInMs?: number;
  /** Consecutive failed batch attempts behind the current backoff. Present when `entered`. */
  attempt?: number;
  /** The HTTP status that caused it, when there was one (absent for a transport failure). */
  httpStatus?: number;
  /** The failure message. Present when `entered`. */
  reason?: string;
}

/**
 * One flush pass's report (ADR-0053 decision 2) — the ephemeral surface `onEventLaneReport` delivers.
 *
 * It carries what the Outbox can no longer answer: `acked` is NOT reported (a successful append-only lane
 * would drown the app in its own volume), but `refused` and `rejected` are — those rows are deleted, so once
 * they are gone the Outbox cannot say what happened to them. `deferred` rows stay, but are reported so a
 * rollout skew is visible rather than mysterious. The batch-level backoff transitions ride here too.
 */
export interface EventLaneReport {
  /** Terminal, non-`acked` verdicts: the row was DELETED on the server's say-so. */
  terminal: EventLaneVerdict[];
  /** `deferred` verdicts: the row STAYS in the Outbox and retries with backoff. */
  deferred: EventLaneVerdict[];
  /** Present only on the pass that changed the lane's batch-level backoff state. */
  backoff?: EventLaneBackoffTransition;
}

export interface CreateEventLaneRuntimeOptions<TRegistry extends SyncTableRegistry> {
  db: EventLaneDb;
  registry: TRegistry;
  /** The ingestion endpoint — `/api/events`, or an absolute deployment URL ending in it. */
  batchEventUrl: string;
  getAuthToken?: () => Promise<string | undefined>;
  /** Static headers added to every flush request (the toolkit's own Content-Type/Authorization still win). */
  requestHeaders?: Record<string, string>;
  /** Client-level flush policy. See {@link EventLaneOptions}. */
  events?: EventLaneOptions;
  /** @internal Injectable wall clock (ms) — the deterministic seam the backoff/deferred tests drive. */
  now?: () => number;
  /** @internal Injectable jitter source, for deterministic backoff assertions. */
  random?: () => number;
}

export interface EventLaneRuntime {
  /** Whether the registry registered any Event stream. False → `appendEvent` throws and no driver is stood up. */
  readonly hasStreams: boolean;
  appendEvent: (stream: string, payload: unknown) => Promise<EventAppendResult>;
  /** Drain the Outbox: assemble, POST and settle batches until nothing more is eligible this pass. */
  flush: () => Promise<void>;
  /** The current drain signal, read from the store. */
  outboxStatus: () => Promise<OutboxStatus>;
  /** Subscribe to the drain signal; the CURRENT state is delivered on subscribe. Returns an unsubscribe. */
  onOutboxStatus: (listener: (status: OutboxStatus) => void) => () => void;
  /** Subscribe to per-flush reports. Ephemeral (nothing is retained); returns an unsubscribe. */
  onEventLaneReport: (listener: (report: EventLaneReport) => void) => () => void;
  /** Abort any in-flight flush request (the teardown seam, mirroring the mutation runtime's). */
  abortInFlight: () => void;
}

// ─── Typed append refusals ───────────────────────────────────────────────────────────────────────────

/** The registry registered no Event stream at all, so there is nothing an append could target. */
export class EventStreamsNotRegisteredError extends Error {
  constructor() {
    super(
      "pgxsinkit: no Event streams registered — `appendEvent` needs a `streams` entry on the sync registry " +
        "(defineSyncRegistry({ tables, streams: { <name>: defineEventStream({ … }) } })).",
    );
    this.name = "EventStreamsNotRegisteredError";
  }
}

/** `appendEvent` named an Event stream this registry does not register — a call-site bug, never a rollout. */
export class UnknownEventStreamError extends Error {
  readonly stream: string;
  constructor(stream: string, known: readonly string[]) {
    super(
      `pgxsinkit: unknown Event stream "${stream}" — this registry registers [${known.join(", ")}]. ` +
        "Register it with `defineEventStream` or fix the name.",
    );
    this.name = "UnknownEventStreamError";
    this.stream = stream;
  }
}

/** The payload failed the Event stream's registered zod schema. Validated at append so the Outbox stays well-formed. */
export class EventPayloadInvalidError extends Error {
  readonly stream: string;
  constructor(stream: string, detail: string) {
    super(`pgxsinkit: event payload for Event stream "${stream}" failed its registered schema — ${detail}`);
    this.name = "EventPayloadInvalidError";
    this.stream = stream;
  }
}

/** The serialized payload exceeded {@link MAX_EVENT_PAYLOAD_BYTES}; the server would reject it per-event anyway. */
export class EventPayloadTooLargeError extends Error {
  readonly stream: string;
  readonly byteLength: number;
  constructor(stream: string, byteLength: number) {
    super(
      `pgxsinkit: event payload for Event stream "${stream}" is ${byteLength} bytes, over the ` +
        `${MAX_EVENT_PAYLOAD_BYTES}-byte per-event limit. Events are facts, not documents — carry a reference, not the document.`,
    );
    this.name = "EventPayloadTooLargeError";
    this.stream = stream;
    this.byteLength = byteLength;
  }
}

/** A non-2xx flush response. Batch-level by construction: a well-formed envelope always gets a per-event verdict. */
class EventRequestError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(message: string, status: number, retryAfterMs: number | null) {
    super(message);
    this.name = "EventRequestError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// ─── URL + header resolution (the mutation client's idioms) ──────────────────────────────────────────

const CANONICAL_EVENT_PATH = batchEventPaths[0];

function invalidBatchEventUrl(): Error {
  return new Error(
    `[pgxsinkit] batchEventUrl must be "${CANONICAL_EVENT_PATH}" or an absolute deployment URL ending in "${CANONICAL_EVENT_PATH}"`,
  );
}

/**
 * Resolve the ingestion endpoint under the same HARD-REQUIRED-PATH rule the mutation client applies to
 * `batchWriteUrl`: a relative URL must BE the canonical path, an absolute one must end in it, and neither
 * may carry a query or fragment. The endpoint is toolkit-owned (`createSyncServer` mounts it), so a URL that
 * cannot be it is a configuration error worth failing on at boot rather than at the first append.
 */
export function resolveBatchEventUrl(batchEventUrl: string): string {
  if (batchEventUrl.trim() !== batchEventUrl || batchEventUrl.length === 0) {
    throw invalidBatchEventUrl();
  }

  const isRelative = batchEventUrl.startsWith("/") && !batchEventUrl.startsWith("//");
  let parsed: URL;
  try {
    parsed = isRelative ? new URL(batchEventUrl, "https://pgxsinkit.invalid") : new URL(batchEventUrl);
  } catch {
    throw invalidBatchEventUrl();
  }

  const hasCanonicalPath = isRelative
    ? parsed.pathname === CANONICAL_EVENT_PATH
    : ["http:", "https:"].includes(parsed.protocol) && parsed.pathname.endsWith(CANONICAL_EVENT_PATH);
  if (!hasCanonicalPath || parsed.search !== "" || parsed.hash !== "") {
    throw invalidBatchEventUrl();
  }

  return batchEventUrl;
}

/**
 * The ingestion endpoint DERIVED from the mutation endpoint, for the ordinary deployment where one
 * `createSyncServer` mounts both: `…/api/mutations` → `…/api/events`. Returns `undefined` when the write URL
 * is not in the canonical shape, so the caller can stay silent rather than guess (the lane is then only
 * usable with an explicit `batchEventUrl`).
 */
export function deriveBatchEventUrl(batchWriteUrl: string): string | undefined {
  const suffix = "/api/mutations";
  if (!batchWriteUrl.endsWith(suffix)) {
    return undefined;
  }
  const candidate = `${batchWriteUrl.slice(0, -suffix.length)}${CANONICAL_EVENT_PATH}`;
  try {
    return resolveBatchEventUrl(candidate);
  } catch {
    return undefined;
  }
}

function buildRequestHeaders(bearerToken?: string, requestHeaders?: Record<string, string>): Record<string, string> {
  // Static headers first so the toolkit-owned Content-Type/Authorization always win (mutation.ts's rule).
  return {
    ...(requestHeaders ?? {}),
    "Content-Type": "application/json",
    ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
  };
}

// ─── Retry classification (ADR-0053 decision 4) ──────────────────────────────────────────────────────

/** Auth statuses: refresh the token once, then treat a repeat as ordinary retryable congestion. */
const AUTH_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * The lane has EXACTLY TWO retry classes, and this is the whole rule. Unlike the mutation path there is no
 * third, terminal class: a structural 4xx (400/404/413) is unreachable through the library (appends are
 * validated, envelopes are library-built), and quarantining events on one would discard data the server
 * never rejected — which at-least-once forbids. So everything that is not auth is retryable.
 */
export function classifyEventBatchFailure(httpStatus: number | null | undefined): "auth" | "retryable" {
  return httpStatus != null && AUTH_STATUSES.has(httpStatus) ? "auth" : "retryable";
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms, or null when absent/unreadable. */
export function parseRetryAfterMs(headerValue: string | null | undefined, nowMs: number): number | null {
  if (headerValue == null) {
    return null;
  }
  const trimmed = headerValue.trim();
  if (trimmed === "") {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isNaN(parsedDate)) {
    return null;
  }
  return Math.max(0, parsedDate - nowMs);
}

/**
 * Jittered exponential backoff with a ceiling — equal jitter around the doubling ceiling, exactly the
 * mutation path's congestion policy (half the ceiling plus a random share of the other half), so a fleet
 * recovering from an outage never stampedes in lockstep.
 */
export function computeEventBackoffMs(attempt: number, options: EventBackoffOptions, random: () => number): number {
  const baseMs = options.baseMs ?? DEFAULT_EVENT_BACKOFF_BASE_MS;
  const ceilingMs = options.ceilingMs ?? DEFAULT_EVENT_BACKOFF_CEILING_MS;
  const exponent = Math.max(attempt - 1, 0);
  const ceiling = Math.min(baseMs * 2 ** exponent, ceilingMs);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

// ─── Runtime ─────────────────────────────────────────────────────────────────────────────────────────

interface OutboxRow extends Record<string, unknown> {
  seq: string;
  eventId: string;
  stream: string;
  occurredAtUs: string;
  payload: unknown;
  attemptCount: number;
}

/** One assembled batch: the wire envelopes plus the local rows they map back to. */
interface AssembledBatch {
  envelopes: EventEnvelope[];
  rowsByEventId: Map<string, OutboxRow>;
  /** True when assembly stopped on the request-byte cap rather than running out of eligible rows. */
  clampedByBytes: boolean;
}

const encoder = new TextEncoder();

function byteLengthOf(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Fail-closed validation of the client's Event-lane tuning, at CONSTRUCTION (the consumer runner's posture,
 * mirrored on the client half — and it names EVERY offender in one error rather than one per boot).
 *
 * This exists because the failure mode of a typo here is silence, not an exception. A per-stream `batchSize`
 * of `0`/`-1`/`NaN` makes batch assembly hold every row of that stream back, so the pass exits with no
 * request and no report and the stream wedges INDEFINITELY while appends keep piling into the Outbox. A
 * broken interval or backoff bound reaches the timer/backoff machinery just as quietly. A configuration typo
 * must be a boundary error, never a runtime behaviour.
 *
 * The bounds mirror `defineEventConsumer`'s: counts are integers >= 1, a backoff FLOOR may legitimately be
 * `0` (retry on the very next pass — the per-pass "one attempt per row" guard is what stops a spin), and a
 * ceiling may not sit below its floor.
 *
 * Backoff bounds are judged on the RESOLVED pair — defaults (and, per stream, the global tuning) filled in
 * FIRST — never on what happens to be written down. `{ baseMs: 600_000 }` alone looks coherent and is not:
 * the omitted ceiling takes the 300,000 ms default, so even a maximum-jitter first delay is capped to half
 * the ten-minute base that was asked for, silently. The pair the machinery will actually run under is the
 * only pair worth checking.
 */
export function validateEventLaneOptions(options: EventLaneOptions): void {
  const problems: string[] = [];

  const requireCount = (label: string, value: number | undefined): void => {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      problems.push(`\`${label}\` must be an integer >= 1 (got ${String(value)})`);
    }
  };
  const requireMs = (label: string, value: number | undefined, minimum: number): void => {
    if (value !== undefined && (!Number.isFinite(value) || value < minimum)) {
      problems.push(`\`${label}\` must be a finite number >= ${minimum} (got ${String(value)})`);
    }
  };

  /** One resolved bound, carrying WHERE its value came from so an incoherence names the real culprit. */
  interface ResolvedBound {
    value: number;
    /** `null` when the value is still the library default; otherwise the label that supplied it. */
    setBy: string | null;
  }
  type ResolvedBackoff = { baseMs: ResolvedBound; ceilingMs: ResolvedBound };

  const defaults: ResolvedBackoff = {
    baseMs: { value: DEFAULT_EVENT_BACKOFF_BASE_MS, setBy: null },
    ceilingMs: { value: DEFAULT_EVENT_BACKOFF_CEILING_MS, setBy: null },
  };
  const originOf = (bound: ResolvedBound, label: string): string =>
    bound.setBy === null ? "the default" : bound.setBy === label ? "configured" : `inherited from \`${bound.setBy}\``;

  /**
   * Validate one backoff and return the bounds it will RUN under. `inherited` is what an omitted bound falls
   * back to — the defaults for the global tuning, the resolved global tuning for a per-stream override —
   * exactly the composition `backoffFor` performs at runtime.
   */
  const requireBackoff = (
    label: string,
    backoff: EventBackoffOptions | undefined,
    inherited: ResolvedBackoff,
  ): ResolvedBackoff => {
    requireMs(`${label}.baseMs`, backoff?.baseMs, 0);
    requireMs(`${label}.ceilingMs`, backoff?.ceilingMs, 0);

    const resolve = (configured: number | undefined, fallback: ResolvedBound): ResolvedBound =>
      configured === undefined ? fallback : { value: configured, setBy: label };
    const resolved: ResolvedBackoff = {
      baseMs: resolve(backoff?.baseMs, inherited.baseMs),
      ceilingMs: resolve(backoff?.ceilingMs, inherited.ceilingMs),
    };

    // Only judge a pair both of whose numbers are usable — an unusable one is already its own problem.
    if (
      Number.isFinite(resolved.baseMs.value) &&
      Number.isFinite(resolved.ceilingMs.value) &&
      resolved.ceilingMs.value < resolved.baseMs.value
    ) {
      problems.push(
        `\`${label}\` resolves to a ceiling BELOW its base — ceilingMs ${resolved.ceilingMs.value} ` +
          `(${originOf(resolved.ceilingMs, label)}) < baseMs ${resolved.baseMs.value} ` +
          `(${originOf(resolved.baseMs, label)}); the base would never be waited, because every delay is ` +
          "clamped to the ceiling",
      );
    }
    return resolved;
  };

  requireCount("events.batchSize", options.batchSize);
  requireMs("events.intervalMs", options.intervalMs, 1);
  const globalBackoff = requireBackoff("events.backoff", options.backoff, defaults);

  for (const [stream, streamOptions] of Object.entries(options.streams ?? {})) {
    if (streamOptions == null || typeof streamOptions !== "object") {
      problems.push(`\`events.streams.${stream}\` must be an object of per-stream flush overrides`);
      continue;
    }
    requireCount(`events.streams.${stream}.batchSize`, streamOptions.batchSize);
    // A per-stream override inherits the GLOBAL bound it does not set, so that is the ceiling it will
    // actually run under — a per-stream base has to cohere with it, not merely with the default.
    requireBackoff(`events.streams.${stream}.backoff`, streamOptions.backoff, globalBackoff);
  }

  if (problems.length > 0) {
    throw new Error(
      `pgxsinkit: invalid Event-lane tuning on the sync client (the \`events\` option) — ${problems.join("; ")}.`,
    );
  }
}

export function createEventLaneRuntime<TRegistry extends SyncTableRegistry>(
  options: CreateEventLaneRuntimeOptions<TRegistry>,
): EventLaneRuntime {
  // Before anything else, including any store access: nonsense tuning must fail at construction.
  validateEventLaneOptions(options.events ?? {});
  // Statements are AUTHORED as Drizzle builders over the Outbox table object (rename-safe, typed, schema
  // qualification handled by the object) and rendered to text+params here, because they EXECUTE through the
  // caller's raw `EventLaneDb` seam — the same arrangement the mutation runtime uses. The connection-less
  // builder is created on FIRST STATEMENT, not at import and not at construction: a client whose registry
  // registers no Event stream never authors one, and the lane should cost it nothing.
  let queryBuilderCache: ReturnType<typeof drizzle.mock> | null = null;
  const queryBuilder = (): ReturnType<typeof drizzle.mock> => (queryBuilderCache ??= drizzle.mock());
  const streams = getSyncRegistryStreams(options.registry);
  const streamNames = streams ? Object.keys(streams) : [];
  const hasStreams = streamNames.length > 0;
  const outbox = getOutboxTable(options.registry);
  const eventUrl = resolveBatchEventUrl(options.batchEventUrl);
  const clockMs = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const laneOptions = options.events ?? {};
  // Clamp to the contracts-level cap: the server enforces it independently of any client tuning, so a
  // client configured above it would only ever produce 413s.
  const batchSize = Math.max(1, Math.min(laneOptions.batchSize ?? DEFAULT_EVENT_BATCH_SIZE, MAX_EVENTS_PER_BATCH));

  const nowUs = (): string => (BigInt(clockMs()) * 1000n).toString();
  const backoffFor = (stream?: string): EventBackoffOptions => ({
    ...(laneOptions.backoff ?? {}),
    ...((stream != null ? laneOptions.streams?.[stream]?.backoff : undefined) ?? {}),
  });

  const disposeController = new AbortController();

  // ─── Observation surfaces ──────────────────────────────────────────────────────────────────────────
  const statusListeners = new Set<(status: OutboxStatus) => void>();
  const reportListeners = new Set<(report: EventLaneReport) => void>();
  /** The last drain state we published. `null` until the first read — subscribe then defers to the probe. */
  let currentEmpty: boolean | null = null;

  const publishEmpty = (empty: boolean): void => {
    if (currentEmpty === empty) {
      return;
    }
    currentEmpty = empty;
    for (const listener of statusListeners) {
      listener({ empty });
    }
  };

  /**
   * The drain signal's read. Deliberately `LIMIT 1`, never `count(*)`: the signal is a BOOLEAN, and an
   * Outbox designed to hold offline weeks would make a counting scan the expensive part of every flush pass
   * and every lifecycle check. (An app that genuinely wants a count queries the table itself.)
   */
  const isOutboxEmpty = async (): Promise<boolean> => {
    const query = queryBuilder()
      .select({ one: sql<number>`1`.as("one") })
      .from(outbox)
      .limit(1)
      .toSQL();
    const result = await options.db.query<{ one: number }>(query.sql, query.params as unknown[]);
    return result.rows.length === 0;
  };

  const refreshDrainSignal = async (): Promise<boolean> => {
    const empty = await isOutboxEmpty();
    publishEmpty(empty);
    return empty;
  };

  // The first read of the drain signal, kicked off eagerly so a subscriber that arrives before any append
  // or flush still gets the CURRENT state delivered (never a silent subscription). Failures are swallowed:
  // an unreadable Outbox at boot is a store problem the boot path itself reports.
  const initialProbe = refreshDrainSignal().catch((error: unknown) => {
    syncDebug("event lane: initial drain-signal probe failed", { error });
    return false;
  });

  const emitReport = (report: EventLaneReport): void => {
    if (report.terminal.length === 0 && report.deferred.length === 0 && report.backoff == null) {
      return;
    }
    if (reportListeners.size === 0) {
      // The `onDeadLetter` idiom: a surface nobody subscribed to still must not be silent. Everything on
      // this report is something the Outbox can no longer answer for (a deleted row's terminal verdict) or
      // something an operator needs to see (a rollout skew, a lane in backoff).
      console.warn("pgxsinkit: event-lane report (no `onEventLaneReport` subscriber)", report);
      return;
    }
    for (const listener of reportListeners) {
      listener(report);
    }
  };

  // ─── Append (ADR-0053 decision 2) ──────────────────────────────────────────────────────────────────
  const resolveStreamEntry = (stream: string): EventStreamEntry => {
    if (!hasStreams) {
      throw new EventStreamsNotRegisteredError();
    }
    const entry = streams?.[stream];
    if (!entry) {
      throw new UnknownEventStreamError(stream, streamNames);
    }
    return entry;
  };

  /**
   * Stage one event (ADR-0053 decision 2).
   *
   * **Validation here, the authoritative parse at ingest.** The registered payload schema is the contract,
   * checked HERE so a malformed payload is a synchronous call-site failure rather than a server verdict on a
   * row already in the Outbox — but this run is a VALIDATION, and its OUTPUT IS DISCARDED. What lands in the
   * Outbox (and therefore on the wire) is EXACTLY the value the caller supplied, never `parsed.data`: the
   * ingestion endpoint's parse is the ONE authoritative one, and the JSON-NORMALIZED form of its output is
   * what the consumer receives (a `Date` becomes its ISO string; a nested `undefined` property is dropped).
   * Taking this run's output instead would hand the server an already-transformed value to re-parse — a
   * terminal `rejected` for a perfectly valid append. The per-event size cap is measured on that same
   * original serialization, for the same reason: it is what the request will carry.
   *
   * So the schema EXECUTES at both boundaries even though only one execution's result is ever taken: a
   * transform callback runs once here and once at ingest. **Transforms must therefore be pure and
   * deterministic** — an effectful or environment-dependent transform is unsupported, because the server's
   * run is the one that counts and nothing reconciles it against this one. Parse output that JSON cannot
   * carry (a `BigInt`, `undefined`) is a terminal per-event `rejected` at ingest.
   */
  const appendEvent = async (stream: string, payload: unknown): Promise<EventAppendResult> => {
    const entry = resolveStreamEntry(stream);

    if (!isZodSchema(entry.payload)) {
      throw new EventPayloadInvalidError(stream, "its registration does not carry a usable zod schema");
    }
    const parsed = entry.payload.safeParse(payload);
    if (!parsed.success) {
      throw new EventPayloadInvalidError(stream, parsed.error.message);
    }

    const payloadJson = JSON.stringify(payload);
    if (payloadJson === undefined) {
      throw new EventPayloadInvalidError(stream, "the payload is not JSON-serializable");
    }
    const byteLength = byteLengthOf(payloadJson);
    if (byteLength > MAX_EVENT_PAYLOAD_BYTES) {
      throw new EventPayloadTooLargeError(stream, byteLength);
    }

    const eventId = globalThis.crypto.randomUUID();
    const occurredAtUs = nowUs();
    const insert = queryBuilder()
      .insert(outbox)
      .values({
        eventId,
        stream,
        occurredAtUs,
        // Bound as a jsonb param, never baked into the statement text.
        payload: sql`${payloadJson}::jsonb`,
        enqueuedAtUs: occurredAtUs,
      })
      .returning({ seq: sql<string>`${outbox.seq}::text`.as("seq") })
      .toSQL();
    const inserted = await options.db.query<{ seq: string }>(insert.sql, insert.params as unknown[]);
    const seq = String(inserted.rows[0]?.seq ?? "");

    // The append resolves on DURABLE local enqueue under the store's declared durability — no special
    // casing: the INSERT above went through the same store as every other local write.
    publishEmpty(false);
    return { eventId, occurredAtUs, seq };
  };

  // ─── Batch assembly (ADR-0053 decisions 3 + 4) ─────────────────────────────────────────────────────

  /** The configured per-stream caps, as `[stream, cap]` pairs. Empty → no fairness filter is needed at all. */
  const streamCaps: [string, number][] = Object.entries(laneOptions.streams ?? {}).flatMap(([stream, streamOptions]) =>
    streamOptions?.batchSize != null ? [[stream, streamOptions.batchSize] as const] : [],
  );

  /**
   * A row deferred by the server waits out its own backoff; every other row is eligible.
   */
  const eligibleNow = () => or(isNull(outbox.nextRetryAtUs), lte(outbox.nextRetryAtUs, nowUs()));

  const readEligibleRows = async (limit: number): Promise<OutboxRow[]> => {
    // Rows come back through the RAW seam (no drizzle result mapping), so every column is aliased to its
    // PROPERTY key — the mutation runtime's `buildPendingRowsProjection` idiom. `_us` bigints cast to
    // `text` so they arrive as exact decimal strings rather than lossy JS numbers.
    const project = <TSource extends typeof outbox | ReturnType<typeof rankedEligible>>(source: TSource) => ({
      seq: sql<string>`${source.seq}::text`.as("seq"),
      eventId: sql<string>`${source.eventId}`.as("eventId"),
      stream: sql<string>`${source.stream}`.as("stream"),
      occurredAtUs: sql<string>`${source.occurredAtUs}::text`.as("occurredAtUs"),
      payload: sql<unknown>`${source.payload}`.as("payload"),
      attemptCount: sql<number>`${source.attemptCount}`.as("attemptCount"),
    });

    // `seq` is the ONE ordering key — across ALL Event streams, so one batch is a mixed, append-ordered
    // slice — and with no per-stream cap configured that is the whole query.
    const query =
      streamCaps.length === 0
        ? queryBuilder().select(project(outbox)).from(outbox).where(eligibleNow()).orderBy(asc(outbox.seq)).limit(limit)
        : (() => {
            // Fairness has to happen IN SQL, before the global `ORDER BY seq LIMIT`. Ranking each stream's
            // eligible rows by `seq` and dropping the over-cap ones FIRST is what makes the cap mean what it
            // says: a chatty stream's surplus never occupies the selection window, so a quieter stream rides
            // the same batch. (Capping after a global `LIMIT` — the shape this replaces — only shrank the
            // request: if the earliest `batchSize` rows were all stream A, stream B stayed invisible until
            // A's whole backlog had drained, one small A-only request at a time.)
            const ranked = rankedEligible();
            return queryBuilder()
              .select(project(ranked))
              .from(ranked)
              .where(
                or(
                  // An uncapped stream is unconstrained; a capped one rides only its first `cap` rows.
                  notInArray(
                    ranked.stream,
                    streamCaps.map(([stream]) => stream),
                  ),
                  ...streamCaps.map(([stream, cap]) => and(eq(ranked.stream, stream), lte(ranked.streamRank, cap))),
                ),
              )
              .orderBy(asc(ranked.seq))
              .limit(limit);
          })();

    const compiled = query.toSQL();
    const result = await options.db.query<OutboxRow>(compiled.sql, compiled.params as unknown[]);
    return result.rows;
  };

  /** The eligible rows, each carrying its 1-based rank WITHIN its own Event stream in `seq` order. */
  function rankedEligible() {
    return queryBuilder()
      .select({
        seq: outbox.seq,
        eventId: outbox.eventId,
        stream: outbox.stream,
        occurredAtUs: outbox.occurredAtUs,
        payload: outbox.payload,
        attemptCount: outbox.attemptCount,
        streamRank: sql<number>`row_number() OVER (PARTITION BY ${outbox.stream} ORDER BY ${outbox.seq})`.as(
          "stream_rank",
        ),
      })
      .from(outbox)
      .where(eligibleNow())
      .as("eligible");
  }

  /**
   * Assemble one batch from the eligible rows: append order by `seq`, clamped by the batch size, any
   * per-stream caps, AND the contracts-level request-byte cap. At least one event always rides (a single
   * payload cannot exceed the body cap — the per-event cap is 64 KiB against a 4 MiB body).
   */
  const assembleBatch = (rows: readonly OutboxRow[]): AssembledBatch => {
    const envelopes: EventEnvelope[] = [];
    const rowsByEventId = new Map<string, OutboxRow>();
    const perStreamCount = new Map<string, number>();
    // `{"events":[]}` framing; each additional envelope also costs a comma.
    let requestBytes = byteLengthOf('{"events":[]}');
    let clampedByBytes = false;

    for (const row of rows) {
      if (envelopes.length >= batchSize) {
        break;
      }
      const streamCap = laneOptions.streams?.[row.stream]?.batchSize;
      const taken = perStreamCount.get(row.stream) ?? 0;
      if (streamCap != null && taken >= streamCap) {
        continue;
      }

      const envelope: EventEnvelope = {
        stream: row.stream,
        eventId: row.eventId,
        occurredAtUs: String(row.occurredAtUs),
        payload: row.payload,
      };
      const envelopeBytes = byteLengthOf(JSON.stringify(envelope)) + (envelopes.length > 0 ? 1 : 0);
      if (envelopes.length > 0 && requestBytes + envelopeBytes > MAX_EVENT_REQUEST_BYTES) {
        clampedByBytes = true;
        break;
      }

      requestBytes += envelopeBytes;
      perStreamCount.set(row.stream, taken + 1);
      envelopes.push(envelope);
      rowsByEventId.set(row.eventId, row);
    }

    return { envelopes, rowsByEventId, clampedByBytes };
  };

  // ─── Verdict settlement ────────────────────────────────────────────────────────────────────────────
  const deleteEvents = async (eventIds: readonly string[]): Promise<void> => {
    if (eventIds.length === 0) {
      return;
    }
    const query = queryBuilder()
      .delete(outbox)
      .where(inArray(outbox.eventId, [...eventIds]))
      .toSQL();
    await options.db.query(query.sql, query.params as unknown[]);
  };

  /** Park one deferred row: bump its attempt count and push its next retry out by the jittered backoff. */
  const deferEvent = async (row: OutboxRow, reason: string | undefined): Promise<void> => {
    const attempt = row.attemptCount + 1;
    const delayMs = computeEventBackoffMs(attempt, backoffFor(row.stream), random);
    const nextRetryAtUs = (BigInt(nowUs()) + BigInt(delayMs) * 1000n).toString();
    const query = queryBuilder()
      .update(outbox)
      .set({
        attemptCount: attempt,
        nextRetryAtUs,
        lastReason: reason ?? null,
      })
      .where(eq(outbox.eventId, row.eventId))
      .toSQL();
    await options.db.query(query.sql, query.params as unknown[]);
  };

  // ─── Batch-level backoff state (in memory: it is congestion, not durable intent) ───────────────────
  let batchAttempt = 0;
  let batchRetryAtMs = 0;

  const enterBatchBackoff = (
    message: string,
    httpStatus: number | null,
    retryAfterMs: number | null,
  ): EventLaneBackoffTransition => {
    batchAttempt += 1;
    // `Retry-After` is the server's own instruction (ADR-0053 decision 4: the endpoint returns it with a
    // 503 when the queue is unavailable) — honour it over our own backoff when it asks for longer.
    const backoffMs = computeEventBackoffMs(batchAttempt, backoffFor(), random);
    const delayMs = Math.max(backoffMs, retryAfterMs ?? 0);
    batchRetryAtMs = clockMs() + delayMs;
    return {
      state: "entered",
      retryInMs: delayMs,
      attempt: batchAttempt,
      ...(httpStatus != null ? { httpStatus } : {}),
      reason: message,
    };
  };

  const clearBatchBackoff = (): EventLaneBackoffTransition | undefined => {
    if (batchAttempt === 0) {
      return undefined;
    }
    batchAttempt = 0;
    batchRetryAtMs = 0;
    return { state: "cleared" };
  };

  // ─── One POST ──────────────────────────────────────────────────────────────────────────────────────
  const postBatch = async (envelopes: readonly EventEnvelope[]): Promise<EventAck[]> => {
    const body = JSON.stringify({ events: envelopes });
    const signal = disposeController.signal;
    const send = async (token: string | undefined): Promise<Response> =>
      fetch(eventUrl, {
        method: "POST",
        headers: buildRequestHeaders(token, options.requestHeaders),
        body,
        signal,
      });

    let response = await send(await options.getAuthToken?.());
    if (classifyEventBatchFailure(response.status) === "auth" && !response.ok && options.getAuthToken) {
      // Refresh ONCE (the mutation client's rule): a second auth failure is ordinary retryable congestion,
      // never a terminal verdict — only the server may retire an event.
      response = await send(await options.getAuthToken());
    }

    if (!response.ok) {
      const text = await response.text();
      throw new EventRequestError(
        parseBatchEventErrorMessage(text) ??
          (text.length > 0 ? text : `Event ingestion responded with ${response.status}`),
        response.status,
        parseRetryAfterMs(response.headers.get("Retry-After"), clockMs()),
      );
    }

    const parsed = batchEventAckSchema.safeParse(await response.json());
    if (!parsed.success) {
      // A 2xx we cannot read is a transport-shaped fault, not a verdict: retry, never discard.
      throw new EventRequestError(
        `Event ingestion returned an unreadable ack body: ${parsed.error.message}`,
        response.status,
        null,
      );
    }
    return parsed.data.acks;
  };

  // ─── The flush pass ────────────────────────────────────────────────────────────────────────────────
  /** Settle one assembled batch's verdicts; returns the report fragments it produced. */
  const settleAcks = async (
    batch: AssembledBatch,
    acks: readonly EventAck[],
  ): Promise<{ terminal: EventLaneVerdict[]; deferred: EventLaneVerdict[]; settledCount: number }> => {
    const terminal: EventLaneVerdict[] = [];
    const deferred: EventLaneVerdict[] = [];
    const deletable: string[] = [];

    for (const ack of acks) {
      const row = batch.rowsByEventId.get(ack.eventId);
      if (!row) {
        // A verdict for an event we did not send. Nothing to settle; worth seeing on the rail.
        syncDebug("event lane: ack for an event that was not in this batch", { eventId: ack.eventId });
        continue;
      }
      const verdict: EventLaneVerdict = {
        eventId: ack.eventId,
        stream: row.stream,
        status: ack.status,
        ...(ack.reason != null ? { reason: ack.reason } : {}),
      };

      if (ack.status === "deferred") {
        // NOT terminal (ADR-0053 decision 3): an Event stream the server does not yet know is ordinary
        // rollout skew, and deleting those events would be data loss on a normal path.
        await deferEvent(row, ack.reason);
        deferred.push(verdict);
        continue;
      }

      deletable.push(ack.eventId);
      if (ack.status !== "acked") {
        // `refused` (gating) and `rejected` (schema-invalid/oversized for a KNOWN stream) are terminal and
        // reported: once the row is deleted the Outbox can no longer answer what happened to it.
        terminal.push(verdict);
      }
    }

    // An envelope the server answered for at all is settled; one it did not answer for stays put and rides
    // the next batch (the server owes a verdict per well-formed envelope, so this is a server bug, not a
    // reason to discard).
    await deleteEvents(deletable);
    return { terminal, deferred, settledCount: deletable.length + deferred.length };
  };

  let flushChain: Promise<void> = Promise.resolve();

  const runFlush = async (): Promise<void> => {
    if (!hasStreams) {
      return;
    }
    if (batchAttempt > 0 && clockMs() < batchRetryAtMs) {
      syncDebug("event lane: flush skipped (batch-level backoff)", {
        retryInMs: batchRetryAtMs - clockMs(),
        attempt: batchAttempt,
      });
      return;
    }

    const terminal: EventLaneVerdict[] = [];
    const deferred: EventLaneVerdict[] = [];
    let backoff: EventLaneBackoffTransition | undefined;
    // Rows this pass already deferred. Their backoff normally lifts them out of the eligible window, but a
    // zero-ish configured backoff (or a frozen clock) would leave them selectable — and re-posting a row the
    // server just deferred is a spin, not a retry. One pass, one attempt per row.
    const deferredThisPass = new Set<string>();

    // Drain in slices until nothing more is eligible. Progress is guaranteed: every settled row leaves the
    // eligible set — deleted on a terminal verdict, or parked by its deferred backoff (and, belt and braces,
    // by `deferredThisPass`) — so a slice that settles nothing ends the pass.
    for (;;) {
      const rows = (await readEligibleRows(batchSize)).filter((row) => !deferredThisPass.has(row.eventId));
      if (rows.length === 0) {
        break;
      }
      const batch = assembleBatch(rows);
      if (batch.envelopes.length === 0) {
        // Every eligible row was held out by a per-stream cap this pass; the next pass reorders nothing but
        // the caps reset, so stop rather than spin.
        break;
      }

      let acks: EventAck[];
      try {
        acks = await postBatch(batch.envelopes);
      } catch (error) {
        const status = error instanceof EventRequestError ? error.status : null;
        const retryAfterMs = error instanceof EventRequestError ? error.retryAfterMs : null;
        const message = error instanceof Error ? error.message : "Unknown event flush failure";
        // Two classes only: auth (already refreshed once inside `postBatch`) and retryable. Neither
        // deletes a row and neither counts toward any cap — the Outbox is the buffer.
        backoff = enterBatchBackoff(message, status, retryAfterMs);
        syncDebug("event lane: batch failed, entering backoff", {
          status,
          klass: classifyEventBatchFailure(status),
          retryInMs: backoff.retryInMs,
        });
        break;
      }

      const settled = await settleAcks(batch, acks);
      terminal.push(...settled.terminal);
      deferred.push(...settled.deferred);
      for (const verdict of settled.deferred) deferredThisPass.add(verdict.eventId);
      backoff = clearBatchBackoff() ?? backoff;

      if (settled.settledCount === 0) {
        break;
      }
    }

    await refreshDrainSignal().catch((error: unknown) => {
      syncDebug("event lane: drain-signal refresh failed", { error });
      return false;
    });
    emitReport({ terminal, deferred, ...(backoff ? { backoff } : {}) });
  };

  return {
    hasStreams,
    appendEvent,
    flush: async () => {
      // Serialise passes on one chain, exactly as the mutation runtime serialises flushes: two concurrent
      // passes would assemble overlapping batches and double-post events.
      const next = flushChain.then(() => runFlush());
      flushChain = next.catch(() => undefined);
      await next;
    },
    outboxStatus: async () => ({ empty: await isOutboxEmpty() }),
    onOutboxStatus: (listener) => {
      // Current state on subscribe (never a silent subscription), delivered EXACTLY once however the race
      // with the runtime's first read falls: if the state is already known, deliver now; if the initial
      // probe is still in flight, its own transition publish reaches this listener — and the `delivered`
      // guard is what stops the two paths from double-firing when the probe lands mid-subscribe.
      let delivered = false;
      const deliver = (status: OutboxStatus): void => {
        delivered = true;
        listener(status);
      };
      statusListeners.add(deliver);
      if (currentEmpty != null) {
        deliver({ empty: currentEmpty });
      } else {
        void initialProbe.then(() => {
          if (!delivered && statusListeners.has(deliver) && currentEmpty != null) {
            deliver({ empty: currentEmpty });
          }
        });
      }
      return () => {
        statusListeners.delete(deliver);
      };
    },
    onEventLaneReport: (listener) => {
      reportListeners.add(listener);
      return () => {
        reportListeners.delete(listener);
      };
    },
    // Terminal, exactly like the mutation runtime's: every caller (`haltActivity`, `stop`, `destroy`) is
    // tearing the client down, and a later flush must NOT sneak a request out against a closing store.
    abortInFlight: () => disposeController.abort(),
  };
}

/** Extract the server's `message` from a non-2xx ingestion body, or undefined when it is not the toolkit's shape. */
function parseBatchEventErrorMessage(body: string): string | undefined {
  if (body.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const result = batchEventErrorSchema.safeParse(parsed);
  return result.success ? result.data.message : undefined;
}

// ─── The flush driver (ADR-0053 decision 3, modelled on the convergence driver) ───────────────────────

/** The scheduling gate the event-lane driver shares with the convergence driver (`autoSync`'s trigger). */
export interface EventFlushGate {
  subscribe: (onSignal: () => void) => () => void;
  /** Whether a flush should run right now — the offline pause (ADR-0053 decision 4). */
  shouldFlush: () => boolean;
}

export interface EventFlushDriverOptions {
  flush: () => Promise<void>;
  /** The app's online/foreground gate, when one is installed. Absent → always flush. */
  gate?: EventFlushGate;
  /** The fallback interval. Defaults to {@link DEFAULT_EVENT_FLUSH_INTERVAL_MS}. */
  intervalMs?: number;
  /** Invoked after each pass with the error it raised, or `null`. */
  onPass?: (error: unknown) => void;
}

export interface EventFlushDriver {
  start: () => void;
  /** Stop scheduling and await any in-flight pass, so a caller can safely close the store afterwards. */
  stop: () => Promise<void>;
  /** Request a pass now — the nudge an append fires, coalesced exactly like an interval tick. */
  requestPass: () => void;
}

/**
 * Drive the Outbox flush: at most one pass in flight, a signal arriving mid-pass coalescing into a single
 * follow-up, an interval as the FALLBACK trigger (retries + recovery), and `requestPass` as the event-driven
 * path an append takes. `start()` runs a pass immediately, which is what drains events written offline after
 * a reconnect or a boot — no new append required.
 */
export function createEventFlushDriver(options: EventFlushDriverOptions): EventFlushDriver {
  const intervalMs = options.intervalMs ?? DEFAULT_EVENT_FLUSH_INTERVAL_MS;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let queued = false;
  let disposed = false;
  let currentPass: Promise<void> | null = null;

  const runPass = async (): Promise<void> => {
    if (disposed || running) {
      if (!disposed) {
        queued = true;
      }
      return;
    }
    if (options.gate && !options.gate.shouldFlush()) {
      // Offline/backgrounded: the Outbox keeps absorbing appends and the next online signal (or interval
      // tick) drains it. Nothing is lost by not trying.
      syncDebug("event lane: flush pass skipped (offline/backgrounded)");
      return;
    }

    running = true;
    let error: unknown = null;
    const pass = (async () => {
      try {
        await options.flush();
      } catch (passError) {
        error = passError;
      }
    })();
    currentPass = pass;
    await pass;
    running = false;
    currentPass = null;
    options.onPass?.(error);

    if (queued && !disposed) {
      queued = false;
      void runPass();
    }
  };

  return {
    start: () => {
      if (timer !== null || disposed) {
        return;
      }
      unsubscribe =
        options.gate?.subscribe(() => {
          void runPass();
        }) ?? null;
      timer = setInterval(() => {
        void runPass();
      }, intervalMs);
      // Boot/reconnect drain (ADR-0053): a pass runs immediately, so events written offline leave the
      // Outbox without waiting for a new append.
      void runPass();
    },
    stop: async () => {
      disposed = true;
      queued = false;
      unsubscribe?.();
      unsubscribe = null;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      await currentPass;
    },
    requestPass: () => {
      void runPass();
    },
  };
}
