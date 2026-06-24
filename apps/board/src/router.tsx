import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { HomeRoute } from "./routes/home";
import { LoginRoute } from "./routes/login";
import { RootLayout } from "./routes/root";

const rootRoute = createRootRoute({ component: RootLayout });

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeRoute,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginRoute,
});

const routeTree = rootRoute.addChildren([homeRoute, loginRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
