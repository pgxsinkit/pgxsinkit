import { Stack, Text, Title } from "@mantine/core";

// Placeholder landing. Phase 4 turns this into the team picker / first-team redirect.
export function HomeRoute() {
  return (
    <Stack gap="xs">
      <Title order={2}>Board demo</Title>
      <Text c="dimmed">
        Scaffold is up. The synced board, realtime chat, and the Sync Inspector arrive in the next phases.
      </Text>
    </Stack>
  );
}
