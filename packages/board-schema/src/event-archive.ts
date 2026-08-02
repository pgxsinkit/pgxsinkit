import { bigint, pgTable, uuid } from "drizzle-orm/pg-core";

import { clockMicrosecondsSql } from "@pgxsinkit/contracts";

/**
 * The board's **Issue view archive** — where the `board_issue_viewed` Event stream lands (pgxsinkit
 * ADR-0053 decision 9).
 *
 * It is a plain server-side table, deliberately NOT a sync entry: the Event lane carries fire-and-forget
 * facts one way, nothing reads them back down, and a client that re-downloaded its own view log is the
 * exact shape this lane exists to avoid. It therefore has no registry entry, no shape, no RLS policy and
 * no `authenticated` grants — the only writer is the board's consumer runner, which connects as the
 * database owner (apps/board-api/src/core/issue-view-consumer.ts). RLS is enabled with no policies, so
 * even a mistakenly granted role sees nothing.
 *
 * `eventId` is the PRIMARY KEY, and that is the whole idempotency design: delivery is at-least-once, so
 * the consumer inserts `ON CONFLICT (event_id) DO NOTHING` and a redelivered sub-batch composes to
 * effectively-exactly-once. Never re-key this table on anything else.
 *
 * The two clocks are both kept because they answer different questions and can differ by weeks: an event
 * appended on a plane carries the `occurredAtUs` the client stamped at append (device clock, when the
 * human actually looked), while `receivedAtUs` is the server's own clock at archive time. Temporal
 * analysis re-sorts on `occurredAtUs` (ADR-0053 decision 6: order across delivered batches is not
 * promised), and lag analysis is the difference.
 */
export const boardIssueViewEventTable = pgTable.withRLS("board_issue_view_event", {
  /** The library-stamped event id — the dedupe key the at-least-once contract is idempotent on. */
  eventId: uuid("event_id").primaryKey(),
  /** The viewer, stamped SERVER-side from the verified `sub` claim (the stream's `viewerId` identity field). */
  viewerId: uuid("viewer_id").notNull(),
  /** The Issue that was opened. Not an FK: an archived fact must survive its Issue being deleted. */
  issueId: uuid("issue_id").notNull(),
  /** When the client appended it (its clock), in unix microseconds. */
  occurredAtUs: bigint("occurred_at_us", { mode: "bigint" }).notNull(),
  /** When the consumer archived it (the server's clock), in unix microseconds. */
  receivedAtUs: bigint("received_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
});
