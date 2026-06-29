import { NavLink, Stack, Text } from "@mantine/core";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useAuth } from "../auth/auth";
import { useTeams } from "../data";

// Sidebar team switcher. The list IS the read-path scoping made visible: it shows exactly the Teams
// the signed-in identity synced (an Admin sees them all). The `/all` cross-team view is Admin-only.
export function TeamNav() {
  const { teams } = useTeams();
  const { isAdmin } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <Stack gap={4}>
      <Text size="xs" tt="uppercase" c="dimmed" fw={600} px="sm" pt="xs">
        Teams
      </Text>
      {teams.map((team) => (
        <NavLink
          key={team.id}
          label={team.name}
          active={pathname.startsWith(`/team/${team.id}`)}
          onClick={() => void navigate({ to: "/team/$teamId/board", params: { teamId: team.id } })}
        />
      ))}
      {teams.length === 0 && (
        <Text size="xs" c="dimmed" px="sm">
          No teams synced.
        </Text>
      )}
      <NavLink
        mt="xs"
        label="Local database"
        description="SQL REPL over your synced store"
        active={pathname === "/database"}
        onClick={() => void navigate({ to: "/database" })}
      />
      {isAdmin && (
        <NavLink
          mt="xs"
          label="All teams"
          description="Admin cross-team view"
          active={pathname === "/all"}
          onClick={() => void navigate({ to: "/all" })}
        />
      )}
      {isAdmin && (
        <NavLink
          label="Members"
          description="Add or remove Team members"
          active={pathname === "/members"}
          onClick={() => void navigate({ to: "/members" })}
        />
      )}
    </Stack>
  );
}
