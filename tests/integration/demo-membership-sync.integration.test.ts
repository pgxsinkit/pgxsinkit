import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { count } from "drizzle-orm";

import {
  DEMO_USER1_ID,
  DEMO_USER2_ID,
  DEMO_WORKSPACE_AURORA_ID,
  demoWorkItems,
  demoWorkspaceMembers,
  demoWorkspaces,
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

async function createLocalStore() {
  const pg = await createCircuitsTestPGlite();
  await pg.exec(localSchemaSql);
  return pg;
}

async function startClient(
  pg: Awaited<ReturnType<typeof createLocalStore>>,
  urls: Pick<NativeSyncStack<unknown>, "controlPlaneUrl" | "streamBaseUrl">,
  sub: string,
) {
  let markDone: (() => void) | null = null;
  const initialSyncDone = new Promise<void>((resolve) => {
    markDone = resolve;
  });

  const sync = await startCircuitsSync(pg, {
    registry: membershipFanoutSyncRegistry,
    controlPlaneUrl: urls.controlPlaneUrl,
    streamBaseUrl: urls.streamBaseUrl,
    metadataSchema: DEFAULT_METADATA_SCHEMA,
    authHeaders: () => ({ "x-test-sub": sub }),
    onInitialSync: () => {
      markDone?.();
      markDone = null;
    },
  });

  return { sync, initialSyncDone };
}

describe("demo membership sync (readonly workspaces + members + work_items) integration", () => {
  let stack!: NativeSyncStack<ReturnType<typeof createSyncServer<typeof membershipFanoutSyncRegistry>>>;
  let server!: ReturnType<typeof createSyncServer<typeof membershipFanoutSyncRegistry>>;
  const serverDb = createServerDb(membershipFanoutSyncRegistry, env.databaseUrl);

  beforeAll(async () => {
    const provisioningServer = createSyncServer({ registry: membershipFanoutSyncRegistry, db: serverDb.db });
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

    await server.drizzle.insert(workspacesTable).values(
      demoWorkspaces.map((workspace) => ({
        id: workspace.id,
        ownerId: workspace.ownerId,
        name: workspace.name,
        locked: workspace.locked,
      })),
    );
    await server.drizzle.insert(workspaceMembersTable).values(
      demoWorkspaceMembers.map((member) => ({
        id: member.id,
        workspaceId: member.workspaceId,
        memberId: member.memberId,
        role: member.role,
        muted: member.muted,
      })),
    );
    await server.drizzle.insert(workItemsTable).values(
      demoWorkItems.map((item) => ({
        id: item.id,
        workspaceId: item.workspaceId,
        ownerId: item.ownerId,
        body: item.body,
        hidden: item.hidden,
      })),
    );
  });

  afterAll(async () => {
    await stack.stop();
    await serverDb.close();
  });

  it("fans the demo fixture down to each identity with the right readonly + asymmetric filtering", async () => {
    const managerPg = await createLocalStore(); // user1: Aurora manager
    const memberPg = await createLocalStore(); // user2: Aurora member
    const manager = await startClient(managerPg, stack, DEMO_USER1_ID);
    const member = await startClient(memberPg, stack, DEMO_USER2_ID);

    try {
      await manager.initialSyncDone;
      await member.initialSyncDone;

      const managerDb = drizzleOver(managerPg);
      const memberDb = drizzleOver(memberPg);

      // Manager (user1): syncs Aurora only, their own manager membership, and BOTH work items (hidden too).
      await waitFor(async () => {
        const workspaces = await managerDb.select({ id: workspacesTable.id }).from(workspacesTable);
        expect(workspaces.map((row) => row.id)).toEqual([DEMO_WORKSPACE_AURORA_ID]);

        const members = await managerDb
          .select({ role: workspaceMembersTable.role, muted: workspaceMembersTable.muted })
          .from(workspaceMembersTable);
        expect(members).toEqual([{ role: "manager", muted: false }]);

        const items = await managerDb.select({ count: count() }).from(workItemsTable);
        expect(items[0]?.count).toBe(2); // visible + hidden
      });

      // Member (user2): same workspace, their own member membership, but only the visible work item.
      await waitFor(async () => {
        const workspaces = await memberDb.select({ id: workspacesTable.id }).from(workspacesTable);
        expect(workspaces.map((row) => row.id)).toEqual([DEMO_WORKSPACE_AURORA_ID]);

        const members = await memberDb
          .select({ role: workspaceMembersTable.role, muted: workspaceMembersTable.muted })
          .from(workspaceMembersTable);
        expect(members).toEqual([{ role: "member", muted: false }]);

        const items = await memberDb.select({ hidden: workItemsTable.hidden }).from(workItemsTable);
        expect(items).toEqual([{ hidden: false }]); // no hidden row for a plain member
      });
    } finally {
      manager.sync.unsubscribe();
      member.sync.unsubscribe();
      await managerPg.close();
      await memberPg.close();
    }
  }, 30_000);
});
