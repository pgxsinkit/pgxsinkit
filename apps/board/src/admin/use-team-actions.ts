import { useMemo } from "react";

import { useSyncClient } from "../board-client";

export interface TeamActions {
  /**
   * Rename a Team (Admin-only; pgxsinkit ADR-0025 showcase). A single optimistic `team.update`. `team`
   * is `readwrite` only in the Admin (authoritative) registry, so this handle exists only on an Admin
   * client; the rename converges to every member's board via the Electric echo (their `team` is
   * `asReadonly`, so they read the new name but have no write handle to change it). `updated_at_us` is
   * the Server version — stamped by the apply function (managed field), never sent in the patch.
   */
  rename: (teamId: string, name: string) => Promise<void>;
}

/**
 * The `team` write surface. Like `useMembershipActions`, writes are Admin-only — the RLS policy rejects
 * a non-Admin `team` mutation server-side, and a Member's client carries no `team` write handle at all
 * (the `asReadonly` projection). The UI only mounts this on the Admin members page.
 */
export function useTeamActions(): TeamActions {
  const client = useSyncClient();
  return useMemo<TeamActions>(
    () => ({
      rename: (teamId, name) => client.tables.team.update({ id: teamId }, { name }),
    }),
    [client],
  );
}
