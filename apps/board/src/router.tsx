import { createHashHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

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

// The hosted GitHub Pages /demo build sets VITE_BOARD_HASH_ROUTING=1 (board ADR-0009): GitHub Pages
// serves the *root* /404.html for any unknown path site-wide, and that root 404 belongs to the docs
// site this demo is published alongside — so a path-based deep-link/refresh into /demo/login would hit
// the docs 404, not the board. Hash history keeps every route under /demo/index.html, so deep-links and
// refreshes always boot the SPA. Local dev and `board:cloud:dev` keep clean path URLs (browser history).
// `history` is spread in only when hash routing is on — `exactOptionalPropertyTypes` forbids passing
// `history: undefined`, and an absent key is what selects the default browser history.
const hashRouting = import.meta.env["VITE_BOARD_HASH_ROUTING"] === "1";

export const router = createRouter({
  routeTree,
  ...(hashRouting ? { history: createHashHistory() } : {}),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
