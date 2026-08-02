import { describe, expect, it } from "bun:test";

import { uuid, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  defineEventStream,
  defineSyncRegistry,
  defineSyncTable,
  EVENT_STREAM_QUEUE_PREFIX,
  type EventStreamRegistry,
} from "@pgxsinkit/contracts";
import {
  EVENT_LANE_FINGERPRINT_PREFIX,
  eventLaneDdlFingerprint,
  eventLaneStreamNames,
  renderEventLaneMigration,
} from "@pgxsinkit/server";

// The Event lane's deploy-time DDL (ADR-0053 decision 5): the pgmq extension plus one queue per registered
// Event stream. Provisioning is deploy-time, never runtime create-if-missing — the endpoint may enqueue long
// before any runner starts — so this artifact is what stands between a registered stream and a 503.

const issues = defineSyncTable({
  tableName: "eld_issues",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    title: varchar("title", { length: 120 }).notNull(),
  }),
});

const stream = (extra?: { note: true }) =>
  defineEventStream({
    payload: z.object({ issueId: z.uuid(), ...(extra ? { note: z.string().optional() } : {}) }).strict(),
    identity: { viewerId: { claimPath: ["sub"] } },
  });

const withStreams = (streams: EventStreamRegistry) => defineSyncRegistry({ tables: { issues }, streams });

describe("event-lane DDL emission (ADR-0053 decision 5)", () => {
  it("emits the extension once and one idempotent pgmq.create per registered Event stream", () => {
    const ddl = renderEventLaneMigration(withStreams({ board_issue_viewed: stream(), board_aid_used: stream() }));

    expect(ddl).toContain("CREATE EXTENSION IF NOT EXISTS pgmq;");
    expect(ddl.match(/CREATE EXTENSION/g)).toHaveLength(1);
    expect(ddl).toContain(`SELECT pgmq.create('${EVENT_STREAM_QUEUE_PREFIX}board_aid_used');`);
    expect(ddl).toContain(`SELECT pgmq.create('${EVENT_STREAM_QUEUE_PREFIX}board_issue_viewed');`);
    // No CASCADE on the statement: pgmq's control file declares no `requires`, and CASCADE would silently
    // install whatever a future one starts requiring. (The comment header says so; the statement must not.)
    expect(ddl).not.toContain("EXISTS pgmq CASCADE");
  });

  it("is registry-ORDER independent, so a reordered `streams` map is not a spurious migration", () => {
    const a = renderEventLaneMigration(withStreams({ board_issue_viewed: stream(), board_aid_used: stream() }));
    const b = renderEventLaneMigration(withStreams({ board_aid_used: stream(), board_issue_viewed: stream() }));

    expect(a).toBe(b);
    expect(eventLaneStreamNames(withStreams({ board_issue_viewed: stream(), board_aid_used: stream() }))).toEqual([
      "board_aid_used",
      "board_issue_viewed",
    ]);
  });

  it("carries a fingerprint that MOVES when a stream is added or removed", () => {
    const one = withStreams({ board_issue_viewed: stream() });
    const two = withStreams({ board_issue_viewed: stream(), board_aid_used: stream() });

    expect(eventLaneDdlFingerprint(one)).toStartWith(EVENT_LANE_FINGERPRINT_PREFIX);
    expect(eventLaneDdlFingerprint(one)).not.toBe(eventLaneDdlFingerprint(two));
    // The emitted artifact carries its own fingerprint — that is what `--check` scans committed migrations for.
    expect(renderEventLaneMigration(two)).toContain(eventLaneDdlFingerprint(two));
  });

  it("does NOT move for a payload-schema change, which provisions nothing", () => {
    // Schema evolution is compatibility-bound (decision 1) and shows up in the registry LOCK diff; it changes
    // no queue, so it must not demand a new migration.
    expect(eventLaneDdlFingerprint(withStreams({ board_issue_viewed: stream() }))).toBe(
      eventLaneDdlFingerprint(withStreams({ board_issue_viewed: stream({ note: true }) })),
    );
  });

  it("refuses to emit anything for a registry with no Event streams", () => {
    const streamless = defineSyncRegistry({ tables: { issues } });

    expect(eventLaneStreamNames(streamless)).toEqual([]);
    expect(() => renderEventLaneMigration(streamless)).toThrow(/registers no Event streams/);
    expect(() => eventLaneDdlFingerprint(streamless)).toThrow(/registers no Event streams/);
  });
});
