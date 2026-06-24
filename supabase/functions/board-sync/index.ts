// board-sync — the read-path Electric shape proxy, board ADR-0001.
//
// A thin Deno adapter over `proxyElectricShapeRequest`: it resolves the caller's identity from the
// verified GoTrue JWT, then lets the registry's per-table `customWhere` row filters (board
// registry.ts) rewrite the shape `where` so Electric only ever streams rows the caller may see. The
// proxy fails closed — a table absent from the registry, or a `null` identity, is rejected, so the
// upstream Electric credentials are never lent to an ungoverned request.
//
// The wall-clock idle window is set above Electric's bounded long-poll (~25s) so live updates are not
// cut off mid-cycle; the path is irrelevant (the proxy keys off the query string), so no rewrite.

import { boardSyncRegistry } from "@pgxsinkit/board-schema";
import { proxyElectricShapeRequest } from "@pgxsinkit/server";

import { resolveBoardClaims } from "../_shared/auth.ts";

const electricUrl = Deno.env.get("ELECTRIC_SHAPE_URL") ?? "http://electric:3000/v1/shape";

Deno.serve(async (request) => {
  const claims = await resolveBoardClaims(request);
  return proxyElectricShapeRequest(request, claims, {
    registry: boardSyncRegistry,
    electricUrl,
  });
});
