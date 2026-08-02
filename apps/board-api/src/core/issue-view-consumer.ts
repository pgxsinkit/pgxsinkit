import {
  BOARD_ISSUE_VIEWED_STREAM,
  boardIssueViewedPayloadSchema,
  boardIssueViewEventTable,
  boardSyncRegistry,
} from "@pgxsinkit/board-schema";
import type { StampedEvent } from "@pgxsinkit/contracts";
import { createPgmqEventQueue, defineEventConsumer, type EventConsumer } from "@pgxsinkit/server";

import type { BoardDb } from "./handlers";

/**
 * The board's **Event lane consumer runner** (pgxsinkit ADR-0053 decisions 7 and 9): the toolkit defines the
 * runner, the app hosts it. It exists so a human can watch the whole lane end-to-end — append in a tab, see
 * a row appear in `board_issue_view_event` — and it is deliberately the smallest thing that does that.
 *
 * It is a LONG-LIVED process, not a request handler: `createSyncServer`'s zero-startup-query serverless
 * posture is the wrong shape for a poller, so this never rides `board-write`. `apps/board-api/src/runtime/
 * bun-consumer.ts` is the process entry (`bun run --cwd apps/board-api consumer`).
 *
 * Everything about pacing, visibility renewal and retry is INTERNAL to `defineEventConsumer` — the app
 * supplies a queue, a callback, and nothing else it would have to get right.
 */

/** How the callback turns one delivered sub-batch into archive rows. Exported for the unit test. */
export function toArchiveRows(events: readonly StampedEvent[]): Array<typeof boardIssueViewEventTable.$inferInsert> {
  return events.map((event) => {
    // Defensive re-parse of an already-validated payload: the ingestion endpoint validated it against this
    // same registered schema, so a failure here means a hand-inserted queue message or a broken deployment.
    // Throwing is the right loud answer — the sub-batch retries and then dead-letters (with a warn log),
    // rather than writing a malformed fact into the archive.
    const payload = boardIssueViewedPayloadSchema.parse(event.payload);
    const viewerId = event.identity["viewerId"];
    if (viewerId == null) {
      throw new Error(
        `board: event ${event.eventId} carries no stamped viewerId — the ingesting request had no verified sub claim.`,
      );
    }
    return {
      eventId: event.eventId,
      viewerId,
      issueId: payload.issueId,
      occurredAtUs: BigInt(event.occurredAtUs),
    };
  });
}

export interface BoardIssueViewConsumerOptions {
  db: BoardDb;
  /** Notified after each archived sub-batch — the demo's "something happened" line. */
  onArchived?: (count: number) => void;
}

/**
 * Build the runner. Construction is query-free: the FIRST statement it sends is the first poll inside
 * `start()`, and the pgmq queues themselves are deploy-time DDL (`bun run db:board:events`).
 */
export function createBoardIssueViewConsumer(options: BoardIssueViewConsumerOptions): EventConsumer {
  const queue = createPgmqEventQueue({ db: options.db });

  return defineEventConsumer({
    registry: boardSyncRegistry,
    queue,
    streams: [BOARD_ISSUE_VIEWED_STREAM],
    callback: async ({ events }) => {
      const rows = toArchiveRows(events);
      // ONE transaction per delivered sub-batch, and `ON CONFLICT (event_id) DO NOTHING` — the blessed
      // dedupe (ADR-0053 decision 6). Delivery is at-least-once, so a redelivered sub-batch (a visibility
      // timeout that lapsed while this transaction was still running, say) must be a no-op rather than a
      // duplicate fact; keying the archive on the library-stamped `eventId` is what composes at-least-once
      // delivery into effectively-exactly-once archiving.
      await options.db.transaction(async (tx) => {
        await tx.insert(boardIssueViewEventTable).values(rows).onConflictDoNothing({
          target: boardIssueViewEventTable.eventId,
        });
      });
      options.onArchived?.(rows.length);
    },
    onDeadLetter: (report) => {
      // The runner already warn-logs every dead letter unconditionally; this adds the board's own line so
      // the demo operator sees WHICH stream gave up without reading pgmq's archive.
      console.error("[board-consumer] dead-lettered a sub-batch", {
        stream: report.stream,
        reason: report.reason,
        attempts: report.attempts,
      });
    },
  });
}
