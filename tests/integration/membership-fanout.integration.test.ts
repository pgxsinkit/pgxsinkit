import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { count, eq } from "drizzle-orm";

import {
  membershipFanoutSyncRegistry,
  workItemsTable,
  workspaceMembersTable,
  workspacesTable,
} from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";
import {
  createServerDb,
  readIntegrationEnv,
  startNativeSyncStack,
  waitFor,
  type NativeSyncStack,
} from "@pgxsinkit/test-utils";

import { startCircuitsSync } from "../../packages/client/src/circuits/group-sync";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { DEFAULT_METADATA_SCHEMA } from "../../packages/client/src/sync/metadata-tables";
import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/plpgsql-apply";
import { createCircuitsTestPGlite } from "../support/circuits-pglite";
import { claimsFromTestHeader } from "../support/claims";
import { drizzleOver } from "../support/drizzle";

const env = readIntegrationEnv();
const localSchemaSql = generateLocalSchemaSql(membershipFanoutSyncRegistry);

// Identities + container fixtures (A & B share workspace 1; C is in workspace 2 only).
//
// EVERY id in this file is generated per run, and must stay that way. A sync engine keeps a per-shape
// log; reusing a fixed id across runs leaves that key's earlier inserts/deletes in the log, and a
// resume then folds a key set that already contains the key. That accumulated history MASKS
// move-out/move-in defects — a revocation that is silently dropped still passes, because the stale
// history makes the eviction reconstructible. It presents as an intermittent failure (the worst
// signature: real data loss that looks like flake), and it is exactly how a silent revocation-loss bug
// survived undetected. Per-test id families are not enough — they isolate tests from each other WITHIN
// a run, not successive runs from each other. Never reintroduce a literal UUID here.
const uuid = () => crypto.randomUUID();

const MEMBER_A = uuid();
const MEMBER_B = uuid();
const NON_MEMBER_C = uuid();
const OUTSIDER_D = uuid();
const WORKSPACE_1 = uuid();
const WORKSPACE_2 = uuid();
const ITEM_A_IN_W1 = uuid();
const MEMBERSHIP_A_W1 = uuid();
const MEMBERSHIP_B_W1 = uuid();
const MEMBERSHIP_C_W2 = uuid();

async function createLocalWorkItemStore() {
  const pg = await createCircuitsTestPGlite();
  await pg.exec(localSchemaSql);
  return pg;
}

async function startMemberSync(
  localPg: Awaited<ReturnType<typeof createLocalWorkItemStore>>,
  urls: Pick<NativeSyncStack<unknown>, "controlPlaneUrl" | "streamBaseUrl">,
  sub: string,
) {
  let markInitialSyncDone: (() => void) | null = null;
  const initialSyncDone = new Promise<void>((resolve) => {
    markInitialSyncDone = resolve;
  });

  const sync = await startCircuitsSync(localPg, {
    registry: membershipFanoutSyncRegistry,
    controlPlaneUrl: urls.controlPlaneUrl,
    streamBaseUrl: urls.streamBaseUrl,
    metadataSchema: DEFAULT_METADATA_SCHEMA,
    authHeaders: () => ({ "x-test-sub": sub }),
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
  let stack!: NativeSyncStack<ReturnType<typeof createSyncServer<typeof membershipFanoutSyncRegistry>>>;
  let server!: ReturnType<typeof createSyncServer<typeof membershipFanoutSyncRegistry>>;
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

    // createSyncServer serves both the write route and the native control plane from the one server,
    // each resolving the test identity from the x-test-sub header via the shared adapter.
    stack = await startNativeSyncStack({
      env,
      registry: membershipFanoutSyncRegistry,
      createServer: (readPath) =>
        createSyncServer({
          registry: membershipFanoutSyncRegistry,
          db: serverDb.db,
          resolveAuthClaims: claimsFromTestHeader,
          readPath,
        }),
    });
    server = stack.server;
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
      { id: MEMBERSHIP_A_W1, workspaceId: WORKSPACE_1, memberId: MEMBER_A, role: "member" },
      { id: MEMBERSHIP_B_W1, workspaceId: WORKSPACE_1, memberId: MEMBER_B, role: "member" },
      { id: MEMBERSHIP_C_W2, workspaceId: WORKSPACE_2, memberId: NON_MEMBER_C, role: "member" },
    ]);
  });

  afterAll(async () => {
    await stack.stop();
    await serverDb.close();
  });

  it("fans a member's row down to a co-member, but not to a non-member", async () => {
    // Item authored by A in workspace 1 (seeded directly; the read path is what we are proving).
    await server.drizzle
      .insert(workItemsTable)
      .values({ id: ITEM_A_IN_W1, workspaceId: WORKSPACE_1, ownerId: MEMBER_A, body: "from A" });

    const coMemberPg = await createLocalWorkItemStore();
    const nonMemberPg = await createLocalWorkItemStore();
    const coMember = await startMemberSync(coMemberPg, stack, MEMBER_B);
    const nonMember = await startMemberSync(nonMemberPg, stack, NON_MEMBER_C);

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
    const REV_WS = uuid();
    const REV_MEMBER = uuid();
    const REV_MEMBERSHIP = uuid();
    const REV_ITEM = uuid();

    await server.drizzle.insert(workspacesTable).values({ id: REV_WS, ownerId: REV_MEMBER });
    await server.drizzle
      .insert(workspaceMembersTable)
      .values({ id: REV_MEMBERSHIP, workspaceId: REV_WS, memberId: REV_MEMBER, role: "member" });
    await server.drizzle
      .insert(workItemsTable)
      .values({ id: REV_ITEM, workspaceId: REV_WS, ownerId: REV_MEMBER, body: "revoke me" });

    const memberPg = await createLocalWorkItemStore();
    const member = await startMemberSync(memberPg, stack, REV_MEMBER);

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
    const RES_WS = uuid();
    const RES_MEMBER = uuid();
    const RES_MEMBERSHIP = uuid();
    const RES_ITEM = uuid();

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
    const first = await startMemberSync(memberPg, stack, RES_MEMBER);
    await first.initialSyncDone;
    await waitFor(async () => {
      expect(await itemCount(memberPg)).toBe(1);
    });
    first.sync.unsubscribe();

    // While offline: the admin removes the membership.
    await server.drizzle.delete(workspaceMembersTable).where(eq(workspaceMembersTable.id, RES_MEMBERSHIP));

    // Session 2: resume on the SAME store. Catch-up from the persisted offset must deliver the move-out.
    const second = await startMemberSync(memberPg, stack, RES_MEMBER);
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
    const MVI_WS = uuid();
    const MVI_MEMBER = uuid();
    const MVI_MEMBERSHIP = uuid();
    const MVI_ITEM = uuid();

    // The workspace + item exist, but the member has NO membership yet → their shape must be empty.
    await server.drizzle.insert(workspacesTable).values({ id: MVI_WS, ownerId: MVI_MEMBER });
    await server.drizzle
      .insert(workItemsTable)
      .values({ id: MVI_ITEM, workspaceId: MVI_WS, ownerId: MVI_MEMBER, body: "appear on join" });

    const memberPg = await createLocalWorkItemStore();
    const member = await startMemberSync(memberPg, stack, MVI_MEMBER);

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
    const MIN_WS = uuid();
    const MIN_MEMBER = uuid();
    const MIN_MEMBERSHIP = uuid();
    const MIN_ITEM = uuid();

    await server.drizzle.insert(workspacesTable).values({ id: MIN_WS, ownerId: MIN_MEMBER });
    await server.drizzle
      .insert(workItemsTable)
      .values({ id: MIN_ITEM, workspaceId: MIN_WS, ownerId: MIN_MEMBER, body: "offline-join" });

    const memberPg = await createLocalWorkItemStore();

    // Session 1: sync as a non-member (sees nothing), persist the offset, then go OFFLINE (unsubscribe)
    // while keeping the local store.
    const first = await startMemberSync(memberPg, stack, MIN_MEMBER);
    await first.initialSyncDone;
    expect(await itemCount(memberPg)).toBe(0);
    first.sync.unsubscribe();

    // While offline: the admin adds the membership.
    await server.drizzle
      .insert(workspaceMembersTable)
      .values({ id: MIN_MEMBERSHIP, workspaceId: MIN_WS, memberId: MIN_MEMBER, role: "member" });

    // Session 2: resume on the SAME store. Catch-up from the persisted offset must deliver the move-in.
    const second = await startMemberSync(memberPg, stack, MIN_MEMBER);
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
    const A_ITEM = uuid();
    const A_MUTATION = uuid();
    const D_ITEM = uuid();
    const D_MUTATION = uuid();

    const memberWrite = await server.request("/api/mutations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-sub": MEMBER_A },
      body: JSON.stringify({
        mutations: [
          {
            tableName: "work_items",
            entityKey: { id: A_ITEM },
            mutationId: A_MUTATION,
            mutationSeq: 1,
            kind: "create",
            payload: { id: A_ITEM, workspace_id: WORKSPACE_1, body: "A writes" },
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
            entityKey: { id: D_ITEM },
            mutationId: D_MUTATION,
            mutationSeq: 1,
            kind: "create",
            payload: { id: D_ITEM, workspace_id: WORKSPACE_1, body: "D intrudes" },
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
