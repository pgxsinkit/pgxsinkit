import { Center, Group, Loader, SegmentedControl, Skeleton, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useTeams } from "../data";

// Header + Board/Chat switch shared by the two per-team routes. If the Team isn't in the local store
// (a member navigating to a Team they don't belong to), the read path simply never synced it — shown
// as an explicit empty state, which is itself the scoping made visible. That claim is only made once
// the teams query has `settled`: every mount (including Board ↔ Chat switches) re-enters a brief
// window where the live query's first snapshot hasn't arrived, and rendering "you're not a member"
// off the interim empty rows would flash a falsehood at every member.
export function TeamPageShell({
  teamId,
  tab,
  children,
}: {
  teamId: string;
  tab: "board" | "chat";
  children: ReactNode;
}) {
  const { teams, settled } = useTeams();
  const navigate = useNavigate();
  const team = teams.find((candidate) => candidate.id === teamId);

  return (
    <Stack gap="md">
      <Group justify="space-between">
        {team == null && !settled ? (
          <Skeleton height={28} width={160} />
        ) : (
          <Title order={2}>{team?.name ?? "Team"}</Title>
        )}
        <SegmentedControl
          value={tab}
          onChange={(value) =>
            void navigate(
              value === "chat"
                ? { to: "/team/$teamId/chat", params: { teamId } }
                : { to: "/team/$teamId/board", params: { teamId } },
            )
          }
          data={[
            { label: "Board", value: "board" },
            { label: "Chat", value: "chat" },
          ]}
        />
      </Group>
      {team != null ? (
        children
      ) : settled ? (
        <Text c="dimmed">This team isn&apos;t in your synced workspace — you&apos;re not a member.</Text>
      ) : (
        <Center h="30vh">
          <Loader />
        </Center>
      )}
    </Stack>
  );
}
