import { createRemoteJWKSet, jwtVerify } from "jose";

import type { JwtClaims } from "@pgxsinkit/contracts";

const bearerPrefix = /^Bearer\s+/i;

export interface BoardClaimsResolverOptions {
  supabaseUrl: string;
  logTimings?: boolean;
}

export function createBoardClaimsResolver(options: BoardClaimsResolverOptions) {
  const jwks = createRemoteJWKSet(new URL("/auth/v1/.well-known/jwks.json", options.supabaseUrl));

  // Best-effort JWKS warm-up: jose rejects because this is not a real token, but still has a chance to
  // populate/cache the remote key set before the first user request pays for it.
  void jwks({ alg: "ES256" }, { payload: "", signature: "", protected: "" }).catch(() => {});

  return async function resolveBoardClaims(request: Request): Promise<JwtClaims | null> {
    const token = bearerToken(request);
    if (!token) {
      return null;
    }

    const verifyStart = perfNow();
    try {
      const { payload } = await jwtVerify(token, jwks, { algorithms: ["ES256", "RS256"] });
      return payload as unknown as JwtClaims;
    } catch {
      return null;
    } finally {
      if (options.logTimings) {
        console.log(
          "[pgxsinkit-timing]",
          JSON.stringify({ route: "auth-verify", ms: Math.round(perfNow() - verifyStart) }),
        );
      }
    }
  };
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return null;
  }

  return authorization.replace(bearerPrefix, "").trim() || null;
}

function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
