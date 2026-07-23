import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { count } from "drizzle-orm";

import { type JwtClaims } from "@pgxsinkit/contracts";
import {
  buildDemoMembershipSyncConfig,
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
import { createServerDb, readIntegrationEnv, waitFor } from "@pgxsinkit/test-utils";

import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { startConfiguredSync } from "../../packages/client/src/shape-sync";
import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/plpgsql-apply";
import { drizzleOver } from "../support/drizzle";
import { createSyncEngineTestPGlite } from "../support/sync-engine-pglite";

const env = readIntegrationEnv();
const localSchemaSql = generateLocalSchemaSql(membershipFanoutSyncRegistry);

function claimsFromHeader(request: Request): JwtClaims | null {
  const sub = request.headers.get("x-test-sub");
  return sub ? { role: "authenticated", sub } : null;
}

async function createLocalStore() {
  const pg = await createSyncEngineTestPGlite();
  await pg.exec(localSchemaSql);
  return pg;
}

async function startClient(pg: Awaited<ReturnType<typeof createLocalStore>>, proxyUrl: string, sub: string) {
  let markDone: (() => void) | null = null;
  const initialSyncDone = new Promise<void>((resolve) => {
    markDone = resolve;
  });

  const sync = await startConfiguredSync(pg as Parameters<typeof startConfiguredSync>[0], {
    syncConfig: buildDemoMembershipSyncConfig(proxyUrl),
    registry: membershipFanoutSyncRegistry,
    shapeHeaders: { "x-test-sub": sub },
    onInitialSync: () => {
      markDone?.();
      markDone = null;
    },
  });

  return { sync, initialSyncDone };
}

describe("demo membership sync (readonly workspaces + members + work_items) integration", () => {
  let server!: ReturnType<typeof createSyncServer<typeof membershipFanoutSyncRegistry>>;
  let httpServer!: ReturnType<typeof Bun.serve>;
  let proxyUrl!: string;
  const serverDb = createServerDb(membershipFanoutSyncRegistry, env.databaseUrl);

  beforeAll(async () => {
    const provisioningServer = createSyncServer({ registry: membershipFanoutSyncRegistry, db: serverDb.db });
    try {
      await installPlpgsqlBatchFunction(provisioningServer.drizzle, membershipFanoutSyncRegistry);
    } finally {
      await provisioningServer.stop();
    }

    // createSyncServer serves the shape proxy itself at a chosen path, sharing the one
    // resolveAuthClaims adapter with the write route (ADR-0003) — no framework wrapper needed.
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
    await httpServer.stop(true);
    await server.stop();
    await serverDb.close();
  });

  it("fans the demo fixture down to each identity with the right readonly + asymmetric filtering", async () => {
    const managerPg = await createLocalStore(); // user1: Aurora manager
    const memberPg = await createLocalStore(); // user2: Aurora member
    const manager = await startClient(managerPg, proxyUrl, DEMO_USER1_ID);
    const member = await startClient(memberPg, proxyUrl, DEMO_USER2_ID);

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
