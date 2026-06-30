// Generate the board demo's COMMITTED, THROWAWAY asymmetric-auth keyset (board ADR-0007).
//
// The board demo runs Supabase's *new* asymmetric auth (ES256 sessions verified via JWKS) with the
// new opaque `sb_publishable_`/`sb_secret_` API keys. To keep `bun run infra:up` zero-config, the
// LOCAL keyset is fixed and committed in `infra/compose/board.env` + `infra/compose/board/envoy.yaml`
// (exactly the posture of the old published demo HS256 JWTs — non-secret, local-only, rotate for any
// real use). This script regenerates that coherent set; paste its output into those two files.
//
//   bun scripts/gen-board-demo-keys.ts
//
// GoTrue refuses to boot ("no signing key detected") unless the EC key carries
// `key_ops: ["sign","verify"]`. We emit `GOTRUE_JWT_KEYS` as a JSON array with ONLY that EC key —
// ASYMMETRIC ONLY, no symmetric `oct` key — so the keyset and the published JWKS carry no symmetric
// material (unlike Supabase's `add-new-auth-keys.sh`, which also carries the legacy HS256 key for
// backward verification the board does not need). GoTrue still requires GOTRUE_JWT_SECRET to boot
// (`Secret` is `required:"true"` through v2.192), but never uses it when Keys is set — so it stays a
// required-but-unused placeholder. Everything below is signed by ONE P-256 key so sessions, the JWKS,
// and the internal role JWTs the gateway swaps in all verify against each other.

import { exportJWK, generateKeyPair, SignJWT } from "jose";

// A required-but-unused placeholder GoTrue needs to boot (see board.env). Not a key, not in the JWKS.
const JWT_SECRET = "board-demo-unused-placeholder-min-32-characters-xx";
const KID = "board-demo-es256";
const ISS = "supabase";
// Far-future fixed window — throwaway local demo credentials, never rotated automatically.
const EXP = Math.floor(new Date("2035-01-01T00:00:00Z").getTime() / 1000);
const IAT = Math.floor(new Date("2025-01-01T00:00:00Z").getTime() / 1000);

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = await exportJWK(privateKey);

// The EC signing JWK — note key_ops MUST include "sign" or GoTrue reports "no signing key detected".
const ecKey = {
  kty: "EC",
  kid: KID,
  use: "sig",
  key_ops: ["sign", "verify"],
  alg: "ES256",
  ext: true,
  crv: jwk.crv,
  x: jwk.x,
  y: jwk.y,
  d: jwk.d,
};
// ASYMMETRIC ONLY: a single-element array, no symmetric `oct` key — the published JWKS carries no
// symmetric material and the board verifies ES256-only.
const jwtKeys = [ecKey];

async function signRole(role: string): Promise<string> {
  return new SignJWT({ role, iss: ISS })
    .setProtectedHeader({ alg: "ES256", kid: KID, typ: "JWT" })
    .setIssuedAt(IAT)
    .setExpirationTime(EXP)
    .sign(privateKey);
}

const internalAnonJwt = await signRole("anon");
const internalServiceJwt = await signRole("service_role");

// Opaque demo keys — fixed strings (the format the platform uses; the local Envoy Lua matches them
// verbatim). The 8-char suffix mimics the real `_<checksum>` shape but carries no meaning locally.
const publishableKey = "sb_publishable_boarddemoLOCALxxxxxxxxx_demo0000";
const secretKey = "sb_secret_boarddemoLOCALxxxxxxxxxxxxxxx_demo0000";

console.log("# ── infra/compose/board.env ────────────────────────────────────────────────────────");
console.log(`JWT_SECRET=${JWT_SECRET}`);
console.log(`GOTRUE_JWT_KEYS=${JSON.stringify(jwtKeys)}`);
console.log(`BOARD_PUBLISHABLE_KEY=${publishableKey}`);
console.log(`BOARD_SECRET_KEY=${secretKey}`);
console.log("");
console.log("# ── infra/compose/board/envoy.yaml (Lua local ANON_JWT / SERVICE_JWT, no Bearer prefix) ──");
console.log(`ANON_JWT    = ${internalAnonJwt}`);
console.log(`SERVICE_JWT = ${internalServiceJwt}`);
