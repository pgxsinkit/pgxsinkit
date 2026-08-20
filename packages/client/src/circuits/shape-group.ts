import type { StreamEnvelope } from "@pgxsinkit/contracts";

import { readShapeStream, STREAM_START, type ShapeStreamSubscription, type StreamSourceOptions } from "./stream-source";

/** One shape a group follows: where to read it, and where to resume. */
export interface GroupShapeSpec {
  /** Absolute URL of the stream through the edge. */
  url: string;
  /** Resume position; {@link STREAM_START} for a new subscription. */
  offset?: string;
}

/** One delivery, tagged with the shape it came from. */
export interface ShapeGroupBatch {
  /** The group-local shape name — the engine's per-shape key. */
  shape: string;
  envelopes: readonly StreamEnvelope[];
  /** The offset that acknowledges these envelopes on this shape's stream. */
  offset: string;
  /** Whether this shape has delivered everything the server held when it answered. */
  upToDate: boolean;
}

export interface ShapeGroupOptions {
  shapes: Record<string, GroupShapeSpec>;
  token: StreamSourceOptions["token"];
  onTokenRejected?: StreamSourceOptions["onTokenRejected"];
  live?: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Run K shape streams as one group.
 *
 * This layer is **ours permanently**, not a bridge to something (ADR-0055 decision 10):
 * `@durable-streams/client` reads one stream and has no multi-stream coordinator, so the K-streams
 * side of decision 4 has to exist either way. What it deliberately does NOT do is imitate Electric's
 * `MultiShapeStream` — it hands back envelopes and per-stream offsets, which is what the native path
 * actually has, rather than reshaping them into a wire format we no longer speak.
 *
 * **Delivery is serialized.** K streams arrive concurrently, but the subscriber is the apply path,
 * whose inbox and commit queue assume one batch at a time. Rather than push that assumption onto
 * every caller, the group chains deliveries: batches are handed over in arrival order, one at a
 * time, and a slow subscriber exerts backpressure on every stream behind it. Per-shape ordering is
 * preserved because each stream's own reader is sequential.
 */
export function createShapeGroup(options: ShapeGroupOptions) {
  const names = Object.keys(options.shapes);
  const caughtUp = new Set<string>();
  const subscriptions = new Map<string, ShapeStreamSubscription>();
  let closed = false;
  let deliver: (batch: ShapeGroupBatch) => void | Promise<void> = () => {};
  // The serialization chain. Every batch appends to it, so deliveries never overlap regardless of
  // how many streams answer at once.
  let queue: Promise<void> = Promise.resolve();

  return {
    /**
     * `true` once **every** shape in the group has reported up-to-date at least once — the group
     * catch-up alignment of ADR-0031, which the native path inherits unchanged.
     *
     * Latching, not instantaneous: a live stream that later has new data to deliver has not stopped
     * being caught up, and the boot gate that reads this must not reopen once it has closed.
     */
    get isUpToDate(): boolean {
      return caughtUp.size === names.length;
    },

    /** Which shapes have not yet caught up — the boot rail's answer to "what are we waiting on?". */
    get pending(): string[] {
      return names.filter((name) => !caughtUp.has(name));
    },

    subscribe(onBatch: (batch: ShapeGroupBatch) => void | Promise<void>): void {
      deliver = onBatch;
    },

    /** Open every stream. Resolves once each has produced its first response. */
    async start(): Promise<void> {
      await Promise.all(
        names.map(async (shape) => {
          const spec = options.shapes[shape]!;
          const subscription = await readShapeStream(
            {
              url: spec.url,
              offset: spec.offset ?? STREAM_START,
              token: options.token,
              live: options.live ?? true,
              ...(options.onTokenRejected ? { onTokenRejected: options.onTokenRejected } : {}),
              ...(options.fetch ? { fetch: options.fetch } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
            },
            (batch) => {
              if (closed) return;
              if (batch.upToDate) caughtUp.add(shape);
              queue = queue.then(() =>
                closed
                  ? undefined
                  : deliver({ shape, envelopes: batch.envelopes, offset: batch.offset, upToDate: batch.upToDate }),
              );
              return queue;
            },
          );
          if (closed) {
            subscription.close();
            return;
          }
          subscriptions.set(shape, subscription);
        }),
      );
    },

    unsubscribeAll(): void {
      closed = true;
      for (const subscription of subscriptions.values()) {
        subscription.close();
      }
      subscriptions.clear();
    },
  };
}

export type ShapeGroup = ReturnType<typeof createShapeGroup>;
