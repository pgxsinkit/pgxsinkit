import { drizzle } from "drizzle-orm/bun-sql";

import {
  demoWorkItems,
  demoWorkspaceMembers,
  demoWorkspaces,
  workItemsTable,
  workspaceMembersTable,
  workspacesTable,
} from "@pgxsinkit/schema";

import { composeCredentials } from "../infra/compose-credentials";

// Connects as the privileged compose role (bypasses RLS) to reset + seed the membership demo
// deterministically. Run after migrations; infra:up calls it automatically.
const databaseUrl = process.env["DATABASE_URL"] ?? composeCredentials.DEFAULT_DATABASE_URL;

async function main(): Promise<void> {
  const db = drizzle({ connection: databaseUrl });

  // Reset (children first for the FK), then seed.
  await db.delete(workItemsTable);
  await db.delete(workspaceMembersTable);
  await db.delete(workspacesTable);

  await db.insert(workspacesTable).values(
    demoWorkspaces.map((workspace) => ({
      id: workspace.id,
      ownerId: workspace.ownerId,
      name: workspace.name,
      locked: workspace.locked,
    })),
  );
  await db.insert(workspaceMembersTable).values(
    demoWorkspaceMembers.map((member) => ({
      id: member.id,
      workspaceId: member.workspaceId,
      memberId: member.memberId,
      role: member.role,
      muted: member.muted,
    })),
  );
  await db.insert(workItemsTable).values(
    demoWorkItems.map((item) => ({
      id: item.id,
      workspaceId: item.workspaceId,
      ownerId: item.ownerId,
      body: item.body,
      hidden: item.hidden,
    })),
  );

  console.log(
    `Seeded membership demo: ${demoWorkspaces.length} workspaces, ${demoWorkspaceMembers.length} members, ${demoWorkItems.length} work items.`,
  );
}

await main();
