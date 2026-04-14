import type { SyncConfigInput } from "@pgxsinkit/contracts";

import { authorTableSpecInput } from "./author-config";
import { todoTableSpecInput } from "./todo-config";

export function buildDemoSyncConfig(electricUrl: string): SyncConfigInput {
  return {
    electricUrl,
    tables: {
      authors: authorTableSpecInput,
      todos: todoTableSpecInput,
    },
  };
}
