import { Avatar, Badge, Button, Group, NavLink, Paper, ScrollArea, Stack, Text, Textarea } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { useMessageActions } from "../chat/use-message-actions";
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
  const { messages, settled } = useChannelMessages(channelId);
  const viewportRef = useRef<HTMLDivElement>(null);

  // Keep the thread pinned to the newest message — on initial load and whenever a message arrives
  // (an optimistic local post or a fan-out from another window). Length is the cheap, sufficient signal.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport != null) viewport.scrollTo({ top: viewport.scrollHeight });
  }, [messages.length]);

  // Message is lazy: `settled` covers its activation + initial sync (data.ts convention), so "no
  // messages" is only ever claimed once the channel has genuinely synced empty.
  if (!settled && messages.length === 0) {
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
    <ScrollArea.Autosize mah="56vh" viewportRef={viewportRef}>
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

// Compose box pinned under the thread. Posts an optimistic Message into the active Channel (board
// Phase 7); the local thread re-renders this frame and the post fans out to every other Channel member
// on the next Electric live cycle. Enter sends, Shift+Enter inserts a newline. Mounted with a
// `key={channelId}` by the parent, so switching Channels starts a fresh draft.
function MessageComposer({ channelId, channelName }: { channelId: string; channelName: string }) {
  const actions = useMessageActions();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const send = useCallback(async () => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || sending) return;
    setSending(true);
    try {
      await actions.post(channelId, trimmed);
      setBody("");
    } finally {
      setSending(false);
    }
  }, [actions, body, channelId, sending]);

  return (
    <Group align="flex-end" gap="sm" wrap="nowrap" mt="md">
      <Textarea
        flex={1}
        autosize
        minRows={1}
        maxRows={6}
        radius="md"
        placeholder={`Message ${channelName}`}
        aria-label={`Message ${channelName}`}
        value={body}
        onChange={(event) => setBody(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <Button onClick={() => void send()} disabled={body.trim().length === 0} loading={sending}>
        Send
      </Button>
    </Group>
  );
}

// Chat for a Team: the global Channel plus this Team's Channel (the only Channels visible to a member
// here). Each Channel is read live from the local store and writable via the composer (Phase 7).
export function ChatView({ teamId }: { teamId: string }) {
  const { channels, settled } = useChannels();
  const { profiles } = useProfileMap();
  const [activeId, setActiveId] = useState<string | null>(null);

  const visible: ChannelRow[] = channels.filter((channel) => channel.kind === "global" || channel.teamId === teamId);
  const active =
    activeId != null && visible.some((channel) => channel.id === activeId) ? activeId : (visible[0]?.id ?? null);
  const activeChannel = visible.find((channel) => channel.id === active) ?? null;

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
      <Paper withBorder p="md" radius="md" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {active != null && activeChannel != null ? (
          <>
            <ChannelMessages channelId={active} profiles={profiles} />
            <MessageComposer key={active} channelId={active} channelName={activeChannel.name} />
          </>
        ) : (
          <Text size="sm" c="dimmed">
            {settled ? "No channels." : "Loading…"}
          </Text>
        )}
      </Paper>
    </Group>
  );
}
