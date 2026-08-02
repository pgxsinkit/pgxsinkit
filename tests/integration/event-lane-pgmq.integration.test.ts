import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { sql } from "drizzle-orm";
import { uuid, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  batchEventPaths,
  defineEventStream,
  defineSyncRegistry,
  defineSyncTable,
  batchEventAckSchema,
} from "@pgxsinkit/contracts";
import { createPgmqEventQueue, createSyncServer, renderEventLaneMigration } from "@pgxsinkit/server";
import { createServerDb, readIntegrationEnv } from "@pgxsinkit/test-utils";

// The Event lane's server half against a REAL pgmq (ADR-0053 decisions 5 and 9): deploy-time DDL →
// ingestion endpoint → queue → read/ack → dead-letter → enumerate → requeue. The unit lane covers the verdict
// matrix and the statement shapes; what only a database can prove is that pgmq accepts these statements, that
// `pgmq.create()` really is idempotent, and that the archive round-trips a dead-letter reason.
//
// Wired into `test:integration:implementation` (maintainer-approved 2026-08-01; the compose Postgres image
// ships pgmq built in — the emitted migration's CREATE EXTENSION activates it).

const env = readIntegrationEnv();

const issues = defineSyncTable({
  tableName: "elp_issues",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 120 }).notNull(),
  }),
});

const registry = defineSyncRegistry({
  tables: { issues },
  streams: {
    elp_issue_viewed: defineEventStream({
      payload: z.object({ issueId: z.uuid() }).strict(),
      identity: { viewerId: { claimPath: ["sub"] } },
    }),
    elp_aid_used: defineEventStream({
      payload: z.object({ aid: z.string() }).strict(),
      identity: { viewerId: { claimPath: ["sub"] } },
    }),
    // A parse output that SERIALIZES cleanly but is not itself a JSON value. Only this lane can prove the
    // route's normalization matters: the in-memory fake stores whatever object it is handed, so a `Date`
    // enqueued as a `Date` looks fine there and comes back an ISO string from a real `jsonb` queue. The
    // route enqueues the JSON round-trip, so both transports must now agree — and here is the real one.
    elp_note_dated: defineEventStream({
      payload: z.string().transform((value) => new Date(value)),
      identity: { viewerId: { claimPath: ["sub"] } },
    }),
  },
});

const SUB = "00000000-0000-4000-8000-000000000001";
const ISSUE = "00000000-0000-4000-8000-0000000000ff";

/** Apply an emitted migration body the way a migration runner does: statement by statement, comments dropped. */
async function applyMigration(db: ReturnType<typeof createServerDb>["db"], body: string): Promise<void> {
  const statements = body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

describe("event lane over pgmq", () => {
  const serverDb = createServerDb(registry, env.databaseUrl);
  let server!: ReturnType<typeof createSyncServer<typeof registry>>;

  beforeAll(async () => {
    // Applied TWICE on purpose: `pgmq.create()` is idempotent (IF NOT EXISTS tables/indexes, ON CONFLICT DO
    // NOTHING meta), which is what lets the artifact be re-applied and appended to.
    await applyMigration(serverDb.db, renderEventLaneMigration(registry));
    await applyMigration(serverDb.db, renderEventLaneMigration(registry));

    server = createSyncServer({
      registry,
      db: serverDb.db,
      resolveAuthClaims: () => ({ sub: SUB, role: "authenticated" }),
      deployment: { startupVerification: "deploy-time", operationsLog: "disabled" },
    });

    await serverDb.db.execute(sql`SELECT pgmq.purge_queue('pgxsinkit_events_elp_issue_viewed')`);
    await serverDb.db.execute(sql`SELECT pgmq.purge_queue('pgxsinkit_events_elp_aid_used')`);
    await serverDb.db.execute(sql`SELECT pgmq.purge_queue('pgxsinkit_events_elp_note_dated')`);
    await serverDb.db.execute(sql`DELETE FROM pgmq."a_pgxsinkit_events_elp_issue_viewed"`);
    await serverDb.db.execute(sql`DELETE FROM pgmq."a_pgxsinkit_events_elp_aid_used"`);
    await serverDb.db.execute(sql`DELETE FROM pgmq."a_pgxsinkit_events_elp_note_dated"`);
  });

  afterAll(async () => {
    await server.stop();
    await serverDb.close();
  });

  it("ingests a mixed batch, delivers each stream's sub-batch, and acks it terminally", async () => {
    const queue = createPgmqEventQueue({ db: serverDb.db });
    const events = [
      {
        stream: "elp_issue_viewed",
        eventId: eventId(1),
        occurredAtUs: "1754006400000001",
        payload: { issueId: ISSUE },
      },
      { stream: "elp_aid_used", eventId: eventId(2), occurredAtUs: "1754006400000002", payload: { aid: "dictionary" } },
      {
        stream: "elp_issue_viewed",
        eventId: eventId(3),
        occurredAtUs: "1754006400000003",
        payload: { issueId: ISSUE },
      },
      { stream: "elp_not_registered", eventId: eventId(4), occurredAtUs: "1754006400000004", payload: {} },
    ];

    const response = await server.fetch(
      new Request(`http://localhost${batchEventPaths[0]}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events }),
      }),
    );

    expect(response.status).toBe(200);
    const { acks } = batchEventAckSchema.parse(await response.json());
    expect(acks.map((ack) => ack.status)).toEqual(["acked", "acked", "acked", "deferred"]);

    // One message per Event stream, each carrying its events in append order, each stamped with the identity
    // resolved from the VERIFIED claims (the client's envelope carries none).
    const viewed = await queue.readBatch("elp_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 10 });
    expect(viewed).toHaveLength(1);
    expect(viewed[0]?.message.events.map((event) => event.eventId)).toEqual([eventId(1), eventId(3)]);
    expect(viewed[0]?.message.events[0]?.identity).toEqual({ viewerId: SUB });
    expect(viewed[0]?.deliveryCount).toBe(1);

    const aid = await queue.readBatch("elp_aid_used", { visibilityTimeoutSeconds: 30, maxMessages: 10 });
    expect(aid[0]?.message.events).toHaveLength(1);

    // Invisible while the visibility timeout holds…
    expect(await queue.readBatch("elp_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 10 })).toEqual([]);

    expect(await queue.ack("elp_issue_viewed", [viewed[0]!.receipt])).toBe(1);
    expect(await queue.ack("elp_aid_used", [aid[0]!.receipt])).toBe(1);
  });

  it("delivers the JSON-NORMALIZED parse output: a Date-producing transform arrives as its ISO string", async () => {
    // Transport equivalence, which is the whole point of normalizing at the route. Before the fix the route
    // enqueued the `Date` itself, so the in-memory fake handed the consumer a `Date` while THIS path — the
    // one production runs — serialized it into `jsonb` and handed back a string. Now both are the string,
    // and the fake's unit assertion and this one are the same assertion.
    const queue = createPgmqEventQueue({ db: serverDb.db });
    const iso = "2026-08-01T00:00:00.000Z";

    const response = await server.fetch(
      new Request(`http://localhost${batchEventPaths[0]}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [{ stream: "elp_note_dated", eventId: eventId(11), occurredAtUs: "1754006400000011", payload: iso }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(batchEventAckSchema.parse(await response.json()).acks.map((ack) => ack.status)).toEqual(["acked"]);

    const [delivered] = await queue.readBatch("elp_note_dated", { visibilityTimeoutSeconds: 30, maxMessages: 10 });
    const payload = delivered?.message.events[0]?.payload;
    expect(typeof payload).toBe("string");
    expect(payload).toBe(iso);
    expect(delivered?.message.events[0]?.eventId).toBe(eventId(11));

    expect(await queue.ack("elp_note_dated", [delivered!.receipt])).toBe(1);
  });

  it("extends a delivered message's visibility with set_vt, holding it invisible past the original window", async () => {
    const queue = createPgmqEventQueue({ db: serverDb.db });
    await server.fetch(
      new Request(`http://localhost${batchEventPaths[0]}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              stream: "elp_issue_viewed",
              eventId: eventId(9),
              occurredAtUs: "1754006400000009",
              payload: { issueId: ISSUE },
            },
          ],
        }),
      }),
    );

    // Read with a deliberately tiny window, then renew it the way the consumer runner does mid-processing.
    const [delivered] = await queue.readBatch("elp_issue_viewed", { visibilityTimeoutSeconds: 2, maxMessages: 10 });
    expect(await queue.extendVisibility("elp_issue_viewed", [delivered!.receipt], 30)).toBe(1);

    // A real wall-clock wait, exceptionally: a visibility window is wall time by nature, and what this case
    // proves is that the LATERAL set_vt statement really moved it — the message must still be invisible
    // after the ORIGINAL 2s window has lapsed.
    await Bun.sleep(2500);
    expect(await queue.readBatch("elp_issue_viewed", { visibilityTimeoutSeconds: 30, maxMessages: 10 })).toEqual([]);

    expect(await queue.ack("elp_issue_viewed", [delivered!.receipt])).toBe(1);
  });

  it("dead-letters into pgmq's archive with a reason, and requeues only on a deliberate act", async () => {
    const queue = createPgmqEventQueue({ db: serverDb.db });
    await server.fetch(
      new Request(`http://localhost${batchEventPaths[0]}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            {
              stream: "elp_aid_used",
              eventId: eventId(5),
              occurredAtUs: "1754006400000005",
              payload: { aid: "poison" },
            },
          ],
        }),
      }),
    );

    const [delivered] = await queue.readBatch("elp_aid_used", { visibilityTimeoutSeconds: 30, maxMessages: 10 });
    expect(await queue.deadLetter("elp_aid_used", [delivered!.receipt], "callback threw 5 times")).toBe(1);

    const dead = await queue.listDeadLetters("elp_aid_used", 10);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.reason).toBe("callback threw 5 times");
    // The reserved reason key is stripped back out, so the enumerated body is exactly what was enqueued.
    expect(dead[0]?.message.events[0]?.eventId).toBe(eventId(5));

    const receipt = await queue.requeueDeadLetter("elp_aid_used", dead[0]!.id);
    expect(receipt).not.toBeNull();
    expect(await queue.listDeadLetters("elp_aid_used", 10)).toEqual([]);

    const requeued = await queue.readBatch("elp_aid_used", { visibilityTimeoutSeconds: 1, maxMessages: 10 });
    expect(requeued[0]?.message.events[0]?.eventId).toBe(eventId(5));
    await queue.ack("elp_aid_used", [requeued[0]!.receipt]);
  });
});

function eventId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
