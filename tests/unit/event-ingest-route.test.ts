import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { uuid, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  batchEventAckSchema,
  batchEventErrorSchema,
  batchEventPaths,
  defineEventStream,
  defineSyncRegistry,
  defineSyncTable,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENT_REQUEST_BYTES,
  MAX_EVENTS_PER_BATCH,
  type EventAck,
  type JwtClaims,
} from "@pgxsinkit/contracts";
import { createSyncServer, type EventGateInput } from "@pgxsinkit/server";

import { createFakeEventQueue, type FakeEventQueue } from "./support/event-queue-fake";

// The Event lane's ingestion endpoint (ADR-0053 decisions 3, 4 and 5). The layering under test is the whole
// design: framing/limits/auth/queue faults are WHOLE-BATCH (nothing enqueued, no acks), while every
// well-formed envelope gets its own verdict — and only `deferred` is non-terminal.

const issues = defineSyncTable({
  tableName: "ei_issues",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 120 }).notNull(),
  }),
});

const registry = defineSyncRegistry({
  tables: { issues },
  streams: {
    board_issue_viewed: defineEventStream({
      payload: z.object({ issueId: z.uuid() }).strict(),
      identity: { viewerId: { claimPath: ["sub"] } },
    }),
    board_aid_used: defineEventStream({
      payload: z.object({ aid: z.string(), note: z.string().optional() }).strict(),
      // A NESTED claim path, the `app_metadata.person_id` shape the managed-field surface also addresses.
      identity: { viewerId: { claimPath: ["sub"] }, personId: { claimPath: ["app_metadata", "person_id"] } },
    }),
    // The authoritative-parse pin's other half: the client stored the caller's original value, so the
    // transform's OUTPUT is taken HERE. (Its client half is `event-outbox-append`'s store-the-original test.)
    note_shouted: defineEventStream({ payload: z.string().transform((value) => value.toUpperCase()), identity: {} }),
    // Two legal zod schemas whose parse output leaves the JSON value domain: `JSON.stringify` THROWS on the
    // first and RETURNS `undefined` for the second. Both must be terminal per-event verdicts, never a 500.
    note_counted: defineEventStream({ payload: z.string().transform((value) => BigInt(value.length)), identity: {} }),
    note_erased: defineEventStream({ payload: z.string().transform(() => undefined), identity: {} }),
    // Two schemas whose parse output SERIALIZES fine but is not itself a JSON value: a `Date` stringifies to
    // an ISO string, a nested `undefined` property vanishes, an `undefined` array member becomes `null`. The
    // route enqueues the JSON round-trip precisely so the fake queue here and real pgmq's `jsonb` cannot
    // disagree about what the consumer sees.
    note_dated: defineEventStream({ payload: z.string().transform((value) => new Date(value)), identity: {} }),
    note_sparse: defineEventStream({
      payload: z
        .object({ aid: z.string() })
        .strict()
        .transform((value) => ({
          aid: value.aid,
          meta: { kept: 1, note: undefined as string | undefined },
          tags: ["a", undefined as string | undefined],
        })),
      identity: {},
    }),
  },
});

const anonymousRegistry = defineSyncRegistry({
  tables: { issues },
  streams: {
    // No identity fields at all ⇒ ingest stamps nothing from claims, so it must not force an auth adapter.
    board_ping: defineEventStream({ payload: z.object({ at: z.string() }).strict(), identity: {} }),
  },
});

const streamlessRegistry = defineSyncRegistry({ tables: { issues } });

const SUB = "00000000-0000-4000-8000-000000000001";
const PERSON = "person-42";
const claims = (): JwtClaims => ({ sub: SUB, role: "authenticated", app_metadata: { person_id: PERSON } });

let eventIdCounter = 0;
const nextEventId = () => `00000000-0000-4000-8000-${String(++eventIdCounter).padStart(12, "0")}`;

function envelope(stream: string, payload: unknown, eventId = nextEventId()) {
  return { stream, eventId, occurredAtUs: "1754006400000000", payload };
}

interface DbCall {
  kind: "transaction" | "execute";
  inTx: boolean;
}

/** A db that only knows how to open a transaction — the ONLY thing the ingest route asks of it. */
function makeDb(options: { failTransaction?: boolean } = {}) {
  const calls: DbCall[] = [];
  const db = {
    execute: async () => {
      calls.push({ kind: "execute", inTx: false });
      return [];
    },
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      calls.push({ kind: "transaction", inTx: false });
      if (options.failTransaction) {
        throw new Error("connection refused");
      }
      return callback({
        execute: async () => {
          calls.push({ kind: "execute", inTx: true });
          return [];
        },
      });
    },
  };
  return { db, calls };
}

function makeServer(
  options: {
    registry?: typeof registry | typeof anonymousRegistry | typeof streamlessRegistry;
    queue?: FakeEventQueue;
    resolveAuthClaims?: (request: Request) => JwtClaims | null;
    eventGate?: (input: EventGateInput) => boolean | { allow: boolean; reason?: string } | Promise<boolean>;
    onEventsEnqueued?: (info: { streams: string[] }) => void;
    failTransaction?: boolean;
  } = {},
) {
  const queue = options.queue ?? createFakeEventQueue();
  const { db, calls } = makeDb(options.failTransaction ? { failTransaction: true } : {});
  const server = createSyncServer({
    registry: (options.registry ?? registry) as never,
    db: db as never,
    resolveAuthClaims: options.resolveAuthClaims ?? (() => claims()),
    eventQueue: queue,
    ...(options.eventGate ? { eventGate: options.eventGate } : {}),
    ...(options.onEventsEnqueued ? { onEventsEnqueued: options.onEventsEnqueued } : {}),
    deployment: { startupVerification: "deploy-time", operationsLog: "disabled" },
  });
  return { server, queue, calls };
}

async function post(
  server: ReturnType<typeof makeServer>["server"],
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  return server.fetch(
    new Request(`http://localhost${batchEventPaths[0]}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    }),
  );
}

async function acksOf(response: Response): Promise<EventAck[]> {
  return batchEventAckSchema.parse(await response.json()).acks;
}

describe("event ingestion — per-event verdicts (ADR-0053 decision 3)", () => {
  it("acks a well-formed event and enqueues it stamped with its claim-derived identity", async () => {
    const { server, queue } = makeServer();
    const issueId = "00000000-0000-4000-8000-0000000000ff";
    const event = envelope("board_issue_viewed", { issueId });

    const response = await post(server, { events: [event] });

    expect(response.status).toBe(200);
    expect(await acksOf(response)).toEqual([{ eventId: event.eventId, status: "acked" }]);
    expect(queue.enqueued).toEqual([
      {
        stream: "board_issue_viewed",
        events: [
          {
            eventId: event.eventId,
            occurredAtUs: "1754006400000000",
            identity: { viewerId: SUB },
            payload: { issueId },
          },
        ],
      },
    ]);
  });

  it("resolves a NESTED claim path, exactly as the managed-field authClaim strategy addresses claims", async () => {
    const { server, queue } = makeServer();

    const response = await post(server, { events: [envelope("board_aid_used", { aid: "dictionary" })] });

    expect(response.status).toBe(200);
    expect(queue.enqueued[0]?.events[0]?.identity).toEqual({ viewerId: SUB, personId: PERSON });
  });

  it("enqueues `parsed.data` — the ingest parse is the ONE authoritative parse of a payload", async () => {
    const { server, queue } = makeServer();

    const response = await post(server, { events: [envelope("note_shouted", "quiet")] });

    expect(response.status).toBe(200);
    // The client staged (and sent) "quiet"; the consumer receives the transform's output, applied ONCE.
    expect(queue.enqueued[0]?.events[0]?.payload).toBe("QUIET");
  });

  it("ACKS a Date-producing transform and enqueues its JSON-NORMALIZED form — the ISO string", async () => {
    // The finding this closes: `JSON.stringify` SUCCEEDING does not make the parse output a JSON value. A
    // `Date` reached an in-memory queue as a `Date` while real pgmq (`jsonb`) delivered the ISO string, so
    // the same event was two different values depending on the backend, and unit tests disagreed with
    // production. The route now enqueues the round-trip, so this assertion holds on EVERY backend.
    const { server, queue } = makeServer();
    const iso = "2026-08-01T00:00:00.000Z";

    const response = await post(server, { events: [envelope("note_dated", iso)] });

    expect(response.status).toBe(200);
    expect((await acksOf(response))[0]?.status).toBe("acked");
    const payload = queue.enqueued[0]?.events[0]?.payload;
    expect(payload).toBe(iso);
    expect(payload).not.toBeInstanceOf(Date);
  });

  it("drops a nested `undefined` property and nulls an `undefined` array member, by the same normalization", async () => {
    const { server, queue } = makeServer();

    const response = await post(server, { events: [envelope("note_sparse", { aid: "dictionary" })] });

    expect(response.status).toBe(200);
    expect((await acksOf(response))[0]?.status).toBe("acked");
    const payload = queue.enqueued[0]?.events[0]?.payload as {
      aid: string;
      meta: Record<string, unknown>;
      tags: unknown[];
    };
    // `toEqual` treats an absent key and an `undefined` one alike, so the KEY SET is the assertion.
    expect(Object.keys(payload.meta)).toEqual(["kept"]);
    expect("note" in payload.meta).toBe(false);
    expect(payload.tags).toEqual(["a", null]);
    expect(payload.aid).toBe("dictionary");
  });

  it("DEFERS an unknown Event stream (rollout skew is not data loss) and enqueues nothing for it", async () => {
    const { server, queue } = makeServer();
    const known = envelope("board_issue_viewed", { issueId: "00000000-0000-4000-8000-0000000000aa" });
    const unknown = envelope("board_not_deployed_yet", { anything: true });

    const acks = await acksOf(await post(server, { events: [known, unknown] }));

    expect(acks.map((ack) => ack.status)).toEqual(["acked", "deferred"]);
    expect(acks[1]?.reason).toContain("board_not_deployed_yet");
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.events).toHaveLength(1);
  });

  it("REJECTS a payload that fails the registered schema of a KNOWN stream", async () => {
    const { server, queue } = makeServer();

    const acks = await acksOf(await post(server, { events: [envelope("board_issue_viewed", { issueId: "nope" })] }));

    expect(acks[0]?.status).toBe("rejected");
    expect(acks[0]?.reason).toContain("board_issue_viewed");
    expect(queue.enqueued).toEqual([]);
  });

  it("REJECTS an oversized payload per-event, never as a batch fault", async () => {
    const { server, queue } = makeServer();
    const fine = envelope("board_aid_used", { aid: "dictionary" });
    const oversized = envelope("board_aid_used", { aid: "x", note: "n".repeat(MAX_EVENT_PAYLOAD_BYTES + 1) });

    const response = await post(server, { events: [fine, oversized] });
    const acks = await acksOf(response);

    expect(response.status).toBe(200);
    expect(acks.map((ack) => ack.status)).toEqual(["acked", "rejected"]);
    expect(acks[1]?.reason).toContain(String(MAX_EVENT_PAYLOAD_BYTES));
    expect(queue.enqueued[0]?.events).toHaveLength(1);
  });

  it("REJECTS a parse output JSON cannot carry — per event, with its OWN reason, never a 500", async () => {
    // The finding this closes: `z.string().transform(BigInt)` passes registry definition and append
    // validation, and then made `JSON.stringify(parsed.data)` throw straight out of the handler — a
    // batch-level 500 with no verdict, so the Outbox kept every row and retried that same event forever.
    const { server, queue } = makeServer();
    const sibling = envelope("note_shouted", "still fine");
    const bigintOutput = envelope("note_counted", "abcd");
    const undefinedOutput = envelope("note_erased", "gone");

    const response = await post(server, { events: [sibling, bigintOutput, undefinedOutput] });
    const acks = await acksOf(response);

    expect(response.status).toBe(200);
    expect(acks.map((ack) => ack.status)).toEqual(["acked", "rejected", "rejected"]);
    expect(acks[1]?.reason).toContain("note_counted");
    expect(acks[1]?.reason).toContain("cannot be serialized as JSON");
    expect(acks[2]?.reason).toContain("note_erased");
    expect(acks[2]?.reason).toContain("cannot be serialized as JSON");
    // Emphatically NOT the size verdict's reason: a byte-limit message would send an author hunting a
    // payload that is not too big, and the two faults have entirely different fixes.
    expect(acks[1]?.reason).not.toContain("per-event limit");
    expect(acks[2]?.reason).not.toContain("per-event limit");
    // The sibling in the SAME batch was unaffected, and is the only thing enqueued.
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.events.map((event) => event.payload)).toEqual(["STILL FINE"]);
  });

  it("REJECTS an event whose identity claim is absent — an empty identity is never stamped silently", async () => {
    const { server, queue } = makeServer({ resolveAuthClaims: () => ({ sub: SUB }) });

    // `personId` resolves through app_metadata, which this token does not carry.
    const acks = await acksOf(await post(server, { events: [envelope("board_aid_used", { aid: "dictionary" })] }));

    expect(acks[0]?.status).toBe("rejected");
    expect(acks[0]?.reason).toContain("personId");
    expect(acks[0]?.reason).toContain("app_metadata");
    expect(queue.enqueued).toEqual([]);
  });

  it("REJECTS an identity claim that is not a stampable scalar", async () => {
    const { server } = makeServer({ resolveAuthClaims: () => ({ sub: { nested: "object" } }) as unknown as JwtClaims });

    const acks = await acksOf(await post(server, { events: [envelope("board_issue_viewed", { issueId: SUB })] }));

    expect(acks[0]?.status).toBe("rejected");
    expect(acks[0]?.reason).toContain("viewerId");
  });
});

describe("event ingestion — the gating hook (ADR-0053 decision 1)", () => {
  it("REFUSES the events the gate declines, allowing its siblings, and never enqueues a refused one", async () => {
    const seen: EventGateInput[] = [];
    const { server, queue } = makeServer({
      eventGate: (input) => {
        seen.push(input);
        return input.stream === "board_aid_used" ? { allow: false, reason: "aid consent withdrawn" } : true;
      },
    });
    const allowed = envelope("board_issue_viewed", { issueId: SUB });
    const refused = envelope("board_aid_used", { aid: "dictionary" });

    const acks = await acksOf(await post(server, { events: [allowed, refused] }));

    expect(acks).toEqual([
      { eventId: allowed.eventId, status: "acked" },
      { eventId: refused.eventId, status: "refused", reason: "aid consent withdrawn" },
    ]);
    // Called once per event, after validation, with the resolved identity in hand.
    expect(seen).toHaveLength(2);
    expect(seen[0]?.identity).toEqual({ viewerId: SUB });
    expect(seen[0]?.claims["sub"]).toBe(SUB);
    expect(seen[0]?.event.eventId).toBe(allowed.eventId);
    expect(queue.enqueued).toHaveLength(1);
  });

  it("treats a bare `false` as a refusal and supplies a default reason", async () => {
    const { server } = makeServer({ eventGate: () => false });

    const acks = await acksOf(await post(server, { events: [envelope("board_issue_viewed", { issueId: SUB })] }));

    expect(acks[0]?.status).toBe("refused");
    expect(acks[0]?.reason).toContain("board_issue_viewed");
  });

  it("fails the whole batch retryably when the gate throws — a gate that cannot decide is never 'allow'", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { server, queue } = makeServer({
        eventGate: () => {
          throw new Error("consent service down");
        },
      });

      const response = await post(server, { events: [envelope("board_issue_viewed", { issueId: SUB })] });

      expect(response.status).toBe(500);
      expect(batchEventErrorSchema.parse(await response.json()).message).toContain("nothing was enqueued");
      expect(queue.enqueued).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
});

describe("event ingestion — batch-level faults (ADR-0053 decisions 3 and 4)", () => {
  it("400s unparseable JSON and a body that fails the strict envelope parse", async () => {
    const { server, queue } = makeServer();

    expect((await post(server, "{not json")).status).toBe(400);
    // Strict: an unknown key on the request, and a client-supplied identity on an envelope, are framing faults.
    expect((await post(server, { events: [envelope("board_issue_viewed", { issueId: SUB })], extra: 1 })).status).toBe(
      400,
    );
    expect(
      (await post(server, { events: [{ ...envelope("board_issue_viewed", { issueId: SUB }), identity: { a: "b" } }] }))
        .status,
    ).toBe(400);
    expect((await post(server, { events: [] })).status).toBe(400);
    expect(queue.enqueued).toEqual([]);
  });

  it("413s an events array over the per-batch count limit — a LIMIT fault, never framing", async () => {
    const { server, queue } = makeServer();
    // Every envelope here is perfectly well-formed; only the COUNT is over. ADR-0053 decision 3 puts
    // batch-count violations with the other request-shape limits (413), not with malformed framing (400),
    // so a client can tell "you sent too many" apart from "your body was garbage". Unreachable through the
    // library (the flush loop clamps to this same constant) — it exists for skew and foreign callers.
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () =>
      envelope("board_issue_viewed", { issueId: SUB }),
    );

    const response = await post(server, { events });

    expect(response.status).toBe(413);
    expect(batchEventErrorSchema.parse(await response.json()).message).toContain(String(MAX_EVENTS_PER_BATCH));
    expect(queue.enqueued).toEqual([]);
  });

  it("still 400s an over-count body whose framing is ALSO malformed only when the count is legal", async () => {
    const { server, queue } = makeServer();
    // The count check reads nothing but the array length, so a legal-count body with a bad envelope keeps
    // its 400 — the two layers do not swallow each other.
    const response = await post(server, {
      events: [{ ...envelope("board_issue_viewed", { issueId: SUB }), identity: { a: "b" } }],
    });

    expect(response.status).toBe(400);
    expect(queue.enqueued).toEqual([]);
  });

  it("413s a body over the request-byte limit", async () => {
    const { server, queue } = makeServer();
    // One event whose payload alone pushes the BODY past its cap.
    const body = JSON.stringify({
      events: [envelope("board_aid_used", { aid: "x", note: "n".repeat(MAX_EVENT_REQUEST_BYTES) })],
    });

    const response = await post(server, body);

    expect(response.status).toBe(413);
    expect(batchEventErrorSchema.parse(await response.json()).message).toContain(String(MAX_EVENT_REQUEST_BYTES));
    expect(queue.enqueued).toEqual([]);
  });

  it("413s a CHUNKED body over the cap without buffering past it — the cap bounds memory", async () => {
    const { server, queue } = makeServer();
    // No `Content-Length` at all (a chunked upload), and far more body than the cap. The counting stream is
    // the assertion: `request.text()` would have pulled every byte before measuring anything.
    let producedBytes = 0;
    const chunk = "x".repeat(64 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (producedBytes >= MAX_EVENT_REQUEST_BYTES * 8) {
          controller.close();
          return;
        }
        producedBytes += chunk.length;
        controller.enqueue(new TextEncoder().encode(chunk));
      },
    });

    const response = await server.fetch(
      new Request(`http://localhost${batchEventPaths[0]}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
    );

    expect(response.status).toBe(413);
    expect(batchEventErrorSchema.parse(await response.json()).message).toContain(String(MAX_EVENT_REQUEST_BYTES));
    // At most ONE chunk past the cap was ever pulled — never the whole (8×) upload.
    expect(producedBytes).toBeLessThanOrEqual(MAX_EVENT_REQUEST_BYTES + chunk.length);
    expect(queue.enqueued).toEqual([]);
  });

  it("keeps the truthful `Content-Length` fast path — refused without consuming the body", async () => {
    const { server, queue } = makeServer();
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new TextEncoder().encode("x")),
    });

    const request = new Request(`http://localhost${batchEventPaths[0]}`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(MAX_EVENT_REQUEST_BYTES + 1) },
      body,
      duplex: "half",
    } as RequestInit);

    const response = await server.fetch(request);

    expect(response.status).toBe(413);
    // A declared over-cap length is answered from the HEADER: the body was never even opened.
    expect(request.bodyUsed).toBe(false);
    expect(queue.enqueued).toEqual([]);
  });

  it("400s a request with no body at all — an unreadable body is framing, and batch-level", async () => {
    const { server } = makeServer();

    const response = await server.fetch(
      new Request(`http://localhost${batchEventPaths[0]}`, { method: "POST", headers: { "content-type": "aj" } }),
    );

    expect(response.status).toBe(400);
    expect(batchEventErrorSchema.parse(await response.json()).message).toContain("could not be read");
  });

  it("401s the whole batch when a claim-stamping registry gets no verified claims", async () => {
    const { server, queue } = makeServer({ resolveAuthClaims: () => null });

    const response = await post(server, { events: [envelope("board_issue_viewed", { issueId: SUB })] });

    expect(response.status).toBe(401);
    expect(queue.enqueued).toEqual([]);
  });

  it("does NOT demand claims when no registered stream stamps an identity", async () => {
    const queue = createFakeEventQueue();
    const { server } = makeServer({ registry: anonymousRegistry, queue, resolveAuthClaims: () => null });

    const response = await post(server, { events: [envelope("board_ping", { at: "now" })] });

    expect(response.status).toBe(200);
    expect(queue.enqueued[0]?.events[0]?.identity).toEqual({});
  });

  it("503s with Retry-After and enqueues NOTHING when the queue is unavailable", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const queue = createFakeEventQueue();
      queue.failEnqueueOnce();
      const { server } = makeServer({ queue });
      const first = envelope("board_issue_viewed", { issueId: SUB });
      const second = envelope("board_aid_used", { aid: "dictionary" });

      const response = await post(server, { events: [first, second] });

      expect(response.status).toBe(503);
      expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(batchEventErrorSchema.parse(await response.json()).message).toContain("nothing was enqueued");
      // Atomic: neither stream's sub-batch landed, and no per-event verdicts were issued.
      expect(queue.enqueued).toEqual([]);
      expect(queue.peek("board_issue_viewed")).toEqual([]);
      expect(queue.peek("board_aid_used")).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it("503s the same way when the transaction itself cannot be opened", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { server, queue } = makeServer({ failTransaction: true });

      const response = await post(server, { events: [envelope("board_issue_viewed", { issueId: SUB })] });

      expect(response.status).toBe(503);
      expect(queue.enqueued).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });
});

describe("event ingestion — queue assembly and mounting (ADR-0053 decision 5)", () => {
  it("splits a mixed batch by Event stream, ONE message per stream, preserving append order", async () => {
    const { server, queue } = makeServer();
    const a1 = envelope("board_issue_viewed", { issueId: "00000000-0000-4000-8000-00000000000a" });
    const b1 = envelope("board_aid_used", { aid: "first" });
    const a2 = envelope("board_issue_viewed", { issueId: "00000000-0000-4000-8000-00000000000b" });
    const b2 = envelope("board_aid_used", { aid: "second" });

    const acks = await acksOf(await post(server, { events: [a1, b1, a2, b2] }));

    expect(acks.map((ack) => ack.eventId)).toEqual([a1.eventId, b1.eventId, a2.eventId, b2.eventId]);
    expect(queue.enqueued).toHaveLength(2);
    const viewed = queue.enqueued.find((message) => message.stream === "board_issue_viewed");
    const aid = queue.enqueued.find((message) => message.stream === "board_aid_used");
    expect(viewed?.events.map((event) => event.eventId)).toEqual([a1.eventId, a2.eventId]);
    expect(aid?.events.map((event) => event.payload)).toEqual([{ aid: "first" }, { aid: "second" }]);
  });

  it("enqueues inside ONE transaction, handing the queue that transaction's executor", async () => {
    const { server, queue, calls } = makeServer();

    await post(server, {
      events: [envelope("board_issue_viewed", { issueId: SUB }), envelope("board_aid_used", { aid: "dictionary" })],
    });

    expect(calls.filter((call) => call.kind === "transaction")).toHaveLength(1);
    expect(queue.enqueueExecutors).toHaveLength(1);
    expect(typeof queue.enqueueExecutors[0]?.execute).toBe("function");
  });

  it("does not mount the route at all when the registry registers no Event stream", async () => {
    const { server } = makeServer({ registry: streamlessRegistry });

    const response = await post(server, { events: [envelope("board_issue_viewed", { issueId: SUB })] });

    expect(response.status).toBe(404);
  });

  it("keeps the zero-startup-query posture: no query before the enqueue transaction", async () => {
    const { server, calls } = makeServer();

    expect(calls).toEqual([]);

    await post(server, { events: [envelope("board_issue_viewed", { issueId: SUB })] });

    const transactionIndex = calls.findIndex((call) => call.kind === "transaction");
    expect(transactionIndex).toBe(0);
  });
});

describe("event ingestion — the enqueue nudge (ADR-0053 amendment: serverless drain hosting)", () => {
  it("fires ONCE per request with the deduplicated stream names, after the enqueue committed", async () => {
    const nudges: Array<{ streams: string[] }> = [];
    const { server, queue } = makeServer({
      onEventsEnqueued: (info) => {
        // The enqueue must already have happened — the nudge exists to say "there is work", so a drain it
        // wakes must be able to find it.
        expect(queue.enqueued.length).toBeGreaterThan(0);
        nudges.push(info);
      },
    });

    const response = await post(server, {
      events: [
        envelope("board_issue_viewed", { issueId: SUB }),
        envelope("board_aid_used", { aid: "dictionary" }),
        envelope("board_issue_viewed", { issueId: SUB }),
      ],
    });

    expect(response.status).toBe(200);
    expect(nudges).toEqual([{ streams: ["board_issue_viewed", "board_aid_used"] }]);
  });

  it("does NOT fire when nothing was enqueued", async () => {
    const nudges: Array<{ streams: string[] }> = [];
    // Every event refused by the gate ⇒ no sub-batch, no enqueue, and nothing to nudge a drain about.
    const { server, queue } = makeServer({
      eventGate: () => false,
      onEventsEnqueued: (info) => nudges.push(info),
    });

    const acks = await acksOf(await post(server, { events: [envelope("board_issue_viewed", { issueId: SUB })] }));

    expect(acks[0]?.status).toBe("refused");
    expect(queue.enqueued).toEqual([]);
    expect(nudges).toEqual([]);
  });

  it("swallows a throwing hook — a lost nudge is latency, never a failed ingest", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { server, queue } = makeServer({
        onEventsEnqueued: () => {
          throw new Error("drain function unreachable");
        },
      });
      const event = envelope("board_issue_viewed", { issueId: SUB });

      const response = await post(server, { events: [event] });

      expect(response.status).toBe(200);
      expect(await acksOf(response)).toEqual([{ eventId: event.eventId, status: "acked" }]);
      expect(queue.enqueued).toHaveLength(1);
      expect(warn.mock.calls.map((call) => String(call[0])).some((line) => line.includes("onEventsEnqueued"))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("event ingestion — verdict coverage", () => {
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("answers EVERY well-formed envelope exactly once, whatever the mix of verdicts", async () => {
    const { server } = makeServer({
      eventGate: (input) => input.stream !== "board_aid_used",
    });
    const events = [
      envelope("board_issue_viewed", { issueId: SUB }),
      envelope("board_issue_viewed", { issueId: "not-a-uuid" }),
      envelope("board_aid_used", { aid: "dictionary" }),
      envelope("board_unknown_stream", {}),
    ];

    const acks = await acksOf(await post(server, { events }));

    expect(acks.map((ack) => ack.eventId)).toEqual(events.map((event) => event.eventId));
    expect(acks.map((ack) => ack.status)).toEqual(["acked", "rejected", "refused", "deferred"]);
  });
});
