// board-write — the mutation ingress (write path), board ADR-0001.
//
// A thin Deno adapter over the toolkit server: `createSyncServer` without `electricUrl` registers
// only the write route (POST /mutations). Identity is resolved from the verified GoTrue JWT; the
// applier switches the RLS actor to `authenticated` and sets the claims, so the board's hand-authored
// policies + the cross-team-move trigger (board ADR-0005) enforce on every write. No shape proxy
// lives here — reads go through the separate `board-sync` function.

import { boardSyncRegistry } from "@pgxsinkit/board-schema";
import { createSyncServer } from "@pgxsinkit/server";

import { resolveBoardClaims } from "../_shared/auth.ts";
import { createBoardDb } from "../_shared/db.ts";
import { routeToMutations } from "../_shared/http.ts";

const server = createSyncServer({
  registry: boardSyncRegistry,
  db: createBoardDb(),
  resolveAuthClaims: resolveBoardClaims,
  // The board client runs on the Vite dev server; widen if the static build is served elsewhere.
  allowedOrigins: (Deno.env.get("BOARD_ALLOWED_ORIGINS") ?? "http://localhost:5173,http://localhost:5174")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
});

Deno.serve((request) => server.fetch(routeToMutations(request, "board-write")));
