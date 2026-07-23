import { sql, type SQL } from "drizzle-orm";
import { bigint, pgEnum, uuid, varchar } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { c, clockMicrosecondsSql, defineSyncTable, DENY_ALL, type JwtClaims } from "@pgxsinkit/contracts";

import {
  buildChannelPolicies,
  buildIssuePolicies,
  buildMessagePolicies,
  buildProfilePolicies,
  buildTeamMemberPolicies,
  buildTeamPolicies,
} from "./policies";

export const issueStatusEnum = pgEnum("issue_status", ["backlog", "todo", "in_progress", "done"]);
export const issuePriorityEnum = pgEnum("issue_priority", ["none", "urgent", "high", "medium", "low"]);
export const channelKindEnum = pgEnum("channel_kind", ["global", "team"]);

// Tables grouped here commit atomically at a shared LSN frontier (board ADR-0004), so a member who is
// added to a Team sees the Team, its Channel, and its Issues appear in one frame — no broken-join flicker.
const TEAM_SCOPE = "team-scope";

function isAdmin(claims: JwtClaims): boolean {
  return claims.app_metadata?.roles?.includes("admin") ?? false;
}

// This closes over the resolved membership entry but runs only when a request is filtered, after every
// entry below has been initialized.
function memberTeams(sub: string): SQL {
  return sql`select ${c(teamMemberSyncEntry.table.teamId)} from ${teamMemberSyncEntry.table} where ${c(teamMemberSyncEntry.table.userId)} = ${sub}`;
}

const MS_PER_DAY = 86_400_000;
const CHAT_WINDOW_DAYS = 21;
function memberChatWindowCutoffMicros(): bigint {
  const startOfTodayMs = Math.floor(Date.now() / MS_PER_DAY) * MS_PER_DAY;
  return BigInt(startOfTodayMs - CHAT_WINDOW_DAYS * MS_PER_DAY) * 1000n;
}

// profile — readonly, synced to everyone (renders assignees + message authors). id = Supabase auth user id.
// SELECT-only RLS: visible to any authenticated identity, no client writes.
const profileSyncEntry = defineSyncTable({
  tableName: "profile",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    avatarColor: varchar("avatar_color", { length: 24 }).notNull().default("indigo"),
  }),
  policies: buildProfilePolicies(authenticatedRole),
  mode: "readonly",
  shape: {
    rowFilter: () => ({ customWhere: (claims): SQL | null => (claims.sub ? null : DENY_ALL) }),
  },
});

// team — readwrite, Admin-only writes (pgxsinkit ADR-0025 showcase). Members read their Teams (Admin
// reads all) but cannot mutate — only an Admin may rename a Team, and the rename fans out to every
// member's board live. The member client consumes this entry via `asReadonly` (registry.ts), so it
// provisions no overlay/journal and exposes no write handle. updatedAtUs is the Server version
// optimistic convergence keys on.
const teamSyncEntry = defineSyncTable({
  tableName: "team",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
  }),
  extras: (t) => buildTeamPolicies(authenticatedRole, t.id),
  mode: "readwrite",
  conflictPolicy: "reject-if-stale",
  consistencyGroup: TEAM_SCOPE,
  shape: {
    rowFilter: (columns) => ({
      customWhere: (claims): SQL | null => {
        if (isAdmin(claims)) return null;
        if (!claims.sub) return DENY_ALL;
        return sql`${c(columns.id)} in (${memberTeams(claims.sub)})`;
      },
    }),
  },
  governance: {
    managedFields: [
      { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
    ],
  },
});

// team_member — readwrite, Admin-only writes. Adding/removing a member is the live fan-out showcase.
const teamMemberSyncEntry = defineSyncTable({
  tableName: "team_member",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teamSyncEntry.table.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => profileSyncEntry.table.id),
    createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
  }),
  extras: (t) => buildTeamMemberPolicies(authenticatedRole, t.teamId),
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  consistencyGroup: TEAM_SCOPE,
  shape: {
    rowFilter: (columns) => ({
      customWhere: (claims): SQL | null => {
        if (isAdmin(claims)) return null;
        if (!claims.sub) return DENY_ALL;
        return sql`${c(columns.teamId)} in (${memberTeams(claims.sub)})`;
      },
    }),
  },
  governance: {
    managedFields: [
      { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
    ],
  },
});

// channel — readonly, seeded. One global Channel (team_id null) plus one per Team. SELECT-only RLS:
// readable when global or in one of your Teams (Admin reads all), no writes.
const channelSyncEntry = defineSyncTable({
  tableName: "channel",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    teamId: uuid("team_id").references(() => teamSyncEntry.table.id),
    kind: channelKindEnum("kind").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
  }),
  extras: (t) => buildChannelPolicies(authenticatedRole, t.kind, t.teamId),
  mode: "readonly",
  consistencyGroup: TEAM_SCOPE,
  shape: {
    rowFilter: (columns) => ({
      customWhere: (claims): SQL | null => {
        if (isAdmin(claims)) return null;
        if (!claims.sub) return DENY_ALL;
        return sql`${c(columns.kind)}::text = 'global' or ${c(columns.teamId)} in (${memberTeams(claims.sub)})`;
      },
    }),
  },
});

// message — readwrite, last-write-wins (append-mostly; each insert has its own PK so inserts never
// collide). Chat is the ADR-0021 × ADR-0025 lifecycle showcase, split across two axes:
//   - `lazy` (both roles) — its shape is held out of the boot set and subscribes on first reference
//     (opening a Channel), so the board's other shapes own the HTTP/2 connection budget at startup.
//   - retention is **per-client** (registry.ts). The authoritative/Admin entry is `persistent` (the
//     default), so for the Admin chat is `lazy + persistent` — a deferred-activation durable table that,
//     on first channel-open, *permanently promotes* itself to the eager set (a persisted activation
//     flag) and resumes full history like any durable shape on later boots. The Member registry projects
//     this entry through `asEphemeral`, so for a Member chat is `lazy + ephemeral` — its whole local
//     cluster (read cache, overlay, journal, views) is emitted as `TEMP`, leaving no durable trace and
//     re-hydrating fresh each session. Same rows (modulo the Member read-window), different durability —
//     exactly what a per-client projection may legitimately differ on.
// `message` is its own singleton consistency group (no `consistencyGroup`), so these lifecycle axes apply
// to it alone (no whole-group flip needed for the projection). Trade-off (ADR-0021/0022): the ephemeral
// Member has no durable offline write queue — a message posted while online flushes immediately; one
// staged offline does not survive a session end (acceptable for chat; the durable offline-write story is
// shown by issues). The persistent Admin keeps a durable queue.
const messageSyncEntry = defineSyncTable({
  tableName: "message",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channelSyncEntry.table.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => profileSyncEntry.table.id),
    body: varchar("body", { length: 4000 }).notNull(),
    createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
  }),
  extras: (t) => buildMessagePolicies(authenticatedRole, t.channelId, t.authorId, channelSyncEntry.table),
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  // `lazy` for both roles; the authoritative entry is `persistent` (Admin), projected `ephemeral` for the
  // Member in registry.ts. See the block comment above.
  subscription: "lazy",
  shape: {
    rowFilter: (columns) => ({
      customWhere: (claims): SQL | null => {
        if (isAdmin(claims)) return null;
        if (!claims.sub) return DENY_ALL;
        const channel = channelSyncEntry.table;
        const visibleChannels = sql`select ${c(channel.id)} from ${channel} where ${c(channel.kind)}::text = 'global' or ${c(channel.teamId)} in (${memberTeams(claims.sub)})`;
        return sql`${c(columns.channelId)} in (${visibleChannels}) and ${c(columns.createdAtUs)} >= ${memberChatWindowCutoffMicros()}`;
      },
    }),
  },
  governance: {
    managedFields: [
      { column: "authorId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
      { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
    ],
  },
});

// issue — readwrite, reject-if-stale (the headline conflict surface). Cross-team move is Admin-only
// (board ADR-0005 trigger). assignee/createdBy reference profile (= auth user).
const issueSyncEntry = defineSyncTable({
  tableName: "issue",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teamSyncEntry.table.id),
    assigneeId: uuid("assignee_id").references(() => profileSyncEntry.table.id),
    title: varchar("title", { length: 200 }).notNull(),
    description: varchar("description", { length: 4000 }),
    status: issueStatusEnum("status").notNull().default("todo"),
    priority: issuePriorityEnum("priority").notNull().default("none"),
    createdBy: uuid("created_by").references(() => profileSyncEntry.table.id),
    createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
  }),
  extras: (t) => buildIssuePolicies(authenticatedRole, t.teamId),
  mode: "readwrite",
  conflictPolicy: "reject-if-stale",
  consistencyGroup: TEAM_SCOPE,
  shape: {
    rowFilter: (columns) => ({
      customWhere: (claims): SQL | null => {
        if (isAdmin(claims)) return null;
        if (!claims.sub) return DENY_ALL;
        return sql`${c(columns.teamId)} in (${memberTeams(claims.sub)})`;
      },
    }),
  },
  governance: {
    managedFields: [
      { column: "createdBy", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
      { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
    ],
  },
});

export const profileTable = profileSyncEntry.table;
export const teamTable = teamSyncEntry.table;
export const teamMemberTable = teamMemberSyncEntry.table;
export const channelTable = channelSyncEntry.table;
export const messageTable = messageSyncEntry.table;
export const issueTable = issueSyncEntry.table;

export const teamMemberView = teamMemberSyncEntry.view!;
export const messageView = messageSyncEntry.view!;
export const issueView = issueSyncEntry.view!;

export { channelSyncEntry, issueSyncEntry, messageSyncEntry, profileSyncEntry, teamMemberSyncEntry, teamSyncEntry };
