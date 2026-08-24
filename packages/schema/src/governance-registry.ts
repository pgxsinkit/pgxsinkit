import { defineSyncRegistry } from "@pgxsinkit/contracts";

import {
  fkSyncRegistry,
  membershipFanoutSyncRegistry,
  projectionKeyRowsSyncRegistry,
  projectsSyncRegistry,
  rlsSyncRegistry,
} from "./integration";
import { demoSyncRegistry } from "./registry";

export const governanceSyncRegistry = defineSyncRegistry({
  ...demoSyncRegistry,
  ...projectsSyncRegistry,
  ...projectionKeyRowsSyncRegistry,
  ...fkSyncRegistry,
  ...rlsSyncRegistry,
  ...membershipFanoutSyncRegistry,
});
