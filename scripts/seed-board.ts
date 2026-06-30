import { drizzle } from "drizzle-orm/bun-sql";
import { reset, seed } from "drizzle-seed";

import {
  channelTable,
  issueTable,
  messageTable,
  profileTable,
  teamMemberTable,
  teamTable,
} from "@pgxsinkit/board-schema";

// Two-phase board seed (board ADR-0002, plan Phase 3).
//   1. Create the fixture identities through the **GoTrue admin API** — real users, one shared dev
//      password, `app_metadata.roles: ["admin"]` on the Admin — and resolve email → auth id.
//   2. Reset + seed the public tables as the privileged `postgres` role (BYPASSRLS), so the running
//      write path is never involved:
//        - a **deterministic structural fixture** (profiles/teams/memberships/channels, keyed by the
//          stable user/team keys) so the login scenarios are reproducible across resets;
//        - a **drizzle-seed bulk filler** for the high-volume tables (issues across status/priority,
//          a chat backlog per channel), seeded per-team / per-channel so every generated FK is valid.
//
// drizzle-seed is version-locked to drizzle-orm at the unified `1.0.0-rc.2` tag (the whole drizzle
// suite releases as one version, like this repo's own standard). `f.int` takes bigint bounds, so the
// microsecond Server-version columns generate as real bigints.

// ── config (demo defaults mirror infra/compose/board.env) ────────────────────────────────────────
const GATEWAY_URL = process.env["BOARD_GATEWAY_URL"] ?? "http://localhost:54331";
// The new opaque SECRET key (board ADR-0007). Sent as `apikey` + bearer to the GoTrue admin API; the
// gateway (Envoy locally, the platform on Cloud) translates it into the internal service_role JWT the
// admin endpoint accepts. On Cloud, set BOARD_SECRET_KEY to the project's `sb_secret_…` key.
const SECRET_KEY = process.env["BOARD_SECRET_KEY"] ?? "sb_secret_boarddemoLOCALxxxxxxxxxxxxxxx_demo0000";
const DATABASE_URL =
  process.env["BOARD_DATABASE_URL"] ??
  "postgresql://postgres:your-super-secret-and-long-postgres-password@localhost:54322/postgres?sslmode=disable";
// One shared, well-known dev password for every fixture identity — the /login screen signs in with it.
const SEED_PASSWORD = process.env["BOARD_SEED_PASSWORD"] ?? "board-demo-password";

// ── fixtures (deterministic; keyed so scenarios stay reproducible across resets) ──────────────────
interface UserFixture {
  key: string;
  email: string;
  displayName: string;
  avatarColor: string;
  admin?: boolean;
}

const USERS: readonly UserFixture[] = [
  { key: "alice", email: "alice@board.local", displayName: "Alice Okafor", avatarColor: "grape" },
  { key: "bob", email: "bob@board.local", displayName: "Bob Nilsson", avatarColor: "blue" },
  { key: "carol", email: "carol@board.local", displayName: "Carol Mensah", avatarColor: "teal" },
  { key: "dave", email: "dave@board.local", displayName: "Dave Ibarra", avatarColor: "green" },
  { key: "erin", email: "erin@board.local", displayName: "Erin Flores", avatarColor: "orange" },
  { key: "frank", email: "frank@board.local", displayName: "Frank Petrov", avatarColor: "cyan" },
  { key: "grace", email: "grace@board.local", displayName: "Grace Lindqvist", avatarColor: "pink" },
  { key: "heidi", email: "heidi@board.local", displayName: "Heidi Park", avatarColor: "violet" },
  { key: "admin", email: "admin@board.local", displayName: "Admin", avatarColor: "dark", admin: true },
];

interface TeamFixture {
  key: string;
  id: string;
  name: string;
  issueCount: number;
}

const TEAMS: readonly TeamFixture[] = [
  { key: "platform", id: "00000000-0000-4000-8000-0000000000a1", name: "Platform", issueCount: 14 },
  { key: "growth", id: "00000000-0000-4000-8000-0000000000a2", name: "Growth", issueCount: 11 },
  { key: "design", id: "00000000-0000-4000-8000-0000000000a3", name: "Design", issueCount: 9 },
];

// Alice spans Platform + Growth — the multi-team identity the cross-team-move demo (ADR-0005) needs.
const MEMBERSHIPS: ReadonlyArray<readonly [teamKey: string, userKey: string]> = [
  ["platform", "alice"],
  ["platform", "bob"],
  ["platform", "carol"],
  ["growth", "alice"],
  ["growth", "dave"],
  ["growth", "erin"],
  ["design", "frank"],
  ["design", "grace"],
  ["design", "heidi"],
];

interface ChannelFixture {
  id: string;
  teamKey: string | null;
  kind: "global" | "team";
  name: string;
  messageCount: number;
}

const CHANNELS: readonly ChannelFixture[] = [
  { id: "00000000-0000-4000-8000-0000000000c0", teamKey: null, kind: "global", name: "general", messageCount: 18 },
  { id: "00000000-0000-4000-8000-0000000000c1", teamKey: "platform", kind: "team", name: "platform", messageCount: 10 },
  { id: "00000000-0000-4000-8000-0000000000c2", teamKey: "growth", kind: "team", name: "growth", messageCount: 9 },
  { id: "00000000-0000-4000-8000-0000000000c3", teamKey: "design", kind: "team", name: "design", messageCount: 8 },
];

const STATUSES = ["backlog", "todo", "in_progress", "done"] as const;
const PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;

// Each team draws a DISJOINT slice of this pool without replacement (see the seed loop), so every seeded
// issue gets a distinct title — no two tickets anywhere share one (which otherwise reads as a duplicate-row
// bug in the demo). The pool must therefore have at least as many entries as the total issue count.
const ISSUE_TITLES = [
  "Flush queue stalls under burst writes",
  "Reconnect storm after offline window",
  "Optimistic overlay flickers on reject-if-stale",
  "Shape handle expiry not resumed cleanly",
  "Member fan-out misses a co-member on add",
  "Cross-team move leaks into the source board",
  "PGlite cold start exceeds budget",
  "Convergence dot stuck on a quarantined row",
  "Chat backlog renders out of order",
  "Avatar colors collide for two members",
  "Initial sync double-counts a channel",
  "Drag-reorder loses priority on conflict",
  "Sidebar team switch drops the live cursor",
  "Empty-state copy missing for a fresh team",
  "Inspector shows a phantom pending mutation",
  "Keyboard nav skips the done column",
  "Stale token not refreshed before a write",
  "Offline toggle does not pause the proxy",
  "Issue counter off by one after delete",
  "Search ignores description matches",
  "Reorder animation drops frames on large boards",
  "Team filter persists after sign-out",
  "Retry backoff resets when the tab regains focus",
  "Done column count excludes archived issues",
  "Priority badge misaligns in compact density",
  "Unread channel badge lingers after read",
  "Assignee tooltip clips at the board edge",
  "Board scroll jumps when a row syncs in",
  "Description markdown renders as raw text",
  "Live cursor flickers during a rebase",
  "Quarantine banner does not auto-dismiss",
  "First board open misses the warm cache",
  "Status dropdown closes before the click lands",
  "Cross-team move keeps the stale assignee",
  "Hard refresh discards a queued offline edit",
  "Notification count drifts after reconnect",
] as const;

const CHAT_LINES = [
  "shipping the read-path fix now",
  "can someone take a look at the reconnect storm?",
  "moved that issue to in_progress",
  "the overlay flicker is gone on my machine",
  "who owns the fan-out edge case?",
  "rebased onto main, re-running the lane",
  "nice, convergence is green again",
  "let's pair on the cross-team move tomorrow",
  "added a repro in the inspector",
  "that one is blocked on the token refresh",
  "good catch, pushing a follow-up",
  "demo looks great, dots converge instantly",
  "bumping priority on the cold-start issue",
  "offline toggle works end to end now",
  "thanks! merging once the lane passes",
  "I'll grab the backlog ordering bug",
  "can we get a second review here?",
  "syncing fine across all three teams",
] as const;

// ── GoTrue admin API ──────────────────────────────────────────────────────────────────────────────
interface GoTrueUser {
  id: string;
  email?: string;
}

function adminHeaders(): Record<string, string> {
  return {
    apikey: SECRET_KEY,
    Authorization: `Bearer ${SECRET_KEY}`,
    "Content-Type": "application/json",
  };
}

async function listAllUsers(): Promise<GoTrueUser[]> {
  const users: GoTrueUser[] = [];
  for (let page = 1; page < 100; page++) {
    const response = await fetch(`${GATEWAY_URL}/auth/v1/admin/users?page=${page}&per_page=200`, {
      headers: adminHeaders(),
    });
    if (!response.ok) {
      throw new Error(`GoTrue admin list failed (${response.status}): ${await response.text()}`);
    }
    const body = (await response.json()) as { users?: GoTrueUser[] };
    const batch = body.users ?? [];
    users.push(...batch);
    if (batch.length < 200) break;
  }
  return users;
}

async function deleteUser(id: string): Promise<void> {
  const response = await fetch(`${GATEWAY_URL}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: adminHeaders(),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`GoTrue admin delete failed (${response.status}): ${await response.text()}`);
  }
}

async function createUser(user: UserFixture): Promise<string> {
  const response = await fetch(`${GATEWAY_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      email: user.email,
      password: SEED_PASSWORD,
      email_confirm: true,
      app_metadata: user.admin ? { roles: ["admin"] } : {},
      user_metadata: { display_name: user.displayName },
    }),
  });
  if (!response.ok) {
    throw new Error(`GoTrue admin create failed for ${user.email} (${response.status}): ${await response.text()}`);
  }
  return ((await response.json()) as GoTrueUser).id;
}

// Idempotent: delete any existing fixture identities (a clean reset on re-seed), then recreate.
async function seedIdentities(): Promise<Map<string, string>> {
  const fixtureEmails = new Set(USERS.map((u) => u.email.toLowerCase()));
  for (const user of await listAllUsers()) {
    if (user.email && fixtureEmails.has(user.email.toLowerCase())) {
      await deleteUser(user.id);
    }
  }
  const idByKey = new Map<string, string>();
  for (const user of USERS) {
    idByKey.set(user.key, await createUser(user));
  }
  return idByKey;
}

async function main(): Promise<void> {
  const db = drizzle({ connection: DATABASE_URL });

  // 1. Identities (GoTrue) → email/key → auth id.
  const idByKey = await seedIdentities();
  const memberKeys = USERS.filter((u) => !u.admin).map((u) => u.key);
  const membersByTeam = new Map<string, string[]>(TEAMS.map((t) => [t.key, []]));
  for (const [teamKey, userKey] of MEMBERSHIPS) {
    membersByTeam.get(teamKey)!.push(userKey);
  }

  // 2a. Reset every board table (truncate … cascade), then seed the deterministic structure.
  await reset(db, {
    profile: profileTable,
    team: teamTable,
    teamMember: teamMemberTable,
    channel: channelTable,
    issue: issueTable,
    message: messageTable,
  });

  await db.insert(profileTable).values(
    USERS.map((user) => ({
      id: idByKey.get(user.key)!,
      displayName: user.displayName,
      avatarColor: user.avatarColor,
    })),
  );
  await db.insert(teamTable).values(TEAMS.map((team) => ({ id: team.id, name: team.name })));
  await db.insert(teamMemberTable).values(
    MEMBERSHIPS.map(([teamKey, userKey]) => ({
      id: crypto.randomUUID(),
      teamId: TEAMS.find((t) => t.key === teamKey)!.id,
      userId: idByKey.get(userKey)!,
    })),
  );
  await db.insert(channelTable).values(
    CHANNELS.map((channel) => ({
      id: channel.id,
      teamId: channel.teamKey ? TEAMS.find((t) => t.key === channel.teamKey)!.id : null,
      kind: channel.kind,
      name: channel.name,
    })),
  );

  // 2b. Bulk filler (drizzle-seed). Recent-microsecond window for the Server-version columns.
  const nowUs = BigInt(Date.now()) * 1000n;
  const minUs = nowUs - 30n * 24n * 60n * 60n * 1_000_000n;

  // Each team consumes the next disjoint slice of the title pool, drawn without replacement (`isUnique`),
  // so every issue across the whole board gets a globally-distinct title.
  const totalIssues = TEAMS.reduce((sum, team) => sum + team.issueCount, 0);
  if (ISSUE_TITLES.length < totalIssues) {
    throw new Error(
      `ISSUE_TITLES needs at least ${totalIssues} entries for unique per-issue titles, has ${ISSUE_TITLES.length}`,
    );
  }

  let issueTotal = 0;
  let titleOffset = 0;
  for (const [index, team] of TEAMS.entries()) {
    const memberIds = membersByTeam.get(team.key)!.map((key) => idByKey.get(key)!);
    const titleSlice = ISSUE_TITLES.slice(titleOffset, titleOffset + team.issueCount);
    titleOffset += team.issueCount;
    await seed(db, { issue: issueTable }, { seed: 100 + index }).refine((f) => ({
      issue: {
        count: team.issueCount,
        columns: {
          teamId: f.default({ defaultValue: team.id }),
          assigneeId: f.valuesFromArray({ values: memberIds }),
          createdBy: f.valuesFromArray({ values: memberIds }),
          title: f.valuesFromArray({ values: [...titleSlice], isUnique: true }),
          description: f.loremIpsum({ sentencesCount: 2 }),
          status: f.valuesFromArray({ values: [...STATUSES] }),
          priority: f.valuesFromArray({ values: [...PRIORITIES] }),
          createdAtUs: f.int({ minValue: minUs, maxValue: nowUs }),
          updatedAtUs: f.int({ minValue: minUs, maxValue: nowUs }),
        },
      },
    }));
    issueTotal += team.issueCount;
  }

  let messageTotal = 0;
  for (const [index, channel] of CHANNELS.entries()) {
    const authorKeys = channel.teamKey ? membersByTeam.get(channel.teamKey)! : memberKeys;
    const authorIds = authorKeys.map((key) => idByKey.get(key)!);
    await seed(db, { message: messageTable }, { seed: 200 + index }).refine((f) => ({
      message: {
        count: channel.messageCount,
        columns: {
          channelId: f.default({ defaultValue: channel.id }),
          authorId: f.valuesFromArray({ values: authorIds }),
          body: f.valuesFromArray({ values: [...CHAT_LINES] }),
          createdAtUs: f.int({ minValue: minUs, maxValue: nowUs }),
          updatedAtUs: f.int({ minValue: minUs, maxValue: nowUs }),
        },
      },
    }));
    messageTotal += channel.messageCount;
  }

  console.log(
    `Seeded board: ${USERS.length} identities (1 admin), ${TEAMS.length} teams, ${MEMBERSHIPS.length} memberships, ` +
      `${CHANNELS.length} channels, ${issueTotal} issues, ${messageTotal} messages.`,
  );
  console.log(`Sign in at /login with any identity (e.g. alice@board.local) — password: ${SEED_PASSWORD}`);
}

await main();
