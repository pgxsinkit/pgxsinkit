import { boardSyncRegistry } from "@pgxsinkit/board-schema";
import { createBrowserConvergenceTrigger, createSyncClient } from "@pgxsinkit/client";
import type { SyncRuntimeStatus } from "@pgxsinkit/contracts";
import { createSyncClientHooks } from "@pgxsinkit/react";

import { boardConfig } from "./config";
import { supabase } from "./lib/supabase";

// One set of registry-typed hooks for the whole app (board ADR-0001 read path). Components read the
// local PGlite store reactively via `useLiveRows` / `useLiveDrizzleRows`; the live data is whatever
// `board-sync` has streamed in for the signed-in identity.
export const { SyncClientProvider, useSyncClient, useLiveRows, useLiveDrizzleRows } =
  createSyncClientHooks<typeof boardSyncRegistry>();

/**
 * Build the board's sync client for a signed-in identity. `getAuthToken` is resolved **per request**
 * (read shapes and writes both call it fresh) so a refreshed GoTrue token is always used. The local
 * store is keyed by auth user id, so switching identity uses a separate IndexedDB rather than
 * inheriting the previous user's synced rows.
 *
 * `autoSync` is the browser convergence trigger (online / visibilitychange / a 1.5s fallback). It is
 * what drives the optimistic write path: each pass runs `flush` (send pending mutations to
 * `board-write`) → `reconcile` (clear the optimistic Overlay once the server value streams back via
 * Electric), started once sync is ready and stopped on `stop()`. Without it, `issue.update` would land
 * in the local Overlay and never reach Postgres.
 */
export function createBoardSyncClient(userId: string, onStatusChange?: (status: SyncRuntimeStatus) => void) {
  return createSyncClient({
    registry: boardSyncRegistry,
    electricUrl: boardConfig.electricUrl,
    writeUrl: boardConfig.writeUrl,
    getAuthToken: async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token;
    },
    dataDir: `idb://pgxsinkit-board-${userId}`,
    autoSync: createBrowserConvergenceTrigger(),
    ...(onStatusChange ? { onStatusChange } : {}),
  });
}
