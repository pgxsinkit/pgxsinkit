import { Avatar, Badge, Group, NavLink, Paper, ScrollArea, Stack, Text } from "@mantine/core";
import { useState } from "react";

import { type ChannelRow, useChannelMessages, useChannels, useProfileMap, type ProfileRow } from "../data";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function formatTime(createdAtUs: bigint | string): string {
  // Microseconds since epoch → ms. Declared `bigint` (column mode), returned as a string by PGlite;
  // `Number(...)` handles both.
  return new Date(Number(createdAtUs) / 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MessageRowView({
  authorId,
  body,
  createdAtUs,
  profiles,
}: {
  authorId: string;
  body: string;
  createdAtUs: bigint | string;
  profiles: Map<string, ProfileRow>;
}) {
  const author = profiles.get(authorId);
  return (
    <Group align="flex-start" gap="sm" wrap="nowrap">
      <Avatar size="sm" radius="xl" color={author?.avatarColor ?? "gray"}>
        {author != null ? initials(author.displayName) : "?"}
      </Avatar>
      <div style={{ minWidth: 0 }}>
        <Group gap="xs">
          <Text size="sm" fw={600}>
            {author?.displayName ?? "Unknown"}
          </Text>
          <Text size="xs" c="dimmed">
            {formatTime(createdAtUs)}
          </Text>
        </Group>
        <Text size="sm">{body}</Text>
      </div>
    </Group>
  );
}

function ChannelMessages({ channelId, profiles }: { channelId: string; profiles: Map<string, ProfileRow> }) {
  const { messages, loading } = useChannelMessages(channelId);
  if (loading && messages.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        Loading…
      </Text>
    );
  }
  if (messages.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No messages in this channel yet.
      </Text>
    );
  }
  return (
    <ScrollArea.Autosize mah="62vh">
      <Stack gap="md" pr="sm">
        {messages.map((message) => (
          <MessageRowView
            key={message.id}
            authorId={message.authorId}
            body={message.body}
            createdAtUs={message.createdAtUs}
            profiles={profiles}
          />
        ))}
      </Stack>
    </ScrollArea.Autosize>
  );
}

// Read-only chat for a Team: the global Channel plus this Team's Channel (the only Channels visible to
// a member here). Writing messages arrives in Phase 7.
export function ChatView({ teamId }: { teamId: string }) {
  const { channels } = useChannels();
  const profiles = useProfileMap();
  const [activeId, setActiveId] = useState<string | null>(null);

  const visible: ChannelRow[] = channels.filter((channel) => channel.kind === "global" || channel.teamId === teamId);
  const active =
    activeId != null && visible.some((channel) => channel.id === activeId) ? activeId : (visible[0]?.id ?? null);

  return (
    <Group align="flex-start" gap="lg" wrap="nowrap">
      <Stack gap={4} miw={200} w={200}>
        <Text size="xs" tt="uppercase" c="dimmed" fw={600} px={4}>
          Channels
        </Text>
        {visible.map((channel) => (
          <NavLink
            key={channel.id}
            active={channel.id === active}
            label={channel.name}
            leftSection={
              <Badge size="xs" variant="light" color={channel.kind === "global" ? "blue" : "grape"}>
                {channel.kind === "global" ? "all" : "team"}
              </Badge>
            }
            onClick={() => setActiveId(channel.id)}
          />
        ))}
      </Stack>
      <Paper withBorder p="md" radius="md" style={{ flex: 1, minWidth: 0 }}>
        {active != null ? (
          <ChannelMessages channelId={active} profiles={profiles} />
        ) : (
          <Text size="sm" c="dimmed">
            No channels.
          </Text>
        )}
      </Paper>
    </Group>
  );
}
