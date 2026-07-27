import "@mantine/core/styles.css";
import { Center, Loader, MantineProvider } from "@mantine/core";
import { RouterProvider } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";

import { syncDebug } from "@pgxsinkit/client";

import { AuthProvider, useAuth } from "./auth/auth";
import { BoardClientProvider } from "./board/board-client-provider";
import { applyPendingLocalDataWipe } from "./board/local-data";
import { prewarmMappedStoreForSession } from "./board/store-prewarm";
import { boardStoreRegistry } from "./board/store-registry-default";
import { router } from "./router";
import { theme } from "./theme";

// Dev-only: turn on the toolkit's opt-in sync/convergence instrumentation so the console shows the
// per-phase timing of a write (enqueue → convergence pass → board-write → Electric echo → apply →
// live-query re-render). Filter the console to "pgxsinkit" and enable Verbose to read it; flip off at
// runtime with `globalThis.__pgxsinkitDebug = false`. Never on in a production build — except the e2e
// lane's (`VITE_E2E=1`): its scenarios assert the rail lines against the built artifact.
if (import.meta.env.DEV || import.meta.env["VITE_E2E"] === "1") {
  (globalThis as { __pgxsinkitDebug?: boolean }).__pgxsinkitDebug = true;
}

// Auth gate for the whole app. The router (and its routes) only mount inside `BoardClientProvider`
// when there is a session, so every authenticated route can rely on the live sync client; the
// unauthenticated tree still mounts the router so `/login` renders (and other routes redirect to it).
function AppRoot() {
  const { session, loading, isAdmin } = useAuth();
  if (loading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (session == null) {
    return <RouterProvider router={router} />;
  }
  return (
    <BoardClientProvider key={session.user.id} userId={session.user.id} isAdmin={isAdmin}>
      <RouterProvider router={router} />
    </BoardClientProvider>
  );
}

const navigateToLogin = () => router.navigate({ to: "/login" });

void (async () => {
  // A requested "Delete local data" wipe runs HERE, before anything below constructs a worker or opens a
  // store: this is the one moment THIS document holds nothing. The reload does not free the stores outright —
  // the board's workers are `extendedLifetime: true` and survive their document for a grace period — so the
  // wipe waits through blocked deletes under a per-target deadline and retains anything still held on the
  // registry's Obsolete list for `destroyObsoleteStores` to retry each boot (see local-data.ts). A no-wipe
  // boot returns immediately; a wipe is timeout-clamped per target, so boot can never hang on it.
  await applyPendingLocalDataWipe();

  // Offline return (board ADR-0010): register the runtime-capture service worker that lets a signed-in
  // User reopen the board with no connectivity. `public/sw.js` is copied to the build root, so with base
  // `/demo/` it serves at `/demo/sw.js` and its default scope is `/demo/` — the same file, correctly
  // scoped, on both surfaces. PROD-gated: `vite dev` serves un-hashed modules a cached copy would shadow,
  // and the dev boot must stay a straight line to the sources. The e2e lane runs the BUILT app under
  // `vite preview`, so the worker IS active there — deliberately, since it is what the offline-return
  // scenarios exercise. Never awaited and never allowed to throw: registration is a background capability,
  // not a boot dependency.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    void (async () => {
      try {
        await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
        const registration = await navigator.serviceWorker.ready;
        // First-session backfill (ADR-0010): the entry assets — this document's own script/style graph —
        // were fetched during parse, BEFORE the worker existed, so runtime capture structurally misses
        // them and a single-session visitor would have no offline shell. Hand the worker the same-origin
        // URLs this session already fetched (nothing a drive-by visitor didn't download anyway); it
        // caches the ones it missed while we are still online, mostly straight from the HTTP cache.
        // Deferred off the boot path — the capture window has no deadline while the session is up.
        setTimeout(() => {
          const urls = [
            ...new Set(
              performance
                .getEntriesByType("resource")
                .map((entry) => entry.name)
                .filter((name) => name.startsWith(location.origin)),
            ),
          ];
          registration.active?.postMessage({ type: "backfill", urls });
        }, 3000);
      } catch (cause: unknown) {
        syncDebug(
          `board service worker registration failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    })();
  }

  // Obsolete-store cleanup (ADR-0050): destroy the store paths a past "Apply & reload" dropped —
  // fire-and-forget in the background, NEVER awaited on the boot path. A path a live extended-lifetime
  // worker still holds fails its delete and simply stays listed for the next boot's retry.
  void boardStoreRegistry.destroyObsoleteStores();

  // Eager mapped-store open (board cold-boot optimisation B, reload path). On a signed-in reload the
  // user's PGlite store open otherwise doesn't start until BoardClientProvider mounts — its ~1.9s initdb
  // then sits fully on the critical path. Kicking it here (before React render) starts the
  // open in parallel with React mount / auth restore / route transition; openUserStore's per-userId memo
  // makes the provider's later call adopt this in-flight open. Guarded internally: a fresh anonymous
  // visitor has no session → this no-ops, and any failure is swallowed (never a boot dependency).
  void prewarmMappedStoreForSession();

  // Note: deliberately no <React.StrictMode>. The board boots a single stateful PGlite/IndexedDB
  // instance per identity (BoardClientProvider); StrictMode's dev-only double-invoke would open it
  // twice on the same store path. Lifecycle is managed explicitly via the provider's effect cleanup.
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <AuthProvider navigateToLogin={navigateToLogin}>
        <AppRoot />
      </AuthProvider>
    </MantineProvider>,
  );
})();
