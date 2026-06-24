import { defineSyncRegistry, escapeSqlLiteral, type JwtClaims } from "@pgxsinkit/contracts";

import {
  channelSyncEntry,
  issueSyncEntry,
  messageSyncEntry,
  profileSyncEntry,
  teamMemberSyncEntry,
  teamSyncEntry,
} from "./schema";

function isAdmin(claims: JwtClaims): boolean {
  return claims.app_metadata?.roles?.includes("admin") ?? false;
}

// The read-path twin of the RLS `memberOfTeam` predicate (policies.ts), but over the literal claim:
// Electric runs this `where`, not Postgres, so there is no `auth.uid()` here. enum columns referenced
// in a shape `where` must be cast to text (Electric's grammar) — see `channelReadFilter`.
function memberTeamsSubquery(sub: string): string {
  return `SELECT "team_id" FROM "team_member" WHERE "user_id" = '${escapeSqlLiteral(sub)}'`;
}

// Every authenticated user syncs all profiles (to render any author/assignee); nobody otherwise.
function profileReadFilter(claims: JwtClaims): string | null {
  return claims.sub ? null : "1 = 0";
}

function teamReadFilter(claims: JwtClaims): string | null {
  if (isAdmin(claims)) return null;
  if (!claims.sub) return "1 = 0";
  return `"id" IN (${memberTeamsSubquery(claims.sub)})`;
}

function teamMemberReadFilter(claims: JwtClaims): string | null {
  if (isAdmin(claims)) return null;
  if (!claims.sub) return "1 = 0";
  // Fan-out: you sync every membership of your Teams, so you can see your co-members (assignee lists).
  return `"team_id" IN (${memberTeamsSubquery(claims.sub)})`;
}

function channelReadFilter(claims: JwtClaims): string | null {
  if (isAdmin(claims)) return null;
  if (!claims.sub) return "1 = 0";
  return `"kind"::text = 'global' OR "team_id" IN (${memberTeamsSubquery(claims.sub)})`;
}

function issueReadFilter(claims: JwtClaims): string | null {
  if (isAdmin(claims)) return null;
  if (!claims.sub) return "1 = 0";
  return `"team_id" IN (${memberTeamsSubquery(claims.sub)})`;
}

function messageReadFilter(claims: JwtClaims): string | null {
  if (isAdmin(claims)) return null;
  if (!claims.sub) return "1 = 0";
  return `"channel_id" IN (SELECT "id" FROM "channel" WHERE "kind"::text = 'global' OR "team_id" IN (${memberTeamsSubquery(
    claims.sub,
  )}))`;
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
