---
title: Run the board on managed BaaS
description: Run the board demo against real Supabase Cloud + Electric Cloud with your own credentials.
sidebar:
  label: Board on the cloud
---

The board demo (`apps/board`) runs against **managed BaaS — Supabase Cloud + Electric Cloud** with the
**same code** it runs locally; you supply your own credentials. The local compose stack
([Demo & harness](/demo-and-harness/)) is just a faithful, version-matched mirror of that managed shape.

It is **not** a one-command push. It is: do a little one-time console setup, fill in a credentials file,
then run one deploy command — after which `bun run dev:board` drives the cloud backend.

For a public, always-on, browser-ready instance of this same setup — served at
[pgxsinkit.github.io/demo](https://pgxsinkit.github.io/demo/) and reset nightly — see
[The hosted board /demo](/demo-and-harness/hosted-demo/).

## What it looks like

```bash
# one-time (manual console steps — see the runbook):
#   • create a Supabase project          • create an Electric Cloud source on its database
cp board.cloud.env.example board.cloud.env   # fill in your project + Electric Cloud values

bun run board:cloud:deploy   # migrate → set the Electric secret → deploy the two edge functions → seed
bun run dev:board            # local Vite, pointed at the cloud backend
```

`board:cloud:deploy` is a thin wrapper over the repeatable steps; each is also its own
`board:cloud:migrate` / `:secrets` / `:functions` / `:seed` script.

Use `bun run board:cloud:preview` to build the board with the cloud browser configuration and serve the
compiled artifact locally at `http://localhost:5173`. `board:cloud:dev` remains the source-mode Vite server.
Every Supabase CLI mutation receives the explicit `BOARD_SUPABASE_PROJECT_REF`; the commands do not
depend on whichever project another checkout may have linked. CLI authentication similarly comes
from `BOARD_SUPABASE_ACCESS_TOKEN`, not global profile state, so separate Supabase accounts stay
separate.

## How it fits together

- **Auth is Supabase's new asymmetric model** — ES256 sessions verified against the project JWKS, with
  the new `sb_publishable_`/`sb_secret_` API keys (no HS256). The board functions are the single auth
  point; the gateway only translates the opaque keys into role JWTs. Board
  [ADR-0007](https://github.com/pgxsinkit/pgxsinkit/blob/main/apps/board/docs/adr/0007-supabase-asymmetric-auth-only.md).
- **The read path needs no toolkit change** — `board-sync` forwards to
  `https://api.electric-sql.cloud/v1/shape?source_id=…&secret=…`; the proxy only rewrites `where`/`columns`,
  so the Cloud source credentials ride through, server-side only.
- **The edge functions deploy as pre-built bundles** (`supabase/config.toml` entrypoints,
  `verify_jwt = false`), because the demo registry `@pgxsinkit/board-schema` is unpublished. Board
  [ADR-0008](https://github.com/pgxsinkit/pgxsinkit/blob/main/apps/board/docs/adr/0008-board-on-managed-baas.md).
- **The client sends its publishable key** via `@pgxsinkit/client`'s `requestHeaders` option, alongside
  the per-request `Authorization`.

:::caution[Activate subqueries on your Electric Cloud source]
The board's membership-scoped shapes use a cross-table `where` subquery — a flagged Electric preview. On
managed Electric Cloud it is **activated per source by Electric staff on request** (no self-serve toggle
yet; default-on intended), so **ask Electric to enable subqueries for your source**. Until then a normal
member's shapes return `{"where":["Subqueries are not supported"]}` (an admin, all-rows, works). Or
self-host Electric with the flags. See [The Electric subquery requirement](/concepts/electric-subqueries/).
:::

## What's verified, and what's yours to verify

The **local** stack mirrors the cloud shape exactly and is covered by the board smoke
(`bun run test:integration:board`, 8/8): the new-API-key flow, ES256/JWKS verification, and the full
read/write topology. The **managed endpoints themselves** are operator-verified — they need your
Supabase + Electric Cloud accounts, so the cloud run is supported and documented, not CI-gated.

## The full runbook

Step-by-step (project creation, the Electric source, connection strings, the credentials file, and
troubleshooting) is in
[**docs/runbooks/board-on-cloud.md**](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/runbooks/board-on-cloud.md).
