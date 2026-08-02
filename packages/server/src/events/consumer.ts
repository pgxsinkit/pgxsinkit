import {
  getSyncRegistryStreams,
  type EventQueueMessage,
  type StampedEvent,
  type SyncTableRegistry,
} from "@pgxsinkit/contracts";

import {
  MalformedEventQueueMessageError,
  type DeliveredEventMessage,
  type EventQueue,
  type EventQueueReceipt,
} from "./queue";

/**
 * The **Event lane**'s consumer runner (ADR-0053 decisions 6 and 7): the library defines it, the app hosts it.
 *
 * `defineEventConsumer` returns a `start()`/`stop()` handle the app runs in its OWN long-lived Bun process —
 * the toolkit's first long-lived server artifact, deliberately separate from `createSyncServer`'s
 * zero-startup-query serverless posture. There is no supervisor, no CLI entrypoint, no daemon and no signal
 * handling here: the app owns its process lifecycle and calls `stop()` from wherever it already handles
 * shutdown. Construction stays query-free — the FIRST statement this runner sends is the first poll inside
 * `start()`.
 *
 * One runner hosts many Event streams: each gets its own independent loop (a poison event or slow callback in
 * one stream must never head-of-line-block another), so small deployments run one process and large ones split
 * `streams` across processes.
 *
 * **Pacing is adaptive interval polling, and it is INTERNAL** (ADR-0053 decision 7 — out of consumer-app design
 * space by ratified requirement; only the floor/ceiling/factor are exposed as tuning, never as contract):
 *
 * - a NON-EMPTY read is followed by an immediate re-read, so a backlog drains back-to-back;
 * - consecutive EMPTY reads grow the wait from a floor ({@link DEFAULT_EVENT_POLL_FLOOR_MS}) toward an idle
 *   ceiling ({@link DEFAULT_EVENT_POLL_CEILING_MS}) by {@link DEFAULT_EVENT_POLL_FACTOR};
 * - one non-empty read resets the wait to the floor.
 *
 * LISTEN/NOTIFY and `pgmq.read_with_poll` long-polling are REJECTED as wake mechanisms (ADR-0053, maintainer
 * decision): Bun's native `SQL` — the sanctioned Postgres driver — has no LISTEN/NOTIFY, and both mechanisms
 * hold a connection per stream through the transaction poolers the consumers' stacks run behind. Because
 * pacing is internal, the mechanism can change later without any contract change.
 *
 * **Leases are RENEWED while a read is being worked through; a thrown sub-batch's lease is deliberately left
 * to lapse** (ADR-0053 decision 7: visibility renewal is internal). One read makes up to `batchSize` messages
 * invisible at once, so the timeout cannot be "the processing budget": ten ordinary ten-second callbacks
 * would outlive a 60-second window for the later messages, and in a documented multi-runner deployment
 * another process would pick them up while the first is still working toward them. So for as long as a read
 * is in flight the runner extends EVERY not-yet-settled receipt of that read — the one running plus the ones
 * still queued behind it — every `visibilityTimeoutSeconds / 2`. Renewal is best-effort: a failure is
 * warn-logged and the loop carries on, because redelivery is the safety net it would fall back on anyway.
 *
 * `visibilityTimeoutSeconds` therefore means two retry-shaped things, never a budget:
 *
 * - **the redelivery delay of a FAILED sub-batch.** A callback that throws is not acked AND is dropped from
 *   renewal immediately, so its lease lapses and the queue redelivers it with an incremented `deliveryCount`.
 *   That lapse IS the retry pacing — the runner never sleeps "on behalf of" a failed message, and if a
 *   backend ever wants exponential redelivery backoff it belongs INSIDE that backend, behind the
 *   {@link EventQueue} seam, so the runner stays backend-agnostic;
 * - **the crash-recovery bound.** A runner that dies takes its renewals with it, so everything it held comes
 *   back one timeout later.
 *
 * **A graceful stop does not cancel renewal — it narrows it.** `stop()` starts no further read and no further
 * callback, but the callbacks already in flight are AWAITED and then acked, so their receipts must stay
 * invisible until they settle: cancelling renewal at `stop()` would hand a second runner the very message
 * this one is deliberately finishing, on every ordinary SIGTERM/rollout. What IS released at `stop()` is the
 * rest of that read — the messages no callback has started — which drop out of the renewal set so their
 * leases lapse and the queue redelivers them promptly. `stop()` therefore resolves only once every in-flight
 * callback has settled AND its renewal task has shut down.
 *
 * **The SECOND pacing mode: `drainOnce()`, for hosts that cannot hold a process** (ADR-0053 amendment,
 * 2026-08-02). Everything above describes the primary mode. A serverless-only deployment — managed
 * Supabase, whose edge functions are the only compute — has nowhere to put a `start()`; its queue would
 * simply never drain. So the SAME handle also answers `drainOnce({ budgetMs })`: one bounded pass that
 * reads/delivers/acks through the identical internals until every stream reads empty or the wall-clock
 * budget runs out. Nothing about the delivery contract moves — at-least-once, batch-internal order only,
 * dead-lettering to the backend's archive are all the same code — because pacing was internal from the
 * start (decision 7), which is exactly what makes this a HOSTING addition rather than a contract change.
 * The long-lived runner remains the primary mode; `drainOnce` is what a scheduled invocation calls.
 */

/** Max messages (each ONE single-stream sub-batch) a single read delivers, when the app sets nothing. */
export const DEFAULT_EVENT_CONSUMER_BATCH_SIZE = 10;
/**
 * How long a delivered sub-batch stays invisible, when the app sets nothing — and how long the runner extends
 * it by on each renewal (it renews at half this). Healthy long processing is covered by renewal, so this is
 * the REDELIVERY DELAY of a sub-batch whose callback threw and the crash-recovery bound, not a budget: it
 * wants to sit above a single callback's worst case (too short redelivers a callback that is merely slower
 * than one renewal interval), never above the whole batch's.
 */
export const DEFAULT_EVENT_VISIBILITY_TIMEOUT_SECONDS = 60;
/** Deliveries a sub-batch gets before a further callback failure dead-letters it, when the app sets nothing. */
export const DEFAULT_EVENT_MAX_ATTEMPTS = 5;
/** The adaptive poll's floor — the wait after the FIRST empty read (ADR-0053 decision 7: ~250 ms). */
export const DEFAULT_EVENT_POLL_FLOOR_MS = 250;
/** The adaptive poll's idle ceiling — the longest an idle stream ever waits between reads. */
export const DEFAULT_EVENT_POLL_CEILING_MS = 5_000;
/** How fast consecutive empty reads grow the wait from the floor toward the ceiling. */
export const DEFAULT_EVENT_POLL_FACTOR = 2;
/**
 * The wall-clock budget one {@link EventConsumer.drainOnce} pass gets, when the caller sets nothing.
 *
 * **Set it under your platform's invocation wall-clock cap**, with head-room for one callback: the budget is
 * only ever checked BETWEEN sub-batches, so a pass can overrun it by however long the callback that was
 * already running takes. 25 s suits the common serverless caps (Supabase Edge, Vercel, Cloud Run jobs); a
 * platform with a tighter cap wants a tighter budget, and a generous one (a cron container) can raise it.
 */
export const DEFAULT_EVENT_DRAIN_BUDGET_MS = 25_000;

/**
 * Adaptive-poll tuning. Defaults are the ADR's; they are TUNING, not contract — the pacing mechanism itself is
 * internal and may change.
 */
export interface EventConsumerPollOptions {
  /** The wait after the first empty read. Defaults to {@link DEFAULT_EVENT_POLL_FLOOR_MS}. */
  floorMs?: number;
  /** The longest wait an idle stream reaches. Defaults to {@link DEFAULT_EVENT_POLL_CEILING_MS}. */
  ceilingMs?: number;
  /** The growth factor per consecutive empty read. Defaults to {@link DEFAULT_EVENT_POLL_FACTOR}. */
  factor?: number;
}

/** One callback invocation: exactly ONE delivered queue message, i.e. one single-stream sub-batch. */
export interface EventConsumerBatch {
  /** The Event stream these events were appended under. */
  stream: string;
  /**
   * The stamped envelopes, EXACTLY as the ingestion endpoint enqueued them (ADR-0053 decision 5) — in append
   * order within this sub-batch. Across sub-batches there is no ordering promise (decision 6).
   */
  events: readonly StampedEvent[];
}

/**
 * The consumer callback. Returning (resolving) ACKS the sub-batch; THROWING retries it — the message stays
 * invisible until its visibility timeout lapses and the queue redelivers it.
 *
 * It MUST be idempotent (ADR-0053 decision 6, at-least-once): the blessed pattern is deduping on `eventId`
 * against the app's own durable store, which composes to effectively-exactly-once.
 */
export type EventConsumerCallback = (batch: EventConsumerBatch) => void | Promise<void>;

/** What {@link DefineEventConsumerOptions.onDeadLetter} is told about a sub-batch the runner gave up on. */
export interface EventDeadLetterReport {
  stream: string;
  /** Why it was dead-lettered — the same reason recorded in the backend's dead-letter storage. */
  reason: string;
  /** Deliveries this message had received. `0` when the body was unreadable (nothing was ever delivered from it). */
  attempts: number;
  /** The receipt it was dead-lettered under — always present, including for an unparseable body. */
  receipt: EventQueueReceipt;
  /** The message, when it was readable. Absent for a malformed body (that is exactly what could not be parsed). */
  message?: EventQueueMessage;
  /** The error behind it: the callback's throw, or the {@link MalformedEventQueueMessageError}. */
  cause?: unknown;
}

/**
 * The deterministic seam the runner waits on. `signal` is aborted by `stop()`, so a stopping runner never
 * lingers for a full idle ceiling. Injected only by tests; production uses an abortable `setTimeout`.
 */
export type EventConsumerSleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** What {@link EventConsumer.drainOnce} is tuned with. */
export interface EventDrainOptions {
  /**
   * The pass's wall-clock budget. Defaults to {@link DEFAULT_EVENT_DRAIN_BUDGET_MS}. Checked between
   * sub-batches only, never inside a callback — so size it under the invocation's cap with head-room for
   * one callback's worst case.
   */
  budgetMs?: number;
}

/** What one {@link EventConsumer.drainOnce} pass reports back. Counts are SUB-BATCHES (one queue message,
 * one callback invocation), the unit the queue and the dead-letter archive both work in. */
export interface EventDrainSummary {
  /**
   * Sub-batches whose callback completed during this pass. An ack that then failed still counts — the work
   * was delivered, and at-least-once means it may be delivered again later (the callback is idempotent).
   */
  delivered: number;
  /** Sub-batches this pass moved to the backend's dead-letter storage. */
  deadLettered: number;
  /**
   * `true` when every configured Event stream read empty before the budget ran out — the queue is drained
   * as far as this pass can see.
   *
   * `false` means the pass ended with work possibly still queued: the budget cut it short, or a stream's
   * read faulted. It is the caller's signal that another tick has something to do — a scheduler that
   * chains passes should invoke again promptly rather than waiting out its full period.
   */
  empty: boolean;
}

export interface DefineEventConsumerOptions<TRegistry extends SyncTableRegistry> {
  /** The sync registry whose `streams` this runner consumes. */
  registry: TRegistry;
  /**
   * The queue to consume from — REQUIRED, and the reason the runner is backend-agnostic by construction. The
   * ordinary wiring is `createPgmqEventQueue({ db })` with the app's own drizzle handle; constructing it here
   * from a `db` option would bake the shipped backend into the runner for one line of ergonomics.
   */
  queue: EventQueue;
  callback: EventConsumerCallback;
  /**
   * Narrow to a subset of the registered Event streams — the knob that splits streams across processes.
   * Defaults to ALL registered streams. An unknown name is a definition-time throw (fail-closed): a runner
   * that silently consumed nothing is the failure mode this forbids.
   */
  streams?: readonly string[];
  /** Max messages per read. Defaults to {@link DEFAULT_EVENT_CONSUMER_BATCH_SIZE}. */
  batchSize?: number;
  /**
   * The delivered-message invisibility window, renewed at half of it while the runner is still working
   * through a read. Defaults to {@link DEFAULT_EVENT_VISIBILITY_TIMEOUT_SECONDS}. Size it above ONE
   * callback's worst case (renewal covers the rest of the batch), not above the whole batch's.
   */
  visibilityTimeoutSeconds?: number;
  /**
   * Max CONCURRENT callback invocations per Event stream. Defaults to `1` (strictly sequential). Values above 1
   * are safe for the idempotent callback the lane already requires: ADR-0053 decision 6 disclaims any ordering
   * across sub-batches precisely so concurrency is available. Reads stay serial — only the callbacks of one
   * delivered read run in parallel.
   */
  concurrency?: number;
  /**
   * Deliveries a sub-batch gets before a further callback failure dead-letters it. Defaults to
   * {@link DEFAULT_EVENT_MAX_ATTEMPTS}. A malformed body never gets attempts — it dead-letters on sight.
   */
  maxAttempts?: number;
  /** Adaptive-poll tuning. See {@link EventConsumerPollOptions}. */
  poll?: EventConsumerPollOptions;
  /**
   * Notified for every dead-lettered sub-batch. The runner ALSO warn-logs each one unconditionally: loudness is
   * the ADR's requirement and a hook that swallows (or throws) must not be able to make a dead letter silent.
   */
  onDeadLetter?: (report: EventDeadLetterReport) => void;
  /** @internal The injectable wait — the deterministic seam the pacing tests drive. Defaults to `setTimeout`. */
  sleep?: EventConsumerSleep;
  /** @internal The injectable clock `drainOnce` measures its budget against. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * @internal The injectable RENEWAL wait, deliberately a second seam rather than `sleep`: the two cadences
   * are independent (one paces reads, one paces lease renewal) and sharing one would make every pacing
   * assertion depend on renewal timing. Defaults to `setTimeout`.
   */
  renewalSleep?: EventConsumerSleep;
}

export interface EventConsumer {
  /**
   * Begin every stream's loop. Idempotent; a no-op after {@link EventConsumer.stop}. Throws while a
   * {@link EventConsumer.drainOnce} pass is in flight — one handle drives one pacing mode at a time.
   */
  start: () => void;
  /**
   * Graceful stop: no new reads, no new callbacks, in-flight callbacks are awaited (and their leases KEPT
   * renewed until they ack or dead-letter), and the promise resolves when every loop — and every renewal
   * task it still owned — is quiet. Safe to call twice (the second call awaits the first). Messages of an
   * in-progress read whose callback had not started are released at once: they stop being renewed and are
   * left unacked, so at-least-once redelivers them as soon as their lease lapses.
   *
   * A `drainOnce` pass in flight is treated the same way: it starts no further read, finishes the callback
   * it is on, and `stop()` resolves once it has.
   */
  stop: () => Promise<void>;
  /**
   * One bounded drain pass — the pacing mode for a host that cannot hold a process (ADR-0053 amendment,
   * 2026-08-02).
   *
   * It walks every configured Event stream, read → deliver → ack, and keeps going until EITHER every stream
   * has returned an empty read OR the wall-clock budget is spent. Same internals as the loop mode
   * throughout: the same read/deliver/ack path, the same lease renewal while a callback runs, the same
   * per-sub-batch retry-by-lapsing-lease, the same dead-lettering after `maxAttempts` with the same
   * `onDeadLetter` hook and unconditional warn log. It never sleeps: a stream that reads empty is finished
   * for this pass, and there is no adaptive interval to wait out.
   *
   * **The budget is checked BETWEEN sub-batches, never inside one.** A callback already running is awaited
   * and acked exactly as the runner would (its lease stays renewed throughout), and no new read starts once
   * the budget is gone — so a pass can overrun its budget by one callback, and `budgetMs` must leave
   * head-room for that under the platform's invocation cap. A sub-batch whose callback THROWS near the
   * budget edge is not special-cased: it is left unacked and dropped from renewal, its lease lapses, and the
   * queue redelivers it on a later pass with an incremented delivery count. That is at-least-once working as
   * designed, not a lost event — and it is why the callback must be idempotent.
   *
   * **Hosting it.** Wire a SCHEDULED invocation (a platform cron, e.g. every 10 s) that calls `drainOnce`
   * and, optionally, an ingest-side nudge (`createSyncServer({ onEventsEnqueued })` firing a
   * fetch-and-forget at the same endpoint) so an interactive append is drained in milliseconds instead of
   * waiting for the next tick. The **schedule is the delivery guarantee; the nudge is only latency** — a
   * lost nudge costs nothing but time. Overlapping invocations are SAFE: two processes reading the same
   * queue are arbitrated by the visibility timeout, exactly as two long-lived runners would be. (Two passes
   * on ONE handle are not — that is a bug, and throws; see below.)
   *
   * **One handle, one pacing mode.** Throws if `start()` is live, if another `drainOnce` is already in
   * flight on this handle, or if the handle has been stopped — the lifecycle is one-way, so the next drain
   * builds a fresh `defineEventConsumer` (construction is query-free, so that costs nothing).
   */
  drainOnce: (options?: EventDrainOptions) => Promise<EventDrainSummary>;
}

/**
 * The adaptive wait for `idleCount` CONSECUTIVE unproductive reads (an empty read or a queue fault), clamped to
 * the ceiling. `idleCount` is 1 for the first one; a productive read resets it to 0 and re-reads immediately.
 */
export function computeEventPollWaitMs(idleCount: number, options: EventConsumerPollOptions = {}): number {
  const floorMs = options.floorMs ?? DEFAULT_EVENT_POLL_FLOOR_MS;
  const ceilingMs = options.ceilingMs ?? DEFAULT_EVENT_POLL_CEILING_MS;
  const factor = options.factor ?? DEFAULT_EVENT_POLL_FACTOR;
  const exponent = Math.max(idleCount - 1, 0);
  return Math.min(Math.round(floorMs * factor ** exponent), ceilingMs);
}

/** The production wait: a `setTimeout` that is CLEARED on abort, so `stop()` never leaves a timer holding the process open. */
const abortableSleep: EventConsumerSleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let handle: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (handle !== undefined) {
        clearTimeout(handle);
      }
      signal.removeEventListener("abort", finish);
      resolve();
    };
    handle = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });

function assertPositive(label: string, value: number, minimum: number): number {
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(
      `pgxsinkit: defineEventConsumer's \`${label}\` must be a finite number >= ${minimum} (got ${value}).`,
    );
  }
  return value;
}

export function defineEventConsumer<TRegistry extends SyncTableRegistry>(
  options: DefineEventConsumerOptions<TRegistry>,
): EventConsumer {
  // ─── Definition-time resolution (fail-closed, and query-free) ────────────────────────────────────────
  const registered = getSyncRegistryStreams(options.registry) ?? {};
  const registeredNames = Object.keys(registered);
  if (registeredNames.length === 0) {
    throw new Error(
      "pgxsinkit: this registry registers no Event streams, so there is nothing for a consumer runner to " +
        "consume. Register one with `defineSyncRegistry({ tables, streams: { <name>: defineEventStream({ … }) } })`.",
    );
  }

  let streams: string[];
  if (options.streams) {
    const unknown = options.streams.filter((stream) => !Object.hasOwn(registered, stream));
    if (unknown.length > 0) {
      // Every offender is named: a typo'd stream on a runner would otherwise present as "the events never
      // arrive", which is the most expensive shape of silence in the lane.
      throw new Error(
        `pgxsinkit: defineEventConsumer was asked for Event stream(s) [${unknown.join(", ")}] this registry ` +
          `does not register — it registers [${registeredNames.join(", ")}].`,
      );
    }
    streams = [...new Set(options.streams)];
    if (streams.length === 0) {
      throw new Error(
        "pgxsinkit: defineEventConsumer was given an empty `streams` list. Omit it to consume every registered " +
          "Event stream, or name at least one.",
      );
    }
  } else {
    streams = registeredNames;
  }

  const batchSize = assertPositive("batchSize", options.batchSize ?? DEFAULT_EVENT_CONSUMER_BATCH_SIZE, 1);
  const visibilityTimeoutSeconds = assertPositive(
    "visibilityTimeoutSeconds",
    options.visibilityTimeoutSeconds ?? DEFAULT_EVENT_VISIBILITY_TIMEOUT_SECONDS,
    1,
  );
  const concurrency = assertPositive("concurrency", options.concurrency ?? 1, 1);
  const maxAttempts = assertPositive("maxAttempts", options.maxAttempts ?? DEFAULT_EVENT_MAX_ATTEMPTS, 1);
  const poll = options.poll ?? {};
  const floorMs = assertPositive("poll.floorMs", poll.floorMs ?? DEFAULT_EVENT_POLL_FLOOR_MS, 0);
  const ceilingMs = assertPositive("poll.ceilingMs", poll.ceilingMs ?? DEFAULT_EVENT_POLL_CEILING_MS, floorMs);
  const factor = assertPositive("poll.factor", poll.factor ?? DEFAULT_EVENT_POLL_FACTOR, 1);
  const pollOptions: EventConsumerPollOptions = { floorMs, ceilingMs, factor };

  const queue = options.queue;
  const sleep = options.sleep ?? abortableSleep;
  const renewalSleep = options.renewalSleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  /** Renew at HALF the window: one missed renewal still leaves a full half-window of head-room. */
  const renewalIntervalMs = Math.max(1, Math.floor((visibilityTimeoutSeconds * 1000) / 2));

  // ─── Lifecycle state ─────────────────────────────────────────────────────────────────────────────────
  const stopController = new AbortController();
  let started = false;
  let stopping = false;
  let loops: Promise<void>[] = [];
  let stopPromise: Promise<void> | null = null;
  /** The in-flight bounded drain, if any — the second pacing mode's whole lifecycle state. */
  let activeDrain: Promise<EventDrainSummary> | null = null;
  /**
   * The counters of the drain pass in flight, or `null` in loop mode. The settle points below feed it
   * rather than returning counts, so `drainOnce` reports on the SAME delivery path the runner uses instead
   * of a parallel one. Exactly one pass can be in flight (the mode is mutually exclusive), so one slot is
   * all this needs.
   */
  let drainStats: { delivered: number; deadLettered: number } | null = null;

  // ─── Dead-lettering (ADR-0053 decision 7: the loudness lives HERE) ───────────────────────────────────
  const reportDeadLetter = (report: EventDeadLetterReport): void => {
    // Unconditional, and deliberately not the client report surface's "warn only when nobody subscribed"
    // rule: a dead letter is rare and terminal, so it is worth a line in the operator's log even when the
    // app also handles it.
    console.warn(
      `pgxsinkit: dead-lettered an event sub-batch on Event stream "${report.stream}" (receipt ${report.receipt}, ` +
        `${report.attempts} delivery attempt(s)) — ${report.reason}. It is in the queue's dead-letter storage; ` +
        "requeue it deliberately with `requeueDeadLetter` once the cause is fixed.",
      report.cause,
    );
    if (!options.onDeadLetter) {
      return;
    }
    try {
      options.onDeadLetter(report);
    } catch (error) {
      console.error("pgxsinkit: the `onDeadLetter` hook threw; the message is dead-lettered regardless", error);
    }
  };

  /** Move one message to dead-letter storage and report it. Resolves `false` when the QUEUE refused the move. */
  const deadLetter = async (
    stream: string,
    receipt: EventQueueReceipt,
    attempts: number,
    reason: string,
    cause: unknown,
    message?: EventQueueMessage,
  ): Promise<boolean> => {
    try {
      await queue.deadLetter(stream, [receipt], reason);
    } catch (error) {
      // The message is still queued and still invisible; it redelivers and dead-letters on a later pass.
      console.warn(
        `pgxsinkit: could not dead-letter message ${receipt} on Event stream "${stream}"; it stays queued and ` +
          "will be retried",
        error,
      );
      return false;
    }
    if (drainStats) {
      drainStats.deadLettered += 1;
    }
    reportDeadLetter({ stream, reason, attempts, receipt, ...(message ? { message } : {}), cause });
    return true;
  };

  // ─── Lease renewal (ADR-0053 decision 7: internal, and not optional) ─────────────────────────────────
  /**
   * Keep every UNSETTLED receipt of one read invisible for as long as that read is being worked through.
   * Returns the stopper, which the caller awaits so no renewal outlives its read (a stray timer would hold
   * the app's process open, and a stray extension would delay a redelivery the runner no longer wants).
   *
   * Its lifetime is the READ's, deliberately NOT the runner's: this task is wired to its OWN controller and
   * never to `stopController`. A graceful stop still awaits the callbacks already in flight, so aborting
   * renewal there would let their leases lapse mid-callback and let another runner take the work this one is
   * finishing. `stop()` instead shrinks `unsettled` (see `processDelivered`), and the loop below exits on its
   * own the moment that set drains.
   */
  const startRenewal = (stream: string, unsettled: Set<EventQueueReceipt>): (() => Promise<void>) => {
    const controller = new AbortController();

    const task = (async () => {
      while (!controller.signal.aborted && unsettled.size > 0) {
        await renewalSleep(renewalIntervalMs, controller.signal);
        if (controller.signal.aborted || unsettled.size === 0) {
          return;
        }
        try {
          await queue.extendVisibility(stream, [...unsettled], visibilityTimeoutSeconds);
        } catch (error) {
          // Best-effort by design: the worst case of a failed renewal is the behaviour there would be with
          // no renewal at all — the lease lapses and the sub-batch is redelivered to an idempotent callback.
          console.warn(
            `pgxsinkit: could not renew the visibility lease on Event stream "${stream}" (receipts ` +
              `${[...unsettled].join(", ")}); the sub-batch may be redelivered while it is still being processed`,
            error,
          );
        }
      }
    })();

    return async () => {
      controller.abort();
      await task;
    };
  };

  // ─── One delivered message ───────────────────────────────────────────────────────────────────────────
  const processMessage = async (
    stream: string,
    delivered: DeliveredEventMessage,
    /** Drop this message from the read's renewal set — it is settled, one way or the other. */
    settle: () => void,
  ): Promise<void> => {
    try {
      await options.callback({ stream, events: delivered.message.events });
    } catch (error) {
      // Settled the moment it throws, and settled FIRST: a failed sub-batch's lease is deliberately allowed
      // to lapse, because that lapse IS the retry pacing. Renewing it would postpone its own redelivery.
      settle();
      const detail = error instanceof Error ? error.message : String(error);
      if (delivered.deliveryCount >= maxAttempts) {
        await deadLetter(
          stream,
          delivered.receipt,
          delivered.deliveryCount,
          `the consumer callback failed on delivery ${delivered.deliveryCount} of ${maxAttempts}: ${detail}`,
          error,
          delivered.message,
        );
        return;
      }
      // NOT acked, and no longer renewed: the lapsing lease IS the retry pacing (see the module note).
      console.warn(
        `pgxsinkit: the event consumer callback failed for Event stream "${stream}" (receipt ${delivered.receipt}, ` +
          `delivery ${delivered.deliveryCount} of ${maxAttempts}); the sub-batch will be redelivered after its ` +
          `${visibilityTimeoutSeconds}s visibility timeout`,
        error,
      );
      return;
    }

    if (drainStats) {
      // Counted on the callback's success, before the ack: the work was delivered either way, and an ack
      // that fails only means at-least-once will deliver it again to an idempotent callback.
      drainStats.delivered += 1;
    }

    try {
      await queue.ack(stream, [delivered.receipt]);
    } catch (error) {
      // At-least-once's honest failure mode: the work succeeded but the ack did not, so the sub-batch will be
      // redelivered. The idempotent callback the lane requires is exactly what makes that harmless.
      console.warn(
        `pgxsinkit: could not ack message ${delivered.receipt} on Event stream "${stream}"; it will be ` +
          "redelivered (the callback must be idempotent)",
        error,
      );
    }
    // Settled either way: an acked message is gone, and one whose ack failed is meant to be redelivered.
    settle();
  };

  /**
   * Process one read's messages, at most `concurrency` callbacks at a time. Never throws.
   *
   * The renewal task spans the WHOLE read, not one callback: the messages queued behind the one in flight are
   * just as invisible, and they are precisely the ones a long first callback would otherwise let lapse.
   *
   * `halted` is the "enter no further callback" predicate — a graceful stop in loop mode, and additionally
   * the spent wall-clock budget under {@link EventConsumer.drainOnce}. It is consulted BETWEEN sub-batches
   * only, so whatever is already running is always awaited and settled first; the messages of this read no
   * callback ever entered are then released from renewal so their leases lapse and they redeliver at once,
   * rather than staying invisible behind work this pass will not do.
   */
  const processDelivered = async (
    stream: string,
    messages: readonly DeliveredEventMessage[],
    halted: () => boolean,
  ): Promise<void> => {
    const unsettled = new Set(messages.map((delivered) => delivered.receipt));
    const settleOf = (delivered: DeliveredEventMessage) => () => unsettled.delete(delivered.receipt);
    /** Receipts a callback has actually been entered for — the ones a graceful stop must keep renewing. */
    const startedReceipts = new Set<EventQueueReceipt>();
    /**
     * A graceful stop enters no further callback, so every message of this read the workers never reached is
     * released HERE: dropping it from the renewal set lets its lease lapse and the queue redeliver it at once,
     * instead of holding it invisible for as long as the in-flight callbacks still take. The started ones stay
     * in the set and keep being renewed until `processMessage` settles them.
     */
    const releaseUnstarted = (): void => {
      for (const delivered of messages) {
        if (!startedReceipts.has(delivered.receipt)) {
          unsettled.delete(delivered.receipt);
        }
      }
    };
    if (stopController.signal.aborted) {
      releaseUnstarted();
    } else {
      stopController.signal.addEventListener("abort", releaseUnstarted, { once: true });
    }
    const stopRenewal = startRenewal(stream, unsettled);

    // The `halted` check and this call are one synchronous step, so a stop (or an expiring budget) can never
    // land between "we decided to run it" and "it counts as started".
    const runOne = async (delivered: DeliveredEventMessage): Promise<void> => {
      startedReceipts.add(delivered.receipt);
      await processMessage(stream, delivered, settleOf(delivered));
    };

    try {
      if (concurrency <= 1) {
        for (const delivered of messages) {
          if (halted()) {
            releaseUnstarted();
            return;
          }
          await runOne(delivered);
        }
        return;
      }

      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          if (halted()) {
            releaseUnstarted();
            return;
          }
          const delivered = messages[cursor++];
          if (!delivered) {
            return;
          }
          await runOne(delivered);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, messages.length) }, worker));
    } finally {
      // Every callback of this read has settled by now (the workers await theirs), so the renewal task has
      // nothing left to protect — and `stop()`, which awaits this loop, therefore awaits the shutdown too.
      stopController.signal.removeEventListener("abort", releaseUnstarted);
      await stopRenewal();
    }
  };

  // ─── One stream's loop ───────────────────────────────────────────────────────────────────────────────
  const runStream = async (stream: string): Promise<void> => {
    let idleCount = 0;

    while (!stopping) {
      let productive = false;
      try {
        const messages = await queue.readBatch(stream, { visibilityTimeoutSeconds, maxMessages: batchSize });
        if (messages.length > 0) {
          productive = true;
          await processDelivered(stream, messages, () => stopping);
        }
      } catch (error) {
        if (error instanceof MalformedEventQueueMessageError) {
          // The endpoint is the only writer of these queues and it writes contract-shaped bodies, so this is a
          // hand-inserted or corrupted message. It fails the WHOLE read, so it must go on sight or it wedges
          // the stream: dead-letter exactly the named receipt, then re-read for the rest of the batch.
          productive = await deadLetter(
            stream,
            error.receipt,
            0,
            `the queue message body is not a valid event queue message: ${error.message}`,
            error,
          );
        } else {
          // A queue/database fault. A runner NEVER exits on a transient one — it backs off exactly like an
          // idle stream and keeps trying.
          console.warn(
            `pgxsinkit: the event consumer could not read Event stream "${stream}"; backing off and retrying`,
            error,
          );
        }
      }

      if (productive) {
        // A backlog drains back-to-back: read again immediately, at the floor again once it runs dry.
        idleCount = 0;
        continue;
      }

      idleCount += 1;
      if (stopping) {
        break;
      }
      await sleep(computeEventPollWaitMs(idleCount, pollOptions), stopController.signal);
    }
  };

  // ─── One bounded drain pass (the serverless pacing mode) ─────────────────────────────────────────────
  /**
   * Read → deliver → ack across every stream until they all read empty or the budget is spent. Deliberately
   * built out of `processDelivered` and `deadLetter` — the loop mode's own path — so retry, renewal and
   * dead-lettering cannot drift between the two modes.
   */
  const runDrain = async (budgetMs: number): Promise<EventDrainSummary> => {
    const stats = { delivered: 0, deadLettered: 0 };
    drainStats = stats;
    const deadline = now() + budgetMs;
    /** Streams not yet known to be empty. A stream leaves the set on an empty read, or on a read fault. */
    const pending = new Set(streams);
    /** Anything that ended the pass with work possibly still queued — the `empty: false` reasons. */
    let unfinished = false;
    // Budget AND stop: a `stop()` during a pass must wind it down just as it winds down a loop.
    const halted = (): boolean => stopping || now() >= deadline;

    try {
      while (pending.size > 0) {
        if (halted()) {
          unfinished = true;
          break;
        }
        for (const stream of [...pending]) {
          if (halted()) {
            unfinished = true;
            break;
          }

          let messages: readonly DeliveredEventMessage[];
          try {
            messages = await queue.readBatch(stream, { visibilityTimeoutSeconds, maxMessages: batchSize });
          } catch (error) {
            if (error instanceof MalformedEventQueueMessageError) {
              // Same policy as the loop: it fails the WHOLE read, so it goes on sight and the stream stays
              // pending for the re-read that fetches the rest of the batch.
              await deadLetter(
                stream,
                error.receipt,
                0,
                `the queue message body is not a valid event queue message: ${error.message}`,
                error,
              );
              continue;
            }
            // A queue/database fault. The loop mode backs off and retries; a bounded pass has nothing to
            // back off INTO (it must not busy-spin against a broken queue for the whole budget), so the
            // stream is left for the next invocation and the pass reports itself unfinished.
            console.warn(
              `pgxsinkit: the event consumer could not read Event stream "${stream}" during a bounded drain; ` +
                "leaving it for the next pass",
              error,
            );
            pending.delete(stream);
            unfinished = true;
            continue;
          }

          if (messages.length === 0) {
            pending.delete(stream);
            continue;
          }
          await processDelivered(stream, messages, halted);
        }
      }
    } finally {
      drainStats = null;
    }

    return { delivered: stats.delivered, deadLettered: stats.deadLettered, empty: !unfinished };
  };

  return {
    start: () => {
      if (activeDrain) {
        throw new Error(
          "pgxsinkit: this event consumer is running a bounded `drainOnce()` pass, so `start()` cannot also " +
            "run its polling loops — one handle drives one pacing mode at a time. Await the pass first.",
        );
      }
      if (started || stopping) {
        // Idempotent, and a no-op after `stop()` — the handle's lifecycle is one-way, matching the client's
        // flush driver. A restart is a new `defineEventConsumer`.
        return;
      }
      started = true;
      loops = streams.map((stream) =>
        // The catch is attached HERE, at creation: a loop is only awaited by `stop()`, so an unexpected
        // rejection must never be able to surface as an unhandled promise in the app's process.
        runStream(stream).catch((error: unknown) => {
          console.error(`pgxsinkit: the event consumer loop for Event stream "${stream}" ended unexpectedly`, error);
        }),
      );
    },

    stop: () => {
      stopping = true;
      stopController.abort();
      stopPromise ??= (async () => {
        await Promise.all(loops);
        loops = [];
        // A bounded pass is stopped like a loop: `halted()` already saw `stopping`, so it enters no further
        // callback — this just makes `stop()` resolve only once the one it was on has settled.
        await activeDrain?.catch(() => undefined);
      })();
      return stopPromise;
    },

    // Deliberately `async`, so every refusal below is a REJECTION rather than a synchronous throw from a
    // promise-returning function — a caller that only wired `.catch()` must not lose one.
    drainOnce: async (drainOptions = {}) => {
      if (started) {
        throw new Error(
          "pgxsinkit: `drainOnce()` cannot run while this consumer's polling loops are live — one handle " +
            "drives one pacing mode at a time. Use the long-lived runner OR bounded drains, not both on one " +
            "handle. (Two separate PROCESSES draining the same queues concurrently is safe: the visibility " +
            "timeout arbitrates them.)",
        );
      }
      if (stopping) {
        throw new Error(
          "pgxsinkit: this event consumer handle is stopped — its lifecycle is one-way. Build a fresh " +
            "`defineEventConsumer` for the next drain pass; construction is query-free, so that costs nothing.",
        );
      }
      if (activeDrain) {
        throw new Error(
          "pgxsinkit: a `drainOnce()` pass is already in flight on this handle. Two SEPARATE PROCESSES " +
            "draining concurrently is safe (the queue's visibility timeouts arbitrate); two passes on one " +
            "handle would share its internal state, so it is refused. Await the first pass.",
        );
      }

      const budgetMs = drainOptions.budgetMs ?? DEFAULT_EVENT_DRAIN_BUDGET_MS;
      if (!Number.isFinite(budgetMs) || budgetMs < 0) {
        throw new Error(`pgxsinkit: drainOnce's \`budgetMs\` must be a finite number >= 0 (got ${budgetMs}).`);
      }
      const pass = runDrain(budgetMs).finally(() => {
        activeDrain = null;
      });
      activeDrain = pass;
      return pass;
    },
  };
}
