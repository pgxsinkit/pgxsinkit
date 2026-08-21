import type { JwtClaims } from "@pgxsinkit/contracts";

/**
 * The subject an integration lane runs as when the registry under test has no row filter.
 *
 * The native read path has no anonymous form — a stream token names its bearer, or it names nobody
 * revocation could reach — so every lane needs a subject even when the shape's predicate ignores it.
 * `createSyncServer` refuses `readPath` without an auth adapter for exactly that reason, and this is
 * the adapter for the tests that have no auth story of their own.
 */
export const TEST_SUBJECT = "01965156-5884-7a0b-a24e-31b5c9be00a1";

export function fixedTestClaims(): JwtClaims {
  return { role: "authenticated", sub: TEST_SUBJECT };
}

/**
 * The per-subject adapter the membership lanes use: each client sends its own `x-test-sub`, so one
 * server serves several subjects and their shapes differ by exactly the claim.
 */
export function claimsFromTestHeader(request: Request): JwtClaims | null {
  const sub = request.headers.get("x-test-sub");
  return sub ? { role: "authenticated", sub } : null;
}
