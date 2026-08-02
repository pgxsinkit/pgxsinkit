import { afterEach, describe, expect, it } from "bun:test";

import { bigint, boolean, uuid, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";

import { defineEventStream, defineSyncRegistry, defineSyncTable, MAX_EVENT_PAYLOAD_BYTES } from "@pgxsinkit/contracts";

import {
  createEventLaneRuntime,
  deriveBatchEventUrl,
  EventPayloadInvalidError,
  EventPayloadTooLargeError,
  EventStreamsNotRegisteredError,
  resolveBatchEventUrl,
  UnknownEventStreamError,
} from "../../packages/client/src/event-lane";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { closeOpenTestPGlites, createSchemaTestPGlite } from "../support/pglite";

// The Outbox + `appendEvent` (ADR-0053 decision 2), against a REAL PGlite carrying the generated local
// schema. What is pinned here: the shape of the library-owned Outbox table (public contract), the four
// append refusals (all synchronous call-site failures — "everything in the Outbox is well-formed" is the
// invariant the flush loop and best-guess views lean on), the library's `eventId`/`occurredAtUs` stamps,
// and the `seq` append ordinal being the ONE ordering key.

const todos = defineSyncTable({
  tableName: "todos",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 200 }).notNull(),
    done: boolean("done").notNull(),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull(),
  }),
});

const viewedStream = defineEventStream({
  payload: z.object({ issueId: z.uuid(), dwellMs: z.number().int().optional() }).strict(),
  identity: { viewerId: { claimPath: ["sub"] } },
});
const gradedStream = defineEventStream({
  payload: z.object({ cardId: z.string(), grade: z.number().int() }).strict(),
  identity: { learnerId: { claimPath: ["sub"] } },
});

/**
 * A NON-object root carrying a transform — the shape that pins single-parse semantics. Object payloads are
 * required to be strict (so they cannot strip), but a transform can still rewrite any root, and it must run
 * exactly once, at ingest, on the value the caller actually appended.
 */
const shoutedStream = defineEventStream({
  payload: z.string().transform((value) => value.toUpperCase()),
  identity: {},
});

const streamRegistry = defineSyncRegistry({
  tables: { todos },
  streams: { board_issue_viewed: viewedStream, review_graded: gradedStream, note_shouted: shoutedStream },
});
const streamlessRegistry = defineSyncRegistry({ tables: { todos } });

const EVENT_URL = "http://localhost:3001/api/events";
const schemaSql = generateLocalSchemaSql(streamRegistry);

afterEach(async () => {
  await closeOpenTestPGlites();
});

async function makeRuntime(registry: typeof streamRegistry | typeof streamlessRegistry = streamRegistry) {
  const db = await createSchemaTestPGlite(schemaSql);
  return { db, runtime: createEventLaneRuntime({ db, registry, batchEventUrl: EVENT_URL }) };
}

const ISSUE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ISSUE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("Outbox DDL (ADR-0053 decision 2 — the shape is public contract)", () => {
  it("provisions ONE shared, stream-independent table with the contracted columns", async () => {
    const db = await createSchemaTestPGlite(schemaSql);
    const columns = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'pgxsinkit_outbox' ORDER BY ordinal_position`,
    );

    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "seq",
      "event_id",
      "stream",
      "occurred_at_us",
      "payload",
      "enqueued_at_us",
      "attempt_count",
      "next_retry_at_us",
      "last_reason",
    ]);
    // The ordering key is a bigint, the payload is queryable jsonb (best-guess views read it), and the
    // deferred-backoff columns are the only nullable ones besides the reason.
    const byName = new Map(columns.rows.map((row) => [row.column_name, row]));
    expect(byName.get("seq")?.data_type).toBe("bigint");
    expect(byName.get("payload")?.data_type).toBe("jsonb");
    expect(byName.get("next_retry_at_us")?.is_nullable).toBe("YES");
    expect(byName.get("stream")?.is_nullable).toBe("NO");
  });

  it("indexes both access patterns: `WHERE stream = ?` app queries and ordered batch assembly", async () => {
    const db = await createSchemaTestPGlite(schemaSql);
    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'pgxsinkit_outbox' ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain("pgxsinkit_outbox_stream_seq_idx");
    expect(indexes.rows.map((row) => row.indexname)).toContain("pgxsinkit_outbox_retry_seq_idx");
  });

  it("is emitted for a STREAMLESS registry too — the DDL is stream-independent", () => {
    // Registering the first Event stream must change nothing locally, so the table cannot be conditional.
    expect(generateLocalSchemaSql(streamlessRegistry)).toContain("pgxsinkit_outbox");
  });
});

describe("appendEvent (ADR-0053 decision 2)", () => {
  it("stamps eventId + occurredAtUs and durably stages the row", async () => {
    const { db, runtime } = await makeRuntime();
    const before = Date.now() * 1000;
    const result = await runtime.appendEvent("board_issue_viewed", { issueId: ISSUE_A, dwellMs: 1200 });

    expect(result.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(result.occurredAtUs)).toBeGreaterThanOrEqual(before);
    expect(Number(result.seq)).toBeGreaterThan(0);

    const rows = await db.query<{
      event_id: string;
      stream: string;
      payload: { issueId: string; dwellMs: number };
      attempt_count: number;
      next_retry_at_us: string | null;
    }>(`SELECT event_id, stream, payload, attempt_count, next_retry_at_us FROM pgxsinkit_outbox`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.event_id).toBe(result.eventId);
    expect(rows.rows[0]!.stream).toBe("board_issue_viewed");
    // jsonb, so an app's best-guess view reads the payload as data, not as an opaque blob.
    expect(rows.rows[0]!.payload).toEqual({ issueId: ISSUE_A, dwellMs: 1200 });
    // A fresh row is eligible NOW: the deferred backoff exists only after a server verdict.
    expect(rows.rows[0]!.attempt_count).toBe(0);
    expect(rows.rows[0]!.next_retry_at_us).toBeNull();
  });

  it("assigns a strictly increasing `seq` across DIFFERENT Event streams (the one ordering key)", async () => {
    const { db, runtime } = await makeRuntime();
    await runtime.appendEvent("board_issue_viewed", { issueId: ISSUE_A });
    await runtime.appendEvent("review_graded", { cardId: "c-1", grade: 3 });
    await runtime.appendEvent("board_issue_viewed", { issueId: ISSUE_B });

    const rows = await db.query<{ seq: string; stream: string }>(
      `SELECT seq, stream FROM pgxsinkit_outbox ORDER BY seq`,
    );
    const seqs = rows.rows.map((row) => Number(row.seq));
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(new Set(seqs).size).toBe(3);
    // One shared table with a `stream` column — never a table per Event stream.
    expect(rows.rows.map((row) => row.stream)).toEqual(["board_issue_viewed", "review_graded", "board_issue_viewed"]);
  });

  it("stores the CALLER'S value, not `parsed.data` — the schema validates here, it does not parse", async () => {
    const { db, runtime } = await makeRuntime();
    await runtime.appendEvent("note_shouted", "quiet");

    const rows = await db.query<{ payload: unknown }>(`SELECT payload FROM pgxsinkit_outbox`);
    // The transform did NOT run on the way in. Running it here would apply it twice end-to-end (the ingest
    // parse is the authoritative one), so a non-idempotent transform would deliver something the caller
    // never appended — and a shape-changing one could make the server's re-parse reject a valid append.
    expect(rows.rows[0]!.payload).toBe("quiet");
  });

  it("measures the size cap on the ORIGINAL serialization — the bytes the request will actually carry", async () => {
    const { runtime } = await makeRuntime();
    const tooLarge = await runtime
      .appendEvent("note_shouted", "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 1))
      .catch((e: unknown) => e);
    expect(tooLarge).toBeInstanceOf(EventPayloadTooLargeError);
  });

  it("throws on an UNKNOWN Event stream (a call-site bug, never a rollout condition)", async () => {
    const { db, runtime } = await makeRuntime();
    const refusal = await runtime.appendEvent("board_issue_hovered", { issueId: ISSUE_A }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(UnknownEventStreamError);
    expect((await db.query(`SELECT 1 FROM pgxsinkit_outbox`)).rows).toHaveLength(0);
  });

  it("throws when the payload fails the Event stream's registered zod schema", async () => {
    const { db, runtime } = await makeRuntime();
    const badUuid = await runtime.appendEvent("board_issue_viewed", { issueId: "not-a-uuid" }).catch((e: unknown) => e);
    expect(badUuid).toBeInstanceOf(EventPayloadInvalidError);
    // A strict schema also rejects an unknown key — the Outbox never holds a payload the server would reject.
    const rogueKey = await runtime
      .appendEvent("board_issue_viewed", { issueId: ISSUE_A, rogue: true })
      .catch((e: unknown) => e);
    expect(rogueKey).toBeInstanceOf(EventPayloadInvalidError);
    expect((await db.query(`SELECT 1 FROM pgxsinkit_outbox`)).rows).toHaveLength(0);
  });

  it("throws when the serialized payload exceeds the contracts-level per-event cap", async () => {
    const { db, runtime } = await makeRuntime();
    const oversized = { cardId: "x".repeat(MAX_EVENT_PAYLOAD_BYTES), grade: 1 };
    const tooLarge = await runtime.appendEvent("review_graded", oversized).catch((e: unknown) => e);
    expect(tooLarge).toBeInstanceOf(EventPayloadTooLargeError);
    expect((await db.query(`SELECT 1 FROM pgxsinkit_outbox`)).rows).toHaveLength(0);
  });

  it("throws a clear refusal when the registry registers NO Event stream", async () => {
    const { runtime } = await makeRuntime(streamlessRegistry);
    expect(runtime.hasStreams).toBe(false);
    const noStreams = await runtime.appendEvent("board_issue_viewed", { issueId: ISSUE_A }).catch((e: unknown) => e);
    expect(noStreams).toBeInstanceOf(EventStreamsNotRegisteredError);
  });
});

describe("the ingestion endpoint URL (ADR-0053 decision 3 — the mutation URL's hard-required-path idiom)", () => {
  it("accepts the canonical relative path and an absolute URL ending in it", () => {
    expect(resolveBatchEventUrl("/api/events")).toBe("/api/events");
    expect(resolveBatchEventUrl("https://api.example.test/fn/api/events")).toBe(
      "https://api.example.test/fn/api/events",
    );
  });

  it("refuses a non-canonical path, a query, or a fragment", () => {
    expect(() => resolveBatchEventUrl("/api/event")).toThrow();
    expect(() => resolveBatchEventUrl("/api/events?x=1")).toThrow();
    expect(() => resolveBatchEventUrl("https://api.example.test/api/events#f")).toThrow();
    expect(() => resolveBatchEventUrl("")).toThrow();
  });

  it("derives the sibling endpoint from the mutation endpoint, and stays silent when it cannot", () => {
    expect(deriveBatchEventUrl("http://localhost:3001/api/mutations")).toBe("http://localhost:3001/api/events");
    expect(deriveBatchEventUrl("/api/mutations")).toBe("/api/events");
    expect(deriveBatchEventUrl("https://example.test/write")).toBeUndefined();
  });
});
