# Run the board on managed BaaS: Supabase Cloud + Electric Cloud

The board only ran on its local, trimmed, self-hosted compose stack. "Runs unchanged against real
cloud Supabase + Electric Cloud" was **aspirational** — there was no `supabase/config.toml`, no cloud
env, and no deploy path; only the local mechanics existed. This ADR defines the real, documented
**bring-your-own-credentials** path: a developer supplies their Supabase Cloud + Electric Cloud
credentials, runs a documented deploy sequence, and the same board code runs against the managed
backend. It depends on [asymmetric auth](./0007-supabase-asymmetric-auth-only.md) (Cloud issues ES256
tokens) and complements [ADR-0001](./0001-edge-function-deployment.md) (why two edge functions) by
specifying how those functions reach Cloud.

This is **not** "supply credentials and push." It is "supply credentials → run a documented
migrate + deploy + seed sequence, after ~3 one-time manual console steps → it runs."

## Decision

- **Read path needs no toolkit change.** `board-sync` forwards to
  `ELECTRIC_SHAPE_URL=https://<electric>/v1/shape?source_id=…&secret=…`. The proxy only strips
  `where`/`columns` from the base URL (`electric-proxy.ts`), so the source credentials ride through
  untouched, and the secret lives only in the function secret, **never** the client. Electric Cloud is
  designed for exactly this "auth proxy injects `source_id`+`secret`" pattern.
- **The membership fan-out needs Electric's subquery flags — request activation on Electric Cloud.**
  The member `team` filter emits a cross-table `where` subquery (`board_member_team_ids()`), which needs
  Electric's `allow_subqueries,tagged_subqueries` preview. On managed **Electric Cloud** that preview is
  **activated per source by Electric staff on request** (no self-serve toggle yet; ElectricSQL intends
  to make it the default). Until you ask Electric to enable it for your source, a member's shape returns
  `400 {"where":["Subqueries are not supported"]}` while an admin's (all-rows, no subquery) works — an
  asymmetry that hid the gap until a non-admin logged in. A self-hosted Electric (a container with the
  flags set, pointed at the project's direct DB) is the fallback if Cloud activation isn't available;
  either way only `ELECTRIC_SHAPE_URL` changes. See
  [The Electric subquery requirement](https://pgxsinkit.github.io/concepts/electric-subqueries/).
- **Edge functions deploy as the pre-built bundle.** Because `@pgxsinkit/board-schema` is unpublished,
  the deployable artifact is the `edge:build` bundle, not raw source. A `supabase/config.toml` points
  each function's `entrypoint` at its `functions-dist/<name>/index.js` and sets `verify_jwt = false`
  (the functions self-verify per ADR-0007; with the new API keys the platform does not enforce the
  `apikey` header anyway). `supabase functions deploy board-write board-sync`. The vendored local
  `main` router is local-only — Cloud routes `/functions/v1/<name>` itself.
- **The client sends `apikey` via a new generic toolkit option.** `@pgxsinkit/client` gains a
  `requestHeaders` option merged into both the read shape headers and the write headers; the board
  passes `requestHeaders: { apikey: <publishable key> }`. This is a general, additive toolkit
  capability (not an app workaround) and makes the client robust to any gateway that demands `apikey`.
- **DB connections.** Edge functions use the **Supavisor transaction pooler** (port 6543,
  `prepare:false` — already set in `_shared/db.ts`). Migrations and the seed use a **direct/session**
  connection (they need DDL and `postgres`/BYPASSRLS). Electric Cloud connects to the database through
  its own `REPLICATION` role, configured in the Electric dashboard.
- **Frontend runs locally.** `bun run dev:board` (Vite) points at the cloud backend via the
  `VITE_BOARD_*` vars; `board-write`'s CORS `allowedOrigins` includes `http://localhost:5173`. Hosting
  the static SPA on a third-party host is an optional, documented follow-on.
- **Packaging is hybrid.** A gitignored `board.cloud.env` (from a committed `board.cloud.env.example`)
  holds the credentials. A `board:cloud:*` script set wraps the repeatable toil (migrate → deploy
  functions → set secrets → seed). A runbook documents the unavoidable one-time manual console steps:
  create the Supabase project, create the Electric Cloud source on that project's database, and
  `supabase link`.

## Considered Options

- **Publish `@pgxsinkit/board-schema` to npm** for a raw-TS (zero-bundle) deploy — rejected. It is a
  demo-local example registry ("your app defines its own"); publishing it pollutes the package
  namespace with demo code.
- **A Bun/Hono container on a cloud host** instead of edge functions — rejected. It abandons the
  Supabase-Edge-Function deployment story this demo exists to prove (ADR-0001) and adds another host.
- **Full automation** including project and Electric-source creation — rejected. Source creation +
  database linking are dashboard/`REPLICATION`-role driven and brittle to script for a demo.
- **Rely on `verify_jwt=false` so no `apikey` is sent** (no toolkit change) — rejected in favour of
  the generic `requestHeaders` option, so the client is robust regardless of gateway behaviour.

## Consequences

- **The live cloud run cannot be CI-validated here** — it requires real Supabase Cloud + Electric
  Cloud accounts and credentials. The static layer is verifiable (the bundles build, typecheck and
  validate stay green, migrations generate, the env plumbing resolves); the end-to-end cloud run is
  **supported and documented, not CI-gated**. The runbook is the verification surface.
- Reconciles the now-inaccurate "env-driven (incl. `JWT_SECRET`)" cloud claim on the docs site's
  Demo & harness page — `JWT_SECRET` is gone under ADR-0007.
- Two consumers gain a `requestHeaders` surface; the option is documented in `@pgxsinkit/client`.
- The one-time manual steps are inherent to managed BaaS and are owned by the runbook, not a script.

## Realization

- **The local stack mirrors the cloud shape and is fully verified** (`bun run test:integration:board`,
  8/8): the local gateway is **Envoy** running the same opaque-key → role-JWT Lua translation the Cloud
  gateway does (board ADR-0007 realization), the client sends the publishable key via the toolkit's new
  `requestHeaders`, and the functions verify ES256 sessions via JWKS. So everything the cloud path
  depends on — the new-API-key flow, the `requestHeaders` apikey, ES256/JWKS verification, the read/write
  topology — is proven locally; only the managed endpoints themselves remain operator-verified via the
  runbook.
- The cloud deploy surface is `supabase/config.toml` (bundle entrypoints + `verify_jwt = false`),
  `board.cloud.env.example`, and the `board:cloud:*` scripts.
