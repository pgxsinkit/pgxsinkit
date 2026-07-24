import { syncDebug } from "@pgxsinkit/client";

import { supabase } from "../lib/supabase";
import { boardStoreRegistry } from "./store-registry-default";

// Bootstrap prewarm (board cold-boot optimisation B, RELOAD path). On a signed-in reload there is no
// login-screen think-time to hide the store open behind, and the open otherwise doesn't START until the
// board provider mounts — so PGlite's ~1.9s initdb sits fully on the critical path, and begins late.
//
// This kicks the signed-in user's MAPPED store open at app bootstrap (within ~100ms of JS load), in
// parallel with React mount / auth restore / route transition, instead of at provider mount. It reads
// the persisted session directly (bypassing React), and openUserStore's per-userId memoisation makes the
// provider's later openUserStore(userId) ADOPT this same in-flight open rather than starting a second.
//
// Interplay:
//   • Unmapped-but-spare-present: openUserStore CLAIMS the spare here — exactly what the provider would
//     do moments later, so no behaviour change, just earlier.
//   • Fresh anonymous visitor: no session → no-op → the login-screen spare flow is unchanged.
//   • GC: a claim mutates the registry under the cross-tab lock BEFORE any ensureSpare GC could observe
//     the store as unmapped (the orphan sweep keeps every map value plus the spare), so GC can never delete a
//     store this prewarm just opened/claimed.
export async function prewarmMappedStoreForSession(): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user.id;
    syncDebug("boot mapped store prewarm", { hit: userId != null });
    // Fire-and-forget: the provider awaits the memoised result; we only need to START the open here.
    if (userId != null) void boardStoreRegistry.openUserStore(userId);
  } catch {
    // Pure accelerator — any failure (storage/idb/auth) is swallowed; the provider's own openUserStore
    // still boots the store. Never a boot dependency.
  }
}
