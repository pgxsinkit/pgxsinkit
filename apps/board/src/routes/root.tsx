import { AppShell, Group, Text } from "@mantine/core";
import { Outlet } from "@tanstack/react-router";

// The shell every route renders inside. Sidebar (team switcher), auth gate, and the
// Sync Inspector drawer attach here in later phases; for now it is just a header + outlet.
export function RootLayout() {
  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Text fw={700}>pgxsinkit board</Text>
          <Text size="sm" c="dimmed">
            offline-first sync demo
          </Text>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
