// Verifies a GoTrue-issued JWT and projects it onto the toolkit's `JwtClaims` shape.
//
// In a hosted Supabase deployment the platform enforces `verify_jwt = true` at the gateway and the
// function can trust the already-verified token. This self-hosted demo has no such gateway step for
// the Edge functions, so each function re-verifies the HS256 signature here with the shared project
// JWT secret (`JWT_SECRET`). That is strictly stronger than a gateway check and keeps the function
// portable — the same code runs verbatim on Supabase, Deno Deploy, or a plain Deno server.
//
// The returned object is already `@pgxsinkit/contracts`'s `JwtClaims`: a real GoTrue access token
// carries `sub`, a top-level `role` (the Postgres role, "authenticated"), and `app_metadata` — into
// which the seed step writes `roles: ["admin"]` for the single Admin identity (board ADR-0002). The
// write path's apply function reads `role` to switch the RLS actor and `app_metadata.roles` for the
// Admin predicate; the read proxy reads `sub` + `app_metadata.roles` for the membership filter.

import type { JwtClaims } from "@pgxsinkit/contracts";

const bearerPrefix = /^Bearer\s+/i;

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64UrlToString(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return null;
  }
  return authorization.replace(bearerPrefix, "").trim() || null;
}

async function verifyHs256(message: string, signature: Uint8Array, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(message));
}

/**
 * Verifies the request's bearer JWT against `JWT_SECRET` and returns its claims, or `null` when there
 * is no token or the signature/shape is invalid. Both board functions fail closed on `null` (the
 * read proxy blocks all rows; the write route rejects), so an unauthenticated caller can do nothing.
 */
export async function resolveBoardClaims(request: Request): Promise<JwtClaims | null> {
  const secret = Deno.env.get("JWT_SECRET");
  if (!secret) {
    throw new Error("JWT_SECRET is not set — the board functions cannot verify GoTrue tokens.");
  }

  const token = bearerToken(request);
  if (!token) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) {
    return null;
  }

  try {
    const header = JSON.parse(base64UrlToString(headerPart)) as { alg?: string };
    if (header.alg !== "HS256") {
      return null;
    }

    const verified = await verifyHs256(`${headerPart}.${payloadPart}`, base64UrlToBytes(signaturePart), secret);
    if (!verified) {
      return null;
    }

    const payload = JSON.parse(base64UrlToString(payloadPart)) as JwtClaims & { exp?: number };
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
