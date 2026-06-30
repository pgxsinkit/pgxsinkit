// board-sync — the read-path Electric shape proxy, board ADR-0001.
//
// A thin Deno adapter over `proxyElectricShapeRequest`: it resolves the caller's identity from the
// verified GoTrue JWT, then lets the registry's per-table `customWhere` row filters (board
// registry.ts) rewrite the shape `where` so Electric only ever streams rows the caller may see. The
// proxy fails closed two ways: a table absent from the registry is rejected outright (403, never
// forwarded), and an unauthenticated request (null/`sub`-less claims) trips every filter's
// `if (!claims.sub) return "1 = 0"` guard, so Electric is asked for an empty shape rather than lent
// ungoverned reach — verified live: an anonymous `team` shape stays empty even with rows present.
//
// The wall-clock idle window is set above Electric's bounded long-poll (~25s) so live updates are not
// cut off mid-cycle; the path is irrelevant (the proxy keys off the query string), so no rewrite.
//
// Caching: Electric tags shape responses with a long, CDN-oriented `cache-control`
// (`max-age=…, stale-while-revalidate=…`) that assumes a CDN keying on the full URL. Behind this
// same-origin proxy with no CDN, the browser HTTP cache instead serves those responses *stale* once a
// shape handle is rotated server-side (re-seed, re-login, restart) — the client then loops on
// "expired shape handle" 409s before self-healing. We force `cache-control: no-store` on the response
// so the browser never reuses a stale shape; Electric's own offset/handle bookkeeping (tracked in the
// local store) is what makes resumption cheap, not the HTTP cache. (Board dogfooding finding.)

import { boardSyncRegistry } from "@pgxsinkit/board-schema";
import { proxyElectricShapeRequest } from "@pgxsinkit/server";

import { resolveBoardClaims } from "../_shared/auth.ts";

const electricUrl = Deno.env.get("ELECTRIC_SHAPE_URL") ?? "http://electric:3000/v1/shape";

// The read path owns its CORS so it is portable to a gateway-less deployment (a Supabase Cloud edge
// function, which the platform routes to directly). Locally the Envoy gateway also handles CORS — it
// short-circuits the preflight and overwrites the response headers, so this is a harmless no-op there.
// Set BOARD_ALLOWED_ORIGINS (a function secret on Cloud) to your hosted SPA origin + localhost dev;
// it matches what board-write uses. board-write self-serves CORS via `createSyncServer`.
const allowedOrigins = (Deno.env.get("BOARD_ALLOWED_ORIGINS") ?? "http://localhost:5173,http://localhost:5174")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

Deno.serve(async (request) => {
  const claims = await resolveBoardClaims(request);
  const response = await proxyElectricShapeRequest(request, claims, {
    registry: boardSyncRegistry,
    electricUrl,
    cors: { origins: allowedOrigins },
  });
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});
