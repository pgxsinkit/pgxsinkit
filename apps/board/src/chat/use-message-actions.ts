import { useMemo } from "react";

import { useSyncClient } from "../board-client";

export interface MessageActions {
  /**
   * Post a Message into a Channel (board Phase 7). A single optimistic `message.create`: the local
   * Overlay gains the row immediately (so the live thread re-renders this frame), then the convergence
   * trigger flushes it to `board-write` and reconciles once the server value streams back via Electric.
   * `authorId` and the timestamps are server-managed (`authUid` / `nowMicroseconds`), so compose only
   * supplies `channelId` + `body`; the optimistic overlay still stamps the author from the session, so
   * the row renders attributed to the current user immediately rather than as "Unknown" until echo.
   * Conflict policy is `last-write-wins` — each insert has its own PK, so concurrent posts never
   * collide; an edit-to-the-same-row race simply takes the latest writer.
   */
  post: (channelId: string, body: string) => Promise<void>;
}

export function useMessageActions(): MessageActions {
  const client = useSyncClient();
  return useMemo<MessageActions>(
    () => ({
      post: (channelId, body) => client.tables.message.create({ id: crypto.randomUUID(), channelId, body }),
    }),
    [client],
  );
}
