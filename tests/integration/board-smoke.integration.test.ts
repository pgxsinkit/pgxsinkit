// Board demo smoke — the ONE lane that drives the demo's real deployment topology end-to-end:
// GoTrue (password login) → Kong → the two Deno edge functions (board-write, board-sync) → Electric,
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
// Demo defaults mirror infra/compose/board.env (public Supabase self-hosted values, not secrets).
const ANON_KEY =
  process.env["ANON_KEY"] ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE";
const DATABASE_URL =
  process.env["BOARD_DATABASE_URL"] ??
  "postgresql://postgres:your-super-secret-and-long-postgres-password@localhost:54322/postgres?sslmode=disable";

// Seeded team ids (scripts/seed-board.ts) — the unit of read/write isolation.
const PLATFORM = "00000000-0000-4000-8000-0000000000a1";
const GROWTH = "00000000-0000-4000-8000-0000000000a2";
const DESIGN = "00000000-0000-4000-8000-0000000000a3";

const sql = postgres(DATABASE_URL, { prepare: false });

interface IssueRow {
  id: string;
  status: string;
  updated_at_us: string;
}

async function login(email: string): Promise<string> {
  const response = await fetch(`${GATEWAY_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
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

    const headers = { apikey: ANON_KEY, Authorization: `Bearer ${token}` };
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

async function boardWriteStatus(token: string, issue: IssueRow, next: string): Promise<MutationAck> {
  const response = await fetch(`${GATEWAY_URL}/functions/v1/board-write/mutations`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      mutations: [
        {
          tableName: "issue",
          entityKey: { id: issue.id },
          mutationId: crypto.randomUUID(),
          mutationSeq: 1,
          kind: "update",
          payload: { status: next },
          clientTimestampUs: String(BigInt(Date.now()) * 1000n),
          baseServerVersion: issue.updated_at_us,
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`board-write failed (${response.status}): ${await response.text()}`);
  }
  return ((await response.json()) as { acks: MutationAck[] }).acks[0]!;
}

const otherStatus = (status: string): string => (status === "done" ? "todo" : "done");

describe("board demo smoke (real edge stack: GoTrue → Kong → edge functions → Electric)", () => {
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
});
