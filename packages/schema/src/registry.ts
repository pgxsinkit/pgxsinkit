import { defineSyncRegistry } from "@pgxsinkit/contracts";

import { membershipFanoutSyncRegistry } from "./integration";
import { authorsSyncEntry, todosSyncEntry } from "./schema";

export const demoSyncRegistry = defineSyncRegistry({
  authors: authorsSyncEntry,
  todos: todosSyncEntry,
});

// The registry the demo website + write-api use: the authors/todos ownership demo plus the
// membership scenarios (readonly workspaces + workspace_members, readwrite work_items). Kept separate
// from `demoSyncRegistry` so the existing demo-registry tests stay pinned to authors/todos only.
export const demoMembershipSyncRegistry = defineSyncRegistry({
  ...demoSyncRegistry,
  ...membershipFanoutSyncRegistry,
});
