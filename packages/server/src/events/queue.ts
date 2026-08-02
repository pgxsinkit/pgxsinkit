import type { SQL } from "drizzle-orm";

import {
  EVENT_STREAM_NAME_MAX_LENGTH,
  EVENT_STREAM_NAME_PATTERN,
  EVENT_STREAM_QUEUE_PREFIX,
  type EventQueueMessage,
} from "@pgxsinkit/contracts";

/**
 * The **Event lane**'s queue seam (ADR-0053 decision 5): a narrow, backend-agnostic interface over
 * "enqueue a batch / consume with a visibility timeout / ack / dead-letter (+ enumerate and requeue)".
 *
 * It is deliberately MECHANICS ONLY — there is no loop, no polling cadence, no wake policy and no
 * retry/backoff here. Those are the consumer runner's internals (ADR-0053 decision 7) and stay out of the
 * seam so a backend swap can never change pacing, and so the ingestion endpoint depends on nothing but
 * `enqueueBatch`.
 *
 * The interface, not the storage, is the contract: dead-letter STORAGE is backend-defined (the shipped pgmq
 * backend uses pgmq's own per-queue archive rather than a library-owned DLQ table), and v1 ships one backend.
 */

/**
 * The minimal SQL seam a backend executes through — satisfied by a drizzle `PgAsyncDatabase` AND by the
 * transaction handle its `transaction()` callback receives. The ingestion endpoint enqueues INSIDE its own
 * transaction (a batch is enqueued atomically or the request fails retryably), so every mutating method
 * takes an optional executor rather than owning a connection.
 */
export interface EventQueueExecutor {
  execute: (query: SQL) => Promise<unknown>;
}

/**
 * An opaque handle for one delivered message, used to ack or dead-letter it. Backend-defined (pgmq: the
 * `msg_id` as a decimal string) — never parsed or ordered by callers.
 */
export type EventQueueReceipt = string;

export interface EventQueueReadOptions {
  /**
   * How long a delivered message stays invisible to other consumers, in seconds. The runner renews or lets
   * it lapse; the queue seam only applies what it is given.
   */
  visibilityTimeoutSeconds: number;
  /** At most this many messages (each message is one single-stream sub-batch). */
  maxMessages: number;
}

/** One message delivered by {@link EventQueue.readBatch}: a single-stream sub-batch plus its delivery metadata. */
export interface DeliveredEventMessage {
  receipt: EventQueueReceipt;
  /** The Event-stream name this message was read from (also carried inside `message`). */
  stream: string;
  message: EventQueueMessage;
  /**
   * How many times this message has been DELIVERED (pgmq's `read_ct`), including the current delivery — the
   * attempt counter a runner's dead-letter-after-N policy reads. Never a client-supplied value.
   */
  deliveryCount: number;
  /** When the message was enqueued, in unix microseconds (decimal string). */
  enqueuedAtUs: string;
}

/** One dead-lettered message, as enumerated from the backend's dead-letter storage. */
export interface DeadLetteredEventMessage {
  /** The dead-letter identity, and the handle {@link EventQueue.requeueDeadLetter} takes. */
  id: EventQueueReceipt;
  stream: string;
  message: EventQueueMessage;
  /** The reason recorded when it was dead-lettered, when one was recorded. */
  reason?: string;
  deliveryCount: number;
  /** When it was dead-lettered, in unix microseconds (decimal string). */
  deadLetteredAtUs: string;
}

export interface EventQueue {
  /**
   * Enqueue whole messages. Called by the ingestion endpoint inside its own transaction, so passing
   * `executor` is what makes a multi-stream flush batch atomic: every message lands or none does
   * (ADR-0053 decision 4 — the endpoint never partially enqueues). Without an executor the backend uses its
   * own handle, and a multi-message call is then only as atomic as that handle.
   */
  enqueueBatch: (messages: readonly EventQueueMessage[], executor?: EventQueueExecutor) => Promise<void>;
  /** Deliver up to `maxMessages` messages of one Event stream, made invisible for the visibility timeout. */
  readBatch: (stream: string, options: EventQueueReadOptions) => Promise<DeliveredEventMessage[]>;
  /**
   * Push delivered messages' invisibility out to `visibilityTimeoutSeconds` FROM NOW — the lease RENEWAL a
   * consumer runner performs while it is still working through a read (one read makes a whole batch
   * invisible at once, so without renewal the later messages of a slow batch would become visible to another
   * runner while the first is still working toward them).
   *
   * Returns how many were actually extended. A receipt that is no longer queued (already acked or
   * dead-lettered) is simply not counted — a renewal racing a settle is ordinary, never an error.
   */
  extendVisibility: (
    stream: string,
    receipts: readonly EventQueueReceipt[],
    visibilityTimeoutSeconds: number,
    executor?: EventQueueExecutor,
  ) => Promise<number>;
  /** Acknowledge (permanently remove) delivered messages. Returns how many were actually removed. */
  ack: (stream: string, receipts: readonly EventQueueReceipt[]) => Promise<number>;
  /** Move delivered messages to dead-letter storage with a recorded reason. Returns how many moved. */
  deadLetter: (stream: string, receipts: readonly EventQueueReceipt[], reason: string) => Promise<number>;
  /** Enumerate an Event stream's dead-lettered messages, most recent first. */
  listDeadLetters: (stream: string, limit: number) => Promise<DeadLetteredEventMessage[]>;
  /**
   * Put one dead-lettered message back on its queue — a DELIBERATE act (ADR-0053 decision 7), never
   * automatic. Resolves with the requeued message's new receipt, or `null` when the id is not dead-lettered.
   */
  requeueDeadLetter: (stream: string, id: EventQueueReceipt) => Promise<EventQueueReceipt | null>;
}

/**
 * A queue message whose body is not a well-formed {@link EventQueueMessage}. The endpoint is the only writer
 * of these queues and it writes contract-shaped bodies, so this means a hand-inserted or corrupted message.
 * It carries the receipt precisely so a consumer runner can dead-letter exactly that message rather than
 * failing the whole read.
 */
export class MalformedEventQueueMessageError extends Error {
  readonly stream: string;
  readonly receipt: EventQueueReceipt;

  constructor(stream: string, receipt: EventQueueReceipt, detail: string) {
    super(`pgxsinkit: queue message ${receipt} on Event stream "${stream}" is not a valid queue message — ${detail}`);
    this.name = "MalformedEventQueueMessageError";
    this.stream = stream;
    this.receipt = receipt;
  }
}

/**
 * The queue name an Event stream is provisioned under: `pgxsinkit_events_<stream>` (ADR-0053 decision 5), the
 * SAME derivation the deploy-time DDL emits — one definition, so a runtime call can never address a queue the
 * migration did not create.
 *
 * The name is re-validated here even though `defineSyncRegistry` already validated it at module eval:
 * the queue name is interpolated into backend SQL, and a value arriving from a non-registry caller must not
 * be able to smuggle anything past that.
 */
export function eventStreamQueueName(stream: string): string {
  if (!EVENT_STREAM_NAME_PATTERN.test(stream) || stream.length > EVENT_STREAM_NAME_MAX_LENGTH) {
    throw new Error(
      `pgxsinkit: "${stream}" is not a usable Event-stream name — it must match ` +
        `${EVENT_STREAM_NAME_PATTERN.source} and be at most ${EVENT_STREAM_NAME_MAX_LENGTH} characters.`,
    );
  }
  return `${EVENT_STREAM_QUEUE_PREFIX}${stream}`;
}

/** Receipts are backend-issued decimal ids; anything else never reaches the backend's SQL. */
export function assertEventQueueReceipts(receipts: readonly EventQueueReceipt[]): void {
  for (const receipt of receipts) {
    if (!/^\d+$/.test(receipt)) {
      throw new Error(`pgxsinkit: "${receipt}" is not a valid event-queue receipt (expected a decimal id).`);
    }
  }
}
