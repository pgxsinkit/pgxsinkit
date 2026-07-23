import { useMemo } from "react";

import { useSyncClient } from "../board-client";

export interface MembershipActions {
  /**
   * Add a Member to a Team (Admin-only; board ADR-0002). A single optimistic `team_member.create`.
   * On the added member's own client this is the **atomic fan-out showcase** (board ADR-0004): the
   * new membership widens their read shape, so the Team plus its Channel and Issues all stream in and
   * commit at one LSN frontier — the whole board appears in a single frame, no broken-join flicker.
   */
  addMember: (teamId: string, userId: string) => Promise<void>;
  /** Remove a Member from a Team (Admin-only). Optimistic `team_member.delete` by membership PK; on
   * the removed member's client the Team's board + Channel leave their shape together. */
  removeMember: (membershipId: string) => Promise<void>;
}

/**
 * The `team_member` write surface (board Phase 7). Writes are Admin-only — the RLS policy rejects a
 * non-Admin `team_member` mutation server-side, so a non-Admin write would optimistically apply then
 * be quarantined. The UI only mounts these actions on the Admin members page.
 */
export function useMembershipActions(): MembershipActions {
  const client = useSyncClient();
  return useMemo<MembershipActions>(
    () => ({
      addMember: (teamId, userId) => client.tables.team_member.create({ id: crypto.randomUUID(), teamId, userId }),
      removeMember: (membershipId) => client.tables.team_member.delete({ id: membershipId }),
    }),
    [client],
  );
}
