import { describe, expect, it } from "bun:test";

import { PgDialect } from "drizzle-orm/pg-core";

import { EVENT_STREAM_QUEUE_PREFIX, type EventQueueMessage } from "@pgxsinkit/contracts";
import {
  createPgmqEventQueue,
  eventStreamQueueName,
  MalformedEventQueueMessageError,
  PGMQ_DEAD_LETTER_KEY,
} from "@pgxsinkit/server";

import { createFakeEventQueue } from "./support/event-queue-fake";

// The Event lane's queue seam (ADR-0053 decision 5). Two halves, deliberately separated:
//
//  - the INTERFACE contract (receipts, visibility timeout, redelivery, archive-as-dead-letter, deliberate
//    requeue), exercised against the in-memory backend — that is what a backend swap must preserve;
//  - the pgmq backend's STATEMENT shapes, asserted by rendering the drizzle `sql` templates. The SQL's real
//    behaviour is the container lane's job; what belongs here is that every queue name, receipt and value
//    crosses as a BOUND parameter and never as baked template text.

const dialect = new PgDialect();

interface RecordedStatement {
  sql: string;
  params: unknown[];
}

/** Records the rendered SQL of every statement and replays canned rows. */
function recordingExecutor(rows: unknown[][] = []) {
  const statements: RecordedStatement[] = [];
  let index = 0;
  return {
    statements,
    executor: {
      execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        const rendered = dialect.sqlToQuery(query);
        statements.push({ sql: rendered.sql, params: rendered.params });
        return rows[index++] ?? [];
      },
    },
  };
}

const message = (stream: string, eventId: string): EventQueueMessage => ({
  stream,
  events: [{ eventId, occurredAtUs: "1754006400000000", identity: { viewerId: "someone" }, payload: { a: 1 } }],
});

const EVENT_A = "00000000-0000-4000-8000-00000000000a";
const EVENT_B = "00000000-0000-4000-8000-00000000000b";

describe("event queue naming (ADR-0053 decision 5)", () => {
  it("derives the queue name from the contracts-level prefix", () => {
    expect(eventStreamQueueName("board_issue_viewed")).toBe(`${EVENT_STREAM_QUEUE_PREFIX}board_issue_viewed`);
  });

  it("refuses a name the registry would never have accepted — nothing unvalidated reaches backend SQL", () => {
    expect(() => eventStreamQueueName("Board Issues")).toThrow(/not a usable Event-stream name/);
    expect(() => eventStreamQueueName("x'; DROP TABLE q; --")).toThrow(/not a usable Event-stream name/);
    expect(() => eventStreamQueueName("a".repeat(31))).toThrow(/not a usable Event-stream name/);
  });
});

describe("pgmq backend — statement shapes", () => {
  it("sends ONE send_batch per Event stream, through the caller's executor, with bound bodies", async () => {
    const { statements, executor } = recordingExecutor();
    const outer = recordingExecutor();
    const queue = createPgmqEventQueue({ db: outer.executor });

    await queue.enqueueBatch(
      [
        message("board_issue_viewed", EVENT_A),
        message("board_aid_used", EVENT_B),
        message("board_issue_viewed", EVENT_B),
      ],
      executor,
    );

    // The endpoint's transaction was used, not the backend's own handle — that is what makes it atomic.
    expect(outer.statements).toEqual([]);
    expect(statements).toHaveLength(2);
    expect(statements[0]?.sql).toContain("pgmq.send_batch($1, ARRAY(SELECT jsonb_array_elements($2::text::jsonb)))");
    expect(statements[0]?.params[0]).toBe(`${EVENT_STREAM_QUEUE_PREFIX}board_issue_viewed`);
    // Both messages of a stream ride ONE send_batch, in order.
    expect(JSON.parse(String(statements[0]?.params[1]))).toHaveLength(2);
    expect(statements[1]?.params[0]).toBe(`${EVENT_STREAM_QUEUE_PREFIX}board_aid_used`);
    expect(JSON.parse(String(statements[1]?.params[1]))).toHaveLength(1);
  });

  it("sends nothing at all for an empty batch", async () => {
    const { statements, executor } = recordingExecutor();
    await createPgmqEventQueue({ db: executor }).enqueueBatch([], executor);
    expect(statements).toEqual([]);
  });

  it("reads with a visibility timeout and maps pgmq's delivery metadata", async () => {
    const { statements, executor } = recordingExecutor([
      [
        {
          receipt: "7",
          deliveryCount: 3,
          enqueuedAtUs: "1754006400000000",
          message: JSON.stringify(message("board_issue_viewed", EVENT_A)),
        },
      ],
    ]);

    const delivered = await createPgmqEventQueue({ db: executor }).readBatch("board_issue_viewed", {
      visibilityTimeoutSeconds: 30,
      maxMessages: 5,
    });

    expect(statements[0]?.sql).toContain("pgmq.read($1, $2, $3)");
    expect(statements[0]?.params).toEqual([`${EVENT_STREAM_QUEUE_PREFIX}board_issue_viewed`, 30, 5]);
    expect(delivered).toEqual([
      {
        receipt: "7",
        stream: "board_issue_viewed",
        message: message("board_issue_viewed", EVENT_A),
        deliveryCount: 3,
        enqueuedAtUs: "1754006400000000",
      },
    ]);
  });

  it("names the offending receipt when a queue body is not a valid queue message", async () => {
    const { executor } = recordingExecutor([[{ receipt: "9", deliveryCount: 1, enqueuedAtUs: "1", message: "{oops" }]]);

    const failure = await createPgmqEventQueue({ db: executor })
      .readBatch("board_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 1 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MalformedEventQueueMessageError);
    expect((failure as MalformedEventQueueMessageError).receipt).toBe("9");
    expect(String(failure)).toContain("board_issue_viewed");
  });

  it("acks through pgmq.delete and refuses a receipt that is not a backend-issued id", async () => {
    const { statements, executor } = recordingExecutor([[{ affected: 2 }]]);
    const queue = createPgmqEventQueue({ db: executor });

    expect(await queue.ack("board_issue_viewed", ["4", "5"])).toBe(2);
    expect(statements[0]?.sql).toContain("pgmq.delete($1, string_to_array($2, ',')::bigint[])");
    expect(statements[0]?.params).toEqual([`${EVENT_STREAM_QUEUE_PREFIX}board_issue_viewed`, "4,5"]);

    expect(await queue.ack("board_issue_viewed", [])).toBe(0);
    const failure = await queue.ack("board_issue_viewed", ["4; DELETE FROM x"]).catch((error: unknown) => error);
    expect(String(failure)).toContain("not a valid event-queue receipt");
  });

  it("renews a lease through the single-message set_vt, applied over the receipts with a LATERAL", async () => {
    const { statements, executor } = recordingExecutor([[{ affected: 2 }]]);
    const queue = createPgmqEventQueue({ db: executor });

    expect(await queue.extendVisibility("board_issue_viewed", ["4", "5"], 60)).toBe(2);
    // The ARRAY-taking `set_vt` only landed in pgmq 1.8.0 and the toolkit pins no version, so the portable
    // shape is the single-message function over an unnested receipt array — still one statement.
    expect(statements[0]?.sql).toContain("string_to_array($1, ',')::bigint[]");
    expect(statements[0]?.sql).toContain("pgmq.set_vt($2");
    expect(statements[0]?.params).toEqual(["4,5", `${EVENT_STREAM_QUEUE_PREFIX}board_issue_viewed`, 60]);

    expect(await queue.extendVisibility("board_issue_viewed", [], 60)).toBe(0);
    const failure = await queue
      .extendVisibility("board_issue_viewed", ["4; DELETE FROM x"], 60)
      .catch((error: unknown) => error);
    expect(String(failure)).toContain("not a valid event-queue receipt");
  });

  it("dead-letters into pgmq's own archive, then stamps the reason onto the archived body", async () => {
    const { statements, executor } = recordingExecutor([[{ affected: 1 }]]);

    const moved = await createPgmqEventQueue({ db: executor }).deadLetter("board_issue_viewed", ["11"], "poison batch");

    expect(moved).toBe(1);
    // pgmq's own archive move first (version-correct), the reason stamp second (fail-safe direction).
    expect(statements[0]?.sql).toContain("pgmq.archive($1, string_to_array($2, ',')::bigint[])");
    expect(statements[1]?.sql).toContain(`UPDATE pgmq."a_${EVENT_STREAM_QUEUE_PREFIX}board_issue_viewed"`);
    expect(statements[1]?.params).toContain(PGMQ_DEAD_LETTER_KEY);
    expect(statements[1]?.params).toContain("poison batch");
  });

  it("enumerates dead letters with the reserved reason key stripped back out of the message", async () => {
    const { statements, executor } = recordingExecutor([
      [
        {
          id: "11",
          deliveryCount: 4,
          deadLetteredAtUs: "1754006400000000",
          message: JSON.stringify(message("board_issue_viewed", EVENT_A)),
          reason: "poison batch",
        },
      ],
    ]);

    const dead = await createPgmqEventQueue({ db: executor }).listDeadLetters("board_issue_viewed", 10);

    expect(statements[0]?.sql).toContain(`FROM pgmq."a_${EVENT_STREAM_QUEUE_PREFIX}board_issue_viewed"`);
    expect(statements[0]?.params).toContain(PGMQ_DEAD_LETTER_KEY);
    expect(dead).toEqual([
      {
        id: "11",
        stream: "board_issue_viewed",
        message: message("board_issue_viewed", EVENT_A),
        reason: "poison batch",
        deliveryCount: 4,
        deadLetteredAtUs: "1754006400000000",
      },
    ]);
  });

  it("requeues in ONE statement, so a message is never both dead-lettered and queued", async () => {
    const { statements, executor } = recordingExecutor([[{ receipt: "42" }]]);
    const queue = createPgmqEventQueue({ db: executor });

    expect(await queue.requeueDeadLetter("board_issue_viewed", "11")).toBe("42");
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain("WITH restored AS (DELETE FROM");
    expect(statements[0]?.sql).toContain("SELECT pgmq.send($2,");
    expect(statements[0]?.params).toEqual([
      "11",
      `${EVENT_STREAM_QUEUE_PREFIX}board_issue_viewed`,
      PGMQ_DEAD_LETTER_KEY,
    ]);

    const failure = await queue.requeueDeadLetter("board_issue_viewed", "not-an-id").catch((error: unknown) => error);
    expect(String(failure)).toContain("not a valid event-queue receipt");
  });

  it("returns null when the requeued id was not in the archive", async () => {
    const { executor } = recordingExecutor([[]]);
    expect(await createPgmqEventQueue({ db: executor }).requeueDeadLetter("board_issue_viewed", "11")).toBeNull();
  });
});

describe("event queue — the interface contract (backend-independent)", () => {
  it("delivers with a visibility timeout, redelivers when it lapses, and ack is terminal", async () => {
    const queue = createFakeEventQueue();
    await queue.enqueueBatch([message("board_issue_viewed", EVENT_A)]);

    const first = await queue.readBatch("board_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 10 });
    expect(first).toHaveLength(1);
    expect(first[0]?.deliveryCount).toBe(1);

    // Invisible while the timeout holds…
    expect(await queue.readBatch("board_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 10 })).toEqual([]);

    // …and redelivered once it lapses: at-least-once is the contract.
    queue.advance(31_000);
    const second = await queue.readBatch("board_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 10 });
    expect(second[0]?.receipt).toBe(first[0]!.receipt);
    expect(second[0]?.deliveryCount).toBe(2);

    expect(await queue.ack("board_issue_viewed", [first[0]!.receipt])).toBe(1);
    queue.advance(31_000);
    expect(await queue.readBatch("board_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 10 })).toEqual([]);
  });

  it("keeps each Event stream's queue independent — one stream can never block another", async () => {
    const queue = createFakeEventQueue();
    await queue.enqueueBatch([message("board_issue_viewed", EVENT_A), message("board_aid_used", EVENT_B)]);

    const viewed = await queue.readBatch("board_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 10 });
    const aid = await queue.readBatch("board_aid_used", { visibilityTimeoutSeconds: 30, maxMessages: 10 });

    expect(viewed).toHaveLength(1);
    expect(aid).toHaveLength(1);
    // A held (invisible) message on one stream does not hold the other.
    expect(await queue.readBatch("board_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 10 })).toEqual([]);
    expect(aid[0]?.message.stream).toBe("board_aid_used");
  });

  it("dead-letters with a reason, enumerates it, and requeues only on a deliberate act", async () => {
    const queue = createFakeEventQueue();
    await queue.enqueueBatch([message("board_issue_viewed", EVENT_A)]);
    const [delivered] = await queue.readBatch("board_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 10 });

    expect(await queue.deadLetter("board_issue_viewed", [delivered!.receipt], "callback threw 5 times")).toBe(1);
    queue.advance(31_000);
    expect(await queue.readBatch("board_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 10 })).toEqual([]);

    const dead = await queue.listDeadLetters("board_issue_viewed", 10);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.reason).toBe("callback threw 5 times");
    expect(dead[0]?.message).toEqual(message("board_issue_viewed", EVENT_A));

    // Requeue is deliberate — and it LEAVES the dead-letter storage, so it cannot be requeued twice.
    const receipt = await queue.requeueDeadLetter("board_issue_viewed", dead[0]!.id);
    expect(receipt).not.toBeNull();
    expect(await queue.listDeadLetters("board_issue_viewed", 10)).toEqual([]);
    const redelivered = await queue.readBatch("board_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 10 });
    expect(redelivered[0]?.message).toEqual(message("board_issue_viewed", EVENT_A));

    expect(await queue.requeueDeadLetter("board_issue_viewed", "does-not-exist")).toBeNull();
  });

  it("extends a delivered message's invisibility from NOW, and ignores a receipt that is already settled", async () => {
    const queue = createFakeEventQueue();
    await queue.enqueueBatch([message("board_issue_viewed", EVENT_A), message("board_issue_viewed", EVENT_B)]);
    const delivered = await queue.readBatch("board_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 10 });
    const [first, second] = delivered;

    // 20s in, both would lapse in 10s; a renewal pushes them a full window out from NOW, not from then.
    queue.advance(20_000);
    expect(await queue.extendVisibility("board_issue_viewed", [first!.receipt, second!.receipt], 30)).toBe(2);
    queue.advance(11_000);
    expect(await queue.readBatch("board_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 10 })).toEqual([]);

    // An acked message is simply not extended — a renewal racing a settle is ordinary, never an error.
    await queue.ack("board_issue_viewed", [first!.receipt]);
    expect(await queue.extendVisibility("board_issue_viewed", [first!.receipt, second!.receipt], 30)).toBe(1);
  });

  it("caps a read at maxMessages", async () => {
    const queue = createFakeEventQueue();
    await queue.enqueueBatch([
      message("board_issue_viewed", EVENT_A),
      message("board_issue_viewed", EVENT_B),
      message("board_issue_viewed", EVENT_A),
    ]);

    expect(await queue.readBatch("board_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 2 })).toHaveLength(
      2,
    );
  });
});
