import type { SyncConfigInput } from "@pgxsinkit/contracts";

import { authorsSyncEntry, todosSyncEntry } from "./schema";

export function buildDemoSyncConfig(electricUrl: string): SyncConfigInput {
  return {
    electricUrl,
    tables: {
      authors: authorsSyncEntry,
      todos: todosSyncEntry,
    },
  };
}
