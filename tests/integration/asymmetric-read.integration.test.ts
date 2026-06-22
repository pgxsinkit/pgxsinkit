import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { Hono } from "hono";

import { type JwtClaims } from "@pgxsinkit/contracts";
import {
  buildMembershipFanoutSyncConfig,
  membershipFanoutSyncRegistry,
  workItemsTable,
  workspaceMembersTable,
  workspacesTable,
} from "@pgxsinkit/schema";
import { createSyncServer, proxyElectricShapeRequest } from "@pgxsinkit/server";
import { createServerDb, readIntegrationEnv } from "@pgxsinkit/test-utils";

import { generateLocalSchemaSql } from "../../packages/client/src/schema";
import { createElectricExtension, startConfiguredSync } from "../../packages/client/src/shape-sync";
import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/plpgsql-apply";
import { createFreshTestPGlite } from "../support/pglite";

const env = readIntegrationEnv();
const localSchemaSql = generateLocalSchemaSql(membershipFanoutSyncRegistry);

// A manages workspace 1; B is a plain member of the same workspace. Both belong to W1, so the only
// thing distinguishing them is their per-workspace role — which is what asymmetric read turns on.
const MANAGER_A = "1c4f0d2a-0000-4000-8000-000000000a01";
const MEMBER_B = "1c4f0d2a-0000-4000-8000-000000000b02";
const WORKSPACE_1 = "2d5e1e3b-0000-4000-8000-000000000111";
const VISIBLE_ITEM = "3e6f2f4c-0000-4000-8000-0000000000f1";
const HIDDEN_ITEM = "3e6f2f4c-0000-4000-8000-0000000000f2";

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

describe("asymmetric read (role-conditional visibility) integration", () => {
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

    const app = new Hono();
    app.get("/v1/electric-proxy", async (context) =>
      proxyElectricShapeRequest(context.req.raw, claimsFromHeader(context.req.raw), {
        registry: membershipFanoutSyncRegistry,
        electricUrl: env.electricUrl,
      }),
    );

    server = createSyncServer({
      app,
      registry: membershipFanoutSyncRegistry,
      db: serverDb.db,
      resolveAuthClaims: (request) => claimsFromHeader(request),
    });

    httpServer = Bun.serve({ port: 0, fetch: app.fetch });
    proxyUrl = `http://127.0.0.1:${httpServer.port}/v1/electric-proxy`;
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
    await httpServer.stop(true);
    await server.stop();
    await serverDb.close();
  });

  it("streams hidden rows to a workspace manager but not to a plain member", async () => {
    const managerPg = await createLocalWorkItemStore();
    const memberPg = await createLocalWorkItemStore();
    const manager = await startMemberSync(managerPg, proxyUrl, MANAGER_A);
    const member = await startMemberSync(memberPg, proxyUrl, MEMBER_B);

    try {
      await manager.initialSyncDone;
      await member.initialSyncDone;

      // Manager A (role = manager of W1) receives BOTH the visible and the hidden item.
      const managerRows = await managerPg.query<{ id: string; hidden: boolean }>(
        "SELECT id, hidden FROM work_items ORDER BY body;",
      );
      expect(managerRows.rows.map((row) => row.id).sort()).toEqual([VISIBLE_ITEM, HIDDEN_ITEM].sort());
      expect(managerRows.rows.some((row) => row.id === HIDDEN_ITEM && row.hidden)).toBe(true);

      // Member B (role = member of W1) receives ONLY the visible item — same workspace, different role.
      const memberRows = await memberPg.query<{ id: string }>("SELECT id FROM work_items;");
      expect(memberRows.rows.map((row) => row.id)).toEqual([VISIBLE_ITEM]);
    } finally {
      manager.sync.unsubscribe();
      member.sync.unsubscribe();
      await managerPg.close();
      await memberPg.close();
    }
  }, 30_000);
});
