import { defineSyncRegistry } from "@pgxsinkit/contracts";

import { fkSyncRegistry, membershipFanoutSyncRegistry, projectsSyncRegistry, rlsSyncRegistry } from "./integration";
import { demoSyncRegistry } from "./registry";

export const governanceSyncRegistry = defineSyncRegistry({
  ...demoSyncRegistry,
  ...projectsSyncRegistry,
  ...fkSyncRegistry,
  ...rlsSyncRegistry,
  ...membershipFanoutSyncRegistry,
});
