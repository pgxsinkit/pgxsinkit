import { Center, Loader, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useAuth } from "../auth/auth";
import { useTeams } from "../data";

// Index route: send the identity to their first Team's board (Admin → first Team too; the `/all`
// cross-team view is reachable from the sidebar). An identity with no synced Teams sees an empty state.
export function HomeRoute() {
  const { session, isAdmin } = useAuth();
  const navigate = useNavigate();
  const { teams, settled } = useTeams();

  useEffect(() => {
    if (!session) {
      void navigate({ to: "/login" });
      return;
    }
    if (!settled) return;
    const first = teams[0];
    if (first != null) {
      void navigate({ to: "/team/$teamId/board", params: { teamId: first.id } });
    } else if (isAdmin) {
      void navigate({ to: "/all" });
    }
  }, [session, isAdmin, teams, settled, navigate]);

  if (!session) return null;

  if (settled && teams.length === 0 && !isAdmin) {
    return (
      <Stack gap="xs">
        <Title order={2}>No teams yet</Title>
        <Text c="dimmed">You&apos;re not a member of any team. An Admin can add you to one.</Text>
      </Stack>
    );
  }

  return (
    <Center h="40vh">
      <Loader />
    </Center>
  );
}
