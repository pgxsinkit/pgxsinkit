import { Card, Group, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { issueView, messageView } from "@pgxsinkit/board-schema";

import { useAuth } from "../auth/auth";
import { useLiveDrizzleRows } from "../board-client";

function StatCard({ label, value, loading }: { label: string; value: number; loading: boolean }) {
  return (
    <Card withBorder padding="md" radius="md" miw={150}>
      <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
        {label}
      </Text>
      <Text fz={32} fw={700} lh={1.1}>
        {loading ? "…" : value}
      </Text>
    </Card>
  );
}

// Phase 3 landing: proof that login → real session → local PGlite boot → initial sync works, scoped to
// the signed-in identity. The counts are live reads of the local store, so they climb as `board-sync`
// streams rows in. Phase 4 replaces this with the actual board surface.
export function HomeRoute() {
  const { session } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!session) void navigate({ to: "/login" });
  }, [session, navigate]);

  const issues = useLiveDrizzleRows((client) => client.drizzle.select().from(issueView), []);
  const messages = useLiveDrizzleRows((client) => client.drizzle.select().from(messageView), []);

  if (!session) return null;

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>You&apos;re synced</Title>
        <Text c="dimmed">
          Your browser&apos;s local database holds exactly the Issues and Channels you&apos;re allowed to see — streamed
          in over Electric and filtered by the read path. The board, realtime chat, and the Sync Inspector arrive in the
          next phases.
        </Text>
      </div>
      <Group>
        <StatCard label="Issues synced" value={issues.rows.length} loading={issues.loading} />
        <StatCard label="Messages synced" value={messages.rows.length} loading={messages.loading} />
      </Group>
    </Stack>
  );
}
