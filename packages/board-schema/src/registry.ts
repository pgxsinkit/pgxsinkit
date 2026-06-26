import { sql, type SQL } from "drizzle-orm";

import { c, defineSyncRegistry, DENY_ALL, type JwtClaims } from "@pgxsinkit/contracts";

import {
  channelSyncEntry,
  issueSyncEntry,
  messageSyncEntry,
  profileSyncEntry,
  teamMemberSyncEntry,
  teamSyncEntry,
} from "./schema";

const team = teamSyncEntry.table;
const teamMember = teamMemberSyncEntry.table;
const channel = channelSyncEntry.table;
const issue = issueSyncEntry.table;
const message = messageSyncEntry.table;

function isAdmin(claims: JwtClaims): boolean {
  return claims.app_metadata?.roles?.includes("admin") ?? false;
}

// The read-path twin of the RLS `memberOfTeam` predicate (policies.ts), but over the literal claim:
// Electric runs this `where`, not Postgres, so there is no `auth.uid()` here. Built from the real
// Drizzle columns — bare via `c()` (Electric's where-grammar needs plain, unqualified refs) with the
// subject as a bound param (`$1`), never a hand-escaped literal. enum columns must be cast to text
// (Electric's grammar) — see `channelReadFilter`.
function memberTeams(sub: string) {
  return sql`select ${c(teamMember.teamId)} from ${teamMember} where ${c(teamMember.userId)} = ${sub}`;
}

// Every authenticated user syncs all profiles (to render any author/assignee); nobody otherwise.
function profileReadFilter(claims: JwtClaims): SQL | null {
  return claims.sub ? null : DENY_ALL;
}

function teamReadFilter(claims: JwtClaims) {
  if (isAdmin(claims)) return null;
  if (!claims.sub) return DENY_ALL;
  return sql`${c(team.id)} in (${memberTeams(claims.sub)})`;
}

function teamMemberReadFilter(claims: JwtClaims) {
  if (isAdmin(claims)) return null;
  if (!claims.sub) return DENY_ALL;
  // Fan-out: you sync every membership of your Teams, so you can see your co-members (assignee lists).
  return sql`${c(teamMember.teamId)} in (${memberTeams(claims.sub)})`;
}

function channelReadFilter(claims: JwtClaims) {
  if (isAdmin(claims)) return null;
  if (!claims.sub) return DENY_ALL;
  return sql`${c(channel.kind)}::text = 'global' or ${c(channel.teamId)} in (${memberTeams(claims.sub)})`;
}

function issueReadFilter(claims: JwtClaims) {
  if (isAdmin(claims)) return null;
  if (!claims.sub) return DENY_ALL;
  return sql`${c(issue.teamId)} in (${memberTeams(claims.sub)})`;
}

function messageReadFilter(claims: JwtClaims) {
  if (isAdmin(claims)) return null;
  if (!claims.sub) return DENY_ALL;
  const visibleChannels = sql`select ${c(channel.id)} from ${channel} where ${c(channel.kind)}::text = 'global' or ${c(channel.teamId)} in (${memberTeams(claims.sub)})`;
  return sql`${c(message.channelId)} in (${visibleChannels})`;
}

/**
 * The board sync registry — the single contract the client, the `board-sync` proxy, and the
 * `board-write` API all consume. Each entry carries its read-path `customWhere` (applied by the
 * proxy); the write-path RLS lives on the tables (schema.ts / policies.ts). The two are deliberate
 * mirrors: read filters and write policies derive from the same member-of-team / channel-visibility /
 * admin predicates so a row can never be visible-but-unwritable or vice versa by accident.
 */
export const boardSyncRegistry = defineSyncRegistry({
  profile: {
    ...profileSyncEntry,
    shape: { ...profileSyncEntry.shape!, rowFilter: { customWhere: profileReadFilter } },
  },
  team: {
    ...teamSyncEntry,
    shape: { ...teamSyncEntry.shape!, rowFilter: { customWhere: teamReadFilter } },
  },
  team_member: {
    ...teamMemberSyncEntry,
    shape: { ...teamMemberSyncEntry.shape!, rowFilter: { customWhere: teamMemberReadFilter } },
  },
  channel: {
    ...channelSyncEntry,
    shape: { ...channelSyncEntry.shape!, rowFilter: { customWhere: channelReadFilter } },
  },
  issue: {
    ...issueSyncEntry,
    shape: { ...issueSyncEntry.shape!, rowFilter: { customWhere: issueReadFilter } },
  },
  message: {
    ...messageSyncEntry,
    shape: { ...messageSyncEntry.shape!, rowFilter: { customWhere: messageReadFilter } },
  },
});
