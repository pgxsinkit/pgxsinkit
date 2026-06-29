import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { AllRoute } from "./routes/all";
import { DatabaseRoute } from "./routes/database";
import { HomeRoute } from "./routes/home";
import { LoginRoute } from "./routes/login";
import { MembersRoute } from "./routes/members";
import { RootLayout } from "./routes/root";
import { TeamBoardRoute } from "./routes/team-board";
import { TeamChatRoute } from "./routes/team-chat";

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

const teamBoardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/team/$teamId/board",
  component: TeamBoardRoute,
});

const teamChatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/team/$teamId/chat",
  component: TeamChatRoute,
});

const allRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/all",
  component: AllRoute,
});

const membersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/members",
  component: MembersRoute,
});

const databaseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/database",
  component: DatabaseRoute,
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  loginRoute,
  teamBoardRoute,
  teamChatRoute,
  allRoute,
  membersRoute,
  databaseRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
