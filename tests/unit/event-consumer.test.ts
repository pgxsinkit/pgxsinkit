import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  defineEventStream,
  defineSyncRegistry,
  defineSyncTable,
  type EventQueueMessage,
  type StampedEvent,
} from "@pgxsinkit/contracts";
import {
  computeEventPollWaitMs,
  defineEventConsumer,
  MalformedEventQueueMessageError,
  type EventConsumer,
  type EventConsumerBatch,
  type EventConsumerSleep,
  type EventDeadLetterReport,
  type EventQueue,
} from "@pgxsinkit/server";

import { createFakeEventQueue, type FakeEventQueue } from "./support/event-queue-fake";

// The Event lane's consumer runner (ADR-0053 decisions 6 + 7), against the in-memory queue fake (which has
// REAL visibility-timeout/redelivery semantics) and a fully injected wait, so nothing here sleeps.
//
// What is pinned: the adaptive interval pacing (immediate re-read after a productive read, floor → ceiling
// growth over consecutive empty reads, reset on delivery), the delivery contract (the callback gets the
// stamped sub-batch exactly as enqueued; return acks, throw retries via the visibility timeout), the
// dead-letter policy and its unconditional loudness, queue-fault resilience, the start/stop lifecycle, and
// per-stream independence.

const todos = defineSyncTable({
  tableName: "todos",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    done: boolean("done").notNull(),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
  }),
});

const registry = defineSyncRegistry({
  tables: { todos },
  streams: {
    board_issue_viewed: defineEventStream({
      payload: z.object({ issueId: z.string() }).strict(),
      identity: { viewerId: { claimPath: ["sub"] } },
    }),
    review_graded: defineEventStream({
      payload: z.object({ cardId: z.string() }).strict(),
      identity: { learnerId: { claimPath: ["sub"] } },
    }),
  },
});

const VIEWED = "board_issue_viewed";
const GRADED = "review_graded";

let eventCounter = 0;
function stampedEvent(): StampedEvent {
  eventCounter += 1;
  return {
    eventId: `00000000-0000-4000-8000-${String(eventCounter).padStart(12, "0")}`,
    occurredAtUs: String(1_754_006_400_000_000 + eventCounter),
    identity: { viewerId: "someone" },
    payload: { issueId: `issue-${eventCounter}` },
  };
}

function message(stream: string, eventCount = 1): EventQueueMessage {
  return { stream, events: Array.from({ length: eventCount }, stampedEvent) };
}

/**
 * The injected wait. Every call records its delay and PARKS until the test releases it, so each loop advances
 * exactly one read per `release()` — the whole suite is stepped, never timed.
 */
function manualSleeper() {
  const waits: number[] = [];
  let parked: Array<() => void> = [];

  const sleep: EventConsumerSleep = (ms, signal) => {
    waits.push(ms);
    if (signal.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const release = (): void => {
        signal.removeEventListener("abort", release);
        resolve();
      };
      parked.push(release);
      signal.addEventListener("abort", release, { once: true });
    });
  };

  return {
    waits,
    sleep,
    parkedCount: () => parked.length,
    /** Let every currently parked loop take its next read. */
    release: (): void => {
      const current = parked;
      parked = [];
      for (const resolve of current) {
        resolve();
      }
    },
  };
}

/**
 * Await a rejection and hand back its message. Used instead of `expect(promise).rejects.toThrow(…)` for the
 * drain refusals: that matcher types as `void` for a promise of an object, so awaiting it trips the
 * `await-thenable` lint.
 */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** A polling helper — no fixed sleeps anywhere in this suite. */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Let already-resolved promise chains drain, for the "nothing more happened" assertions. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** Wrap the fake so reads and lease renewals can be counted, and made to fail, per Event stream. */
function countingQueue(fake: FakeEventQueue) {
  const reads = new Map<string, number>();
  /** Every `extendVisibility` call, as the receipt list it renewed. */
  const renewals: string[][] = [];
  let readFailure: Error | null = null;
  let failuresLeft = 0;
  let renewalFailure: Error | null = null;

  const queue: EventQueue = {
    ...fake,
    readBatch: async (stream, readOptions) => {
      reads.set(stream, (reads.get(stream) ?? 0) + 1);
      if (readFailure && failuresLeft > 0) {
        failuresLeft -= 1;
        const failure = readFailure;
        if (failuresLeft === 0) {
          readFailure = null;
        }
        throw failure;
      }
      return fake.readBatch(stream, readOptions);
    },
    extendVisibility: async (stream, receipts, visibilityTimeoutSeconds) => {
      renewals.push([...receipts]);
      if (renewalFailure) {
        throw renewalFailure;
      }
      return fake.extendVisibility(stream, receipts, visibilityTimeoutSeconds);
    },
  };

  return {
    queue,
    renewals,
    readsOf: (stream: string) => reads.get(stream) ?? 0,
    failReads: (error: Error, times: number) => {
      readFailure = error;
      failuresLeft = times;
    },
    failRenewals: (error: Error | null) => {
      renewalFailure = error;
    },
  };
}

/**
 * The clock `drainOnce` measures its budget against — the drain suite's equivalent of `manualSleeper`, so a
 * budget can expire at an exact point in the pass without anything actually waiting.
 */
function manualClock() {
  let ms = 1_700_000_000_000;
  return {
    now: () => ms,
    advance: (by: number): void => {
      ms += by;
    },
  };
}

interface Harness {
  fake: FakeEventQueue;
  queue: EventQueue;
  renewals: string[][];
  readsOf: (stream: string) => number;
  failReads: (error: Error, times: number) => void;
  failRenewals: (error: Error | null) => void;
  sleeper: ReturnType<typeof manualSleeper>;
  /** The renewal cadence's own stepped wait — a SECOND seam, so poll assertions stay free of renewal noise. */
  renewalSleeper: ReturnType<typeof manualSleeper>;
  clock: ReturnType<typeof manualClock>;
  batches: EventConsumerBatch[];
  deadLetters: EventDeadLetterReport[];
  consumer: EventConsumer;
}

function makeConsumer(
  options: {
    callback?: (batch: EventConsumerBatch) => void | Promise<void>;
    streams?: readonly string[];
    batchSize?: number;
    maxAttempts?: number;
    concurrency?: number;
    visibilityTimeoutSeconds?: number;
    poll?: { floorMs?: number; ceilingMs?: number; factor?: number };
    withDeadLetterHook?: boolean;
  } = {},
): Harness {
  const fake = createFakeEventQueue();
  const counting = countingQueue(fake);
  const sleeper = manualSleeper();
  const renewalSleeper = manualSleeper();
  const clock = manualClock();
  const batches: EventConsumerBatch[] = [];
  const deadLetters: EventDeadLetterReport[] = [];

  const consumer = defineEventConsumer({
    registry,
    queue: counting.queue,
    callback: async (batch) => {
      batches.push(batch);
      await options.callback?.(batch);
    },
    sleep: sleeper.sleep,
    renewalSleep: renewalSleeper.sleep,
    now: clock.now,
    ...(options.streams ? { streams: options.streams } : {}),
    ...(options.batchSize != null ? { batchSize: options.batchSize } : {}),
    ...(options.maxAttempts != null ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.concurrency != null ? { concurrency: options.concurrency } : {}),
    ...(options.visibilityTimeoutSeconds != null ? { visibilityTimeoutSeconds: options.visibilityTimeoutSeconds } : {}),
    ...(options.poll ? { poll: options.poll } : {}),
    ...(options.withDeadLetterHook === false
      ? {}
      : {
          onDeadLetter: (report) => {
            deadLetters.push(report);
          },
        }),
  });

  return { fake, ...counting, sleeper, renewalSleeper, clock, batches, deadLetters, consumer };
}

let warn: ReturnType<typeof spyOn<Console, "warn">>;
let errorLog: ReturnType<typeof spyOn<Console, "error">>;
const running: EventConsumer[] = [];

beforeEach(() => {
  // Dead-letters, callback failures and queue faults all warn by design; capture rather than print.
  warn = spyOn(console, "warn").mockImplementation(() => {});
  errorLog = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((consumer) => consumer.stop()));
  warn.mockRestore();
  errorLog.mockRestore();
});

/** Start a consumer and register it for teardown, so no loop can outlive its test. */
function start(harness: Harness): void {
  running.push(harness.consumer);
  harness.consumer.start();
}

describe("adaptive poll wait (ADR-0053 decision 7)", () => {
  it("starts at the floor, grows by the factor and clamps at the ceiling", () => {
    const poll = { floorMs: 250, ceilingMs: 5_000, factor: 2 };
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((idle) => computeEventPollWaitMs(idle, poll))).toEqual([
      250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000,
    ]);
  });

  it("uses the ADR's defaults when nothing is tuned", () => {
    expect(computeEventPollWaitMs(1)).toBe(250);
    expect(computeEventPollWaitMs(2)).toBe(500);
    expect(computeEventPollWaitMs(99)).toBe(5_000);
  });
});

describe("consumer pacing", () => {
  it("grows the wait from the floor toward the ceiling over consecutive empty reads", async () => {
    const harness = makeConsumer({ streams: [VIEWED] });
    start(harness);

    for (let round = 1; round <= 6; round += 1) {
      await waitUntil(() => harness.sleeper.waits.length === round, `wait #${round}`);
      harness.sleeper.release();
    }
    await waitUntil(() => harness.sleeper.waits.length === 7, "wait #7");

    expect(harness.sleeper.waits).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
    expect(harness.readsOf(VIEWED)).toBe(7);
  });

  it("re-reads IMMEDIATELY after a non-empty read — a backlog drains back-to-back", async () => {
    const harness = makeConsumer({ streams: [VIEWED], batchSize: 1 });
    await harness.fake.enqueueBatch([message(VIEWED), message(VIEWED), message(VIEWED)]);
    start(harness);

    // Three productive reads with NO wait between them, then one empty read that parks at the floor.
    await waitUntil(() => harness.sleeper.waits.length === 1, "the first wait");
    expect(harness.batches).toHaveLength(3);
    expect(harness.readsOf(VIEWED)).toBe(4);
    expect(harness.sleeper.waits).toEqual([250]);
  });

  it("resets the wait to the floor after a delivery", async () => {
    const harness = makeConsumer({ streams: [VIEWED] });
    start(harness);

    for (let round = 1; round <= 3; round += 1) {
      await waitUntil(() => harness.sleeper.waits.length === round, `wait #${round}`);
      harness.sleeper.release();
    }
    await waitUntil(() => harness.sleeper.waits.length === 4, "the grown wait");
    expect(harness.sleeper.waits).toEqual([250, 500, 1_000, 2_000]);

    await harness.fake.enqueueBatch([message(VIEWED)]);
    harness.sleeper.release();

    await waitUntil(() => harness.sleeper.waits.length === 5, "the reset wait");
    expect(harness.batches).toHaveLength(1);
    expect(harness.sleeper.waits.at(-1)).toBe(250);
  });
});

describe("delivery", () => {
  it("hands the callback the stamped sub-batch exactly as enqueued, and acks on success", async () => {
    const enqueued = message(VIEWED, 3);
    const harness = makeConsumer({ streams: [VIEWED] });
    await harness.fake.enqueueBatch([enqueued]);
    start(harness);

    await waitUntil(() => harness.batches.length === 1, "the delivery");
    expect(harness.batches[0]?.stream).toBe(VIEWED);
    expect(harness.batches[0]?.events).toEqual(enqueued.events);

    await waitUntil(() => harness.fake.peek(VIEWED).length === 0, "the ack");
    expect(harness.fake.peekDeadLetters(VIEWED)).toHaveLength(0);
  });

  it("a throwing callback does NOT ack — the visibility timeout is the retry pacing", async () => {
    const harness = makeConsumer({
      streams: [VIEWED],
      visibilityTimeoutSeconds: 30,
      callback: () => {
        throw new Error("consumer blew up");
      },
    });
    await harness.fake.enqueueBatch([message(VIEWED)]);
    start(harness);

    await waitUntil(() => harness.batches.length === 1, "the first delivery");
    // Still queued, and invisible: the very next read sees nothing.
    await waitUntil(() => harness.sleeper.waits.length === 1, "the wait after the failed delivery");
    expect(harness.fake.peek(VIEWED)).toHaveLength(1);
    expect(harness.fake.peek(VIEWED)[0]?.deliveryCount).toBe(1);

    harness.sleeper.release();
    await waitUntil(() => harness.sleeper.waits.length === 2, "the read while still invisible");
    expect(harness.batches).toHaveLength(1);

    // Once the visibility timeout lapses it is redelivered, with an incremented delivery count.
    harness.fake.advance(30_000);
    harness.sleeper.release();
    await waitUntil(() => harness.batches.length === 2, "the redelivery");
    expect(harness.fake.peek(VIEWED)[0]?.deliveryCount).toBe(2);
  });

  it("runs at most `concurrency` callbacks at once, and still processes every message", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const gates: Array<() => void> = [];
    const harness = makeConsumer({
      streams: [VIEWED],
      batchSize: 4,
      concurrency: 2,
      callback: async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise<void>((resolve) => gates.push(resolve));
        inFlight -= 1;
      },
    });
    await harness.fake.enqueueBatch([message(VIEWED), message(VIEWED), message(VIEWED), message(VIEWED)]);
    start(harness);

    await waitUntil(() => gates.length === 2, "two concurrent callbacks");
    expect(inFlight).toBe(2);
    while (gates.length > 0) {
      gates.splice(0).forEach((resolve) => {
        resolve();
      });
      await settle();
    }

    await waitUntil(() => harness.fake.peek(VIEWED).length === 0, "every message acked");
    expect(harness.batches).toHaveLength(4);
    expect(peakInFlight).toBe(2);
  });
});

describe("visibility renewal (ADR-0053 decision 7 — internal, and not optional)", () => {
  it("renews at HALF the visibility window, so the timeout is never the batch's processing budget", async () => {
    const harness = makeConsumer({ streams: [VIEWED], visibilityTimeoutSeconds: 10, callback: async () => {} });
    await harness.fake.enqueueBatch([message(VIEWED)]);
    start(harness);

    await waitUntil(() => harness.renewalSleeper.waits.length >= 1, "the renewal wait");
    expect(harness.renewalSleeper.waits[0]).toBe(5_000);
  });

  it("keeps the LATER messages of a slow sequential batch invisible while an earlier callback runs long", async () => {
    // The finding this closes: one read makes the whole batch invisible, and the runner then works through
    // it sequentially. Without renewal, ten ordinary callbacks outlive a shared 60s window and a second
    // runner picks up messages the first has not reached yet — avoidable duplicates, and delivery counts
    // marching toward dead-lettering while every individual callback is comfortably inside the timeout.
    const gates: Array<() => void> = [];
    const harness = makeConsumer({
      streams: [VIEWED],
      batchSize: 3,
      visibilityTimeoutSeconds: 10,
      callback: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
      },
    });
    await harness.fake.enqueueBatch([message(VIEWED), message(VIEWED), message(VIEWED)]);
    start(harness);

    await waitUntil(() => gates.length === 1, "the first (slow) callback");
    await waitUntil(() => harness.renewalSleeper.parkedCount() === 1, "the renewal timer");

    // 5s in (half the window), the renewal fires for ALL THREE receipts — the one in flight and the two
    // still queued behind it.
    harness.fake.advance(5_000);
    harness.renewalSleeper.release();
    await waitUntil(() => harness.renewals.length === 1, "the first renewal");
    expect(harness.renewals[0]).toEqual(["1", "2", "3"]);

    // Now past the ORIGINAL deadline: a second runner's read still sees nothing.
    harness.fake.advance(6_000);
    expect(await harness.fake.readBatch(VIEWED, { visibilityTimeoutSeconds: 10, maxMessages: 10 })).toEqual([]);

    // The batch then completes normally.
    while (harness.batches.length < 3 || gates.length > 0) {
      gates.splice(0).forEach((resolve) => {
        resolve();
      });
      await settle();
    }
    await waitUntil(() => harness.fake.peek(VIEWED).length === 0, "every message acked");
  });

  it("stops renewing a message the moment it throws — the lapsing lease IS the retry pacing", async () => {
    const gates: Array<() => void> = [];
    let deliveries = 0;
    const harness = makeConsumer({
      streams: [VIEWED],
      batchSize: 2,
      visibilityTimeoutSeconds: 10,
      maxAttempts: 5,
      callback: async () => {
        deliveries += 1;
        if (deliveries === 1) {
          throw new Error("first sub-batch blew up");
        }
        if (deliveries === 2) {
          await new Promise<void>((resolve) => gates.push(resolve));
        }
      },
    });
    await harness.fake.enqueueBatch([message(VIEWED), message(VIEWED)]);
    start(harness);

    // Message 1 threw; message 2's callback is still running.
    await waitUntil(() => gates.length === 1, "the second callback");
    await waitUntil(() => harness.renewalSleeper.parkedCount() === 1, "the renewal timer");

    harness.renewalSleeper.release();
    await waitUntil(() => harness.renewals.length === 1, "the renewal");
    // ONLY the unsettled one. Renewing the thrown message would postpone its own redelivery.
    expect(harness.renewals[0]).toEqual(["2"]);

    gates.splice(0).forEach((resolve) => {
      resolve();
    });
    await waitUntil(() => harness.fake.peek(VIEWED).length === 1, "the second message acked");

    // …and the thrown one comes back after its (un-renewed) visibility timeout, exactly as before.
    harness.fake.advance(11_000);
    harness.sleeper.release();
    await waitUntil(() => harness.batches.length === 3, "the redelivery of the thrown sub-batch");
  });

  it("stops renewing once the read settles", async () => {
    const gates: Array<() => void> = [];
    const harness = makeConsumer({
      streams: [VIEWED],
      visibilityTimeoutSeconds: 10,
      callback: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
      },
    });
    await harness.fake.enqueueBatch([message(VIEWED)]);
    start(harness);

    await waitUntil(() => gates.length === 1, "the in-flight callback");
    await waitUntil(() => harness.renewalSleeper.parkedCount() === 1, "the renewal timer");
    harness.renewalSleeper.release();
    await waitUntil(() => harness.renewals.length === 1, "the renewal");

    gates.splice(0).forEach((resolve) => {
      resolve();
    });
    await waitUntil(() => harness.fake.peek(VIEWED).length === 0, "the ack");

    // The unsettled set drained, so the renewal task exited with its read — a stray timer would keep
    // extending a lease nobody holds any more (and would hold the app's process open).
    harness.renewalSleeper.release();
    await settle();
    expect(harness.renewals).toHaveLength(1);
  });

  it("KEEPS renewing an in-flight callback across stop(), and releases the read's unstarted messages", async () => {
    // The finding this closes: `stop()` used to abort renewal outright while still awaiting (and then
    // acking) the callback already running. On an ordinary SIGTERM/rollout a callback outliving the lease
    // remaining at shutdown would be handed to a second runner while the first deliberately completes it.
    const gates: Array<() => void> = [];
    const harness = makeConsumer({
      streams: [VIEWED],
      batchSize: 2,
      visibilityTimeoutSeconds: 10,
      callback: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
      },
    });
    await harness.fake.enqueueBatch([message(VIEWED), message(VIEWED)]);
    start(harness);

    // Message 1's callback is in flight; message 2 is delivered-but-unstarted behind it. Both are renewed.
    await waitUntil(() => gates.length === 1, "the in-flight callback");
    await waitUntil(() => harness.renewalSleeper.parkedCount() === 1, "the renewal timer");
    harness.renewalSleeper.release();
    await waitUntil(() => harness.renewals.length === 1, "the renewal before the stop");
    expect(harness.renewals[0]).toEqual(["1", "2"]);

    let stopped = false;
    const stopping = harness.consumer.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);

    // Renewal did NOT stop with the runner: the receipt whose callback is being awaited keeps its lease.
    // Message 2, which no callback ever entered, was released the moment stop() was called.
    await waitUntil(() => harness.renewalSleeper.parkedCount() === 1, "the renewal timer after the stop");
    harness.renewalSleeper.release();
    await waitUntil(() => harness.renewals.length === 2, "the renewal after the stop");
    expect(harness.renewals[1]).toEqual(["1"]);

    gates.splice(0).forEach((resolve) => {
      resolve();
    });
    await stopping;
    expect(stopped).toBe(true);

    // The in-flight one was finished and acked; the released one is still queued, unacked and un-renewed…
    const remaining = harness.fake.peek(VIEWED);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe("2");

    // …so its (never-extended-again) lease lapses and the queue hands it straight back for redelivery.
    harness.fake.advance(11_000);
    expect(
      (await harness.fake.readBatch(VIEWED, { visibilityTimeoutSeconds: 10, maxMessages: 10 })).map(
        (delivered) => delivered.receipt,
      ),
    ).toEqual(["2"]);

    // And once stop() has resolved, nothing renews anything: the task shut down with the read it owned.
    harness.renewalSleeper.release();
    await settle();
    expect(harness.renewals).toHaveLength(2);
  });

  it("stop() still resolves promptly when nothing is in flight — no renewal outlives an idle runner", async () => {
    const harness = makeConsumer({ streams: [VIEWED], visibilityTimeoutSeconds: 10 });
    await harness.fake.enqueueBatch([message(VIEWED)]);
    start(harness);

    // The read settled (acked) and the loop is parked on its poll wait; nothing is in flight.
    await waitUntil(() => harness.fake.peek(VIEWED).length === 0, "the ack");
    await waitUntil(() => harness.sleeper.parkedCount() === 1, "the idle poll wait");

    // Resolves on the stop signal alone — never after a renewal interval, which is NEVER released here.
    await harness.consumer.stop();
    expect(harness.renewals).toHaveLength(0);
  });

  it("survives a renewal failure — best-effort, because redelivery is the safety net anyway", async () => {
    const gates: Array<() => void> = [];
    const harness = makeConsumer({
      streams: [VIEWED],
      visibilityTimeoutSeconds: 10,
      callback: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
      },
    });
    harness.failRenewals(new Error("connection refused"));
    await harness.fake.enqueueBatch([message(VIEWED)]);
    start(harness);

    await waitUntil(() => gates.length === 1, "the in-flight callback");
    await waitUntil(() => harness.renewalSleeper.parkedCount() === 1, "the renewal timer");
    harness.renewalSleeper.release();
    await waitUntil(() => harness.renewals.length === 1, "the failed renewal");

    // It warns and keeps going: the renewal loop re-parks, and the callback/ack path is untouched.
    await waitUntil(() => harness.renewalSleeper.parkedCount() === 1, "the next renewal wait");
    expect(warn.mock.calls.map((call) => String(call[0])).some((line) => line.includes("could not renew"))).toBe(true);

    gates.splice(0).forEach((resolve) => {
      resolve();
    });
    await waitUntil(() => harness.fake.peek(VIEWED).length === 0, "the ack");
    expect(harness.batches).toHaveLength(1);
  });
});

describe("dead-lettering", () => {
  it("dead-letters after `maxAttempts` deliveries, with the report payload and a warn", async () => {
    const harness = makeConsumer({
      streams: [VIEWED],
      maxAttempts: 2,
      visibilityTimeoutSeconds: 10,
      callback: () => {
        throw new Error("poison");
      },
    });
    const enqueued = message(VIEWED, 2);
    await harness.fake.enqueueBatch([enqueued]);
    start(harness);

    await waitUntil(() => harness.sleeper.waits.length === 1, "the wait after delivery 1");
    expect(harness.fake.peekDeadLetters(VIEWED)).toHaveLength(0);

    harness.fake.advance(10_000);
    harness.sleeper.release();
    await waitUntil(() => harness.deadLetters.length === 1, "the dead-letter");

    const report = harness.deadLetters[0];
    expect(report?.stream).toBe(VIEWED);
    expect(report?.attempts).toBe(2);
    expect(report?.receipt).toBe("1");
    expect(report?.message).toEqual(enqueued);
    expect(report?.reason).toContain("delivery 2 of 2");
    expect(report?.cause).toBeInstanceOf(Error);
    expect((report?.cause as Error | undefined)?.message).toBe("poison");

    expect(harness.fake.peek(VIEWED)).toHaveLength(0);
    expect(harness.fake.peekDeadLetters(VIEWED)).toHaveLength(1);
    expect(harness.fake.peekDeadLetters(VIEWED)[0]?.reason).toContain("delivery 2 of 2");
  });

  it("warns even when no `onDeadLetter` hook is wired — loudness is the runner's job", async () => {
    const harness = makeConsumer({
      streams: [VIEWED],
      maxAttempts: 1,
      withDeadLetterHook: false,
      callback: () => {
        throw new Error("poison");
      },
    });
    await harness.fake.enqueueBatch([message(VIEWED)]);
    start(harness);

    await waitUntil(() => harness.fake.peekDeadLetters(VIEWED).length === 1, "the dead-letter");
    const warned = warn.mock.calls.map((call) => String(call[0]));
    expect(warned.some((line) => line.includes("dead-lettered an event sub-batch"))).toBe(true);
  });

  it("dead-letters a malformed body ON SIGHT, without invoking the callback", async () => {
    const fake = createFakeEventQueue();
    const sleeper = manualSleeper();
    const batches: EventConsumerBatch[] = [];
    const deadLetters: EventDeadLetterReport[] = [];
    let poisoned = true;

    const queue: EventQueue = {
      ...fake,
      readBatch: async (stream, readOptions) => {
        if (poisoned) {
          poisoned = false;
          // The pgmq backend's behaviour: one unreadable body fails the WHOLE read, naming its receipt.
          throw new MalformedEventQueueMessageError(stream, "1", "not an object");
        }
        return fake.readBatch(stream, readOptions);
      },
    };

    const consumer = defineEventConsumer({
      registry,
      queue,
      streams: [VIEWED],
      sleep: sleeper.sleep,
      callback: (batch) => {
        batches.push(batch);
      },
      onDeadLetter: (report) => {
        deadLetters.push(report);
      },
    });
    running.push(consumer);
    await fake.enqueueBatch([message(VIEWED)]);
    consumer.start();

    await waitUntil(() => deadLetters.length === 1, "the malformed dead-letter");
    expect(batches).toHaveLength(0);
    expect(deadLetters[0]?.receipt).toBe("1");
    expect(deadLetters[0]?.attempts).toBe(0);
    expect(deadLetters[0]?.message).toBeUndefined();
    expect(deadLetters[0]?.reason).toContain("not a valid event queue message");
    expect(fake.peekDeadLetters(VIEWED)).toHaveLength(1);
    // A dead-letter IS progress: the loop re-read IMMEDIATELY (no wait in between) and the wait it then
    // parked at is the FLOOR — had the malformed read counted as an idle read, this would be 500.
    await waitUntil(() => sleeper.waits.length === 1, "the wait after the re-read");
    await settle();
    expect(sleeper.waits).toEqual([250]);
  });
});

describe("queue-fault resilience", () => {
  it("backs off on a read failure and recovers when the queue heals", async () => {
    const harness = makeConsumer({ streams: [VIEWED] });
    harness.failReads(new Error("connection refused"), 2);
    start(harness);

    await waitUntil(() => harness.sleeper.waits.length === 1, "the first backoff");
    expect(harness.sleeper.waits).toEqual([250]);

    harness.sleeper.release();
    await waitUntil(() => harness.sleeper.waits.length === 2, "the grown backoff");
    expect(harness.sleeper.waits).toEqual([250, 500]);

    // Healed: the loop never exited, so the next read succeeds and a delivery lands.
    await harness.fake.enqueueBatch([message(VIEWED)]);
    harness.sleeper.release();
    await waitUntil(() => harness.batches.length === 1, "the recovered delivery");

    const warned = warn.mock.calls.map((call) => String(call[0]));
    expect(warned.some((line) => line.includes("could not read Event stream"))).toBe(true);
  });
});

describe("lifecycle", () => {
  it("start() is idempotent — a second call does not add a second loop", async () => {
    const harness = makeConsumer({ streams: [VIEWED] });
    start(harness);
    harness.consumer.start();
    harness.consumer.start();

    await waitUntil(() => harness.sleeper.waits.length === 1, "the first wait");
    await settle();
    expect(harness.readsOf(VIEWED)).toBe(1);
    expect(harness.sleeper.parkedCount()).toBe(1);
  });

  it("stop() awaits an in-flight callback, then acks it", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const harness = makeConsumer({
      streams: [VIEWED],
      callback: async () => {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      },
    });
    await harness.fake.enqueueBatch([message(VIEWED)]);
    start(harness);

    await waitUntil(() => gate.release !== null, "the in-flight callback");
    let stopped = false;
    const stopping = harness.consumer.stop().then(() => {
      stopped = true;
    });

    await settle();
    expect(stopped).toBe(false);

    gate.release?.();
    await stopping;
    expect(stopped).toBe(true);
    // The in-flight work was FINISHED, not abandoned.
    expect(harness.fake.peek(VIEWED)).toHaveLength(0);
  });

  it("stop() issues no further reads, is safe twice, and makes a later start() a no-op", async () => {
    const harness = makeConsumer({ streams: [VIEWED] });
    start(harness);
    await waitUntil(() => harness.sleeper.waits.length === 1, "the first wait");

    const first = harness.consumer.stop();
    const second = harness.consumer.stop();
    await Promise.all([first, second]);
    const readsAtStop = harness.readsOf(VIEWED);

    harness.consumer.start();
    harness.sleeper.release();
    await settle();
    expect(harness.readsOf(VIEWED)).toBe(readsAtStop);
  });

  it("stop() before start() resolves immediately", async () => {
    const harness = makeConsumer({ streams: [VIEWED] });
    await harness.consumer.stop();
    expect(harness.readsOf(VIEWED)).toBe(0);
  });
});

describe("bounded drain — drainOnce (ADR-0053 amendment: serverless drain hosting)", () => {
  it("drains every configured stream to empty and reports what it did", async () => {
    // `batchSize: 1` forces several reads per stream, which is the point: the pass keeps re-reading a
    // productive stream and only drops it once it reads EMPTY.
    const harness = makeConsumer({ batchSize: 1 });
    await harness.fake.enqueueBatch([message(VIEWED, 2), message(GRADED), message(VIEWED)]);

    const summary = await harness.consumer.drainOnce();

    expect(summary).toEqual({ delivered: 3, deadLettered: 0, empty: true });
    // Round-robin across streams, one read each per round — the loop mode's per-stream independence,
    // preserved: a long backlog on one stream cannot hold up another's drain within the same pass.
    expect(harness.batches.map((batch) => batch.stream)).toEqual([VIEWED, GRADED, VIEWED]);
    expect(harness.fake.peek(VIEWED)).toHaveLength(0);
    expect(harness.fake.peek(GRADED)).toHaveLength(0);
    // Two productive reads + the empty one that ends the stream; one + one for the single-message stream.
    expect(harness.readsOf(VIEWED)).toBe(3);
    expect(harness.readsOf(GRADED)).toBe(2);
    // No pacing at all: a bounded pass never waits, so the injected sleep is untouched.
    expect(harness.sleeper.waits).toEqual([]);
  });

  it("reports `empty: true` on an already-drained queue, without delivering anything", async () => {
    const harness = makeConsumer({ streams: [VIEWED] });

    expect(await harness.consumer.drainOnce()).toEqual({ delivered: 0, deadLettered: 0, empty: true });
    expect(harness.readsOf(VIEWED)).toBe(1);
  });

  it("stops BETWEEN sub-batches when the budget runs out, and reports `empty: false`", async () => {
    // The budget is 4s and the first callback burns 5s of it. The other two messages of that same read were
    // delivered but never entered, so nothing further runs and NO further read is issued.
    const harness = makeConsumer({
      streams: [VIEWED],
      batchSize: 3,
      visibilityTimeoutSeconds: 30,
      callback: () => {
        harness.clock.advance(5_000);
      },
    });
    await harness.fake.enqueueBatch([message(VIEWED), message(VIEWED), message(VIEWED)]);

    const summary = await harness.consumer.drainOnce({ budgetMs: 4_000 });

    expect(summary).toEqual({ delivered: 1, deadLettered: 0, empty: false });
    expect(harness.batches).toHaveLength(1);
    // Exactly ONE read — the pass issues none after the cutoff.
    expect(harness.readsOf(VIEWED)).toBe(1);
    // The one that ran was acked; the two the pass never entered are still queued for the next invocation.
    expect(harness.fake.peek(VIEWED)).toHaveLength(2);

    // …and they were RELEASED from renewal rather than held invisible behind work this pass will not do, so
    // their leases lapse on schedule and the next pass picks them straight up.
    harness.fake.advance(31_000);
    expect(
      (await harness.fake.readBatch(VIEWED, { visibilityTimeoutSeconds: 30, maxMessages: 10 })).map(
        (delivered) => delivered.receipt,
      ),
    ).toEqual(["2", "3"]);
  });

  it("issues no read at all once the budget is already spent", async () => {
    const harness = makeConsumer({ streams: [VIEWED] });
    await harness.fake.enqueueBatch([message(VIEWED)]);

    expect(await harness.consumer.drainOnce({ budgetMs: 0 })).toEqual({
      delivered: 0,
      deadLettered: 0,
      empty: false,
    });
    expect(harness.readsOf(VIEWED)).toBe(0);
    expect(harness.fake.peek(VIEWED)).toHaveLength(1);
  });

  it("dead-letters through the SAME path the runner uses, and counts it", async () => {
    const harness = makeConsumer({
      streams: [VIEWED],
      maxAttempts: 1,
      callback: () => {
        throw new Error("poison");
      },
    });
    await harness.fake.enqueueBatch([message(VIEWED)]);

    const summary = await harness.consumer.drainOnce();

    expect(summary).toEqual({ delivered: 0, deadLettered: 1, empty: true });
    expect(harness.fake.peek(VIEWED)).toHaveLength(0);
    expect(harness.fake.peekDeadLetters(VIEWED)).toHaveLength(1);
    // The hook AND the unconditional warn — the runner's loudness is not a loop-mode-only property.
    expect(harness.deadLetters).toHaveLength(1);
    expect(harness.deadLetters[0]?.reason).toContain("delivery 1 of 1");
    expect(warn.mock.calls.map((call) => String(call[0])).some((line) => line.includes("dead-lettered an event"))).toBe(
      true,
    );
  });

  it("leaves a sub-batch whose callback threw for a later pass — at-least-once, not a loss", async () => {
    const harness = makeConsumer({
      streams: [VIEWED],
      maxAttempts: 5,
      visibilityTimeoutSeconds: 10,
      callback: () => {
        throw new Error("transient");
      },
    });
    await harness.fake.enqueueBatch([message(VIEWED)]);

    // The throw is not acked and stops being renewed, so it is invisible: the pass's next read finds
    // nothing and ends. Nothing is dead-lettered (attempts remain) and nothing counts as delivered.
    expect(await harness.consumer.drainOnce()).toEqual({ delivered: 0, deadLettered: 0, empty: true });
    expect(harness.fake.peek(VIEWED)).toHaveLength(1);
    expect(harness.fake.peekDeadLetters(VIEWED)).toHaveLength(0);

    // Once the (un-renewed) lease lapses, the very next pass gets it back with an incremented count.
    harness.fake.advance(11_000);
    expect(await harness.consumer.drainOnce()).toEqual({ delivered: 0, deadLettered: 0, empty: true });
    expect(harness.batches).toHaveLength(2);
    expect(harness.fake.peek(VIEWED)[0]?.deliveryCount).toBe(2);
  });

  it("reports `empty: false` on a read fault instead of spinning against a broken queue", async () => {
    const harness = makeConsumer({ streams: [VIEWED] });
    harness.failReads(new Error("connection refused"), 5);

    expect(await harness.consumer.drainOnce()).toEqual({ delivered: 0, deadLettered: 0, empty: false });
    // ONE attempt: a bounded pass has nothing to back off into, so the stream is left for the next tick.
    expect(harness.readsOf(VIEWED)).toBe(1);
  });

  it("refuses to run beside the polling loops — one handle, one pacing mode", async () => {
    const harness = makeConsumer({ streams: [VIEWED] });
    start(harness);
    await waitUntil(() => harness.sleeper.waits.length === 1, "the loop's first wait");

    expect(await rejectionMessage(harness.consumer.drainOnce())).toMatch(/one pacing mode at a time/);
  });

  it("refuses a second concurrent pass on the same handle", async () => {
    const gates: Array<() => void> = [];
    const harness = makeConsumer({
      streams: [VIEWED],
      callback: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
      },
    });
    await harness.fake.enqueueBatch([message(VIEWED)]);

    const first = harness.consumer.drainOnce();
    expect(await rejectionMessage(harness.consumer.drainOnce())).toMatch(/already in flight/);

    await waitUntil(() => gates.length === 1, "the in-flight callback");
    gates.splice(0).forEach((resolve) => {
      resolve();
    });
    expect(await first).toEqual({ delivered: 1, deadLettered: 0, empty: true });

    // …and once it has settled the handle takes another pass: the exclusion is per-pass, not one-shot.
    expect(await harness.consumer.drainOnce()).toEqual({ delivered: 0, deadLettered: 0, empty: true });
  });

  it("refuses after stop() — the handle's lifecycle is one-way, so the next pass is a fresh consumer", async () => {
    const harness = makeConsumer({ streams: [VIEWED] });
    await harness.consumer.stop();

    expect(await rejectionMessage(harness.consumer.drainOnce())).toMatch(/lifecycle is one-way/);
    expect(harness.readsOf(VIEWED)).toBe(0);
  });

  it("start() refuses while a pass is in flight, and stop() waits for it", async () => {
    const gates: Array<() => void> = [];
    const harness = makeConsumer({
      streams: [VIEWED],
      callback: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
      },
    });
    await harness.fake.enqueueBatch([message(VIEWED)]);

    const pass = harness.consumer.drainOnce();
    await waitUntil(() => gates.length === 1, "the in-flight callback");
    expect(() => {
      harness.consumer.start();
    }).toThrow(/one handle drives one pacing mode/);

    let stopped = false;
    const stopping = harness.consumer.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);

    gates.splice(0).forEach((resolve) => {
      resolve();
    });
    await pass;
    await stopping;
    expect(stopped).toBe(true);
    // The callback that was already running was finished and acked, exactly as a graceful loop stop does.
    expect(harness.fake.peek(VIEWED)).toHaveLength(0);
  });
});

describe("multi-stream", () => {
  it("paces each Event stream independently — a busy one stays at the floor while an idle one grows", async () => {
    const harness = makeConsumer({});
    await harness.fake.enqueueBatch([message(VIEWED)]);
    start(harness);

    // Round 1: both streams read; VIEWED delivers then finds nothing, GRADED was empty from the start.
    await waitUntil(() => harness.sleeper.waits.length === 2, "both first waits");
    expect([...harness.sleeper.waits].sort((a, b) => a - b)).toEqual([250, 250]);

    for (const expected of [
      [250, 500],
      [250, 1_000],
    ]) {
      await harness.fake.enqueueBatch([message(VIEWED)]);
      const before = harness.sleeper.waits.length;
      harness.sleeper.release();
      await waitUntil(() => harness.sleeper.waits.length === before + 2, "the next round of waits");
      expect(harness.sleeper.waits.slice(before).sort((a, b) => a - b)).toEqual(expected);
    }

    expect(harness.batches).toHaveLength(3);
    expect(harness.batches.every((batch) => batch.stream === VIEWED)).toBe(true);
  });

  it("`streams` narrows to a subset — an unlisted stream is never read", async () => {
    const harness = makeConsumer({ streams: [GRADED] });
    await harness.fake.enqueueBatch([message(VIEWED), message(GRADED)]);
    start(harness);

    await waitUntil(() => harness.batches.length === 1, "the subset delivery");
    expect(harness.batches[0]?.stream).toBe(GRADED);
    expect(harness.readsOf(VIEWED)).toBe(0);
    expect(harness.fake.peek(VIEWED)).toHaveLength(1);
  });

  it("throws at DEFINITION time for an unknown stream, naming every offender", () => {
    expect(() =>
      defineEventConsumer({
        registry,
        queue: createFakeEventQueue(),
        callback: () => {},
        streams: ["board_issue_viewd", GRADED, "reviw_graded"],
      }),
    ).toThrow(/board_issue_viewd, reviw_graded/);
  });

  it("throws at DEFINITION time for an empty `streams` list", () => {
    expect(() =>
      defineEventConsumer({ registry, queue: createFakeEventQueue(), callback: () => {}, streams: [] }),
    ).toThrow(/empty `streams` list/);
  });

  it("throws at DEFINITION time when the registry registers no Event stream at all", () => {
    const streamless = defineSyncRegistry({ tables: { todos } });
    expect(() =>
      defineEventConsumer({ registry: streamless, queue: createFakeEventQueue(), callback: () => {} }),
    ).toThrow(/registers no Event streams/);
  });

  it("refuses nonsense tuning at DEFINITION time", () => {
    expect(() =>
      defineEventConsumer({ registry, queue: createFakeEventQueue(), callback: () => {}, batchSize: 0 }),
    ).toThrow(/`batchSize` must be a finite number >= 1/);
    expect(() =>
      defineEventConsumer({
        registry,
        queue: createFakeEventQueue(),
        callback: () => {},
        poll: { floorMs: 1_000, ceilingMs: 100 },
      }),
    ).toThrow(/`poll.ceilingMs` must be a finite number >= 1000/);
  });
});
