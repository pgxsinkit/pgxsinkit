import { eq } from "drizzle-orm";
import { useMemo } from "react";

import { channelTable, issueView, messageView, profileTable, teamTable } from "@pgxsinkit/board-schema";

import { useLiveDrizzleRows } from "./board-client";

// The read surface over the local PGlite store. Readonly tables (profile/team/channel) are read from
// their synced local tables; readwrite tables (issue/message) from their `_read_model` views (which
// merge the synced cache with the optimistic overlay — relevant once Phase 5 adds writes). Every query
// is already scoped: the store only holds the rows `board-sync` streamed for the signed-in identity.
//
// `useLiveDrizzleRows` returns rows keyed by the select's field names (the hook remaps PGlite's raw
// snake_case columns back to the builder keys — packages/react/remap-live-row). NB the `created_at_us`
// bigint column is declared `mode: "bigint"`, so its inferred type is `bigint`, but PGlite returns int8
// as a string at runtime — hence `Number(...)` coercion where it's formatted (features/chat).

export const STATUS_ORDER = ["backlog", "todo", "in_progress", "done"] as const;
export type IssueStatus = (typeof STATUS_ORDER)[number];
export const STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  done: "Done",
};

export const PRIORITY_META: Record<string, { label: string; color: string }> = {
  urgent: { label: "Urgent", color: "red" },
  high: { label: "High", color: "orange" },
  medium: { label: "Medium", color: "yellow" },
  low: { label: "Low", color: "blue" },
  none: { label: "None", color: "gray" },
};

export type ProfileRow = { id: string; displayName: string; avatarColor: string };
export type IssueRow = {
  id: string;
  teamId: string;
  title: string;
  status: string;
  priority: string;
  assigneeId: string | null;
};
export type ChannelRow = { id: string; teamId: string | null; kind: string; name: string };

export function useTeams() {
  const { rows, loading } = useLiveDrizzleRows(
    (client) =>
      client.drizzle.select({ id: teamTable.id, name: teamTable.name }).from(teamTable).orderBy(teamTable.name),
    [],
  );
  return { teams: rows, loading };
}

/** id → profile, for assignee/author rendering. Every authenticated identity syncs all profiles. */
export function useProfileMap(): Map<string, ProfileRow> {
  const { rows } = useLiveDrizzleRows(
    (client) =>
      client.drizzle
        .select({ id: profileTable.id, displayName: profileTable.displayName, avatarColor: profileTable.avatarColor })
        .from(profileTable),
    [],
  );
  return useMemo(() => {
    const map = new Map<string, ProfileRow>();
    for (const row of rows) map.set(row.id, row);
    return map;
  }, [rows]);
}

const issueColumns = {
  id: issueView.id,
  teamId: issueView.teamId,
  assigneeId: issueView.assigneeId,
  title: issueView.title,
  status: issueView.status,
  priority: issueView.priority,
} as const;

export function useTeamIssues(teamId: string) {
  const { rows, loading } = useLiveDrizzleRows(
    (client) => client.drizzle.select(issueColumns).from(issueView).where(eq(issueView.teamId, teamId)),
    [teamId],
  );
  return { issues: rows, loading };
}

/** Admin cross-team view: every Issue the store holds (an Admin syncs them all). */
export function useAllIssues() {
  const { rows, loading } = useLiveDrizzleRows((client) => client.drizzle.select(issueColumns).from(issueView), []);
  return { issues: rows, loading };
}

export function useChannels() {
  const { rows, loading } = useLiveDrizzleRows(
    (client) =>
      client.drizzle
        .select({ id: channelTable.id, teamId: channelTable.teamId, kind: channelTable.kind, name: channelTable.name })
        .from(channelTable)
        .orderBy(channelTable.kind, channelTable.name),
    [],
  );
  return { channels: rows, loading };
}

export function useChannelMessages(channelId: string) {
  const { rows, loading } = useLiveDrizzleRows(
    (client) =>
      client.drizzle
        .select({
          id: messageView.id,
          authorId: messageView.authorId,
          body: messageView.body,
          createdAtUs: messageView.createdAtUs,
        })
        .from(messageView)
        .where(eq(messageView.channelId, channelId))
        .orderBy(messageView.createdAtUs),
    [channelId],
  );
  return { messages: rows, loading };
}
