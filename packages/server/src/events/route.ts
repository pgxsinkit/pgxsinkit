import {
  batchEventRequestSchema,
  getSyncRegistryStreams,
  isZodSchema,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENT_REQUEST_BYTES,
  MAX_EVENTS_PER_BATCH,
  type EventAck,
  type EventEnvelope,
  type EventQueueMessage,
  type EventStreamRegistry,
  type JwtClaims,
  type StampedEvent,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import type { FetchHandler } from "../router";
import { resolveEventIdentity } from "./identity";
import type { EventQueue, EventQueueExecutor } from "./queue";

/**
 * The **Event lane**'s ingestion endpoint (ADR-0053 decisions 3, 4 and 5): the mutation endpoint's sibling,
 * minus what events don't need. `createSyncServer` mounts it automatically at `batchEventPaths` when — and
 * only when — the registry registers at least one Event stream.
 *
 * Two shapes of verdict, and the split is the whole design:
 *
 * - **Framing is batch-level.** A body over the request cap OR an events array over the per-batch count cap
 *   (413), unparseable JSON or a body that fails the strict envelope parse (400), missing claims (401), or an
 *   unavailable queue (503) is a WHOLE-batch fault: a malformed item without a parseable `eventId` cannot
 *   receive a per-event verdict, and a queue that cannot take the batch must not half-take it.
 * - **Every well-formed envelope gets a per-event verdict.** `acked` (enqueued), `refused` (the gating hook
 *   said no), `rejected` (schema-invalid payload for a KNOWN stream, oversized payload, or an unresolvable
 *   identity claim) and `deferred` (an Event stream this server does not know — ordinary rollout skew, and
 *   the ONLY non-terminal verdict). A batch-level 400 on one bad event would wedge the whole Outbox behind
 *   that row, which is exactly what the layering avoids.
 *
 * It keeps the write path's **zero-startup-query** posture (ADR-0030): nothing is probed, verified or created
 * at construction — queue provisioning is deploy-time DDL — so the first statement this route sends is the
 * enqueue transaction itself.
 */

/** What the gating hook is told about one event. `identity` is already resolved from the verified claims. */
export interface EventGateInput {
  /** The Event-stream name — the key the hook dispatches on. */
  stream: string;
  /** The client's envelope, with its payload already validated against the stream's registered schema. */
  event: EventEnvelope;
  /** The verified claims of the ingesting request (`{}` when the registry needs none). */
  claims: JwtClaims;
  /** The server-stamped identity this event would carry onto the queue. */
  identity: Record<string, string>;
}

/** `true` allows; `false` or `{ allow: false, reason }` refuses (a TERMINAL `refused` verdict). */
export type EventGateDecision = boolean | { allow: boolean; reason?: string };

/**
 * The consent/entitlement gate (ADR-0053 decision 1): the one FUNCTION of the Event lane's contract, and so a
 * `createSyncServer` option rather than a registry field (the registry stays declarative data only).
 *
 * Called **once per event**, after the payload validated and the identity resolved, and before anything is
 * enqueued. Per-event (rather than per stream × batch) is the simplest correct shape: a consent or entitlement
 * decision may legitimately depend on the payload, and a per-batch hook could only express the subset that
 * does not. The claims are constant across a batch, so a hook that consults a store should memoize on them —
 * a batch can carry up to `MAX_EVENTS_PER_BATCH` events.
 *
 * A hook that THROWS fails the whole batch retryably (500, nothing enqueued): a gate that cannot decide must
 * never be read as "allow".
 */
export type EventGate = (input: EventGateInput) => EventGateDecision | Promise<EventGateDecision>;

/** What {@link EventsEnqueuedHook} is told about a request that enqueued something. */
export interface EventsEnqueuedInfo {
  /** The Event streams this request put a sub-batch onto, deduplicated, in first-appearance order. */
  streams: string[];
}

/**
 * Fired after a request has ENQUEUED at least one sub-batch (ADR-0053 amendment, 2026-08-02) — the
 * deployment-agnostic seam a serverless deployment uses to NUDGE its drain function.
 *
 * The library stays out of the transport: this hook hands over "something landed on these streams" and the
 * deployment decides what that means. A long-lived runner deployment wires nothing (its poller is already
 * about to read). A serverless one fires a fetch-and-forget at whatever endpoint calls the consumer's
 * `drainOnce()`, so an interactive append is drained in milliseconds rather than at the next scheduled tick.
 *
 * **It is latency, never delivery.** The scheduled sweep is the guarantee; a nudge that is lost, refused or
 * never sent costs nothing but time. So it is fire-and-forget by construction: it is called AFTER the
 * enqueue transaction committed, its return value is ignored (it is `void` — do not await anything through
 * it), and a throw is caught and warn-logged rather than affecting the response the client already earned.
 */
export type EventsEnqueuedHook = (info: EventsEnqueuedInfo) => void;

/** The minimal transaction seam the endpoint needs — satisfied by a drizzle `PgAsyncDatabase`. */
export interface EventIngestDb {
  transaction: <TResult>(callback: (tx: EventQueueExecutor) => Promise<TResult>) => Promise<TResult>;
}

export interface CreateEventIngestHandlerOptions {
  resolveAuthClaims?: (request: Request) => Promise<JwtClaims | null> | JwtClaims | null;
  eventGate?: EventGate;
  /** See {@link EventsEnqueuedHook}. Fired only when something was actually enqueued. */
  onEventsEnqueued?: EventsEnqueuedHook;
  logTimings?: boolean;
}

/**
 * What a 503 asks the client to wait, in seconds. The client honours `Retry-After` over its own jittered
 * backoff when it asks for longer, so this is a floor on the retry of a batch the queue could not take.
 */
export const EVENT_QUEUE_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

const encoder = new TextEncoder();

function byteLengthOf(value: string): number {
  return encoder.encode(value).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What {@link readBodyWithinLimit} answers with: the decoded body, or the batch-level status to return. */
type BodyRead = { ok: true; text: string } | { ok: false; status: 400 | 413 };

/**
 * Read the request body WHILE enforcing the byte cap, aborting the moment the accumulated bytes exceed it.
 *
 * `request.text()` would buffer the whole body first and measure afterwards, which protects the JSON parse
 * and the queue but NOT memory: `Content-Length` is a claim, and a chunked (or simply lying) caller can omit
 * or understate it. This endpoint is public, so the cap has to bound what is ever held — hence a reader loop
 * that counts as it goes and cancels the stream on the first chunk that crosses the line, buffering at most
 * one chunk past the cap and never the rest of the upload.
 *
 * A body that cannot be read at all (including a request with no body) is a 400: it is a framing fault, and
 * a batch-level one, exactly like unparseable JSON.
 */
async function readBodyWithinLimit(request: Request, limit: number): Promise<BodyRead> {
  const body = request.body;
  if (body == null) {
    return { ok: false, status: 400 };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value == null) {
        continue;
      }
      total += value.byteLength;
      if (total > limit) {
        // Stop the peer rather than draining the rest of an oversized upload into a buffer we will discard.
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400 };
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(buffer) };
}

function errorResponse(message: string, status: number, headers?: Record<string, string>): Response {
  // `batchEventErrorSchema`: a non-2xx is always a whole-batch fault, so the body carries a message and
  // nothing to attribute.
  return Response.json({ message }, { status, ...(headers ? { headers } : {}) });
}

/**
 * Whether ANY registered Event stream declares an identity field — i.e. whether ingest NEEDS verified claims.
 * The mutation path's posture, mirrored: it demands claims when the registry actually requires them (an RLS
 * policy or an `authClaim` managed field) rather than unconditionally. A registry whose streams declare no
 * identity at all stamps nothing from claims, so it does not force an auth adapter into existence.
 */
export function eventIngestRequiresClaims(streams: EventStreamRegistry): boolean {
  return Object.values(streams).some((entry) => Object.keys(entry.identity ?? {}).length > 0);
}

export function createEventIngestHandler<TRegistry extends SyncTableRegistry>(
  db: EventIngestDb,
  registry: TRegistry,
  queue: EventQueue,
  options: CreateEventIngestHandlerOptions = {},
): FetchHandler {
  const streams = getSyncRegistryStreams(registry) ?? {};
  const requiresClaims = eventIngestRequiresClaims(streams);
  const perfNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const handle = async (request: Request): Promise<Response> => {
    const started = options.logTimings ? perfNow() : 0;
    let authMs = 0;
    let enqueueMs = 0;

    const finish = (response: Response, eventCount: number): Response => {
      if (options.logTimings) {
        console.log(
          "[pgxsinkit-timing]",
          JSON.stringify({
            route: "events",
            authMs: Math.round(authMs),
            enqueueMs: Math.round(enqueueMs),
            totalMs: Math.round(perfNow() - started),
            events: eventCount,
            status: response.status,
          }),
        );
      }
      return response;
    };

    // 1. Request-shape limits, BEFORE any parse — and the cap BOUNDS MEMORY, it does not merely report on it
    //    afterwards. A truthful `Content-Length` is the cheap fast path (refused without reading a byte);
    //    otherwise the body is read through a counting reader that aborts the moment it crosses the cap, so a
    //    chunked or lying caller cannot make this public endpoint buffer an arbitrary upload.
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_EVENT_REQUEST_BYTES) {
      return finish(
        errorResponse(`Event batch body exceeds the ${MAX_EVENT_REQUEST_BYTES}-byte request limit`, 413),
        0,
      );
    }

    const bodyRead = await readBodyWithinLimit(request, MAX_EVENT_REQUEST_BYTES);
    if (!bodyRead.ok) {
      return finish(
        bodyRead.status === 413
          ? errorResponse(`Event batch body exceeds the ${MAX_EVENT_REQUEST_BYTES}-byte request limit`, 413)
          : errorResponse("Invalid batch event request: the body could not be read", 400),
        0,
      );
    }
    const rawText = bodyRead.text;

    // 2. Strict framing. Unreachable through the library (appends are validated, envelopes are library-built)
    //    — this layer exists for library bugs and non-library callers.
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(rawText);
    } catch {
      return finish(errorResponse("Invalid batch event request: the body is not valid JSON", 400), 0);
    }

    // Request-shape limits are 413, NOT 400 (ADR-0053 decision 3): an over-count is a LIMIT violation, and
    // the client must distinguish it from malformed framing. `batchEventRequestSchema` caps the array too, so
    // the count is checked here — after the JSON parse, before the strict parse — or the schema would answer
    // first with a 400. Only the count is read; every other malformation still falls through to the 400 below.
    if (isPlainObject(rawBody) && Array.isArray(rawBody["events"]) && rawBody["events"].length > MAX_EVENTS_PER_BATCH) {
      return finish(
        errorResponse(`Event batch carries more than the ${MAX_EVENTS_PER_BATCH}-event per-request limit`, 413),
        0,
      );
    }

    const framing = batchEventRequestSchema.safeParse(rawBody);
    if (!framing.success) {
      return finish(errorResponse(`Invalid batch event request: ${framing.error.message}`, 400), 0);
    }
    const events = framing.data.events;

    // 3. Claims, resolved through the ONE adapter the read and write paths share, so an event's attribution
    //    can never be authorized differently from a write.
    const authStart = options.logTimings ? perfNow() : 0;
    const resolvedClaims = await options.resolveAuthClaims?.(request);
    if (options.logTimings) authMs = perfNow() - authStart;

    if (requiresClaims && !isPlainObject(resolvedClaims)) {
      return finish(
        errorResponse("Event streams with claim-stamped identity require validated JWT claims", 401),
        events.length,
      );
    }
    const claims: JwtClaims = isPlainObject(resolvedClaims) ? resolvedClaims : {};

    // 4. Per-event verdicts, in request order. Survivors are split by Event stream — insertion order gives
    //    each stream's sub-batch the events in the order the client appended them (ADR-0053 decision 5).
    const acks: EventAck[] = [];
    const byStream = new Map<string, StampedEvent[]>();

    for (const event of events) {
      const entry = streams[event.stream];
      if (!entry) {
        // NOT terminal: a client rolled out ahead of its server is ordinary deployment skew, and deleting
        // its events would be data loss on a normal path.
        acks.push({
          eventId: event.eventId,
          status: "deferred",
          reason: `Unknown Event stream "${event.stream}" — this server registers none by that name`,
        });
        continue;
      }

      if (!isZodSchema(entry.payload)) {
        acks.push({
          eventId: event.eventId,
          status: "rejected",
          reason: `Event stream "${event.stream}" is registered without a usable payload schema`,
        });
        continue;
      }

      // THE authoritative parse: the one whose OUTPUT is taken. The JSON-NORMALIZED form of `parsed.data`
      // (never the raw envelope payload) is what gets stamped onto the queue and what the consumer callback
      // receives — the normalization is the JSON round-trip below, and it is part of the contract, not an
      // artefact: a transform producing a `Date` delivers that date's ISO STRING, and nested `undefined`
      // properties are dropped.
      //
      // The schema itself EXECUTES at both boundaries, and that is worth being exact about: `appendEvent`
      // already ran it on the client as pure validation — discarding the result and storing the caller's
      // original value — so what arrives here is the value that was appended, never a once-transformed one.
      // A transform CALLBACK therefore runs twice while its result is only ever taken once, which is exactly
      // why the lane requires transforms to be pure and deterministic: an effectful or environment-dependent
      // one is unsupported, because this server's run is the one that counts and nothing reconciles it
      // against the client's.
      const parsedPayload = entry.payload.safeParse(event.payload);
      if (!parsedPayload.success) {
        acks.push({
          eventId: event.eventId,
          status: "rejected",
          reason: `Payload failed the schema registered for Event stream "${event.stream}": ${parsedPayload.error.message}`,
        });
        continue;
      }

      // The authoritative parse's OUTPUT still has to reach the queue as JSON, and a schema is free to
      // produce something JSON cannot carry: `z.string().transform(BigInt)` makes `JSON.stringify` THROW,
      // and a transform returning `undefined` makes it RETURN `undefined`. Untrapped, the throw would fail
      // the WHOLE batch with a 500 — and the Outbox, having had no verdict, would resend that same event
      // forever, wedging every sibling behind it. So it is a TERMINAL per-event `rejected`, and deliberately
      // its own reason: labelling it "exceeds the byte limit" would send an author hunting a size problem
      // that does not exist. (The size check below stays exactly what it says.)
      //
      // This serialization is NOT merely a check — it IS the normalization the consumer contract names. A
      // successful `JSON.stringify` does not mean the value belongs to the JSON domain: a `Date` stringifies
      // to an ISO string, a nested `undefined` property vanishes, an `undefined` array member becomes `null`.
      // Enqueueing `parsedPayload.data` itself would hand an in-memory/fake queue the un-normalized value
      // while real pgmq (which serializes into `jsonb`) delivered the normalized one — the same event
      // observed as two different values depending on the backend. So these exact bytes are what is parsed
      // back and stamped below, and every backend, the fake and pgmq alike, sees the identical payload.
      let payloadJson: string | undefined;
      let serializationFailure: unknown;
      try {
        payloadJson = JSON.stringify(parsedPayload.data);
      } catch (error) {
        serializationFailure = error;
      }
      if (payloadJson === undefined) {
        const detail = serializationFailure instanceof Error ? serializationFailure.message : undefined;
        acks.push({
          eventId: event.eventId,
          status: "rejected",
          reason:
            `The payload schema's parse for Event stream "${event.stream}" produced a value that cannot be ` +
            `serialized as JSON${detail != null ? `: ${detail}` : ""}`,
        });
        continue;
      }

      if (byteLengthOf(payloadJson) > MAX_EVENT_PAYLOAD_BYTES) {
        acks.push({
          eventId: event.eventId,
          status: "rejected",
          reason: `Payload exceeds the ${MAX_EVENT_PAYLOAD_BYTES}-byte per-event limit`,
        });
        continue;
      }

      // Identity is resolved BEFORE the gate so the hook can consult the attribution it is gating; an
      // unresolvable identity is a rejection in its own right and never reaches the hook.
      const resolvedIdentity = resolveEventIdentity(claims, entry.identity ?? {});
      if (!resolvedIdentity.ok) {
        acks.push({
          eventId: event.eventId,
          status: "rejected",
          reason:
            `Identity field "${resolvedIdentity.field}" of Event stream "${event.stream}" could not be ` +
            `stamped from claim path ${JSON.stringify(resolvedIdentity.claimPath)}: ${resolvedIdentity.detail}`,
        });
        continue;
      }

      if (options.eventGate) {
        let decision: EventGateDecision;
        try {
          decision = await options.eventGate({
            stream: event.stream,
            event,
            claims,
            identity: resolvedIdentity.identity,
          });
        } catch (error) {
          // A gate that cannot decide must never be read as "allow". Fail the batch retryably: nothing is
          // enqueued, the Outbox keeps every row, and the client retries.
          console.error("[pgxsinkit] event gate threw; refusing the whole batch", error);
          return finish(errorResponse("The event gate failed; nothing was enqueued", 500), events.length);
        }

        const allowed = typeof decision === "boolean" ? decision : decision.allow;
        if (!allowed) {
          const reason = typeof decision === "boolean" ? undefined : decision.reason;
          acks.push({
            eventId: event.eventId,
            status: "refused",
            ...(reason ? { reason } : { reason: `Refused by the event gate for Event stream "${event.stream}"` }),
          });
          continue;
        }
      }

      // `payloadJson` is exactly the bytes the queue will carry, so parsing it back yields exactly the value
      // the consumer will observe — whatever backend is behind the seam. (`JSON.parse` of a string that
      // `JSON.stringify` just produced cannot throw.)
      const normalizedPayload: unknown = JSON.parse(payloadJson);

      const stamped: StampedEvent = {
        eventId: event.eventId,
        occurredAtUs: event.occurredAtUs,
        identity: resolvedIdentity.identity,
        payload: normalizedPayload,
      };
      const bucket = byStream.get(event.stream);
      if (bucket) {
        bucket.push(stamped);
      } else {
        byStream.set(event.stream, [stamped]);
      }
      acks.push({ eventId: event.eventId, status: "acked" });
    }

    // 5. One message per Event stream, all enqueued in ONE transaction. Atomic or nothing (ADR-0053
    //    decision 4): the endpoint never partially enqueues and never buffers on the queue's behalf — the
    //    Outbox is the buffer.
    const messages: EventQueueMessage[] = Array.from(byStream, ([stream, streamEvents]) => ({
      stream,
      events: streamEvents,
    }));

    if (messages.length > 0) {
      const enqueueStart = options.logTimings ? perfNow() : 0;
      try {
        await db.transaction(async (tx) => {
          await queue.enqueueBatch(messages, tx);
        });
      } catch (error) {
        // Deliberately generic to the client (the detail can name schema/queue internals); the operator gets
        // the full error on the server's own log.
        console.error("[pgxsinkit] event enqueue failed; nothing was enqueued", error);
        return finish(
          errorResponse("The event queue is unavailable; nothing was enqueued", 503, {
            "Retry-After": String(EVENT_QUEUE_UNAVAILABLE_RETRY_AFTER_SECONDS),
          }),
          events.length,
        );
      }
      if (options.logTimings) enqueueMs = perfNow() - enqueueStart;

      // The nudge (ADR-0053 amendment): AFTER the commit, never awaited, never able to change the verdict
      // the client already earned. `byStream`'s keys are unique by construction, so the hook gets the
      // deduplicated stream names of this request in first-appearance order.
      if (options.onEventsEnqueued) {
        try {
          options.onEventsEnqueued({ streams: [...byStream.keys()] });
        } catch (error) {
          // A failed nudge costs latency, never delivery: the scheduled sweep is the guarantee.
          console.warn("[pgxsinkit] the `onEventsEnqueued` hook threw; the events are enqueued regardless", error);
        }
      }
    }

    return finish(Response.json({ acks }), events.length);
  };

  return handle;
}
