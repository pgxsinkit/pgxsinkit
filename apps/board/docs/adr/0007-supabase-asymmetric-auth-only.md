# The board uses Supabase asymmetric auth only (no legacy HS256)

The board demo — and its local stack — were originally built on Supabase's **legacy HS256
symmetric auth**: a shared `JWT_SECRET`, the published demo `anon`/`service_role` JWTs, and
`_shared/auth.ts` (`resolveBoardClaims`) verifying GoTrue session tokens with HS256. That was a
mistake. HS256 is the **deprecated** path; new Supabase Cloud projects default to **asymmetric
ES256** signing keys, so a board function that only verifies HS256 rejects every Cloud-issued
token. This ADR migrates the board demo to Supabase's new asymmetric auth **end to end**, with
**no HS256 fallback and no hybrid verifier**.

This stands on its own — it is the right end state regardless of where the board runs — but it is
also a hard prerequisite for [running the board on managed BaaS](./0008-board-on-managed-baas.md),
where Cloud issues ES256 tokens.

## Decision

- **Session tokens are ES256/RS256, verified via the project JWKS.** `resolveBoardClaims` resolves
  the signing keys from `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` (cached) and drops the HS256
  path entirely. This supersedes the ADR-0001 realization note that `_shared/auth.ts` HS256-verifies
  against `JWT_SECRET`.
- **The toolkit is untouched.** `@pgxsinkit/server` stays auth-agnostic — `resolveAuthClaims` is
  injected and `proxyElectricShapeRequest` takes the resolved `claims` — so this lives entirely in
  the board demo's `_shared/auth.ts`, never in a package.
- **New API keys replace the demo JWTs.** `sb_publishable_…` (client `apikey`) and `sb_secret_…`
  (seed admin API, Studio) replace the `anon`/`service_role` JWTs. `JWT_SECRET` is removed as a
  session signer.
- **Local parity.** The local compose stack moves too, so local == cloud: GoTrue signs ES256 via
  `GOTRUE_JWT_KEYS` and auto-exposes the JWKS endpoint. The local demo keys (the EC keypair +
  `sb_publishable`/`sb_secret`) are **committed throwaway defaults** in `board.env` — exactly the
  posture of the old committed demo JWTs (documented non-secret, local-only, rotate for any real
  use) — so `bun run infra:up && seed:board && dev:board` stays zero-config.

## Considered Options

- **Hybrid HS256 + ES256/JWKS verification** (mirroring the vendored `main` router) — rejected. It
  keeps the deprecated path alive: a half-measure that contradicts the decision to support only the
  new system.
- **Keep local on HS256, only Cloud on ES256** — rejected. It forces a hybrid verifier (above) and a
  confusing local/cloud auth mismatch.
- **Full asymmetric parity, local + cloud** — chosen.

## Consequences

- `_shared/auth.ts` becomes JWKS-based and needs the project URL to build the JWKS endpoint; it
  caches the key set (the `main` router already demonstrates the `jose` `createRemoteJWKSet`
  pattern).
- **Seed admin path (resolved):** the seed sends the `sb_secret_` key, the gateway translates it to the
  internal service_role JWT, and GoTrue (`v2.192.0`) accepts it for the admin API — verified, the seed
  provisions all 9 identities. So no special GoTrue admin config is needed.
- Committing a throwaway EC **private** JWK locally is consistent with the existing committed
  demo-secret posture; it is documented as non-secret and local-only, and security scanners should
  treat it like the prior demo `service_role` JWT.
- The `JWT_SECRET`-shaped env in `board.env` and the demo `ANON_KEY`/`SERVICE_ROLE_KEY` JWTs are
  retired; every consumer (compose, seed, client, Studio) reads the new keys.

## Realization (verified by the board smoke, 8/8)

The build settled two things the design under-specified, both confirmed by
`bun run test:integration:board` (GoTrue ES256 login → JWKS verification in both functions → the
seed's `sb_secret_` → service_role translation → RLS scoping, all green):

- **GoTrue requires `GOTRUE_JWT_SECRET` to boot but never uses it for crypto.** Its `Secret` config
  key is `required:"true"` (confirmed in the **v2.192.0** source), so the env must be present — but
  `ApplyDefaults` only falls back to it when `JWT.Keys` is empty. With `GOTRUE_JWT_KEYS` set it is
  never converted to a key, added to the JWKS, or used to sign/verify. So the board runs GoTrue
  **v2.192.0** with `GOTRUE_JWT_KEYS` holding a **single EC signing key** (`key_ops: ["sign","verify"]`,
  or GoTrue reports "no signing key detected") and **no symmetric `oct` key** — the keyset and the
  published JWKS are **asymmetric-only**, no symmetric material anywhere; sessions are ES256 and the
  board verifies ES256-only. `JWT_SECRET` is a required-but-unused placeholder (the closest to "zero
  symmetric" GoTrue allows). This is stricter than Supabase's own `docker/utils/add-new-auth-keys.sh`,
  which also carries the legacy HS256 key for backward verification the board doesn't need.
  `scripts/gen-board-demo-keys.ts` regenerates the coherent committed keyset (the EC key + the two
  internal role JWTs the gateway swaps in). Verified: GoTrue v2.192.0 boots and the smoke is 8/8.
- **The local gateway is Envoy, not Kong** (a deliberate switch toward Supabase's own self-hosted
  direction). It runs the new-API-key → role-JWT translation as a Lua filter — the same job the Cloud
  gateway does — leaving a real session JWT untouched so a signed-in user's identity always reaches the
  function. The board functions remain the single auth point regardless of gateway. See
  [ADR-0008](./0008-board-on-managed-baas.md) and `infra/compose/board/envoy.yaml`.
