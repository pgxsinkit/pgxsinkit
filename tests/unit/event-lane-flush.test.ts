import { afterEach, describe, expect, it, mock } from "bun:test";

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  defineEventStream,
  defineSyncRegistry,
  defineSyncTable,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENT_REQUEST_BYTES,
  MAX_EVENTS_PER_BATCH,
  type BatchEventRequest,
  type EventAckStatus,
} from "@pgxsinkit/contracts";

import {
  classifyEventBatchFailure,
  computeEventBackoffMs,
  createEventFlushDriver,
  createEventLaneRuntime,
  parseRetryAfterMs,
  type EventLaneOptions,
  type EventLaneReport,
  type EventLaneRuntime,
  type OutboxStatus,
} from "../../packages/client/src/event-lane";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { closeOpenTestPGlites, createSchemaTestPGlite } from "../support/pglite";

// The Event lane's flush loop (ADR-0053 decisions 3 + 4), against a REAL PGlite and a mocked endpoint
// (Phase C builds the real one). What is pinned: batch assembly ordered by the `seq` append ordinal across
// every Event stream, the deferred-backoff skip, all three clamps, the four verdicts (three terminal, one
// not), the TWO retry classes with no attempt cap and no client-side quarantine, the drain signal's
// transitions, and the report surface.

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
      payload: z.object({ issueId: z.string(), blob: z.string().optional() }).strict(),
      identity: { viewerId: { claimPath: ["sub"] } },
    }),
    review_graded: defineEventStream({
      payload: z.object({ cardId: z.string() }).strict(),
      identity: { learnerId: { claimPath: ["sub"] } },
    }),
  },
});

const EVENT_URL = "http://localhost:3001/api/events";
const schemaSql = generateLocalSchemaSql(registry);

/** A deterministic clock the backoff/deferred assertions drive; jitter is pinned to its ceiling. */
function fixedClock(startMs = 1_700_000_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

interface LaneHarness {
  db: Awaited<ReturnType<typeof createSchemaTestPGlite>>;
  runtime: EventLaneRuntime;
  clock: ReturnType<typeof fixedClock>;
  reports: EventLaneReport[];
  statuses: OutboxStatus[];
}

async function makeLane(
  options: {
    events?: EventLaneOptions;
    getAuthToken?: () => Promise<string | undefined>;
    subscribeReports?: boolean;
  } = {},
): Promise<LaneHarness> {
  const db = await createSchemaTestPGlite(schemaSql);
  const clock = fixedClock();
  const runtime = createEventLaneRuntime({
    db,
    registry,
    batchEventUrl: EVENT_URL,
    now: clock.now,
    // Jitter pinned to its maximum, so a computed backoff equals its ceiling and assertions are exact.
    random: () => 1,
    ...(options.events ? { events: options.events } : {}),
    ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}),
  });
  const reports: EventLaneReport[] = [];
  const statuses: OutboxStatus[] = [];
  if (options.subscribeReports !== false) {
    runtime.onEventLaneReport((report) => reports.push(report));
  }
  return { db, runtime, clock, reports, statuses };
}

/** A fetch mock that answers each POST from a per-event verdict function, recording every request body. */
function verdictFetch(
  verdict: (eventId: string, index: number, stream: string) => { status: EventAckStatus; reason?: string },
) {
  const bodies: BatchEventRequest[] = [];
  const bodyBytes: number[] = [];
  const fetchMock = mock(async (_input: unknown, init?: { body?: unknown }) => {
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(raw) as BatchEventRequest;
    bodies.push(body);
    bodyBytes.push(new TextEncoder().encode(raw).length);
    return new Response(
      JSON.stringify({
        acks: body.events.map((event, index) => ({
          eventId: event.eventId,
          ...verdict(event.eventId, index, event.stream),
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  return { fetchMock, bodies, bodyBytes };
}

/** A fetch mock that always fails with the given status (and optional `Retry-After`). */
function failingFetch(status: number, headers: Record<string, string> = {}) {
  const calls: { authorization: string | undefined }[] = [];
  const fetchMock = mock(async (_input: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ authorization: init?.headers?.["Authorization"] });
    return new Response(JSON.stringify({ message: "nope" }), { status, headers });
  });
  return { fetchMock, calls };
}

async function withFetch<T>(fetchMock: unknown, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const acked = () => ({ status: "acked" as const });

/** Poll until `predicate` holds — the deterministic alternative to sleeping on an async first read. */
async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  await closeOpenTestPGlites();
});

describe("batch assembly (ADR-0053 decision 3)", () => {
  it("orders by `seq` across ALL Event streams and drops acked rows from the Outbox", async () => {
    const { db, runtime } = await makeLane();
    const { fetchMock, bodies } = verdictFetch(acked);

    await runtime.appendEvent("board_issue_viewed", { issueId: "a" });
    await runtime.appendEvent("review_graded", { cardId: "c-1" });
    await runtime.appendEvent("board_issue_viewed", { issueId: "b" });
    await withFetch(fetchMock, () => runtime.flush());

    expect(bodies).toHaveLength(1);
    // Append order, mixed streams, one batch — the batch's INTERNAL order is its array order (no `seq` on
    // the wire: the local ordinal stays local).
    expect(bodies[0]!.events.map((event) => event.stream)).toEqual([
      "board_issue_viewed",
      "review_graded",
      "board_issue_viewed",
    ]);
    expect(bodies[0]!.events.every((event) => !("seq" in event))).toBe(true);
    expect((await db.query(`SELECT 1 FROM pgxsinkit_outbox`)).rows).toHaveLength(0);
  });

  it("clamps to the configured batch size and keeps draining in slices", async () => {
    const { db, runtime } = await makeLane({ events: { batchSize: 2 } });
    const { fetchMock, bodies } = verdictFetch(acked);

    for (let index = 0; index < 5; index += 1) {
      await runtime.appendEvent("review_graded", { cardId: `c-${index}` });
    }
    await withFetch(fetchMock, () => runtime.flush());

    expect(bodies.map((body) => body.events.length)).toEqual([2, 2, 1]);
    expect((await db.query(`SELECT 1 FROM pgxsinkit_outbox`)).rows).toHaveLength(0);
  });

  it("clamps a configured batch size above the contracts-level cap", async () => {
    const { runtime } = await makeLane({ events: { batchSize: MAX_EVENTS_PER_BATCH * 10 } });
    const { fetchMock, bodies } = verdictFetch(acked);
    await runtime.appendEvent("review_graded", { cardId: "c-0" });
    await withFetch(fetchMock, () => runtime.flush());
    // Nothing to assert on count with one event; what matters is the request stays inside the contract.
    expect(bodies[0]!.events.length).toBeLessThanOrEqual(MAX_EVENTS_PER_BATCH);
  });

  it("clamps a batch to MAX_EVENT_REQUEST_BYTES even when the batch size would allow more", async () => {
    const { runtime } = await makeLane({ events: { batchSize: 500 } });
    const { fetchMock, bodies, bodyBytes } = verdictFetch(acked);

    // Each payload sits just under the per-event cap, so the BODY cap binds first — deliberately, per the
    // contracts note that 1000 × 64 KiB would exceed the 4 MiB body.
    const blob = "x".repeat(MAX_EVENT_PAYLOAD_BYTES - 512);
    const eventCount = Math.ceil(MAX_EVENT_REQUEST_BYTES / MAX_EVENT_PAYLOAD_BYTES) + 2;
    for (let index = 0; index < eventCount; index += 1) {
      await runtime.appendEvent("board_issue_viewed", { issueId: `i-${index}`, blob });
    }
    await withFetch(fetchMock, () => runtime.flush());

    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies[0]!.events.length).toBeLessThan(eventCount);
    for (const bytes of bodyBytes) {
      expect(bytes).toBeLessThanOrEqual(MAX_EVENT_REQUEST_BYTES);
    }
  });

  it("honours a per-Event-stream batch cap, so one chatty stream cannot fill every batch", async () => {
    const { runtime } = await makeLane({
      events: { batchSize: 10, streams: { board_issue_viewed: { batchSize: 1 } } },
    });
    const { fetchMock, bodies } = verdictFetch(acked);

    await runtime.appendEvent("board_issue_viewed", { issueId: "a" });
    await runtime.appendEvent("board_issue_viewed", { issueId: "b" });
    await runtime.appendEvent("review_graded", { cardId: "c-1" });
    await withFetch(fetchMock, () => runtime.flush());

    // First batch: one capped viewed event + the uncapped graded one; the second viewed event follows.
    expect(bodies[0]!.events.map((event) => event.stream)).toEqual(["board_issue_viewed", "review_graded"]);
    expect(bodies[1]!.events.map((event) => event.stream)).toEqual(["board_issue_viewed"]);
  });

  it("gives a capped stream's freed slots to a QUIETER one, even when it would fill the window alone", async () => {
    // The fairness the option actually promises. A cap applied AFTER a global `ORDER BY seq LIMIT batchSize`
    // would only shrink the request: the earliest rows here are all stream A, so B would stay invisible to
    // assembly until A's whole backlog had drained, one small A-only request at a time. Capping IN the query
    // is what makes the freed slots reach B.
    const { runtime } = await makeLane({
      events: { batchSize: 3, streams: { board_issue_viewed: { batchSize: 2 } } },
    });
    const { fetchMock, bodies } = verdictFetch(acked);

    for (const issueId of ["a", "b", "c", "d", "e"]) {
      await runtime.appendEvent("board_issue_viewed", { issueId });
    }
    // Appended LAST, so it sits behind every one of A's rows in `seq` order.
    await runtime.appendEvent("review_graded", { cardId: "c-1" });
    await withFetch(fetchMock, () => runtime.flush());

    const first = bodies[0]!.events;
    expect(first.map((event) => event.stream)).toEqual(["board_issue_viewed", "board_issue_viewed", "review_graded"]);
    // Ordering WITHIN the batch is still global append order — the cap filters, it never reorders.
    expect(first.map((event) => event.payload)).toEqual([{ issueId: "a" }, { issueId: "b" }, { cardId: "c-1" }]);
    // The rest of A drains in later slices; the quiet stream did not wait for it.
    expect(bodies.flatMap((body) => body.events)).toHaveLength(6);
  });

  it("leaves assembly unchanged when no per-stream cap is configured", async () => {
    const { runtime } = await makeLane({ events: { batchSize: 3 } });
    const { fetchMock, bodies } = verdictFetch(acked);

    for (const issueId of ["a", "b", "c"]) {
      await runtime.appendEvent("board_issue_viewed", { issueId });
    }
    await runtime.appendEvent("review_graded", { cardId: "c-1" });
    await withFetch(fetchMock, () => runtime.flush());

    // Pure `seq` order, no fairness filter at all: the first three appends fill the batch.
    expect(bodies[0]!.events.map((event) => event.stream)).toEqual([
      "board_issue_viewed",
      "board_issue_viewed",
      "board_issue_viewed",
    ]);
    expect(bodies[1]!.events.map((event) => event.stream)).toEqual(["review_graded"]);
  });
});

describe("lane tuning is validated at construction (fail-closed, every offender named)", () => {
  // A typo here fails SILENTLY without this gate: a per-stream `batchSize` of 0/-1/NaN makes assembly hold
  // every row of that stream back, so the pass exits with no request and no report and the stream wedges
  // while appends keep piling up. Configuration mistakes must be boundary errors.
  const construct = (events: EventLaneOptions) =>
    createEventLaneRuntime({
      db: { query: async () => ({ rows: [] }) },
      registry,
      batchEventUrl: EVENT_URL,
      events,
    });

  it("refuses a non-integer, zero or negative batch size — global and per-stream", () => {
    expect(() => construct({ batchSize: 0 })).toThrow(/`events.batchSize` must be an integer >= 1/);
    expect(() => construct({ batchSize: -5 })).toThrow(/`events.batchSize` must be an integer >= 1/);
    expect(() => construct({ batchSize: Number.NaN })).toThrow(/`events.batchSize` must be an integer >= 1/);
    expect(() => construct({ batchSize: 2.5 })).toThrow(/`events.batchSize` must be an integer >= 1/);
    expect(() => construct({ streams: { review_graded: { batchSize: 0 } } })).toThrow(
      /`events.streams.review_graded.batchSize` must be an integer >= 1/,
    );
  });

  it("refuses a nonsense interval and incoherent backoff bounds, global and per-stream", () => {
    expect(() => construct({ intervalMs: 0 })).toThrow(/`events.intervalMs` must be a finite number >= 1/);
    expect(() => construct({ intervalMs: Number.POSITIVE_INFINITY })).toThrow(/`events.intervalMs`/);
    expect(() => construct({ backoff: { baseMs: -1 } })).toThrow(/`events.backoff.baseMs`/);
    expect(() => construct({ backoff: { baseMs: 5_000, ceilingMs: 1_000 } })).toThrow(
      /`events.backoff` resolves to a ceiling BELOW its base — ceilingMs 1000 \(configured\) < baseMs 5000 \(configured\)/,
    );
    expect(() => construct({ streams: { review_graded: { backoff: { ceilingMs: Number.NaN } } } })).toThrow(
      /`events.streams.review_graded.backoff.ceilingMs`/,
    );
  });

  it("resolves the DEFAULTS before judging a backoff pair — an omitted ceiling is still a real ceiling", () => {
    // The finding this closes: `{ baseMs: 600_000 }` passed validation and then silently ran under the
    // 300,000 ms DEFAULT ceiling, so even a maximum-jitter first delay was half the base that was asked for.
    // Both numbers have to be named, or the author has no idea which one to change.
    expect(() => construct({ backoff: { baseMs: 600_000 } })).toThrow(
      /`events.backoff` resolves to a ceiling BELOW its base — ceilingMs 300000 \(the default\) < baseMs 600000 \(configured\)/,
    );
  });

  it("judges a per-stream backoff against the ceiling it will ACTUALLY run under", () => {
    // A per-stream override inherits every bound it does not set, so its base must cohere with the global
    // ceiling (and, with no global ceiling either, with the default) — not merely with what it wrote itself.
    expect(() =>
      construct({ backoff: { ceilingMs: 10_000 }, streams: { review_graded: { backoff: { baseMs: 60_000 } } } }),
    ).toThrow(
      /`events.streams.review_graded.backoff` resolves to a ceiling BELOW its base — ceilingMs 10000 \(inherited from `events.backoff`\) < baseMs 60000 \(configured\)/,
    );
    expect(() => construct({ streams: { review_graded: { backoff: { baseMs: 600_000 } } } })).toThrow(
      /`events.streams.review_graded.backoff` resolves to a ceiling BELOW its base — ceilingMs 300000 \(the default\)/,
    );
  });

  it("still accepts an explicitly coherent LARGE pair, global and per-stream", () => {
    expect(() =>
      construct({
        backoff: { baseMs: 600_000, ceilingMs: 1_800_000 },
        streams: { review_graded: { backoff: { baseMs: 900_000 } } },
      }),
    ).not.toThrow();
    // A per-stream ceiling may also raise the global one for its own stream.
    expect(() =>
      construct({
        backoff: { baseMs: 1_000, ceilingMs: 10_000 },
        streams: { review_graded: { backoff: { baseMs: 60_000, ceilingMs: 120_000 } } },
      }),
    ).not.toThrow();
  });

  it("names EVERY offender in one error", () => {
    let message = "";
    try {
      construct({ batchSize: 0, intervalMs: -1, streams: { board_issue_viewed: { batchSize: Number.NaN } } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("events.batchSize");
    expect(message).toContain("events.intervalMs");
    expect(message).toContain("events.streams.board_issue_viewed.batchSize");
  });

  it("accepts the tunings the lane documents, including a zero backoff floor", () => {
    expect(() =>
      construct({
        batchSize: 50,
        intervalMs: 1_000,
        backoff: { baseMs: 0, ceilingMs: 30_000 },
        streams: { board_issue_viewed: { batchSize: 5, backoff: { baseMs: 500 } } },
      }),
    ).not.toThrow();
    expect(() => construct({})).not.toThrow();
  });
});

describe("verdict handling (ADR-0053 decision 3)", () => {
  it("deletes on every TERMINAL verdict and reports the two non-acked ones", async () => {
    const { db, runtime, reports } = await makeLane();
    const { fetchMock } = verdictFetch((_eventId, index) =>
      index === 0
        ? { status: "acked" }
        : index === 1
          ? { status: "refused", reason: "consent withdrawn" }
          : { status: "rejected", reason: "schema" },
    );

    await runtime.appendEvent("review_graded", { cardId: "c-0" });
    await runtime.appendEvent("review_graded", { cardId: "c-1" });
    await runtime.appendEvent("review_graded", { cardId: "c-2" });
    await withFetch(fetchMock, () => runtime.flush());

    // All three are terminal — the Outbox is empty.
    expect((await db.query(`SELECT 1 FROM pgxsinkit_outbox`)).rows).toHaveLength(0);
    // ...but only `refused` and `rejected` are REPORTED: a successful append-only lane must not drown the
    // app in its own volume, while a deleted row's non-acked verdict is unrecoverable once it is gone.
    const terminal = reports.flatMap((report) => report.terminal);
    expect(terminal.map((verdict) => verdict.status).sort()).toEqual(["refused", "rejected"]);
    expect(terminal.every((verdict) => verdict.stream === "review_graded")).toBe(true);
    expect(terminal.find((verdict) => verdict.status === "refused")?.reason).toBe("consent withdrawn");
  });

  it("KEEPS a deferred row, backs it off, and reports it (rollout skew is not data loss)", async () => {
    const { db, runtime, clock, reports } = await makeLane({ events: { backoff: { baseMs: 1_000 } } });
    const { fetchMock, bodies } = verdictFetch((_eventId, index) =>
      index === 0 ? { status: "acked" } : { status: "deferred", reason: "unknown stream" },
    );

    await runtime.appendEvent("review_graded", { cardId: "c-0" });
    await runtime.appendEvent("board_issue_viewed", { issueId: "a" });
    await withFetch(fetchMock, () => runtime.flush());

    const rows = await db.query<{
      stream: string;
      attempt_count: number;
      next_retry_at_us: string;
      last_reason: string;
    }>(`SELECT stream, attempt_count, next_retry_at_us, last_reason FROM pgxsinkit_outbox`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.stream).toBe("board_issue_viewed");
    expect(rows.rows[0]!.attempt_count).toBe(1);
    expect(rows.rows[0]!.last_reason).toBe("unknown stream");
    // Jitter is pinned to 1, so the first delay IS the base.
    expect(Number(rows.rows[0]!.next_retry_at_us)).toBe(clock.now() * 1000 + 1_000 * 1000);
    expect(reports.flatMap((report) => report.deferred).map((verdict) => verdict.status)).toEqual(["deferred"]);

    // The pass ended once nothing more was eligible — the deferred row is NOT re-posted in a spin.
    expect(bodies).toHaveLength(1);
  });

  it("skips a deferred row until its backoff elapses, then re-posts it", async () => {
    const { db, runtime, clock } = await makeLane({ events: { backoff: { baseMs: 1_000 } } });
    const deferOnce = { deferred: true };
    const { fetchMock, bodies } = verdictFetch(() =>
      deferOnce.deferred ? { status: "deferred", reason: "skew" } : { status: "acked" },
    );

    await runtime.appendEvent("board_issue_viewed", { issueId: "a" });
    await withFetch(fetchMock, () => runtime.flush());
    expect(bodies).toHaveLength(1);

    // Still inside the backoff window: assembly skips it, so no request at all.
    clock.advance(500);
    await withFetch(fetchMock, () => runtime.flush());
    expect(bodies).toHaveLength(1);

    // Past it: the row is eligible again and this time the server acks.
    clock.advance(1_000);
    deferOnce.deferred = false;
    await withFetch(fetchMock, () => runtime.flush());
    expect(bodies).toHaveLength(2);
    expect((await db.query(`SELECT 1 FROM pgxsinkit_outbox`)).rows).toHaveLength(0);
  });

  it("posts a deferred row at most ONCE per pass, even with a degenerate zero backoff", async () => {
    // A zero-ish configured backoff (or a stopped clock) would leave a just-deferred row selectable, and
    // re-posting a row the server deferred a millisecond ago is a spin, not a retry.
    const { runtime } = await makeLane({ events: { backoff: { baseMs: 0 } } });
    const { fetchMock, bodies } = verdictFetch(() => ({ status: "deferred", reason: "skew" }));

    await runtime.appendEvent("board_issue_viewed", { issueId: "a" });
    await withFetch(fetchMock, () => runtime.flush());

    expect(bodies).toHaveLength(1);
  });
});

describe("retry classes (ADR-0053 decision 4 — two classes, no cap, no quarantine)", () => {
  it("classifies auth apart from everything else, which is retryable by construction", () => {
    expect(classifyEventBatchFailure(401)).toBe("auth");
    expect(classifyEventBatchFailure(403)).toBe("auth");
    expect(classifyEventBatchFailure(null)).toBe("retryable");
    expect(classifyEventBatchFailure(503)).toBe("retryable");
    expect(classifyEventBatchFailure(429)).toBe("retryable");
    // Unlike the mutation path there is NO terminal class: a structural 4xx must never discard an event.
    expect(classifyEventBatchFailure(413)).toBe("retryable");
    expect(classifyEventBatchFailure(400)).toBe("retryable");
  });

  it("a 5xx keeps every row, enters batch backoff, and reports the transition", async () => {
    const { db, runtime, clock, reports } = await makeLane({ events: { backoff: { baseMs: 2_000 } } });
    const { fetchMock } = failingFetch(503);

    await runtime.appendEvent("review_graded", { cardId: "c-0" });
    await runtime.appendEvent("review_graded", { cardId: "c-1" });
    await withFetch(fetchMock, () => runtime.flush());

    // NOTHING is deleted — the client never discards without a server verdict.
    expect((await db.query(`SELECT 1 FROM pgxsinkit_outbox`)).rows).toHaveLength(2);
    expect(reports.at(-1)!.backoff).toMatchObject({ state: "entered", attempt: 1, httpStatus: 503, retryInMs: 2_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A pass inside the backoff window does not even try.
    await withFetch(fetchMock, () => runtime.flush());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past the window it retries, and the backoff DOUBLES while the failure persists (no attempt cap).
    clock.advance(2_001);
    await withFetch(fetchMock, () => runtime.flush());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reports.at(-1)!.backoff).toMatchObject({ state: "entered", attempt: 2, retryInMs: 4_000 });
    expect((await db.query(`SELECT 1 FROM pgxsinkit_outbox`)).rows).toHaveLength(2);
  });

  it("honours `Retry-After` when it asks for longer than the computed backoff", async () => {
    const { runtime, reports } = await makeLane({ events: { backoff: { baseMs: 1_000 } } });
    const { fetchMock } = failingFetch(503, { "Retry-After": "30" });

    await runtime.appendEvent("review_graded", { cardId: "c-0" });
    await withFetch(fetchMock, () => runtime.flush());

    expect(reports.at(-1)!.backoff?.retryInMs).toBe(30_000);
  });

  it("parses both `Retry-After` forms", () => {
    const nowMs = 1_700_000_000_000;
    expect(parseRetryAfterMs("12", nowMs)).toBe(12_000);
    expect(parseRetryAfterMs(new Date(nowMs + 5_000).toUTCString(), nowMs)).toBeGreaterThanOrEqual(4_000);
    expect(parseRetryAfterMs(null, nowMs)).toBeNull();
    expect(parseRetryAfterMs("soon", nowMs)).toBeNull();
  });

  it("refreshes the token ONCE on 401, then treats a repeat as ordinary retryable backoff", async () => {
    const tokens = ["stale-token", "fresh-token", "fresher-token"];
    let issued = 0;
    const { runtime, reports } = await makeLane({
      getAuthToken: async () => tokens[Math.min(issued++, tokens.length - 1)],
    });
    const { fetchMock, calls } = failingFetch(401);

    await runtime.appendEvent("review_graded", { cardId: "c-0" });
    await withFetch(fetchMock, () => runtime.flush());

    // Exactly two attempts in one pass: the original and the single post-refresh retry.
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
    // And then it is retryable, not terminal — nothing was discarded, the lane simply backed off.
    expect(reports.at(-1)!.backoff).toMatchObject({ state: "entered", httpStatus: 401 });
  });

  it("clears the backoff (and reports it) once a batch succeeds", async () => {
    const { runtime, clock, reports } = await makeLane({ events: { backoff: { baseMs: 1_000 } } });
    const { fetchMock: failMock } = failingFetch(500);
    const { fetchMock: okMock } = verdictFetch(acked);

    await runtime.appendEvent("review_graded", { cardId: "c-0" });
    await withFetch(failMock, () => runtime.flush());
    expect(reports.at(-1)!.backoff?.state).toBe("entered");

    clock.advance(1_001);
    await withFetch(okMock, () => runtime.flush());
    expect(reports.at(-1)!.backoff).toEqual({ state: "cleared" });
  });

  it("computes a jittered exponential backoff with a ceiling", () => {
    const options = { baseMs: 1_000, ceilingMs: 8_000 };
    expect(computeEventBackoffMs(1, options, () => 1)).toBe(1_000);
    expect(computeEventBackoffMs(2, options, () => 1)).toBe(2_000);
    // Jitter is EQUAL jitter: half the ceiling plus a random share of the other half.
    expect(computeEventBackoffMs(2, options, () => 0)).toBe(1_000);
    // ...and the ceiling binds however many attempts have failed (there is no cap on attempts).
    expect(computeEventBackoffMs(50, options, () => 1)).toBe(8_000);
  });
});

describe("the drain signal (ADR-0053 decision 2)", () => {
  it("delivers the CURRENT state on subscribe, then only on empty ↔ non-empty transitions", async () => {
    const { runtime } = await makeLane();
    const { fetchMock } = verdictFetch(acked);
    const seen: OutboxStatus[] = [];

    // Subscribing to an empty Outbox delivers `{ empty: true }` (never a silent subscription) — as soon as
    // the runtime's first read of the store lands, which is a query, not a synchronous fact.
    const unsubscribe = runtime.onOutboxStatus((status) => seen.push(status));
    await waitUntil(() => seen.length > 0);
    expect(seen).toEqual([{ empty: true }]);

    await runtime.appendEvent("review_graded", { cardId: "c-0" });
    expect(seen).toEqual([{ empty: true }, { empty: false }]);

    // A SECOND append is not a transition — the signal is deliberately not a per-append progress feed.
    await runtime.appendEvent("review_graded", { cardId: "c-1" });
    expect(seen).toHaveLength(2);

    await withFetch(fetchMock, () => runtime.flush());
    expect(seen).toEqual([{ empty: true }, { empty: false }, { empty: true }]);

    unsubscribe();
    await runtime.appendEvent("review_graded", { cardId: "c-2" });
    expect(seen).toHaveLength(3);
  });

  it("stays NON-empty after a flush that only deferred rows", async () => {
    const { runtime } = await makeLane();
    const { fetchMock } = verdictFetch(() => ({ status: "deferred" }));
    const seen: OutboxStatus[] = [];
    runtime.onOutboxStatus((status) => seen.push(status));
    await waitUntil(() => seen.length > 0);

    await runtime.appendEvent("board_issue_viewed", { issueId: "a" });
    await withFetch(fetchMock, () => runtime.flush());

    expect(seen.at(-1)).toEqual({ empty: false });
    expect(await runtime.outboxStatus()).toEqual({ empty: false });
  });
});

describe("the report surface (ADR-0053 decision 2)", () => {
  it("emits nothing for an all-acked pass, and warns when nothing is subscribed", async () => {
    const { runtime, reports } = await makeLane();
    const { fetchMock } = verdictFetch(acked);
    await runtime.appendEvent("review_graded", { cardId: "c-0" });
    await withFetch(fetchMock, () => runtime.flush());
    expect(reports).toEqual([]);

    // With NO subscriber a reportable outcome still surfaces — the `onDeadLetter` idiom.
    const { runtime: quiet } = await makeLane({ subscribeReports: false });
    const { fetchMock: refuseMock } = verdictFetch(() => ({ status: "refused", reason: "gated" }));
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      await quiet.appendEvent("review_graded", { cardId: "c-0" });
      await withFetch(refuseMock, () => quiet.flush());
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]![0])).toContain("event-lane report");
  });
});

describe("the flush driver (ADR-0053 decision 3)", () => {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function manualGate(shouldFlush = true) {
    let signal: (() => void) | null = null;
    return {
      gate: {
        subscribe: (onSignal: () => void) => {
          signal = onSignal;
          return () => {
            signal = null;
          };
        },
        shouldFlush: () => shouldFlush,
      },
      fire: () => signal?.(),
    };
  }

  it("runs a pass on start (the boot/reconnect drain) and on each gate signal", async () => {
    let passes = 0;
    const { gate, fire } = manualGate();
    const driver = createEventFlushDriver({ flush: async () => void passes++, gate, intervalMs: 60_000 });

    driver.start();
    await tick();
    // The Outbox may hold events written offline; a pass at start is what drains them with no new append.
    expect(passes).toBe(1);

    fire();
    await tick();
    expect(passes).toBe(2);

    await driver.stop();
  });

  it("pauses while the gate says offline, and resumes on the next signal", async () => {
    let passes = 0;
    const offline = manualGate(false);
    const offlineDriver = createEventFlushDriver({ flush: async () => void passes++, gate: offline.gate });
    offlineDriver.start();
    offline.fire();
    await tick();
    expect(passes).toBe(0);
    await offlineDriver.stop();

    const online = manualGate(true);
    const onlineDriver = createEventFlushDriver({ flush: async () => void passes++, gate: online.gate });
    onlineDriver.start();
    await tick();
    expect(passes).toBe(1);
    await onlineDriver.stop();
  });

  it("coalesces a nudge that lands mid-pass into a single follow-up", async () => {
    let passes = 0;
    let release!: () => void;
    const gateOne = new Promise<void>((resolve) => {
      release = resolve;
    });
    const driver = createEventFlushDriver({
      flush: async () => {
        passes += 1;
        if (passes === 1) await gateOne;
      },
      intervalMs: 60_000,
    });

    driver.start();
    await tick();
    expect(passes).toBe(1);

    // Three nudges while the first pass is still in flight collapse into ONE follow-up.
    driver.requestPass();
    driver.requestPass();
    driver.requestPass();
    release();
    await tick();
    await tick();
    expect(passes).toBe(2);

    await driver.stop();
  });
});
