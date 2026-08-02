import { z } from "zod";

import { unixMicrosecondsSchema } from "./common";

/**
 * The **Event lane**'s wire contracts (ADR-0053 decision 3 + decision 5): the flush endpoint's request and
 * verdict bodies, the request-shape limits both sides enforce, and the stamped envelope that travels the
 * queue to the consumer callback.
 *
 * The mutation endpoint's sibling, minus what events don't need — no `seq` (a batch's internal order is
 * its array order; the Outbox's local append ordinal stays local) and no base version (nothing to conflict
 * with). Same strictness discipline as `mutation.ts`.
 */

/**
 * The batch ingestion endpoint. Deliberate constants, not tuning: the client flush loop clamps its
 * batching to them and the server enforces them independently of any client's configuration.
 *
 * **`MAX_EVENTS_PER_BATCH` (1000)** — one flush batch. Large enough that a device draining an offline
 * backlog makes real progress per round trip, small enough that one batch stays a modest request and one
 * queue transaction.
 *
 * **`MAX_EVENT_PAYLOAD_BYTES` (64 KiB)** — the serialized payload of ONE event. Events are facts, not
 * documents; a payload approaching this is a modelling smell. Enforced at `appendEvent` (so the library
 * caller fails at the call site) AND at ingest, where a single oversized payload is a per-event
 * `rejected` verdict rather than a batch fault.
 *
 * **`MAX_EVENT_REQUEST_BYTES` (4 MiB)** — the whole request body, the backstop for the two above (1000
 * events × 64 KiB would exceed it, deliberately: the body cap binds first). A violation is a batch-level
 * 413, reachable only under deployment skew or from a non-library caller.
 */
export const MAX_EVENTS_PER_BATCH = 1000;
/** See {@link MAX_EVENTS_PER_BATCH}. Serialized bytes of one event's payload. */
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
/** See {@link MAX_EVENTS_PER_BATCH}. Bytes of the whole `POST /api/events` body. */
export const MAX_EVENT_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * The batch event-ingestion endpoint path(s) — the Event lane's twin of the mutation route's
 * `batchMutationPaths`. It lives HERE, in contracts, rather than beside the server route: the same
 * constant is the client flush loop's target and the server's mount point, and the neighbouring
 * request-shape limits are already contracts-level toolkit constants both sides read.
 */
export const batchEventPaths = ["/api/events"] as const;

/**
 * One client-produced event as it crosses the wire. The library builds it (`appendEvent` stamps `eventId`
 * and `occurredAtUs`); `stream` is the registered Event-stream name.
 *
 * It carries NO identity: identity is stamped server-side from verified claims per the stream's
 * registration (see `EventStreamIdentityField`), never client-trusted. `stream` is validated only as a
 * non-empty string here — an unregistered name is a per-event `deferred` verdict (ordinary rollout skew),
 * not a framing fault.
 */
export const eventEnvelopeSchema = z
  .object({
    stream: z.string().trim().min(1),
    eventId: z.uuid(),
    occurredAtUs: unixMicrosecondsSchema,
    payload: z.unknown(),
  })
  .strict();

/**
 * The `POST /api/events` body. A request failing this parse — or exceeding the request-shape limits — is a
 * batch-level 400/413: a malformed item without a parseable `eventId` cannot receive a per-event verdict.
 * That layer is unreachable through the library (appends are validated, envelopes are library-built); it
 * exists for library bugs and non-library callers.
 */
export const batchEventRequestSchema = z
  .object({
    events: z.array(eventEnvelopeSchema).min(1).max(MAX_EVENTS_PER_BATCH),
  })
  .strict();

/**
 * The per-event verdict. Three of the four are TERMINAL — the client deletes the Outbox row:
 *
 * - `acked` — enqueued.
 * - `refused` — the consent/entitlement gating hook said no.
 * - `rejected` — a schema-invalid payload for a KNOWN Event stream, or an oversized payload. Given
 *   append-time validation and the backward-compatibility rule, this means a non-library caller or a
 *   broken consumer deployment — a bug, not a rollout.
 *
 * `deferred` is NOT terminal: an Event stream the server does not (yet) know is ordinary deployment skew
 * (a client rolled out ahead of its server), and deleting those events would be data loss on a normal
 * path. Deferred rows stay in the Outbox, retry with backoff, and drain when the rollout completes.
 */
export const eventAckStatusSchema = z.enum(["acked", "refused", "rejected", "deferred"]);

export const eventAckSchema = z
  .object({
    eventId: z.uuid(),
    status: eventAckStatusSchema,
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

/** The 2xx body: one verdict per well-formed envelope in the request. */
export const batchEventAckSchema = z
  .object({
    acks: z.array(eventAckSchema),
  })
  .strict();

/**
 * The body of a non-2xx batch-event response. Unlike the mutation path there is NO per-item rejection
 * field: a well-formed envelope always gets a per-event verdict in a 2xx `acks` array, so a non-2xx is
 * *always* a whole-batch fault (framing, limits, auth, queue unavailable) with nothing to attribute.
 * Unknown extra fields are stripped.
 */
export const batchEventErrorSchema = z.object({
  message: z.string().optional(),
});

/**
 * The **stamped** envelope (ADR-0053 decision 5): what the server produces at ingest, carries through the
 * queue, and delivers to the consumer callback as-is. `identity` is the record of claim-derived fields the
 * Event stream's registration declares, resolved from the VERIFIED claims of the ingesting request.
 *
 * This is the security-sensitive interface of the lane — the point where a client-supplied event becomes
 * an attributed fact — so its shape is contracts-defined, never implementation-defined. It carries no
 * `stream` (the queue message names it once, below) and no client-supplied identity of any kind.
 */
export const stampedEventSchema = z
  .object({
    eventId: z.uuid(),
    occurredAtUs: unixMicrosecondsSchema,
    identity: z.record(z.string().trim().min(1), z.string()),
    payload: z.unknown(),
  })
  .strict();

/**
 * One queue message: a single-stream sub-batch. The endpoint splits a mixed flush batch by Event stream
 * (preserving array order) and enqueues each sub-batch as ONE message on that stream's queue — one
 * visibility timeout, one ack, one consumer transaction per message. Events arrive at the callback in
 * append order WITHIN a message; across messages there is no ordering promise (ADR-0053 decision 6).
 */
export const eventQueueMessageSchema = z
  .object({
    stream: z.string().trim().min(1),
    events: z.array(stampedEventSchema).min(1),
  })
  .strict();

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type BatchEventRequest = z.infer<typeof batchEventRequestSchema>;
export type EventAckStatus = z.infer<typeof eventAckStatusSchema>;
export type EventAck = z.infer<typeof eventAckSchema>;
export type BatchEventAck = z.infer<typeof batchEventAckSchema>;
export type BatchEventError = z.infer<typeof batchEventErrorSchema>;
export type StampedEvent = z.infer<typeof stampedEventSchema>;
export type EventQueueMessage = z.infer<typeof eventQueueMessageSchema>;
