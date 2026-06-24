import { Center, Loader } from "@mantine/core";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import { useAuth } from "../auth/auth";
import { useIssueActions } from "../board/use-issue-actions";
import { TeamPageShell } from "../components/team-page-shell";
import { buildAssignableByTeam, useProfileMap, useTeamIssues, useTeamMemberships, useTeams } from "../data";
import { BoardColumns, type TeamOption } from "../features/board";

export function TeamBoardRoute() {
  const { teamId } = useParams({ from: "/team/$teamId/board" });
  const { isAdmin } = useAuth();
  const { issues, loading } = useTeamIssues(teamId);
  const profiles = useProfileMap();
  const memberships = useTeamMemberships();
  const { teams } = useTeams();
  const actions = useIssueActions();

  const assignableByTeam = useMemo(() => buildAssignableByTeam(memberships, profiles), [memberships, profiles]);
  // Cross-team move is Admin-only (the board trigger rejects it for anyone else), so only an Admin
  // gets the "Move to team" submenu.
  const moveTeams: TeamOption[] = isAdmin ? teams : [];

  return (
    <TeamPageShell teamId={teamId} tab="board">
      {loading && issues.length === 0 ? (
        <Center h="30vh">
          <Loader />
        </Center>
      ) : (
        <BoardColumns
          issues={issues}
          profiles={profiles}
          actions={actions}
          assignableByTeam={assignableByTeam}
          moveTeams={moveTeams}
        />
      )}
    </TeamPageShell>
  );
}
