import { boardSyncRegistry } from "@pgxsinkit/board-schema";
import { createSyncClient } from "@pgxsinkit/client";
import type { SyncRuntimeStatus } from "@pgxsinkit/contracts";
import { createSyncClientHooks } from "@pgxsinkit/react";

import { createOfflineControl, type OfflineControl } from "./board/offline";
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
 * `autoSync` is a pausable convergence trigger (board Phase 8): the standard browser trigger (online /
 * visibilitychange / a 1.5s fallback) gated behind the Offline toggle. Each pass runs `flush` (send
 * pending mutations to `board-write`) → `reconcile` (clear the optimistic Overlay once the server value
 * streams back via Electric), started once sync is ready and stopped on `stop()`. While the toggle is
 * Offline the pass is suppressed, so writes stage into the local journal and only flush on reconnect.
 * Returns the client paired with its {@link OfflineControl} so the UI can drive the toggle.
 */
export async function createBoardSyncClient(
  userId: string,
  onStatusChange?: (status: SyncRuntimeStatus) => void,
): Promise<{
  client: Awaited<ReturnType<typeof createSyncClient<typeof boardSyncRegistry>>>;
  offline: OfflineControl;
}> {
  const offline = createOfflineControl();
  const client = await createSyncClient({
    registry: boardSyncRegistry,
    electricUrl: boardConfig.electricUrl,
    writeUrl: boardConfig.writeUrl,
    getAuthToken: async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token;
    },
    dataDir: `idb://pgxsinkit-board-${userId}`,
    autoSync: offline.trigger,
    ...(onStatusChange ? { onStatusChange } : {}),
  });
  return { client, offline };
}
