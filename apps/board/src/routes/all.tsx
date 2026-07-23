import { Center, Loader, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { useAuth } from "../auth/auth";
import { useIssueActions } from "../board/use-issue-actions";
import {
  buildAssignableByTeam,
  useAllIssues,
  useIssueConvergence,
  useProfileMap,
  useServerIssueValues,
  useTeamMemberships,
  useTeams,
} from "../data";
import { BoardColumns } from "../features/board";

// Admin-only cross-team view: every Issue the store holds, labelled by Team. For an Admin the read
// path returns all rows (the admin bypass in every `*ReadFilter`), so this is "Admin sees all" made
// concrete. Writes here exercise the Admin authority too: any Status/assignee edit on any Team, plus
// the cross-team "Move to team" move (a row leaving one member's shape and entering another's, live).
// A non-admin who reaches it is redirected home.
export function AllRoute() {
  const { session, isAdmin } = useAuth();
  const navigate = useNavigate();
  const { issues, settled } = useAllIssues();
  const { profiles } = useProfileMap();
  const { memberships } = useTeamMemberships();
  const { teams } = useTeams();
  const actions = useIssueActions();
  const { convergence: convergenceById } = useIssueConvergence();
  const { serverValues: serverValueById } = useServerIssueValues();

  const teamNameById = useMemo(() => new Map(teams.map((team) => [team.id, team.name])), [teams]);
  const assignableByTeam = useMemo(() => buildAssignableByTeam(memberships, profiles), [memberships, profiles]);

  useEffect(() => {
    if (session && !isAdmin) void navigate({ to: "/" });
  }, [session, isAdmin, navigate]);

  if (!isAdmin) return null;

  return (
    <Stack gap="md">
      <div>
        <Title order={2}>All teams</Title>
        <Text c="dimmed">Every Issue across every Team — the Admin global view.</Text>
      </div>
      {!settled && issues.length === 0 ? (
        <Center h="30vh">
          <Loader />
        </Center>
      ) : (
        <BoardColumns
          issues={issues}
          profiles={profiles}
          actions={actions}
          assignableByTeam={assignableByTeam}
          convergenceById={convergenceById}
          serverValueById={serverValueById}
          teamNameById={teamNameById}
          moveTeams={teams}
        />
      )}
    </Stack>
  );
}
