import type { SyncConfigInput, TableSpecInput } from "@pgxsinkit/contracts";

import { authorsSyncEntry, todosSyncEntry } from "./schema";

export function buildDemoSyncConfig(
  electricUrl: string,
): SyncConfigInput<{ authors: TableSpecInput; todos: TableSpecInput }> {
  return {
    electricUrl,
    tables: {
      authors: authorsSyncEntry,
      todos: todosSyncEntry,
    },
  };
}
