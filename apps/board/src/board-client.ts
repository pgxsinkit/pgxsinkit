import { useSyncExternalStore } from "react";

import { boardMemberRegistry, boardSyncRegistry } from "@pgxsinkit/board-schema";
import {
  attachSyncClient,
  type AuthTokenSnapshot,
  type BootReport,
  createSyncClient,
  syncDebug,
  type SyncClient,
} from "@pgxsinkit/client";
import { attachSyncRegistryStorage, type SyncRuntimeStatus } from "@pgxsinkit/contracts";
import { createSyncClientHooks } from "@pgxsinkit/react";

import { createOfflineControl, createWorkerOfflineControl, type OfflineControl } from "./board/offline";
import { warmPgliteBootAssets } from "./board/pglite-warm";
import { boardStorageDeclaration, readBackendPreference, readDurabilityPreference } from "./board/storage-preference";
import { boardEngineWorkerFactory, boardStoreRegistry, boardWorkerMode } from "./board/store-registry-default";
import { boardConfig } from "./config";
import { supabase } from "./lib/supabase";

// SharedWorker-death resilience (ADR-0049 D5): with the `worker` FACTORY form, a pending op left with NO bridge
// traffic for this long triggers ONE reconnect that rebuilds the store's SharedWorker (via the factory) and
// re-attaches. Long enough that a slow-but-live engine — which keeps emitting bridge traffic, re-arming the
// timer — never false-triggers; short enough to recover a genuinely dead worker without a manual reload.
const BOARD_BRIDGE_SILENCE_MS = 20_000;

// One set of registry-typed hooks for the whole app (board ADR-0001 read path). Components read the
// local PGlite store reactively via `useLiveRows` / `useLiveDrizzleRows`; the live data is whatever
// `board-sync` has streamed in for the signed-in identity.
export const { SyncClientProvider, useSyncClient, useLiveRows, useLiveDrizzleRows, useMutationSummary } =
  createSyncClientHooks<typeof boardSyncRegistry>();

/**
 * Build the board's sync client for a signed-in identity. `getAuthToken` is resolved **per request**
 * (read shapes and writes both call it fresh) so a refreshed GoTrue token is always used. Each identity
 * gets its own local store via the spare-store registry (a userId→storeId binding), so switching identity
 * uses a separate IndexedDB rather than inheriting the previous user's synced rows.
 *
 * `autoSync` is a pausable convergence trigger (board Phase 8): the standard browser trigger (online /
 * visibilitychange / a 1.5s fallback) gated behind the Offline toggle. Each pass runs `flush` (send
 * pending mutations to `board-write`) → `reconcile` (clear the optimistic Overlay once the server value
 * streams back via Electric), started once sync is ready and stopped on `stop()`. While the toggle is
 * Offline the pass is suppressed, so writes stage into the local journal and only flush on reconnect.
 * Returns the client paired with its {@link OfflineControl} so the UI can drive the toggle.
 */
// The tab is the single auth owner (ADR-0013): read the current session token, richer than the string
// form because the worker needs the EXPIRY to apply its pull margin (ADR-0032 decision 3). `expires_at`
// is unix seconds; the snapshot wants epoch ms.
async function currentTokenSnapshot(userId: string): Promise<AuthTokenSnapshot | null> {
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  // A stopped in-process client may still be finishing asynchronous teardown while another identity signs in.
  // Never let that old client borrow the new identity's token for its old, separately mapped store.
  if (session?.user.id !== userId || session.access_token == null) return null;
  return { accessToken: session.access_token, expiresAt: (session.expires_at ?? 0) * 1000 };
}

// Boot observability dogfood (pgxsinkit ADR-0034). Every boot's report goes three places: one compact line
// on the board's existing `syncDebug` rail (fires only under `globalThis.__pgxsinkitDebug`), the full report
// on a dev-only global beside `__boardClient` / `__boardProfiler` for console inspection, and — for EVERY
// visitor, dev build or not — the module-level observable below, which the Sync Inspector's Storage readout
// renders. That readout is the post-boot half of the login screen's storage promise (docs/mobile.md Stage B
// item 2: the offered preferences are truthful, what was missing is telling the user what actually engaged).
// Idempotent per boot: the push (`onBootReport`) and the late-attach pull (`bootReport()`) can both deliver
// the SAME report, so we key on `startedAt` and log/publish it once.
let lastLoggedBootAt = -1;
let latestBootReport: BootReport | null = null;
const bootReportListeners = new Set<() => void>();

function publishBootReport(report: BootReport | null): void {
  latestBootReport = report;
  for (const listener of bootReportListeners) listener();
}

function subscribeBootReport(onChange: () => void): () => void {
  bootReportListeners.add(onChange);
  return () => {
    bootReportListeners.delete(onChange);
  };
}

/**
 * The latest boot's {@link BootReport}, or `null` before one lands. A module-level external store rather
 * than context: the report is produced OUTSIDE React (by `createBoardSyncClient`, and possibly by the
 * late-attach pull well after first paint), there is exactly one live client per page, and a component that
 * mounts long afterwards — the inspector drawer, opened minutes into a session — must still see it.
 */
export function useBootReport(): BootReport | null {
  return useSyncExternalStore(
    subscribeBootReport,
    () => latestBootReport,
    () => null,
  );
}

/** Clear the de-dupe key + the published report (provider teardown — an identity switch boots a new store). */
export function resetBoardBootReport(): void {
  lastLoggedBootAt = -1;
  publishBootReport(null);
}

function reportBoot(report: BootReport): void {
  if (report.startedAt === lastLoggedBootAt) return;
  lastLoggedBootAt = report.startedAt;
  publishBootReport(report);
  const rows = report.groups.reduce((sum, group) => sum + group.rows, 0);
  const requests = report.groups.reduce((sum, group) => sum + group.requests, 0);
  // fetchMs/applyMs are concurrent per-group segments, not a partition of totalMs — so the summary reports
  // the headline totalMs and volume, not a fabricated network/apply split (ADR-0034).
  syncDebug("boot report", {
    mode: report.mode,
    totalMs: Math.round(report.totalMs),
    freshStore: report.freshStore,
    overlapPrefetch: report.overlapPrefetch,
    provisioned: report.provision != null,
    groups: report.groups.length,
    rows,
    requests,
  });
  if (import.meta.env.DEV || import.meta.env["VITE_E2E"] === "1") {
    (globalThis as typeof globalThis & { __boardBootReport?: BootReport }).__boardBootReport = report;
  }
}

export async function createBoardSyncClient(
  userId: string,
  isAdmin: boolean,
  onStatusChange?: (status: SyncRuntimeStatus) => void,
): Promise<{
  client: SyncClient<typeof boardSyncRegistry>;
  offline: OfflineControl;
  /** Which engine hosts this client — worker-attached (SharedWorker) or in-process (fallback). */
  mode: "worker" | "in-process";
}> {
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
  const role = isAdmin ? "admin" : "member";

  // Resolve this identity's store binding (board optimisation B): a returning user's mapped store, the
  // claimed login-screen spare, or a fresh one. In WORKER mode the returned `pglite` is a placeholder —
  // the raw store lives in the worker, which the same call has just constructed + `provision`ed (initdb
  // running inside it); we attach to that same worker by store name below. In the in-process fallback the
  // returned `pglite` is the real precreated instance the library adopts.
  const store = await boardStoreRegistry.openUserStore(userId);

  // ── Worker mode (ADR-0032 shared worker): the engine lives off the tab; attach a thin tab client via the
  // store's SharedWorker FACTORY (ADR-0049 D5) — a fresh connection that adopts the store `createStore`
  // provisioned (by storePath, not by sharing its port), and that `bridgeSilenceMs` rebuilds on a dead worker. ──
  if (boardWorkerMode && store.storeId != null) {
    const client = await attachSyncClient({
      registry,
      // The `worker` FACTORY form (not `port:`) arms SharedWorker-death recovery: paired with
      // `bridgeSilenceMs`, a silent (presumed-dead) engine triggers ONE reconnect that rebuilds the store's
      // SharedWorker through this factory and re-attaches (ADR-0049 D5). Provision minted on its own
      // connection; this attach adopts that store by storePath — the handoff is port-agnostic.
      worker: boardEngineWorkerFactory(store.storePath),
      bridgeSilenceMs: BOARD_BRIDGE_SILENCE_MS,
      storeId: store.storeId,
      storePath: store.storePath,
      // The wire storage declaration (ADR-0050): posted pre-placement on the port and bound by the engine.
      // The board's registries are storage-silent (the preferences are a dynamic demo toggle), so this wire
      // declaration is what decides backend (probe vs declared idbfs) and durability.
      storage: boardStorageDeclaration(readDurabilityPreference(), readBackendPreference()),
      // The worker bakes both registries and selects by role at boot (the spare was provisioned before
      // the role was known); the tab additionally builds its OWN write handles from `registry` above.
      role,
      // Fresh-store prefetch overlap (ADR-0032 S4): a just-claimed spare / fresh create is schemaless, so
      // let the worker overlap the shape catch-up with schema exec + journal recovery + reconcile. A
      // returning user's mapped store is NOT fresh, so this stays false and the worker boots sequentially.
      freshStore: store.fresh,
      // The tab pushes this at attach + on notifyAuthChanged, and answers the worker's expiry pulls.
      getToken: () => currentTokenSnapshot(userId),
      // Boot observability (ADR-0034): the one-shot push fires only if THIS tab is attached when the
      // worker's boot finalizes.
      onBootReport: reportBoot,
      ...(onStatusChange ? { onStatusChange } : {}),
    });
    // The Offline toggle forwards over the bridge (`set-online`) — the worker owns the convergence driver.
    const offline = createWorkerOfflineControl((online) => client.setOnline(online));
    // Late-attach fallback (ADR-0034): a tab that attaches AFTER the worker's boot finalized never gets the
    // `onBootReport` push, so pull the engine's stored report to still surface it. `reportBoot` de-dupes if
    // the push already delivered the same boot.
    void client.bootReport().then((report) => {
      if (report) reportBoot(report);
    });
    return { client, offline, mode: "worker" };
  }

  // ── In-process fallback (no SharedWorker, ADR-0032 decision 2): today's main-thread engine, intact. ──
  // In-process there is no worker port and therefore no wire declaration (ADR-0050) — the registry object
  // lives in this one scope, so stamping the boot-read demo preferences onto it IS the static declaration
  // `createSyncClient`'s single mint seam resolves. Same shape as the wire declaration
  // (`boardStorageDeclaration`: `durability` always, `backend: "idbfs"` only when forced). The precreate the
  // store registry baked is already idb-only (createClientPGlite runs no opfs probe), so the backend stamp
  // only records the declared contract here — it does not re-home this already-created store.
  attachSyncRegistryStorage(registry, boardStorageDeclaration(readDurabilityPreference(), readBackendPreference()));
  const offline = createOfflineControl();
  const client = await createSyncClient({
    registry,
    electricUrl: boardConfig.electricUrl,
    batchWriteUrl: boardConfig.batchWriteUrl,
    // The publishable key rides as `apikey` on every read shape + write request (toolkit ADR: generic
    // requestHeaders). The gateway validates it; a signed-in user's session token in Authorization is
    // left untouched, so identity still reaches board-sync/board-write (board ADR-0007/0008).
    requestHeaders: {
      apikey: boardConfig.publishableKey,
    },
    // `x-region` (when configured) pins Supabase edge-function execution to the DATABASE's region — but
    // ONLY on the write path (board-write), whose chatty function→DB protocol then runs on a ~1ms loop.
    // The read proxy (board-sync) is deliberately left UNPINNED: its upstream is Electric Cloud's
    // globally-distributed CDN, so pinning reads away from a distant caller pays intercontinental round
    // trips per catch-up hop (~1.2s) instead of following the caller (~300ms). See boardConfig.functionsRegion.
    ...(boardConfig.functionsRegion ? { writeRequestHeaders: { "x-region": boardConfig.functionsRegion } } : {}),
    // Consume the login-screen pre-warm (see ./board/pglite-warm): the WASM fetch+compile ran during
    // identity-picker think-time, so `PGlite.create` skips its own cold asset load. The module-singleton
    // returns the same promise the login mount already primed; a failed warm is caught internally and
    // falls back to PGlite's own loading, so this never risks the boot.
    pgliteBootAssets: warmPgliteBootAssets(),
    getAuthToken: async () => {
      const { data } = await supabase.auth.getSession();
      return data.session?.user.id === userId ? data.session.access_token : undefined;
    },
    ...(store.pglite ? { precreatedPglite: store.pglite } : {}),
    storePath: store.storePath,
    // Fresh-store prefetch overlap (ADR-0032 S4): the in-process fallback overlaps the shape catch-up with
    // schema exec + journal recovery + reconcile when the store is a just-claimed spare / fresh create.
    freshStore: store.fresh,
    autoSync: offline.trigger,
    // Boot observability (ADR-0034): in-process the push always fires at boot completion.
    onBootReport: reportBoot,
    ...(onStatusChange ? { onStatusChange } : {}),
  });
  return { client, offline, mode: "in-process" };
}
