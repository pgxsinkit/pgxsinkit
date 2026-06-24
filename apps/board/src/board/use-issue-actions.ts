import { useMemo } from "react";

import { useSyncClient } from "../board-client";
import type { IssueStatus } from "../data";

export interface IssueActions {
  /** Move an Issue to another Status column (drag-drop or the card menu). */
  setStatus: (issueId: string, status: IssueStatus) => Promise<void>;
  /** Assign the Issue to a member (`null` = Unassigned). */
  setAssignee: (issueId: string, assigneeId: string | null) => Promise<void>;
  /** Cross-Team move — offered only to an Admin (the `board_block_cross_team_move` trigger rejects it
   * server-side for anyone else, so a non-Admin write would optimistically apply then be quarantined). */
  moveToTeam: (issueId: string, teamId: string) => Promise<void>;
}

/**
 * The Issue write surface (board Phase 5). Each call is a single optimistic `issue.update`: the local
 * Overlay updates immediately (so the live board re-renders this frame), then the convergence trigger
 * (`autoSync`, board-client.ts) flushes it to `board-write` and reconciles once the server value
 * streams back through Electric. `updated_at_us` is server-stamped (a managed field), so the
 * `reject-if-stale` Conflict policy compares against the version the edit was based on.
 */
export function useIssueActions(): IssueActions {
  const client = useSyncClient();
  return useMemo<IssueActions>(
    () => ({
      setStatus: (issueId, status) => client.tables.issue.update({ id: issueId }, { status }),
      setAssignee: (issueId, assigneeId) => client.tables.issue.update({ id: issueId }, { assigneeId }),
      moveToTeam: (issueId, teamId) => client.tables.issue.update({ id: issueId }, { teamId }),
    }),
    [client],
  );
}
