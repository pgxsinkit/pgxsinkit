import { defineSyncRegistry } from "@pgxsinkit/contracts";

import { authorsSyncEntry, todosSyncEntry } from "./schema";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function isAdmin(claims: Record<string, unknown>): boolean {
  const meta = claims.app_metadata;
  if (typeof meta !== "object" || meta === null) return false;
  const roles = (meta as Record<string, unknown>).roles;
  return Array.isArray(roles) && roles.includes("admin");
}

function ownershipRowFilter(claims: Record<string, unknown>): string | null {
  if (isAdmin(claims)) {
    return null;
  }

  if (typeof claims.sub === "string" && claims.sub) {
    return `"owner_id" = '${escapeSqlLiteral(claims.sub)}'`;
  }

  return "1 = 0";
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
