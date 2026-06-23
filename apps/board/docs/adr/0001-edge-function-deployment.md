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
  `/functions/v1/board-sync`. Kong is in the stack already (auth, studio,
  storage) and needs no board-specific configuration.
