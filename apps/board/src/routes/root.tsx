import { AppShell, Badge, Burger, Button, Group, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
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
  // Dropped on mobile (docs/mobile.md): the Inspector button's owed count already carries the same
  // signal, and the phone header only has room for the glanceables.
  return (
    <Badge variant="light" color="yellow" visibleFrom="xs" aria-label={`${summary.unsettledCount} unsettled writes`}>
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
  // Below the `xs` breakpoint the navbar is a Burger-toggled overlay (docs/mobile.md). The team list is
  // never abbreviated into a dropdown — the sidebar IS the read-path scoping made visible.
  const [navOpened, nav] = useDisclosure(false);

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
      {...(showAuthenticatedShell
        ? { navbar: { width: 220, breakpoint: "xs" as const, collapsed: { mobile: !navOpened } } }
        : {})}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm" wrap="nowrap">
            {/* Only meaningful when the navbar exists — the login screen renders no navbar to toggle. */}
            {showAuthenticatedShell && (
              <Burger
                opened={navOpened}
                onClick={nav.toggle}
                hiddenFrom="xs"
                size="sm"
                aria-label="Toggle navigation"
              />
            )}
            <Text fw={700}>pgxsinkit board</Text>
          </Group>
          {showAuthenticatedShell ? (
            <Group gap="sm" data-authenticated-shell>
              <SyncInspector />
              <MutationBadge />
              <SyncBadge />
              {/* Identity + sign-out move into the navbar overlay on mobile (docs/mobile.md), so the
                  phone header keeps only the glanceables and the Inspector entry point. */}
              <Text size="sm" c="dimmed" visibleFrom="xs">
                {session.user.email}
              </Text>
              {signOutError != null && (
                <Text size="xs" c="red" role="alert" visibleFrom="xs">
                  Sign-out failed: {signOutError}
                </Text>
              )}
              <Button
                size="xs"
                variant="default"
                visibleFrom="xs"
                loading={signOutPending}
                onClick={() => void handleSignOut()}
              >
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
          {/* `grow` bottom-anchors the mobile identity section below; on desktop that section is
              display:none, so the navbar renders exactly as it did. */}
          <AppShell.Section grow>
            <TeamNav onNavigate={nav.close} />
          </AppShell.Section>
          {/* The mobile home of the identity + sign-out the header sheds above. Same handler and state —
              one sign-out path, two placements. */}
          <AppShell.Section hiddenFrom="xs" pt="xs">
            <Stack gap="xs">
              {/* Labelled ("Signed in as …") rather than a bare address: this copy of the identity is
                  always in the DOM, and an exact-text match for the email must keep resolving to the one
                  in the header (the e2e lane asserts it there). */}
              <Text size="sm" c="dimmed" px="sm">
                Signed in as {session.user.email}
              </Text>
              {signOutError != null && (
                <Text size="xs" c="red" role="alert" px="sm">
                  Sign-out failed: {signOutError}
                </Text>
              )}
              <Button size="xs" variant="default" loading={signOutPending} onClick={() => void handleSignOut()}>
                Sign out
              </Button>
            </Stack>
          </AppShell.Section>
        </AppShell.Navbar>
      )}
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
