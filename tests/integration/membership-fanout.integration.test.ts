import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

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
        const rows = await coMemberPg.query<{ body: string }>("SELECT body FROM work_items WHERE id = $1;", [
          ITEM_A_IN_W1,
        ]);
        expect(rows.rows[0]?.body).toBe("from A");
      });

      // C (member of a different workspace) never receives it — the filter actually filters.
      const cRows = await nonMemberPg.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM work_items;");
      expect(cRows.rows[0]?.count).toBe(0);
    } finally {
      coMember.sync.unsubscribe();
      nonMember.sync.unsubscribe();
      await coMemberPg.close();
      await nonMemberPg.close();
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
