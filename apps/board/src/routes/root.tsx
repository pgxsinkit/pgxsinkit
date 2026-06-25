import { AppShell, Badge, Button, Group, Text } from "@mantine/core";
import { Outlet } from "@tanstack/react-router";

import { useAuth } from "../auth/auth";
import { useBoardSyncStatus } from "../board/board-client-provider";
import { SyncInspector } from "../board/sync-inspector";
import { TeamNav } from "../components/team-nav";

const PHASE_BADGE: Record<string, { label: string; color: string }> = {
  booting: { label: "Starting…", color: "yellow" },
  syncing: { label: "Syncing…", color: "yellow" },
  ready: { label: "Up to date", color: "green" },
  degraded: { label: "Sync error", color: "red" },
  "auth-needed": { label: "Re-auth needed", color: "orange" },
};

// Renders nothing outside the sync provider (e.g. on the login screen) since `useBoardSyncStatus`
// returns null there.
function SyncBadge() {
  const status = useBoardSyncStatus();
  if (status == null) return null;
  const badge = PHASE_BADGE[status.phase] ?? { label: status.phase, color: "gray" };
  return (
    <Badge variant="light" color={badge.color}>
      {badge.label}
    </Badge>
  );
}

// The shell every route renders inside. When signed in, the header shows the identity, live sync
// status, and a sign-out action, and the left navbar is the Team switcher (the Sync Inspector drawer
// attaches here in Phase 8). The navbar is omitted on the unauthenticated (login) screen.
export function RootLayout() {
  const { session, signOut } = useAuth();
  return (
    <AppShell
      header={{ height: 56 }}
      padding="md"
      {...(session ? { navbar: { width: 220, breakpoint: "xs" as const } } : {})}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Text fw={700}>pgxsinkit board</Text>
          {session ? (
            <Group gap="sm">
              <SyncInspector />
              <SyncBadge />
              <Text size="sm" c="dimmed">
                {session.user.email}
              </Text>
              <Button size="xs" variant="default" onClick={() => void signOut()}>
                Sign out
              </Button>
            </Group>
          ) : (
            <Text size="sm" c="dimmed">
              offline-first sync demo
            </Text>
          )}
        </Group>
      </AppShell.Header>
      {session && (
        <AppShell.Navbar p="xs">
          <TeamNav />
        </AppShell.Navbar>
      )}
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
