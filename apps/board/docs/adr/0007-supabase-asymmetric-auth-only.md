# The board uses Supabase asymmetric auth only

The supported board baseline uses Supabase's asymmetric signing keys end to end. Supabase Cloud
issues tokens from an asymmetric project key, and the board must accept the same tokens locally and
in Cloud. A shared-secret HS256 verifier would reject those tokens and introduce a second auth mode,
so the board has **no HS256 fallback and no hybrid verifier**.

This stands on its own — it is the right end state regardless of where the board runs — but it is
also a hard prerequisite for [running the board on managed BaaS](./0008-board-on-managed-baas.md),
where Cloud issues ES256 tokens.

## Decision

- **Session tokens are ES256/RS256, verified via the project JWKS.** `resolveBoardClaims` in
  `apps/board-api/src/core/auth.ts` resolves the signing keys from
  `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` (cached). `JWT_SECRET` is not an accepted board-auth
  verification key.
- **The toolkit is untouched.** `@pgxsinkit/server` stays auth-agnostic — `resolveAuthClaims` is
  injected and `proxyElectricShapeRequest` takes the resolved `claims` — so this lives entirely in
  `apps/board-api/src/core/auth.ts`, never in a package.
- **Opaque API keys are used at the gateway.** `sb_publishable_…` (client `apikey`) and
  `sb_secret_…` (seed admin API, Studio) are the board's public and privileged API keys.
- **Local parity.** The local compose stack moves too, so local == cloud: GoTrue signs ES256 via
  `GOTRUE_JWT_KEYS` and auto-exposes the JWKS endpoint. The local demo keys (the EC keypair +
  `sb_publishable`/`sb_secret`) are **committed throwaway defaults** in `board.env`, documented as
  non-secret and local-only and requiring rotation for any real use, so
  `bun run infra:up && seed:board && dev:board` stays zero-config.

## Considered Options

- **Hybrid HS256 + ES256/JWKS verification** — rejected. It
  keeps the deprecated path alive: a half-measure that contradicts the decision to support only the
  new system.
- **Keep local on HS256, only Cloud on ES256** — rejected. It forces a hybrid verifier (above) and a
  confusing local/cloud auth mismatch.
- **Full asymmetric parity, local + cloud** — chosen.

## Consequences

- `apps/board-api/src/core/auth.ts` needs the project URL to build the JWKS endpoint and caches the
  key set.
- **Seed admin path (resolved):** the seed sends the `sb_secret_` key, the gateway translates it to the
  internal service_role JWT, and GoTrue (`v2.192.0`) accepts it for the admin API — verified, the seed
  provisions all 9 identities. So no special GoTrue admin config is needed.
- The committed throwaway EC **private** JWK is documented as non-secret and local-only; security
  scanners should treat the entire board keyset as demo fixture material.
- `JWT_SECRET` in `board.env` is only GoTrue's required boot placeholder. Every board consumer
  (compose, seed, client, Studio) uses the asymmetric keyset and opaque API keys.

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
  which also includes symmetric key material that the board deliberately omits.
  `scripts/gen-board-demo-keys.ts` regenerates the coherent committed keyset (the EC key + the two
  internal role JWTs the gateway swaps in). Verified: GoTrue v2.192.0 boots and the smoke is 8/8.
- **The local gateway is Envoy, not Kong** (a deliberate switch toward Supabase's own self-hosted
  direction). It runs the new-API-key → role-JWT translation as a Lua filter — the same job the Cloud
  gateway does — leaving a real session JWT untouched so a signed-in user's identity always reaches the
  function. The board functions remain the single auth point regardless of gateway. See
  [ADR-0008](./0008-board-on-managed-baas.md) and `infra/compose/board/envoy.yaml`.
