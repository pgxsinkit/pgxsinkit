import { sql } from "drizzle-orm";
import { bigint, pgEnum, uuid, varchar } from "drizzle-orm/pg-core";
import { authenticatedRole } from "drizzle-orm/supabase";

import { defineSyncTable } from "@pgxsinkit/contracts";

import { buildIssuePolicies, buildMessagePolicies, buildTeamMemberPolicies } from "./policies";

export const issueStatusEnum = pgEnum("issue_status", ["backlog", "todo", "in_progress", "done"]);
export const issuePriorityEnum = pgEnum("issue_priority", ["none", "urgent", "high", "medium", "low"]);
export const channelKindEnum = pgEnum("channel_kind", ["global", "team"]);

// Canonical microsecond timestamp (bigint), server-stamped. Doubles as the Server version on
// writable tables via the nowMicroseconds-on-update managed field.
const nowMicrosecondsSql = sql`CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000) AS BIGINT)`;

// Tables grouped here commit atomically at a shared LSN frontier (board ADR-0004), so a member who is
// added to a Team sees the Team, its Channel, and its Issues appear in one frame — no broken-join flicker.
const TEAM_SCOPE = "team-scope";

// profile — readonly, synced to everyone (renders assignees + message authors). id = Supabase auth user id.
const profileSyncEntry = defineSyncTable({
  tableName: "profile",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    avatarColor: varchar("avatar_color", { length: 24 }).notNull().default("indigo"),
  }),
  mode: "readonly",
});

// team — readonly, seeded.
const teamSyncEntry = defineSyncTable({
  tableName: "team",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  }),
  mode: "readonly",
  consistencyGroup: TEAM_SCOPE,
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
    createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  }),
  policies: buildTeamMemberPolicies(authenticatedRole),
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  consistencyGroup: TEAM_SCOPE,
  governance: {
    managedFields: [
      { column: "createdAtUs", applyOn: ["create"], strategy: "nowMicroseconds" },
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
    ],
  },
});

// channel — readonly, seeded. One global Channel (team_id null) plus one per Team.
const channelSyncEntry = defineSyncTable({
  tableName: "channel",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    teamId: uuid("team_id").references(() => teamSyncEntry.table.id),
    kind: channelKindEnum("kind").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  }),
  mode: "readonly",
  consistencyGroup: TEAM_SCOPE,
});

// message — readwrite, last-write-wins (append-mostly; each insert has its own PK so inserts never collide).
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
    createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  }),
  policies: buildMessagePolicies(authenticatedRole),
  mode: "readwrite",
  conflictPolicy: "last-write-wins",
  governance: {
    managedFields: [
      { column: "authorId", applyOn: ["create"], strategy: "authUid" },
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
    createdAtUs: bigint("created_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicrosecondsSql),
  }),
  policies: buildIssuePolicies(authenticatedRole),
  mode: "readwrite",
  conflictPolicy: "reject-if-stale",
  consistencyGroup: TEAM_SCOPE,
  governance: {
    managedFields: [
      { column: "createdBy", applyOn: ["create"], strategy: "authUid" },
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
