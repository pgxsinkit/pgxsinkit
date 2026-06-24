# Deploy the board's API and proxy as two Supabase Edge Functions

The board demo runs pgxsinkit's two server roles as **separate Supabase Edge
Functions on Deno** — `board-write` (the mutation ingress) and `board-sync` (the
Electric shape proxy) — using `postgres.js` + Hono, rather than as a Bun/Hono
container. The demo's job includes proving the most common _real_ deployment
target for a Supabase-hosted consumer, and `@pgxsinkit/server` is already a
runtime-neutral `fetch` handler (Hono + web-standard `Request`/`Response`, DB
client injected), so each function is a ~15-line adapter that imports the
relevant export (`registerMutationRoute` / `proxyElectricShapeRequest`), builds a
`drizzle(postgres(connStr))` client, and serves it. All pgxsinkit logic stays in
the portable package; Deno specifics are confined to the two entrypoints.

## Considered Options

- **One combined `board-api` function** mounting the whole Hono app — fewer moving
  parts, but couples the streaming proxy's wall-clock to the short write path and
  is less idiomatic for Supabase (one concern per function).
- **A Bun/Hono container** alongside Supabase — simplest and equally "real", but
  skips the Supabase-Edge-Function deployment story, which is the specific thing
  this demo exists to prove for Supabase-hosted adopters.

## Consequences

- The `board-sync` function's wall-clock is set comfortably above Electric's
  bounded long-poll (~25s). The proxy is a pure pass-through stream for this demo
  (no column-omission/row-transform), so it never buffers a full body.
- Edge invocations are stateless; high connection churn wants a pooler. For the
  demo a direct `postgres.js` connection is acceptable; Supavisor is the
  production answer.
- Routing is stock Supabase: `/functions/v1/board-write` and
  `/functions/v1/board-sync`.

## Realization (Phase 2 build)

What the decision became in code, with the deltas worth recording:

- **The board runs its _own_ trimmed Supabase stack**, not an existing shared one
  (`infra/compose/board-compose.yml`: db / auth / rest / meta + studio / kong /
  edge-runtime / electric, on board-only ports so it coexists with the toolkit
  harness). So Kong _does_ carry board config — a minimal DB-less `kong.yml`
  routing `/auth/v1`, `/rest/v1`, `/functions/v1` (no key-auth: the functions
  verify the JWT themselves, which is stronger and less fragile for a local demo).
- **Adapters use the high-level entry, not the raw exports.** `board-write` is
  `createSyncServer({ registry, db, resolveAuthClaims })` **without** `electricUrl`
  (mutation route only); `board-sync` calls `proxyElectricShapeRequest` directly.
  The DB handle is `drizzle-orm/postgres-js` (`postgres.js`) — Bun's `bun-sql`
  driver has no Deno equivalent, which is exactly why the grilling chose postgres.js.
- **Deno cannot load the toolkit source directly**, so each function is **bundled
  self-contained** (`bun run edge:build` → `supabase/functions-dist/<name>/index.js`,
  node builtins normalized to `node:*` and left external) and the edge-runtime main
  router serves the bundles. The general recipe is documented upstream in the
  toolkit's [Deploying the server](../../../../apps/docs/src/content/docs/start/deploying-the-server.md)
  guide (this build was its dogfooding source — see `consumer-review.md` Phase 2).
- **`verify_jwt` is realized in-function**: `_shared/auth.ts` HS256-verifies the
  GoTrue token against the shared `JWT_SECRET` and returns its claims (already
  `JwtClaims`-shaped). Fails closed on a missing/invalid token.
- **The function-name path prefix is stripped** before `board-write` hands the
  request to `server.fetch` (`_shared/http.ts`); `board-sync` needs no rewrite (the
  proxy keys off the query string).
- **Live shake-out** (needs the stack up): image tags, GoTrue/PostgREST env, and
  postgres.js under Deno's node-compat. The static layer (bundles → valid ESM,
  migrations generate, validate green) is confirmed without containers.
