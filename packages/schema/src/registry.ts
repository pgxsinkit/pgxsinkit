import { sql } from "drizzle-orm";

import { c, defineSyncRegistry, type JwtClaims } from "@pgxsinkit/contracts";

import { membershipFanoutSyncRegistry } from "./integration";
import { authorsSyncEntry, todosSyncEntry } from "./schema";

function isAdmin(claims: JwtClaims): boolean {
  return claims.app_metadata?.roles?.includes("admin") ?? false;
}

function ownershipRowFilter(claims: JwtClaims) {
  if (isAdmin(claims)) {
    return null;
  }

  if (!claims.sub) {
    return "1 = 0";
  }

  // authors + todos both carry owner_id; c() emits the bare name, identical for either table. The
  // subject is a bound param, not a hand-escaped literal.
  return sql`${c(authorsSyncEntry.table.ownerId)} = ${claims.sub}`;
}

export const demoSyncRegistry = defineSyncRegistry({
  authors: {
    ...authorsSyncEntry,
    shape: { ...authorsSyncEntry.shape!, rowFilter: { customWhere: ownershipRowFilter } },
  },
  todos: {
    ...todosSyncEntry,
    shape: { ...todosSyncEntry.shape!, rowFilter: { customWhere: ownershipRowFilter } },
  },
});

// The registry the demo website + write-api use: the authors/todos ownership demo plus the
// membership scenarios (readonly workspaces + workspace_members, readwrite work_items). Kept separate
// from `demoSyncRegistry` so the existing demo-registry tests stay pinned to authors/todos only.
export const demoMembershipSyncRegistry = defineSyncRegistry({
  ...demoSyncRegistry,
  ...membershipFanoutSyncRegistry,
});
