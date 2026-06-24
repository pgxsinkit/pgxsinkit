import { sql } from "drizzle-orm";
import { pgPolicy, type PgRole } from "drizzle-orm/pg-core";

/**
 * Hand-authored board RLS (board ADR-0005). The board is collaborative — any Member may edit any
 * Issue in a Team they belong to — so it deliberately does NOT use
 * `buildSupabaseMembershipNativePolicies`, which gates writes to owner-or-manager. Three reused
 * predicates compose every policy: member-of-team, the channel-visibility two-hop, and the global
 * Admin bypass.
 *
 * Subject is `auth.uid()` (the JWT `sub`); Admin is `public.board_is_admin()` — both read
 * `request.jwt.claims`, which the Mutation applier sets before applying a batch. These run on the
 * **write path** (Postgres-with-JWT). The **read path** filters the same way but over the literal
 * claim value (`escapeSqlLiteral(claims.sub)`) in the proxy `customWhere` (registry.ts), because
 * Electric runs that `where`, not Postgres — keep the two in sync.
 *
 * `board_is_admin()` and the cross-team-move trigger ship in the board migration (server authority,
 * never local — the Parity boundary).
 */

const ADMIN = "public.board_is_admin()";

type Command = "select" | "insert" | "update" | "delete";

/** `<teamColumn> IN (the teams the caller belongs to)`. */
function memberOfTeam(teamColumn: string): string {
  return `${teamColumn} IN (SELECT team_id FROM team_member WHERE user_id = auth.uid())`;
}

function policy(
  name: string,
  command: Command,
  role: PgRole,
  predicate: string,
  parts: { using?: boolean; withCheck?: boolean },
) {
  return pgPolicy(name, {
    as: "permissive",
    for: command,
    to: role,
    ...(parts.using ? { using: sql.raw(predicate) } : {}),
    ...(parts.withCheck ? { withCheck: sql.raw(predicate) } : {}),
  });
}

/**
 * Issue: any Member of the Issue's Team may read and write it; an Admin may do so on any Team.
 * Cross-team move (changing `team_id`) is blocked for non-Admins by the `BEFORE UPDATE` trigger in
 * the board migration — an RLS policy cannot compare `OLD.team_id` to `NEW.team_id`.
 */
export function buildIssuePolicies(role: PgRole) {
  const memberOrAdmin = `(${memberOfTeam("team_id")}) OR ${ADMIN}`;
  return [
    policy("issue_select", "select", role, memberOrAdmin, { using: true }),
    policy("issue_insert", "insert", role, memberOrAdmin, { withCheck: true }),
    policy("issue_update", "update", role, memberOrAdmin, { using: true, withCheck: true }),
    policy("issue_delete", "delete", role, memberOrAdmin, { using: true }),
  ];
}

/** team_member: a Member sees co-members of their Teams; only an Admin may add/remove members. */
export function buildTeamMemberPolicies(role: PgRole) {
  const memberOrAdmin = `(${memberOfTeam("team_id")}) OR ${ADMIN}`;
  return [
    policy("team_member_select", "select", role, memberOrAdmin, { using: true }),
    policy("team_member_insert", "insert", role, ADMIN, { withCheck: true }),
    policy("team_member_update", "update", role, ADMIN, { using: true, withCheck: true }),
    policy("team_member_delete", "delete", role, ADMIN, { using: true }),
  ];
}

/**
 * Message: readable/writable in a global Channel or a Channel of one of your Teams (the two-hop
 * `message → channel → team` container); you may edit/delete only your own Message; Admin moderates.
 */
export function buildMessagePolicies(role: PgRole) {
  const channelVisible = `channel_id IN (SELECT id FROM channel WHERE kind = 'global' OR ${memberOfTeam("team_id")})`;
  const visibleOrAdmin = `(${channelVisible}) OR ${ADMIN}`;
  const authorOrAdmin = `author_id = auth.uid() OR ${ADMIN}`;
  return [
    policy("message_select", "select", role, visibleOrAdmin, { using: true }),
    policy("message_insert", "insert", role, visibleOrAdmin, { withCheck: true }),
    policy("message_update", "update", role, authorOrAdmin, { using: true, withCheck: true }),
    policy("message_delete", "delete", role, authorOrAdmin, { using: true }),
  ];
}
