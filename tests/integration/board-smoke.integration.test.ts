// Board demo smoke — the ONE lane that drives the demo's real deployment topology end-to-end:
// GoTrue (password login) → Envoy → the two Deno edge functions (board-write, board-sync) → Electric,
// with RLS + the registry read filter governing every row. The toolkit integration suites
// (tests/integration/*.integration.test.ts) exercise the client/server primitives in-process against
// the minimal postgres+electric harness with synthetic claims; none of them exercises GoTrue, the
// gateway, or the bundled edge functions. This does, so a wiring break in the demo's deployment path
// (auth, routing, the proxy's claim-driven `customWhere`, the apply's RLS actor switch) fails here.
//
// Run via `bun run test:integration:board` (scripts/run-board-smoke.ts brings the board stack up,
// seeds it, runs this, and tears it down). The deterministic seed (scripts/seed-board.ts) is the
// contract: Alice is a member of Platform + Growth (never Design); Admin holds the workspace-wide role.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import postgres from "postgres";

const GATEWAY_URL = process.env["BOARD_GATEWAY_URL"] ?? "http://localhost:54331";
const SEED_PASSWORD = process.env["BOARD_SEED_PASSWORD"] ?? "board-demo-password";
// Demo defaults mirror infra/compose/board.env (throwaway local values, not secrets). The new opaque
// publishable key (board ADR-0007): the gateway validates it and leaves the session JWT in
// Authorization untouched, so it rides alongside the bearer on every request.
const PUBLISHABLE_KEY = process.env["BOARD_PUBLISHABLE_KEY"] ?? "sb_publishable_boarddemoLOCALxxxxxxxxx_demo0000";
const DATABASE_URL =
  process.env["BOARD_DATABASE_URL"] ??
  "postgresql://postgres:your-super-secret-and-long-postgres-password@localhost:54322/postgres?sslmode=disable";

// Seeded team ids (scripts/seed-board.ts) — the unit of read/write isolation.
const PLATFORM = "00000000-0000-4000-8000-0000000000a1";
const GROWTH = "00000000-0000-4000-8000-0000000000a2";
const DESIGN = "00000000-0000-4000-8000-0000000000a3";

// Seeded channel ids (scripts/seed-board.ts). Alice is in Platform + Growth, so she syncs the global
// channel plus those two; the Design channel is admin-only.
const GLOBAL_CHANNEL = "00000000-0000-4000-8000-0000000000c0";
const PLATFORM_CHANNEL = "00000000-0000-4000-8000-0000000000c1";
const GROWTH_CHANNEL = "00000000-0000-4000-8000-0000000000c2";
const DESIGN_CHANNEL = "00000000-0000-4000-8000-0000000000c3";

const sql = postgres(DATABASE_URL, { prepare: false });

interface IssueRow {
  id: string;
  status: string;
  updated_at_us: string;
}

interface TeamRow {
  id: string;
  name: string;
  updated_at_us: string;
}

async function login(email: string): Promise<string> {
  const response = await fetch(`${GATEWAY_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: SEED_PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(`GoTrue login failed for ${email} (${response.status}): ${await response.text()}`);
  }
  const token = ((await response.json()) as { access_token?: string }).access_token;
  if (!token) throw new Error(`GoTrue returned no access_token for ${email}`);
  return token;
}

interface ShapeMessage {
  value?: Record<string, unknown>;
  key?: string;
  headers: { operation?: "insert" | "update" | "delete"; control?: string };
}

// Read a whole shape through the board-sync proxy as a given identity: walk offsets until Electric
// reports up-to-date, folding insert/update/delete into the final row set (keyed by Electric's row
// key). Returns exactly the rows the proxy's claim-driven `customWhere` let through for this token.
async function fetchShapeRows(table: string, token: string): Promise<Record<string, unknown>[]> {
  const rows = new Map<string, Record<string, unknown>>();
  let handle: string | null = null;
  let offset = "-1";

  for (let guard = 0; guard < 30; guard++) {
    const url = new URL(`${GATEWAY_URL}/functions/v1/board-sync`);
    url.searchParams.set("table", table);
    url.searchParams.set("offset", offset);
    if (handle) url.searchParams.set("handle", handle);

    const headers = { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}` };
    let response = await fetch(url, { headers });
    // Cold-start tolerance: the edge worker can return a transient 502/503/504 from the gateway while
    // board-sync's bundle is (re)importing (~6s; see the header note). That is a local-compose artifact
    // — a managed BaaS keeps functions warm — so retry the transient before failing the correctness smoke.
    for (let attempt = 0; attempt < 20 && [502, 503, 504].includes(response.status); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      response = await fetch(url, { headers });
    }
    if (!response.ok) {
      throw new Error(`board-sync ${table} failed (${response.status}): ${await response.text()}`);
    }

    const messages = (await response.json()) as ShapeMessage[];
    for (const message of messages) {
      if (message.headers.control) continue;
      const key = message.key ?? "";
      if (message.headers.operation === "delete") rows.delete(key);
      else if (message.value) rows.set(key, message.value);
    }

    handle = response.headers.get("electric-handle") ?? handle;
    offset = response.headers.get("electric-offset") ?? offset;
    if (response.headers.get("electric-up-to-date") === "true") break;
  }
  return [...rows.values()];
}

interface MutationAck {
  status: "acked" | "conflicted" | "failed" | "quarantined";
  serverUpdatedAtUs?: string | null;
  conflictReason?: string | null;
  httpStatus?: number;
}

interface MutationInput {
  tableName: string;
  entityKey: Record<string, unknown>;
  kind: "create" | "update" | "delete";
  payload?: Record<string, unknown>;
  baseServerVersion?: string | null;
}

// Apply one mutation through the board-write edge function as a given identity. The apply runs under
// that identity's claims, so RLS governs whether the write lands — exactly as it would for the real
// client. A WITH CHECK violation aborts the batch (non-200); an UPDATE whose USING clause excludes the
// row matches zero rows and acks as a silent no-op (the data is simply untouched).
async function applyMutation(token: string, mutation: MutationInput): Promise<MutationAck> {
  const response = await fetch(`${GATEWAY_URL}/functions/v1/board-write/mutations`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      mutations: [
        {
          tableName: mutation.tableName,
          entityKey: mutation.entityKey,
          mutationId: crypto.randomUUID(),
          mutationSeq: 1,
          kind: mutation.kind,
          payload: mutation.payload ?? {},
          clientTimestampUs: String(BigInt(Date.now()) * 1000n),
          baseServerVersion: mutation.baseServerVersion ?? null,
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`board-write failed (${response.status}): ${await response.text()}`);
  }
  return ((await response.json()) as { acks: MutationAck[] }).acks[0]!;
}

function boardWriteStatus(token: string, issue: IssueRow, next: string): Promise<MutationAck> {
  return applyMutation(token, {
    tableName: "issue",
    entityKey: { id: issue.id },
    kind: "update",
    payload: { status: next },
    baseServerVersion: issue.updated_at_us,
  });
}

const otherStatus = (status: string): string => (status === "done" ? "todo" : "done");

describe("board demo smoke (real edge stack: GoTrue → Envoy → edge functions → Electric)", () => {
  let aliceToken: string;
  let adminToken: string;

  beforeAll(async () => {
    aliceToken = await login("alice@board.local");
    adminToken = await login("admin@board.local");
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("issues GoTrue tokens for the seeded identities", () => {
    expect(aliceToken.length).toBeGreaterThan(0);
    expect(adminToken.length).toBeGreaterThan(0);
  });

  it("scopes a member's read to their own teams (board-sync customWhere: Alice = Platform + Growth, not Design)", async () => {
    const teams = new Set((await fetchShapeRows("issue", aliceToken)).map((row) => row["team_id"]));
    expect(teams.has(PLATFORM)).toBe(true);
    expect(teams.has(GROWTH)).toBe(true);
    expect(teams.has(DESIGN)).toBe(false);
  });

  it("gives an admin every team's rows", async () => {
    const teams = new Set((await fetchShapeRows("issue", adminToken)).map((row) => row["team_id"]));
    expect(teams.has(PLATFORM)).toBe(true);
    expect(teams.has(GROWTH)).toBe(true);
    expect(teams.has(DESIGN)).toBe(true);
  });

  it("applies a governed write from a member and advances the server version", async () => {
    const [issue] = await sql<IssueRow[]>`
      select id, status, updated_at_us from issue where team_id = ${PLATFORM} order by id limit 1`;
    expect(issue).toBeDefined();
    const next = otherStatus(issue!.status);

    const ack = await boardWriteStatus(aliceToken, issue!, next);
    expect(ack.status).toBe("acked");
    expect(BigInt(ack.serverUpdatedAtUs ?? "0")).toBeGreaterThan(BigInt(issue!.updated_at_us));

    const [after] = await sql<IssueRow[]>`select id, status, updated_at_us from issue where id = ${issue!.id}`;
    expect(after!.status).toBe(next);
    expect(BigInt(after!.updated_at_us)).toBeGreaterThan(BigInt(issue!.updated_at_us));
  });

  it("rejects a cross-team write under RLS without mutating the row", async () => {
    const [issue] = await sql<IssueRow[]>`
      select id, status, updated_at_us from issue where team_id = ${DESIGN} order by id limit 1`;
    expect(issue).toBeDefined();

    // Alice cannot even see this row; an attacker who knows its id still cannot write it — the apply
    // runs as `authenticated` with Alice's claims, so the row is invisible and the write conflicts.
    const ack = await boardWriteStatus(aliceToken, issue!, otherStatus(issue!.status));
    expect(ack.status).toBe("conflicted");

    const [after] = await sql<IssueRow[]>`select id, status, updated_at_us from issue where id = ${issue!.id}`;
    expect(after!.status).toBe(issue!.status);
    expect(after!.updated_at_us).toBe(issue!.updated_at_us);
  });

  // pgxsinkit ADR-0025 — per-client mode projection, proven at the write path. `team` is `readwrite` in
  // the authoritative registry but Admin-only by RLS (`team_update`). The Member client never even has a
  // `team` write handle (`boardMemberRegistry` projects `team` `asReadonly`), so this is the server-side
  // backstop: an Admin's rename lands and fans out; a Member's forged write cannot touch the data.
  describe("team rename (ADR-0025: Admin writes, Member is read-only)", () => {
    it("lets an Admin rename a Team — the write applies and the Server version advances", async () => {
      const [team] = await sql<TeamRow[]>`select id, name, updated_at_us from team where id = ${PLATFORM}`;
      expect(team).toBeDefined();
      const renamed = `${team!.name} (renamed)`;

      const ack = await applyMutation(adminToken, {
        tableName: "team",
        entityKey: { id: PLATFORM },
        kind: "update",
        payload: { name: renamed },
        baseServerVersion: team!.updated_at_us,
      });
      expect(ack.status).toBe("acked");
      expect(BigInt(ack.serverUpdatedAtUs ?? "0")).toBeGreaterThan(BigInt(team!.updated_at_us));

      const [after] = await sql<TeamRow[]>`select id, name, updated_at_us from team where id = ${PLATFORM}`;
      expect(after!.name).toBe(renamed);
      expect(BigInt(after!.updated_at_us)).toBeGreaterThan(BigInt(team!.updated_at_us));

      // The rename fans out on the read path: a Member of Platform syncs the Team with its new name.
      const platform = (await fetchShapeRows("team", aliceToken)).find((row) => row["id"] === PLATFORM);
      expect(platform?.["name"]).toBe(renamed);
    });

    it("does not let a Member change a Team, even with a hand-forged write (RLS backstop)", async () => {
      // The Member client has no `team` write handle at all (the ADR-0025 UX guarantee), so it could
      // never issue this. We forge it anyway to prove the server is the real backstop: `team_update` is
      // Admin-only, so the UPDATE's USING clause excludes the row, it matches zero rows, and the data is
      // untouched. Alice *can* read Growth (she's a member), so this is the visible-but-not-writable case
      // — distinct from the cross-team issue write above, which she cannot even see.
      const [before] = await sql<TeamRow[]>`select id, name, updated_at_us from team where id = ${GROWTH}`;
      expect(before).toBeDefined();

      await applyMutation(aliceToken, {
        tableName: "team",
        entityKey: { id: GROWTH },
        kind: "update",
        payload: { name: "Member Was Here" },
        baseServerVersion: before!.updated_at_us,
      });

      const [after] = await sql<TeamRow[]>`select id, name, updated_at_us from team where id = ${GROWTH}`;
      expect(after!.name).toBe(before!.name);
      expect(after!.updated_at_us).toBe(before!.updated_at_us);
    });
  });

  // pgxsinkit ADR-0025 read filter + ADR-0021 lazy/ephemeral chat. The `message` shape carries a Member
  // read window: a Member syncs only their visible channels AND the recent `CHAT_WINDOW_DAYS` of chat,
  // while the Admin syncs every channel and the full history. The seed spreads chat across ~30 days, so
  // older messages always fall outside the 21-day window and are visibly admin-only. (`message` is `lazy`
  // for both roles and the retention is per-client — `persistent` for the Admin, projected `ephemeral`
  // for the Member — but those are client-side subscription/retention hints; the proxy serves the shape on
  // request all the same, which is what this reads.)
  describe("member chat read window (ADR-0025 read filter)", () => {
    it("windows a Member to their channels and the recent history, giving the Admin everything", async () => {
      const aliceMsgs = await fetchShapeRows("message", aliceToken);
      const adminMsgs = await fetchShapeRows("message", adminToken);

      // Channel scope: Alice syncs her teams' channels + global; never the Design channel. The Admin
      // syncs every channel, Design included.
      const aliceChannels = new Set(aliceMsgs.map((row) => row["channel_id"]));
      expect(aliceChannels.has(GLOBAL_CHANNEL)).toBe(true);
      expect(aliceChannels.has(DESIGN_CHANNEL)).toBe(false);
      expect(new Set(adminMsgs.map((row) => row["channel_id"])).has(DESIGN_CHANNEL)).toBe(true);

      // Within the channels BOTH can see, the only differentiator is the time window — isolate them.
      const shared = new Set([GLOBAL_CHANNEL, PLATFORM_CHANNEL, GROWTH_CHANNEL]);
      const inShared = (rows: Record<string, unknown>[]) =>
        rows.filter((row) => shared.has(row["channel_id"] as string));
      const aliceShared = inShared(aliceMsgs);
      const aliceIds = new Set(aliceShared.map((row) => row["id"]));
      const adminOnly = inShared(adminMsgs).filter((row) => !aliceIds.has(row["id"]));

      // The Admin sees strictly more in those shared channels — the older messages the window holds back.
      expect(aliceShared.length).toBeGreaterThan(0);
      expect(adminOnly.length).toBeGreaterThan(0);

      // And it's a clean TIME cutoff, not a random difference: every message held back from the Member is
      // strictly older than every message the Member did receive.
      const createdAt = (row: Record<string, unknown>) => BigInt(row["created_at_us"] as string);
      const newestHeldBack = adminOnly.reduce((max, row) => (createdAt(row) > max ? createdAt(row) : max), 0n);
      const oldestDelivered = aliceShared.reduce(
        (min, row) => (createdAt(row) < min ? createdAt(row) : min),
        createdAt(aliceShared[0]!),
      );
      expect(newestHeldBack).toBeLessThan(oldestDelivered);
    });
  });
});
