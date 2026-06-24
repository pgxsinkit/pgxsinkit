import "@mantine/core/styles.css";
import { Center, Loader, MantineProvider } from "@mantine/core";
import { RouterProvider } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";

import { AuthProvider, useAuth } from "./auth/auth";
import { BoardClientProvider } from "./board/board-client-provider";
import { router } from "./router";
import { theme } from "./theme";

// Auth gate for the whole app. The router (and its routes) only mount inside `BoardClientProvider`
// when there is a session, so every authenticated route can rely on the live sync client; the
// unauthenticated tree still mounts the router so `/login` renders (and other routes redirect to it).
function AppRoot() {
  const { session, loading } = useAuth();
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
    <BoardClientProvider key={session.user.id} userId={session.user.id}>
      <RouterProvider router={router} />
    </BoardClientProvider>
  );
}

// Note: deliberately no <React.StrictMode>. The board boots a single stateful PGlite/IndexedDB
// instance per identity (BoardClientProvider); StrictMode's dev-only double-invoke would open it
// twice on the same `idb://` path. Lifecycle is managed explicitly via the provider's effect cleanup.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="auto">
    <AuthProvider>
      <AppRoot />
    </AuthProvider>
  </MantineProvider>,
);
