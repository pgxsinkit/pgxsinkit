import { boardMemberRegistry, boardSyncRegistry } from "@pgxsinkit/board-schema";
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
  isAdmin: boolean,
  onStatusChange?: (status: SyncRuntimeStatus) => void,
): Promise<{
  client: Awaited<ReturnType<typeof createSyncClient<typeof boardSyncRegistry>>>;
  offline: OfflineControl;
}> {
  const offline = createOfflineControl();
  // Per-role mode projection (pgxsinkit ADR-0025). An Admin client uses the authoritative registry —
  // `team` (rename) and `team_member` (add/remove) are readwrite, so it gets their local write
  // machinery + write handles. A Member uses `boardMemberRegistry`, where both are `asReadonly`: same
  // rows stream in, but no overlay/journal and no `client.tables.team{,_member}` write handle, so a
  // Member can never optimistically apply a write that RLS would only quarantine. The hooks + client
  // type stay the authoritative shape; the member registry preserves its read contract (asserted in
  // board-schema), so this cast only narrows runtime write capability — it never widens what is read.
  const registry: typeof boardSyncRegistry = isAdmin
    ? boardSyncRegistry
    : (boardMemberRegistry as typeof boardSyncRegistry);
  const client = await createSyncClient({
    registry,
    electricUrl: boardConfig.electricUrl,
    writeUrl: boardConfig.writeUrl,
    // The publishable key rides as `apikey` on every read shape + write request (toolkit ADR: generic
    // requestHeaders). The gateway validates it; a signed-in user's session token in Authorization is
    // left untouched, so identity still reaches board-sync/board-write (board ADR-0007/0008).
    requestHeaders: { apikey: boardConfig.publishableKey },
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
