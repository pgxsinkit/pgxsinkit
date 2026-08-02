import type { EventQueueMessage } from "@pgxsinkit/contracts";

import type {
  DeadLetteredEventMessage,
  DeliveredEventMessage,
  EventQueue,
  EventQueueExecutor,
  EventQueueReceipt,
} from "../../../packages/server/src/events/queue";

/**
 * An in-memory {@link EventQueue} — the backend-independent half of the Event lane's queue contract.
 *
 * The seam exists precisely so the ingestion endpoint and (later) the consumer runner can be exercised
 * without a database: this fake implements the SEMANTICS the interface promises (receipts, a visibility
 * timeout, at-least-once redelivery, an archive that is the dead-letter storage, a deliberate requeue), while
 * the pgmq backend's SQL is exercised in the container lane.
 */

interface QueuedMessage {
  id: string;
  message: EventQueueMessage;
  deliveryCount: number;
  visibleAtMs: number;
  enqueuedAtUs: string;
}

interface ArchivedMessage {
  id: string;
  message: EventQueueMessage;
  reason?: string;
  deliveryCount: number;
  deadLetteredAtUs: string;
}

export interface FakeEventQueue extends EventQueue {
  /** Every message that was successfully enqueued, in call order — the endpoint's atomicity assertion. */
  readonly enqueued: EventQueueMessage[];
  /** The executor each `enqueueBatch` was handed (the endpoint must pass its transaction). */
  readonly enqueueExecutors: Array<EventQueueExecutor | undefined>;
  /** Make the next `enqueueBatch` throw, as an unavailable queue would. */
  failEnqueueOnce: (error?: Error) => void;
  /** Currently queued (non-dead-lettered) messages of one Event stream. */
  peek: (stream: string) => QueuedMessage[];
  /** The archive (dead-letter storage) of one Event stream. */
  peekDeadLetters: (stream: string) => ArchivedMessage[];
  /** Advance the fake clock, so a visibility timeout can lapse without waiting. */
  advance: (ms: number) => void;
}

export function createFakeEventQueue(options: { now?: () => number } = {}): FakeEventQueue {
  const queues = new Map<string, QueuedMessage[]>();
  const archives = new Map<string, ArchivedMessage[]>();
  const enqueued: EventQueueMessage[] = [];
  const enqueueExecutors: Array<EventQueueExecutor | undefined> = [];
  let nextId = 1;
  let offsetMs = 0;
  let pendingFailure: Error | null = null;

  const clock = () => (options.now?.() ?? 1_700_000_000_000) + offsetMs;
  const queueOf = (stream: string) => {
    const existing = queues.get(stream);
    if (existing) return existing;
    const created: QueuedMessage[] = [];
    queues.set(stream, created);
    return created;
  };
  const archiveOf = (stream: string) => {
    const existing = archives.get(stream);
    if (existing) return existing;
    const created: ArchivedMessage[] = [];
    archives.set(stream, created);
    return created;
  };
  const nowUs = () => String(BigInt(clock()) * 1000n);

  return {
    enqueued,
    enqueueExecutors,
    failEnqueueOnce: (error) => {
      pendingFailure = error ?? new Error("fake queue: unavailable");
    },
    peek: (stream) => [...queueOf(stream)],
    peekDeadLetters: (stream) => [...archiveOf(stream)],
    advance: (ms) => {
      offsetMs += ms;
    },

    enqueueBatch: async (messages, executor) => {
      if (pendingFailure) {
        const failure = pendingFailure;
        pendingFailure = null;
        // Nothing is recorded: an enqueue that throws must leave the queue exactly as it was.
        throw failure;
      }
      enqueueExecutors.push(executor);
      for (const message of messages) {
        queueOf(message.stream).push({
          id: String(nextId++),
          message,
          deliveryCount: 0,
          visibleAtMs: clock(),
          enqueuedAtUs: nowUs(),
        });
        enqueued.push(message);
      }
    },

    readBatch: async (stream, readOptions): Promise<DeliveredEventMessage[]> => {
      const delivered: DeliveredEventMessage[] = [];
      for (const entry of queueOf(stream)) {
        if (delivered.length >= readOptions.maxMessages) break;
        if (entry.visibleAtMs > clock()) continue;
        entry.deliveryCount += 1;
        entry.visibleAtMs = clock() + readOptions.visibilityTimeoutSeconds * 1000;
        delivered.push({
          receipt: entry.id,
          stream,
          message: entry.message,
          deliveryCount: entry.deliveryCount,
          enqueuedAtUs: entry.enqueuedAtUs,
        });
      }
      return delivered;
    },

    extendVisibility: async (stream, receipts, visibilityTimeoutSeconds) => {
      // Same semantics the pgmq backend's `set_vt` has: the deadline is pushed to NOW + timeout (never
      // added to what is left), and a receipt that is no longer queued is simply not extended.
      const wanted = new Set(receipts);
      let extended = 0;
      for (const entry of queueOf(stream)) {
        if (!wanted.has(entry.id)) continue;
        entry.visibleAtMs = clock() + visibilityTimeoutSeconds * 1000;
        extended += 1;
      }
      return extended;
    },

    ack: async (stream, receipts) => {
      const queue = queueOf(stream);
      const wanted = new Set(receipts);
      let removed = 0;
      for (let index = queue.length - 1; index >= 0; index--) {
        if (wanted.has(queue[index]!.id)) {
          queue.splice(index, 1);
          removed += 1;
        }
      }
      return removed;
    },

    deadLetter: async (stream, receipts, reason) => {
      const queue = queueOf(stream);
      const archive = archiveOf(stream);
      const wanted = new Set(receipts);
      let moved = 0;
      for (let index = queue.length - 1; index >= 0; index--) {
        const entry = queue[index]!;
        if (!wanted.has(entry.id)) continue;
        queue.splice(index, 1);
        archive.push({
          id: entry.id,
          message: entry.message,
          reason,
          deliveryCount: entry.deliveryCount,
          deadLetteredAtUs: nowUs(),
        });
        moved += 1;
      }
      return moved;
    },

    listDeadLetters: async (stream, limit): Promise<DeadLetteredEventMessage[]> =>
      [...archiveOf(stream)]
        .reverse()
        .slice(0, limit)
        .map((entry) => ({
          id: entry.id,
          stream,
          message: entry.message,
          ...(entry.reason != null ? { reason: entry.reason } : {}),
          deliveryCount: entry.deliveryCount,
          deadLetteredAtUs: entry.deadLetteredAtUs,
        })),

    requeueDeadLetter: async (stream, id): Promise<EventQueueReceipt | null> => {
      const archive = archiveOf(stream);
      const index = archive.findIndex((entry) => entry.id === id);
      if (index === -1) {
        return null;
      }
      const [entry] = archive.splice(index, 1);
      const receipt = String(nextId++);
      queueOf(stream).push({
        id: receipt,
        message: entry!.message,
        deliveryCount: 0,
        visibleAtMs: clock(),
        enqueuedAtUs: nowUs(),
      });
      return receipt;
    },
  };
}
