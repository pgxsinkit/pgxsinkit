import { useCallback } from "react";

import { BOARD_ISSUE_VIEWED_STREAM } from "@pgxsinkit/board-schema";

import { useSyncClient } from "../board-client";

/**
 * The board's **Event lane** producer (pgxsinkit ADR-0053 decision 9): append `board_issue_viewed` when a
 * User opens an Issue.
 *
 * The board has no separate Issue detail ROUTE — an Issue's details are its card's actions surface (the
 * kebab menu on a pointer device, the bottom sheet on touch), so that opening is the honest "viewed"
 * moment, and both surfaces call this one function.
 *
 * Deliberately NOT a write: an Issue view is a fire-and-forget fact, not a mutation. It never goes through
 * the journal, never overlays a row, never conflicts, and nothing echoes back. `appendEvent` resolves on
 * DURABLE local enqueue into the Outbox (so an append made offline survives a reload and drains on
 * reconnect); delivery to the board's consumer runner happens later, out of band.
 */
export function useIssueViewEvents(): (issueId: string) => void {
  const client = useSyncClient();
  return useCallback(
    (issueId: string) => {
      // Fire-and-forget, but never a swallowed rejection. `appendEvent` fails only for call-site bugs — an
      // unregistered Event stream, a payload the registered schema refuses, an oversized payload — so a
      // rejection here is a defect in THIS file, and it is logged rather than surfaced to the user: a view
      // that failed to record must not interrupt someone reading an Issue.
      void client.appendEvent(BOARD_ISSUE_VIEWED_STREAM, { issueId }).catch((error: unknown) => {
        console.warn("[board] board_issue_viewed append failed", error);
      });
    },
    [client],
  );
}
