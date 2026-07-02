import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { count, eq } from "drizzle-orm";

import { type JwtClaims } from "@pgxsinkit/contracts";
import {
  buildMembershipFanoutSyncConfig,
  membershipFanoutSyncRegistry,
  workItemsTable,
  workspaceMembersTable,
  workspacesTable,
} from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";
import { createServerDb, readIntegrationEnv, waitFor } from "@pgxsinkit/test-utils";

import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { createElectricExtension, startConfiguredSync } from "../../packages/client/src/shape-sync";
import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/plpgsql-apply";
import { drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

const env = readIntegrationEnv();
const localSchemaSql = generateLocalSchemaSql(membershipFanoutSyncRegistry);

// Identities + container fixtures (A & B share workspace 1; C is in workspace 2 only).
const MEMBER_A = "1b3f0d2a-0000-4000-8000-000000000a01";
const MEMBER_B = "1b3f0d2a-0000-4000-8000-000000000b02";
const NON_MEMBER_C = "1b3f0d2a-0000-4000-8000-000000000c03";
const OUTSIDER_D = "1b3f0d2a-0000-4000-8000-000000000d04";
const WORKSPACE_1 = "2c4e1e3b-0000-4000-8000-000000000111";
const WORKSPACE_2 = "2c4e1e3b-0000-4000-8000-000000000222";
const ITEM_A_IN_W1 = "3d5f2f4c-0000-4000-8000-000000000a11";

// Per-request identity from a test header (the proxy + write-API both resolve claims this way).
function claimsFromHeader(request: Request): JwtClaims | null {
  const sub = request.headers.get("x-test-sub");
  return sub ? { role: "authenticated", sub } : null;
}

async function createLocalWorkItemStore() {
  const pg = await createFreshTestPGlite({ extensions: { electric: createElectricExtension() } });
  await pg.exec(localSchemaSql);
  return pg;
}

async function startMemberSync(
  localPg: Awaited<ReturnType<typeof createLocalWorkItemStore>>,
  proxyUrl: string,
  sub: string,
) {
  let markInitialSyncDone: (() => void) | null = null;
  const initialSyncDone = new Promise<void>((resolve) => {
    markInitialSyncDone = resolve;
  });

  const sync = await startConfiguredSync(localPg as Parameters<typeof startConfiguredSync>[0], {
    syncConfig: buildMembershipFanoutSyncConfig(proxyUrl),
    shapeHeaders: { "x-test-sub": sub },
    onInitialSync: () => {
      markInitialSyncDone?.();
      markInitialSyncDone = null;
    },
  });

  return { sync, initialSyncDone };
}

// The two local-store assertion reads every scenario keeps returning to.
const itemBody = async (pg: Awaited<ReturnType<typeof createLocalWorkItemStore>>, id: string) =>
  (await drizzleOver(pg).select({ body: workItemsTable.body }).from(workItemsTable).where(eq(workItemsTable.id, id)))[0]
    ?.body;

const itemCount = async (pg: Awaited<ReturnType<typeof createLocalWorkItemStore>>) =>
  (await drizzleOver(pg).select({ count: count() }).from(workItemsTable))[0]?.count ?? 0;

describe("membership fan-out (readwrite) integration", () => {
  let server!: ReturnType<typeof createSyncServer<typeof membershipFanoutSyncRegistry>>;
  let httpServer!: ReturnType<typeof Bun.serve>;
  let proxyUrl!: string;
  const serverDb = createServerDb(membershipFanoutSyncRegistry, env.databaseUrl);

  beforeAll(async () => {
    const provisioningServer = createSyncServer({
      registry: membershipFanoutSyncRegistry,
      db: serverDb.db,
    });
    try {
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, membershipFanoutSyncRegistry);
    } finally {
      await provisioningServer.stop();
    }

    // createSyncServer serves both the write route and the shape proxy from the one server,
    // each resolving the test identity from the x-test-sub header via the shared adapter.
    server = createSyncServer({
      registry: membershipFanoutSyncRegistry,
      db: serverDb.db,
      resolveAuthClaims: (request) => claimsFromHeader(request),
      electricUrl: env.electricUrl,
      shapeProxyPath: "/v1/electric-proxy",
    });

    httpServer = Bun.serve({ port: 0, fetch: server.fetch });
    proxyUrl = `http://127.0.0.1:${httpServer.port}/v1/electric-proxy`;
  });

  beforeEach(async () => {
    await server.drizzle.delete(workItemsTable);
    await server.drizzle.delete(workspaceMembersTable);
    await server.drizzle.delete(workspacesTable);

    await server.drizzle.insert(workspacesTable).values([
      { id: WORKSPACE_1, ownerId: MEMBER_A },
      { id: WORKSPACE_2, ownerId: NON_MEMBER_C },
    ]);
    await server.drizzle.insert(workspaceMembersTable).values([
      { id: "4e60305d-0000-4000-8000-0000000000a1", workspaceId: WORKSPACE_1, memberId: MEMBER_A, role: "member" },
      { id: "4e60305d-0000-4000-8000-0000000000b2", workspaceId: WORKSPACE_1, memberId: MEMBER_B, role: "member" },
      { id: "4e60305d-0000-4000-8000-0000000000c3", workspaceId: WORKSPACE_2, memberId: NON_MEMBER_C, role: "member" },
    ]);
  });

  afterAll(async () => {
    await httpServer.stop(true);
    await server.stop();
    await serverDb.close();
  });

  it("fans a member's row down to a co-member, but not to a non-member", async () => {
    // Item authored by A in workspace 1 (seeded directly; the read path is what we are proving).
    await server.drizzle
      .insert(workItemsTable)
      .values({ id: ITEM_A_IN_W1, workspaceId: WORKSPACE_1, ownerId: MEMBER_A, body: "from A" });

    const coMemberPg = await createLocalWorkItemStore();
    const nonMemberPg = await createLocalWorkItemStore();
    const coMember = await startMemberSync(coMemberPg, proxyUrl, MEMBER_B);
    const nonMember = await startMemberSync(nonMemberPg, proxyUrl, NON_MEMBER_C);

    try {
      await coMember.initialSyncDone;
      await nonMember.initialSyncDone;

      // B (co-member of W1) receives A's item — fan-out to a non-owner.
      await waitFor(async () => {
        expect(await itemBody(coMemberPg, ITEM_A_IN_W1)).toBe("from A");
      });

      // C (member of a different workspace) never receives it — the filter actually filters.
      expect(await itemCount(nonMemberPg)).toBe(0);
    } finally {
      coMember.sync.unsubscribe();
      nonMember.sync.unsubscribe();
      await coMemberPg.close();
      await nonMemberPg.close();
    }
  }, 30_000);

  // The REVOCATION twin of the fan-out test: deleting a member's membership row — the SOURCE of the
  // work_items subquery row-filter (`workspace_id IN (SELECT workspace_id FROM workspace_members WHERE
  // member_id = $sub)`) — must stream a move-out delete to that member's LIVE-following shape, so the
  // rows they could see leave their local store. This is the exact mechanism the board demo relies on
  // when an admin removes someone from a team (the team's board + issues should disappear). The
  // documented caveat (apps/board/docs/consumer-review.md) is that only a *live* shape receives this
  // delta; this test holds a live subscription throughout, so it proves the live path end-to-end.
  it("revokes a member's rows from their LIVE shape when their membership is deleted (move-out)", async () => {
    // Fully-isolated identities so Electric serves this subject a BRAND-NEW shape (a unique `sub` →
    // unique where-params → no cached handle from the fan-out test, whose churn would otherwise mask the
    // result). The only thing under test is: live shape + delete the subquery's SOURCE row → move-out.
    const REV_WS = "2c4e1e3b-0000-4000-8000-0000000009ff";
    const REV_MEMBER = "1b3f0d2a-0000-4000-8000-0000000009ff";
    const REV_MEMBERSHIP = "4e60305d-0000-4000-8000-0000000009ff";
    const REV_ITEM = "3d5f2f4c-0000-4000-8000-0000000009ff";

    await server.drizzle.insert(workspacesTable).values({ id: REV_WS, ownerId: REV_MEMBER });
    await server.drizzle
      .insert(workspaceMembersTable)
      .values({ id: REV_MEMBERSHIP, workspaceId: REV_WS, memberId: REV_MEMBER, role: "member" });
    await server.drizzle
      .insert(workItemsTable)
      .values({ id: REV_ITEM, workspaceId: REV_WS, ownerId: REV_MEMBER, body: "revoke me" });

    const memberPg = await createLocalWorkItemStore();
    const member = await startMemberSync(memberPg, proxyUrl, REV_MEMBER);

    try {
      await member.initialSyncDone;

      // The member receives their workspace's item on the live shape — the precondition.
      await waitFor(async () => {
        expect(await itemCount(memberPg)).toBe(1);
      });

      // Admin removes the member from the workspace: delete the SOURCE row of their subquery filter
      // (`workspace_id IN (SELECT workspace_id FROM workspace_members WHERE member_id = $sub)`).
      await server.drizzle.delete(workspaceMembersTable).where(eq(workspaceMembersTable.id, REV_MEMBERSHIP));

      // Electric must re-evaluate the dependent shape and stream the move-out; the item leaves the store.
      await waitFor(async () => {
        expect(await itemCount(memberPg)).toBe(0);
      });
    } finally {
      member.sync.unsubscribe();
      await memberPg.close();
    }
  }, 30_000);

  // ADR-0023 Slice 2 — the security-critical OFFLINE case: the member is removed while their client is
  // shut down (here: unsubscribed), then reconnects. The resume from the persisted offset must replay
  // the move-out and evict the now-unauthorised rows — a revoked member must never resume into a stale
  // board + tickets. The SAME local store is reused across the two sessions so the second resumes from
  // the first's persisted subscription offset/handle (not a fresh snapshot).
  it("revokes a member's rows across an OFFLINE gap: removed while unsubscribed, evicted on resume (ADR-0023 Slice 2)", async () => {
    const RES_WS = "2c4e1e3b-0000-4000-8000-0000000008ff";
    const RES_MEMBER = "1b3f0d2a-0000-4000-8000-0000000008ff";
    const RES_MEMBERSHIP = "4e60305d-0000-4000-8000-0000000008ff";
    const RES_ITEM = "3d5f2f4c-0000-4000-8000-0000000008ff";

    await server.drizzle.insert(workspacesTable).values({ id: RES_WS, ownerId: RES_MEMBER });
    await server.drizzle
      .insert(workspaceMembersTable)
      .values({ id: RES_MEMBERSHIP, workspaceId: RES_WS, memberId: RES_MEMBER, role: "member" });
    await server.drizzle
      .insert(workItemsTable)
      .values({ id: RES_ITEM, workspaceId: RES_WS, ownerId: RES_MEMBER, body: "offline-revoke" });

    const memberPg = await createLocalWorkItemStore();

    // Session 1: sync, receive the item, persist the tag-set + offset, then go OFFLINE (unsubscribe)
    // while keeping the local store.
    const first = await startMemberSync(memberPg, proxyUrl, RES_MEMBER);
    await first.initialSyncDone;
    await waitFor(async () => {
      expect(await itemCount(memberPg)).toBe(1);
    });
    first.sync.unsubscribe();

    // While offline: the admin removes the membership.
    await server.drizzle.delete(workspaceMembersTable).where(eq(workspaceMembersTable.id, RES_MEMBERSHIP));

    // Session 2: resume on the SAME store. Catch-up from the persisted offset must deliver the move-out.
    const second = await startMemberSync(memberPg, proxyUrl, RES_MEMBER);
    try {
      await second.initialSyncDone;
      await waitFor(async () => {
        expect(await itemCount(memberPg)).toBe(0);
      });
    } finally {
      second.sync.unsubscribe();
      await memberPg.close();
    }
  }, 30_000);

  // ADR-0024 Slice 1 — the MOVE-IN twin of the revocation test: ADDING a membership while the member's
  // shape is live must stream the now-visible rows IN (Electric delivers them as `is_move_in` snapshot
  // inserts), so the rows appear with no reload. This is the exact mechanism the board demo relies on
  // when an admin adds someone to a team (the team's board + tickets should appear). The regression it
  // guards: those snapshot inserts carry no LSN, so the engine's change dedup dropped them and the rows
  // only showed after a full re-snapshot (tab reload).
  it("fans a newly-added member's rows into their LIVE shape (move-in, ADR-0024)", async () => {
    const MVI_WS = "2c4e1e3b-0000-4000-8000-0000000007ff";
    const MVI_MEMBER = "1b3f0d2a-0000-4000-8000-0000000007ff";
    const MVI_MEMBERSHIP = "4e60305d-0000-4000-8000-0000000007ff";
    const MVI_ITEM = "3d5f2f4c-0000-4000-8000-0000000007ff";

    // The workspace + item exist, but the member has NO membership yet → their shape must be empty.
    await server.drizzle.insert(workspacesTable).values({ id: MVI_WS, ownerId: MVI_MEMBER });
    await server.drizzle
      .insert(workItemsTable)
      .values({ id: MVI_ITEM, workspaceId: MVI_WS, ownerId: MVI_MEMBER, body: "appear on join" });

    const memberPg = await createLocalWorkItemStore();
    const member = await startMemberSync(memberPg, proxyUrl, MVI_MEMBER);

    try {
      await member.initialSyncDone;

      // Precondition: not a member yet → sees nothing.
      expect(await itemCount(memberPg)).toBe(0);

      // Admin adds the member to the workspace — the SOURCE row of their subquery filter now matches.
      await server.drizzle
        .insert(workspaceMembersTable)
        .values({ id: MVI_MEMBERSHIP, workspaceId: MVI_WS, memberId: MVI_MEMBER, role: "member" });

      // Electric re-evaluates the dependent shape and streams the move-in; the row materialises live.
      await waitFor(async () => {
        expect(await itemBody(memberPg, MVI_ITEM)).toBe("appear on join");
      });
    } finally {
      member.sync.unsubscribe();
      await memberPg.close();
    }
  }, 30_000);

  // ADR-0024 Slice 2 — the OFFLINE move-in: the member is added while their client is shut down (here:
  // unsubscribed), then reconnects. The resume from the persisted offset must replay the move-in snapshot
  // rows and materialise the now-visible board + tickets. The SAME local store is reused across the two
  // sessions so the second resumes from the first's persisted offset/handle (not a fresh snapshot).
  it("fans a member's rows in across an OFFLINE gap: added while unsubscribed, materialised on resume (ADR-0024 Slice 2)", async () => {
    const MIN_WS = "2c4e1e3b-0000-4000-8000-0000000006ff";
    const MIN_MEMBER = "1b3f0d2a-0000-4000-8000-0000000006ff";
    const MIN_MEMBERSHIP = "4e60305d-0000-4000-8000-0000000006ff";
    const MIN_ITEM = "3d5f2f4c-0000-4000-8000-0000000006ff";

    await server.drizzle.insert(workspacesTable).values({ id: MIN_WS, ownerId: MIN_MEMBER });
    await server.drizzle
      .insert(workItemsTable)
      .values({ id: MIN_ITEM, workspaceId: MIN_WS, ownerId: MIN_MEMBER, body: "offline-join" });

    const memberPg = await createLocalWorkItemStore();

    // Session 1: sync as a non-member (sees nothing), persist the offset, then go OFFLINE (unsubscribe)
    // while keeping the local store.
    const first = await startMemberSync(memberPg, proxyUrl, MIN_MEMBER);
    await first.initialSyncDone;
    expect(await itemCount(memberPg)).toBe(0);
    first.sync.unsubscribe();

    // While offline: the admin adds the membership.
    await server.drizzle
      .insert(workspaceMembersTable)
      .values({ id: MIN_MEMBERSHIP, workspaceId: MIN_WS, memberId: MIN_MEMBER, role: "member" });

    // Session 2: resume on the SAME store. Catch-up from the persisted offset must deliver the move-in.
    const second = await startMemberSync(memberPg, proxyUrl, MIN_MEMBER);
    try {
      await second.initialSyncDone;
      await waitFor(async () => {
        expect(await itemBody(memberPg, MIN_ITEM)).toBe("offline-join");
      });
    } finally {
      second.sync.unsubscribe();
      await memberPg.close();
    }
  }, 30_000);

  it("lets a member write into their workspace but rejects a non-member (RLS WITH CHECK)", async () => {
    const memberWrite = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-sub": MEMBER_A },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "work_items",
            entityKey: { id: "5f713f6e-0000-4000-8000-000000000a99" },
            mutationId: "6a824a7f-0000-4000-8000-000000000a99",
            mutationSeq: 1,
            kind: "create",
            payload: { id: "5f713f6e-0000-4000-8000-000000000a99", workspace_id: WORKSPACE_1, body: "A writes" },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });
    expect(memberWrite.status).toBe(200);

    const memberRows = await server.drizzle.select().from(workItemsTable);
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]?.ownerId).toBe(MEMBER_A); // owner_id stamped from the JWT sub on create

    // D is a member of no workspace → the membership WITH CHECK must reject the insert into W1.
    const outsiderWrite = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-sub": OUTSIDER_D },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "work_items",
            entityKey: { id: "5f713f6e-0000-4000-8000-000000000d99" },
            mutationId: "6a824a7f-0000-4000-8000-000000000d99",
            mutationSeq: 1,
            kind: "create",
            payload: { id: "5f713f6e-0000-4000-8000-000000000d99", workspace_id: WORKSPACE_1, body: "D intrudes" },
            clientTimestampUs: String(Date.now() * 1000),
          },
        ],
      }),
    });
    expect(outsiderWrite.status).not.toBe(200);

    const afterOutsider = await server.drizzle.select().from(workItemsTable);
    expect(afterOutsider).toHaveLength(1); // still only A's row
  }, 30_000);
});
