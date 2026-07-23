import { eq } from "drizzle-orm";
import { useMemo } from "react";

import {
  boardSyncRegistry,
  channelTable,
  issueTable,
  issueView,
  messageView,
  profileTable,
  teamMemberTable,
  teamTable,
} from "@pgxsinkit/board-schema";
import { getSyncStateView } from "@pgxsinkit/client";

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
//
// CONVENTION: every hook here returns `settled` — true once the live query has delivered its first
// snapshot AND any lazy relation it reads has completed its initial catch-up (`!loading && !hydrating`;
// the seam guarantees the catch-up rows arrive before `hydrating` clears). Until then, zero rows means
// "not loaded yet", NOT "empty" — so render definitive empty-state or membership copy ("No messages",
// "you're not a member") ONLY when `settled` is true; show a loader/skeleton otherwise. Every live query
// re-enters a brief unsettled window on mount (the first snapshot is an async round trip, worker mode
// especially), so this applies on every route/tab switch, not just cold boot.

// Keep-alive hint for the board's hot reads (pgxsinkit ADR-0040 decision 4). Five hooks opt into a 60s
// grace window after their last consumer unmounts: the two parameterized reads (useTeamIssues,
// useChannelMessages) re-materialize on EVERY channel/team switch, and the shell trio (useTeams,
// useProfileMap, useChannels) remounts on every board↔chat tab switch — so a 60s window makes the
// switch-back reuse the warm PGlite registration instantly instead of paying the hundreds-of-ms
// re-materialization the ADR measured. Bounded by the worker's count/row budgets, which are authoritative
// over any hint. The other hooks (memberships/server-values/convergence/all-issues) stay route-scoped
// (default keep-alive 0), torn down on unmount. One obvious knob, used in all five:
const HOT_QUERY_KEEP_ALIVE_MS = 60_000;

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
  const { rows, loading, hydrating } = useLiveDrizzleRows(
    (client) =>
      client.drizzle.select({ id: teamTable.id, name: teamTable.name }).from(teamTable).orderBy(teamTable.name),
    [],
    { keepAliveMs: HOT_QUERY_KEEP_ALIVE_MS },
  );
  return { teams: rows, settled: !loading && !hydrating };
}

/** id → profile, for assignee/author rendering. Every authenticated identity syncs all profiles. */
export function useProfileMap() {
  const { rows, loading, hydrating } = useLiveDrizzleRows(
    (client) =>
      client.drizzle
        .select({ id: profileTable.id, displayName: profileTable.displayName, avatarColor: profileTable.avatarColor })
        .from(profileTable),
    [],
    { keepAliveMs: HOT_QUERY_KEEP_ALIVE_MS },
  );
  const profiles = useMemo(() => {
    const map = new Map<string, ProfileRow>();
    for (const row of rows) map.set(row.id, row);
    return map;
  }, [rows]);
  return { profiles, settled: !loading && !hydrating };
}

export type MembershipRow = { id: string; teamId: string; userId: string };

/**
 * Every Team membership the store holds. The read path already scopes this to the signed-in identity
 * (a Member syncs the memberships of their own Teams; an Admin syncs all), so callers just group the
 * rows by `teamId` to build per-Team assignee lists — no extra filtering needed. The membership `id`
 * is the `team_member` PK, used by the Admin members page to remove a membership by key (Phase 7).
 *
 * Read from the **base synced table**, not the `_read_model` view: `team_member` is `readwrite` only in
 * the Admin (authoritative) registry; the Member registry consumes it via `asReadonly` and so has no
 * overlay-merged view (pgxsinkit ADR-0025). The base table exists in both, so this one hook serves both
 * roles. Trade-off: an Admin's optimistic add/remove appears here once the Electric echo lands (a
 * round-trip), not instantly — acceptable, and the optimistic surface is already shown by issues.
 */
export function useTeamMemberships() {
  const { rows, loading, hydrating } = useLiveDrizzleRows(
    (client) =>
      client.drizzle
        .select({ id: teamMemberTable.id, teamId: teamMemberTable.teamId, userId: teamMemberTable.userId })
        .from(teamMemberTable),
    [],
  );
  return { memberships: rows, settled: !loading && !hydrating };
}

/** Group memberships into `teamId → member profiles` (sorted) for the per-card assignee menu. */
export function buildAssignableByTeam(
  memberships: readonly MembershipRow[],
  profiles: Map<string, ProfileRow>,
): Map<string, ProfileRow[]> {
  const map = new Map<string, ProfileRow[]>();
  for (const { teamId, userId } of memberships) {
    const profile = profiles.get(userId);
    if (profile == null) continue;
    const list = map.get(teamId);
    if (list != null) list.push(profile);
    else map.set(teamId, [profile]);
  }
  for (const list of map.values()) list.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return map;
}

const issueColumns = {
  id: issueView.id,
  teamId: issueView.teamId,
  assigneeId: issueView.assigneeId,
  title: issueView.title,
  status: issueView.status,
  priority: issueView.priority,
} as const;

// Issues are ordered by title (id tiebreak for duplicates) — a DETERMINISTIC, edit-stable key. With no
// ORDER BY the render order was heap-scan order, and a Postgres UPDATE relocates the tuple — so every
// Electric echo (own writes ~1–3s later, other users' anytime) visibly shuffled cards within a column.
// Title only changes on an explicit rename, where an instant reorder is expected behaviour.
export function useTeamIssues(teamId: string) {
  const { rows, loading, hydrating } = useLiveDrizzleRows(
    (client) =>
      client.drizzle
        .select(issueColumns)
        .from(issueView)
        .where(eq(issueView.teamId, teamId))
        .orderBy(issueView.title, issueView.id),
    [teamId],
    { keepAliveMs: HOT_QUERY_KEEP_ALIVE_MS },
  );
  return { issues: rows, settled: !loading && !hydrating };
}

/** Admin cross-team view: every Issue the store holds (an Admin syncs them all). */
export function useAllIssues() {
  const { rows, loading, hydrating } = useLiveDrizzleRows(
    (client) => client.drizzle.select(issueColumns).from(issueView).orderBy(issueView.title, issueView.id),
    [],
  );
  return { issues: rows, settled: !loading && !hydrating };
}

export type ServerIssueValue = { status: string; assigneeId: string | null };

/**
 * The **server** value of every Issue, read straight from the synced base table (`issue`) — NOT the
 * `issue_read_model` view the board renders, which merges the optimistic overlay on top. The two
 * diverge exactly when a local write has not yet converged; the conflict surface shows this value as
 * "the server moved it to …" against the optimistic value still on the card (board Phase 6).
 */
export function useServerIssueValues() {
  const { rows, loading, hydrating } = useLiveDrizzleRows(
    (client) =>
      client.drizzle
        .select({ id: issueTable.id, status: issueTable.status, assigneeId: issueTable.assigneeId })
        .from(issueTable),
    [],
  );
  const serverValues = useMemo(() => {
    const map = new Map<string, ServerIssueValue>();
    for (const row of rows) map.set(row.id, { status: row.status, assigneeId: row.assigneeId });
    return map;
  }, [rows]);
  return { serverValues, settled: !loading && !hydrating };
}

export type IssueConvergence = {
  /** The reject-if-stale rejection reason while a write is `conflicted`, else null (ADR-0015). */
  conflictState: string | null;
  /** Retryable writes still owed to the server (pending/sending/failed) — drives the "syncing" dot. */
  pendingCount: number;
  /** Terminal writes the server permanently rejected (ADR-0006); surfaced in the Inspector (Phase 8). */
  quarantinedCount: number;
  quarantineState: string | null;
};

// The `issue_sync_state` view as a runtime Drizzle object (`getSyncStateView`): the entry's PK columns
// under their property keys + the fixed convergence columns. The PK column rides the index signature
// (dynamic by construction), hence the bracket access; `issue` always has an `id` PK.
const issueSyncState = getSyncStateView(boardSyncRegistry, "issue");
const issueSyncStateId = issueSyncState["id"]!;

/**
 * Per-Issue convergence state from the toolkit's derived `issue_sync_state` view (ADR-0011): one row
 * per Issue that has any local activity. A live Drizzle query over the toolkit's view object — the
 * board reads `conflictState` to surface reject-if-stale conflicts inline (Phase 6) and
 * `pendingCount`/`quarantinedCount` for the convergence dots + Inspector (Phase 8). The two counts are
 * int8 at runtime (PGlite returns them as strings), hence the `Number(...)` coercion.
 */
export function useIssueConvergence() {
  const { rows, loading, hydrating } = useLiveDrizzleRows(
    (client) =>
      client.drizzle
        .select({
          id: issueSyncStateId,
          conflictState: issueSyncState.conflictState,
          pendingCount: issueSyncState.pendingCount,
          quarantinedCount: issueSyncState.quarantinedCount,
          quarantineState: issueSyncState.quarantineState,
        })
        .from(issueSyncState),
    [],
  );
  const convergence = useMemo(() => {
    const map = new Map<string, IssueConvergence>();
    for (const row of rows) {
      map.set(String(row.id), {
        conflictState: row.conflictState,
        pendingCount: Number(row.pendingCount),
        quarantinedCount: Number(row.quarantinedCount),
        quarantineState: row.quarantineState,
      });
    }
    return map;
  }, [rows]);
  return { convergence, settled: !loading && !hydrating };
}

export function useChannels() {
  const { rows, loading, hydrating } = useLiveDrizzleRows(
    (client) =>
      client.drizzle
        .select({ id: channelTable.id, teamId: channelTable.teamId, kind: channelTable.kind, name: channelTable.name })
        .from(channelTable)
        .orderBy(channelTable.kind, channelTable.name),
    [],
    { keepAliveMs: HOT_QUERY_KEEP_ALIVE_MS },
  );
  return { channels: rows, settled: !loading && !hydrating };
}

export function useChannelMessages(channelId: string) {
  // Message is the board's `lazy` relation, so `settled` here also covers its activation + initial
  // catch-up (the seam delivers the caught-up rows before `hydrating` clears — rows-before-signal).
  const { rows, loading, hydrating } = useLiveDrizzleRows(
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
    // Honest trade-off (ADR-0040 decision 4): `message` is the board's write-hottest table, and a retained
    // zero-subscriber query cannot be paused — EVERY retained channel query reruns + diffs on ANY message
    // write, so a message in channel A also reruns retained channel B's query. Bounded by the 60s TTL + the
    // worker's count/row budgets, and deliberately dogfooding exactly the retention cost the ADR's
    // default-0 argument warns about — the switch-back win is worth it for a demo's channel flipping.
    { keepAliveMs: HOT_QUERY_KEEP_ALIVE_MS },
  );
  return { messages: rows, settled: !loading && !hydrating };
}
