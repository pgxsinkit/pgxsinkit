import {
  DEMO_USER1_ID,
  DEMO_USER2_ID,
  DEMO_USER3_ID,
  DEMO_USER4_ID,
  DEMO_USER5_ID,
  type DemoAuthIdentity,
} from "./demo-auth";

/**
 * Deterministic fixture for the membership demo — the single source of truth shared by the seed
 * script (`scripts/seed-demo.ts`) and the web UI (identity labels + interpreting synced rows).
 *
 * Layout, chosen so each scenario is visible by switching identity:
 * - Aurora (open):    user1 = manager, user2 = member, user3 = member (MUTED)
 * - Borealis (locked): user4 = manager, user5 = member
 *
 * Demonstrates:
 * - fan-out:        user2 sees Aurora items it does not own; Borealis members never see them.
 * - asymmetric read: user1 (manager) sees the hidden Aurora item; user2 (member) does not.
 * - mute:           user3 cannot post into Aurora even though Aurora is open.
 * - lock:           user5 cannot post into Borealis; user4 (manager) can.
 */

export const DEMO_WORKSPACE_AURORA_ID = "a0000000-0000-4000-8000-000000000001";
export const DEMO_WORKSPACE_BOREALIS_ID = "b0000000-0000-4000-8000-000000000002";

export type DemoWorkspaceRole = "member" | "manager";

export interface DemoWorkspaceFixture {
  id: string;
  name: string;
  ownerId: string;
  locked: boolean;
}

export interface DemoWorkspaceMemberFixture {
  id: string;
  workspaceId: string;
  memberId: string;
  role: DemoWorkspaceRole;
  muted: boolean;
  /** Identity-picker option this membership belongs to, for UI labels. */
  identity: DemoAuthIdentity;
}

export interface DemoWorkItemFixture {
  id: string;
  workspaceId: string;
  ownerId: string;
  body: string;
  hidden: boolean;
}

export const demoWorkspaces: DemoWorkspaceFixture[] = [
  { id: DEMO_WORKSPACE_AURORA_ID, name: "Aurora", ownerId: DEMO_USER1_ID, locked: false },
  { id: DEMO_WORKSPACE_BOREALIS_ID, name: "Borealis", ownerId: DEMO_USER4_ID, locked: true },
];

export const demoWorkspaceMembers: DemoWorkspaceMemberFixture[] = [
  {
    id: "a1000000-0000-4000-8000-000000000001",
    workspaceId: DEMO_WORKSPACE_AURORA_ID,
    memberId: DEMO_USER1_ID,
    role: "manager",
    muted: false,
    identity: "user1",
  },
  {
    id: "a1000000-0000-4000-8000-000000000002",
    workspaceId: DEMO_WORKSPACE_AURORA_ID,
    memberId: DEMO_USER2_ID,
    role: "member",
    muted: false,
    identity: "user2",
  },
  {
    id: "a1000000-0000-4000-8000-000000000003",
    workspaceId: DEMO_WORKSPACE_AURORA_ID,
    memberId: DEMO_USER3_ID,
    role: "member",
    muted: true,
    identity: "user3",
  },
  {
    id: "b1000000-0000-4000-8000-000000000004",
    workspaceId: DEMO_WORKSPACE_BOREALIS_ID,
    memberId: DEMO_USER4_ID,
    role: "manager",
    muted: false,
    identity: "user4",
  },
  {
    id: "b1000000-0000-4000-8000-000000000005",
    workspaceId: DEMO_WORKSPACE_BOREALIS_ID,
    memberId: DEMO_USER5_ID,
    role: "member",
    muted: false,
    identity: "user5",
  },
];

export const demoWorkItems: DemoWorkItemFixture[] = [
  {
    id: "a2000000-0000-4000-8000-000000000001",
    workspaceId: DEMO_WORKSPACE_AURORA_ID,
    ownerId: DEMO_USER1_ID,
    body: "Welcome to Aurora — every Aurora member syncs this, even though user1 owns it.",
    hidden: false,
  },
  {
    id: "a2000000-0000-4000-8000-000000000002",
    workspaceId: DEMO_WORKSPACE_AURORA_ID,
    ownerId: DEMO_USER1_ID,
    body: "Moderator-only note — Aurora managers sync this hidden row; plain members do not.",
    hidden: true,
  },
  {
    id: "b2000000-0000-4000-8000-000000000001",
    workspaceId: DEMO_WORKSPACE_BOREALIS_ID,
    ownerId: DEMO_USER4_ID,
    body: "Borealis kickoff — Borealis is locked, so only its manager can post here.",
    hidden: false,
  },
];

/** Identity → its memberships, for labelling the identity picker. */
export function demoMembershipsForIdentity(identity: DemoAuthIdentity): DemoWorkspaceMemberFixture[] {
  return demoWorkspaceMembers.filter((member) => member.identity === identity);
}
