import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { asc } from "drizzle-orm";

import {
  membershipFanoutSyncRegistry,
  workItemsTable,
  workspaceMembersTable,
  workspacesTable,
} from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";
import { createServerDb, readIntegrationEnv, startNativeSyncStack, type NativeSyncStack } from "@pgxsinkit/test-utils";

import { startCircuitsSync } from "../../packages/client/src/circuits/group-sync";
import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { DEFAULT_METADATA_SCHEMA } from "../../packages/client/src/sync/metadata-tables";
import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/plpgsql-apply";
import { createCircuitsTestPGlite } from "../support/circuits-pglite";
import { claimsFromTestHeader } from "../support/claims";
import { drizzleOver } from "../support/drizzle";

const env = readIntegrationEnv();
const localSchemaSql = generateLocalSchemaSql(membershipFanoutSyncRegistry);

// A manages workspace 1; B is a plain member of the same workspace. Both belong to W1, so the only
// thing distinguishing them is their per-workspace role — which is what asymmetric read turns on.
const MANAGER_A = "1c4f0d2a-0000-4000-8000-000000000a01";
const MEMBER_B = "1c4f0d2a-0000-4000-8000-000000000b02";
const WORKSPACE_1 = "2d5e1e3b-0000-4000-8000-000000000111";
const VISIBLE_ITEM = "3e6f2f4c-0000-4000-8000-0000000000f1";
const HIDDEN_ITEM = "3e6f2f4c-0000-4000-8000-0000000000f2";

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

  // The subject rides the SAME per-request adapter production uses; the control plane resolves it
  // into claims and fuses them into the shape predicate, so two members of one workspace subscribe
  // to the same shapeKey and are handed different streams.
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

describe("asymmetric read (role-conditional visibility) integration", () => {
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

    // createSyncServer serves the native control plane itself, sharing the one resolveAuthClaims
    // adapter with the write route (ADR-0003) — no framework wrapper needed.
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

    await server.drizzle.insert(workspacesTable).values([{ id: WORKSPACE_1, ownerId: MANAGER_A }]);
    await server.drizzle.insert(workspaceMembersTable).values([
      { id: "4f70305d-0000-4000-8000-0000000000a1", workspaceId: WORKSPACE_1, memberId: MANAGER_A, role: "manager" },
      { id: "4f70305d-0000-4000-8000-0000000000b2", workspaceId: WORKSPACE_1, memberId: MEMBER_B, role: "member" },
    ]);
    // Two items in the same workspace: one visible to all members, one hidden (e.g. moderated).
    await server.drizzle.insert(workItemsTable).values([
      { id: VISIBLE_ITEM, workspaceId: WORKSPACE_1, ownerId: MEMBER_B, body: "visible", hidden: false },
      { id: HIDDEN_ITEM, workspaceId: WORKSPACE_1, ownerId: MEMBER_B, body: "hidden", hidden: true },
    ]);
  });

  afterAll(async () => {
    await stack.stop();
    await serverDb.close();
  });

  it("streams hidden rows to a workspace manager but not to a plain member", async () => {
    const managerPg = await createLocalWorkItemStore();
    const memberPg = await createLocalWorkItemStore();
    const manager = await startMemberSync(managerPg, stack, MANAGER_A);
    const member = await startMemberSync(memberPg, stack, MEMBER_B);

    try {
      await manager.initialSyncDone;
      await member.initialSyncDone;

      // Manager A (role = manager of W1) receives BOTH the visible and the hidden item.
      const managerRows = await drizzleOver(managerPg)
        .select({ id: workItemsTable.id, hidden: workItemsTable.hidden })
        .from(workItemsTable)
        .orderBy(asc(workItemsTable.body));
      expect(managerRows.map((row) => row.id).sort()).toEqual([VISIBLE_ITEM, HIDDEN_ITEM].sort());
      expect(managerRows.some((row) => row.id === HIDDEN_ITEM && row.hidden)).toBe(true);

      // Member B (role = member of W1) receives ONLY the visible item — same workspace, different role.
      const memberRows = await drizzleOver(memberPg).select({ id: workItemsTable.id }).from(workItemsTable);
      expect(memberRows.map((row) => row.id)).toEqual([VISIBLE_ITEM]);
    } finally {
      manager.sync.unsubscribe();
      member.sync.unsubscribe();
      await managerPg.close();
      await memberPg.close();
    }
  }, 30_000);
});
