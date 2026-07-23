import "@mantine/core/styles.css";
import { Center, Loader, MantineProvider } from "@mantine/core";
import { RouterProvider } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";

import { AuthProvider, useAuth } from "./auth/auth";
import { BoardClientProvider } from "./board/board-client-provider";
import { applyPendingLocalDataWipe } from "./board/local-data";
import { prewarmMappedStoreForSession } from "./board/store-prewarm";
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
  // store: the previous document's reload released every store this page held (a tab cannot terminate a
  // SharedWorker — the reload is what kills it), so this is the one moment the stores are deletable. A
  // no-wipe boot returns immediately; a wipe is timeout-clamped per target, so boot can never hang on it.
  await applyPendingLocalDataWipe();

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
