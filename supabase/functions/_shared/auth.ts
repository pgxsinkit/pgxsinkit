// Verifies a GoTrue-issued session token and projects it onto the toolkit's `JwtClaims` shape.
//
// The board demo runs Supabase's NEW asymmetric auth (board ADR-0007): GoTrue signs sessions with an
// ES256 key and serves the matching public key at `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`. We
// verify every token against that JWKS — no shared secret, no HS256 path. This is the single,
// runtime-portable auth point: the same code runs verbatim on self-hosted Supabase, Supabase Cloud,
// Deno Deploy, or a plain Deno server (any platform gateway check, when present, is strictly
// additive). The board functions deploy with VERIFY_JWT=false, so this is the only verification step.
//
// The returned object is already `@pgxsinkit/contracts`'s `JwtClaims`: a GoTrue access token carries
// `sub`, a top-level `role`, and `app_metadata` — into which the seed writes `roles: ["admin"]` for
// the single Admin identity (board ADR-0002). The write path's apply function reads `role` to switch
// the RLS actor and `app_metadata.roles` for the Admin predicate; the read proxy reads `sub` +
// `app_metadata.roles` for the membership filter. Both functions fail closed on `null` (the read
// proxy blocks all rows; the write route rejects), so an unauthenticated caller can do nothing.

import { createRemoteJWKSet, jwtVerify } from "jose";

import type { JwtClaims } from "@pgxsinkit/contracts";

const bearerPrefix = /^Bearer\s+/i;

// Build the JWKS resolver once per worker. jose caches the fetched key set and re-fetches only on a
// `kid` miss / rotation, so this costs one request per cold worker, not one per verification.
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const jwks = supabaseUrl ? createRemoteJWKSet(new URL("/auth/v1/.well-known/jwks.json", supabaseUrl)) : null;

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return null;
  }
  return authorization.replace(bearerPrefix, "").trim() || null;
}

/**
 * Verify the request's bearer token against the GoTrue JWKS and return its claims, or `null` when
 * there is no token or it fails verification (bad signature, wrong alg, expired). The accepted
 * algorithms are pinned to the asymmetric set (ES256/RS256) so a token cannot be downgraded to a
 * symmetric `alg` the JWKS does not contain. `jwtVerify` enforces `exp`/`nbf` itself.
 */
export async function resolveBoardClaims(request: Request): Promise<JwtClaims | null> {
  if (!jwks) {
    throw new Error("SUPABASE_URL is not set — the board functions cannot resolve the GoTrue JWKS.");
  }

  const token = bearerToken(request);
  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, jwks, { algorithms: ["ES256", "RS256"] });
    return payload as unknown as JwtClaims;
  } catch {
    return null;
  }
}
