import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

import { eq } from "drizzle-orm";

import { type JwtClaims } from "@pgxsinkit/contracts";
import {
  membershipFanoutSyncRegistry,
  workItemsTable,
  workspaceMembersTable,
  workspacesTable,
} from "@pgxsinkit/schema";
import { createSyncServer } from "@pgxsinkit/server";
import { createServerDb, readIntegrationEnv } from "@pgxsinkit/test-utils";

import { installPlpgsqlBatchFunction } from "../../packages/server/src/mutations/plpgsql-apply";

const env = readIntegrationEnv();

// All three belong to workspace 1. The write-state gate turns purely on mutable state: whether the
// workspace is locked (manager-only) and whether the caller's membership is muted.
const MEMBER_A = "1d5f0d2a-0000-4000-8000-000000000a01";
const MANAGER_M = "1d5f0d2a-0000-4000-8000-000000000b02";
const MUTED_X = "1d5f0d2a-0000-4000-8000-000000000c03";
const WORKSPACE_1 = "2e6e1e3b-0000-4000-8000-000000000111";

function claimsFromHeader(request: Request): JwtClaims | null {
  const sub = request.headers.get("x-test-sub");
  return sub ? { role: "authenticated", sub } : null;
}

function createWorkItem(sub: string, id: string, mutationId: string) {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/json", "x-test-sub": sub },
    body: JSON.stringify({
      mutations: [
        {
          tableName: "work_items",
          entityKey: { id },
          mutationId,
          mutationSeq: 1,
          kind: "create",
          // owner_id is stamped from the JWT sub (authClaim managed field, claimPath ["sub"]); workspace_id targets W1.
          payload: { id, workspace_id: WORKSPACE_1, body: "a write" },
          clientTimestampUs: String(Date.now() * 1000),
        },
      ],
    }),
  };
}

describe("write-state gating (locked container + muted member) integration", () => {
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

    server = createSyncServer({
      registry: membershipFanoutSyncRegistry,
      db: serverDb.db,
      resolveAuthClaims: (request) => claimsFromHeader(request),
    });
  });

  beforeEach(async () => {
    await server.drizzle.delete(workItemsTable);
    await server.drizzle.delete(workspaceMembersTable);
    await server.drizzle.delete(workspacesTable);

    // Open workspace; A is a plain member, M a manager, X a muted member.
    await server.drizzle.insert(workspacesTable).values([{ id: WORKSPACE_1, ownerId: MANAGER_M, locked: false }]);
    await server.drizzle.insert(workspaceMembersTable).values([
      { id: "5f80305d-0000-4000-8000-0000000000a1", workspaceId: WORKSPACE_1, memberId: MEMBER_A, role: "member" },
      { id: "5f80305d-0000-4000-8000-0000000000b2", workspaceId: WORKSPACE_1, memberId: MANAGER_M, role: "manager" },
      {
        id: "5f80305d-0000-4000-8000-0000000000c3",
        workspaceId: WORKSPACE_1,
        memberId: MUTED_X,
        role: "member",
        muted: true,
      },
    ]);
  });

  afterAll(async () => {
    await server.stop();
    await serverDb.close();
  });

  it("lets a member write into an open, unmuted workspace", async () => {
    const response = await server.request(
      "/api/mutations",
      createWorkItem(MEMBER_A, "6a900000-0000-4000-8000-000000000a01", "7b900000-0000-4000-8000-000000000a01"),
    );
    expect(response.status).toBe(200);

    const rows = await server.drizzle.select().from(workItemsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ownerId).toBe(MEMBER_A);
  }, 30_000);

  it("blocks a member but not a manager once the workspace is locked", async () => {
    await server.drizzle.update(workspacesTable).set({ locked: true }).where(eq(workspacesTable.id, WORKSPACE_1));

    const memberWrite = await server.request(
      "/api/mutations",
      createWorkItem(MEMBER_A, "6a900000-0000-4000-8000-000000000a02", "7b900000-0000-4000-8000-000000000a02"),
    );
    expect(memberWrite.status).not.toBe(200);

    const managerWrite = await server.request(
      "/api/mutations",
      createWorkItem(MANAGER_M, "6a900000-0000-4000-8000-000000000b02", "7b900000-0000-4000-8000-000000000b02"),
    );
    expect(managerWrite.status).toBe(200);

    const rows = await server.drizzle.select().from(workItemsTable);
    expect(rows).toHaveLength(1); // only the manager's row landed
    expect(rows[0]?.ownerId).toBe(MANAGER_M);
  }, 30_000);

  it("blocks a muted member even when the workspace is open", async () => {
    const mutedWrite = await server.request(
      "/api/mutations",
      createWorkItem(MUTED_X, "6a900000-0000-4000-8000-000000000c03", "7b900000-0000-4000-8000-000000000c03"),
    );
    expect(mutedWrite.status).not.toBe(200);

    const okWrite = await server.request(
      "/api/mutations",
      createWorkItem(MEMBER_A, "6a900000-0000-4000-8000-000000000a03", "7b900000-0000-4000-8000-000000000a03"),
    );
    expect(okWrite.status).toBe(200);

    const rows = await server.drizzle.select().from(workItemsTable);
    expect(rows).toHaveLength(1); // muted write rejected; only A's landed
    expect(rows[0]?.ownerId).toBe(MEMBER_A);
  }, 30_000);
});
