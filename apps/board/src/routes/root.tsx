import { AppShell, Badge, Button, Group, Text } from "@mantine/core";
import { Outlet } from "@tanstack/react-router";
import { useState } from "react";

import { useAuth } from "../auth/auth";
import { useMutationSummary } from "../board-client";
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

// The registry-wide mutation summary (pgxsinkit slice 4): ONE subscription over every writable journal,
// surfaced as a compact "unsettled" count beside the phase badge. Hidden when everything is settled — a
// glanceable dogfood of `useMutationSummary` next to the coarser sync phase.
function MutationBadge() {
  const { summary } = useMutationSummary();
  if (summary.unsettledCount === 0) return null;
  return (
    <Badge variant="light" color="yellow" aria-label={`${summary.unsettledCount} unsettled writes`}>
      {summary.unsettledCount} unsettled
    </Badge>
  );
}

// The shell every route renders inside. When signed in, the header shows the identity, live sync
// status, and a sign-out action, and the left navbar is the Team switcher (the Sync Inspector drawer
// attaches here in Phase 8). The navbar is omitted on the unauthenticated (login) screen.
export function RootLayout() {
  const { session, signingOut: authSigningOut, signOut } = useAuth();
  const [signOutPending, setSignOutPending] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const showAuthenticatedShell = session != null && !authSigningOut;

  const handleSignOut = async () => {
    setSignOutPending(true);
    setSignOutError(null);
    try {
      await signOut();
    } catch (cause) {
      setSignOutError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSignOutPending(false);
    }
  };

  return (
    <AppShell
      header={{ height: 56 }}
      padding="md"
      {...(showAuthenticatedShell ? { navbar: { width: 220, breakpoint: "xs" as const } } : {})}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Text fw={700}>pgxsinkit board</Text>
          {showAuthenticatedShell ? (
            <Group gap="sm" data-authenticated-shell>
              <SyncInspector />
              <MutationBadge />
              <SyncBadge />
              <Text size="sm" c="dimmed">
                {session.user.email}
              </Text>
              {signOutError != null && (
                <Text size="xs" c="red" role="alert">
                  Sign-out failed: {signOutError}
                </Text>
              )}
              <Button size="xs" variant="default" loading={signOutPending} onClick={() => void handleSignOut()}>
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
      {showAuthenticatedShell && (
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
