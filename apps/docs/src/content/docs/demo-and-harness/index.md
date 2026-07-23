---
title: Demo & harness
description: The demo app and verification suites exist to prove and harden the toolkit — they are not the product.
sidebar:
  label: Overview
---

The repository contains a demo app and a verification harness. Neither is the product — the
[`@pgxsinkit/*` packages](/packages/) are. These exist to make the toolkit demonstrable and to keep
it honest against real infrastructure.

## The demo app (`apps/board`)

`apps/board` is a Linear-style issue board with realtime chat — the **substantial** demo. It drives
the full read and write paths against a trimmed, but
version-matched, self-hosted **Supabase + Electric** stack: GoTrue auth, an Envoy gateway, the two
toolkit edge functions (`board-write` for the governed mutation ingress, `board-sync` for the
registry-filtered Electric shape proxy), Postgres, and Electric. Its job is twofold:

- **Example code** — a working reference for wiring `createSyncClient`, staging and flushing
  optimistic writes, reading reactively from PGlite, and surfacing convergence/conflict state.
- **A hands-on view of the behaviour** — somewhere to watch offline-first sync, membership fan-out,
  optimistic writes, and conflict convergence working end-to-end.

It uses a Linear-style domain (Teams, Issues, Channels, Messages). It is one _consumer_ of pgxsinkit —
not pgxsinkit itself, and not any downstream product's data layer. Run it:

```bash
mise install && bun install
bun run infra:up      # the board stack (Supabase + Electric) + the board's migrations
bun run seed:board    # GoTrue identities + deterministic fixtures
bun run dev:board     # the Vite client
```

The same board code runs against **managed BaaS — Supabase Cloud + Electric Cloud** — via a
documented bring-your-own-credentials path: the endpoints are fully env-driven (`SUPABASE_URL`/keys/
DB URL/`ELECTRIC_SHAPE_URL`), and the local compose is just a dev mirror. The board uses Supabase's
**new asymmetric auth** (ES256 session tokens verified via JWKS, `sb_publishable_`/`sb_secret_` keys —
no legacy HS256). See board
[ADR-0007 — Supabase asymmetric auth only](https://github.com/pgxsinkit/pgxsinkit/blob/main/apps/board/docs/adr/0007-supabase-asymmetric-auth-only.md)
and
[ADR-0008 — Run the board on managed BaaS](https://github.com/pgxsinkit/pgxsinkit/blob/main/apps/board/docs/adr/0008-board-on-managed-baas.md).
The live cloud run is supported and documented, not CI-gated (it needs real Supabase + Electric Cloud
credentials). A public, always-on instance is hosted at
[pgxsinkit.github.io/demo](https://pgxsinkit.github.io/demo/) and reset nightly — board
[ADR-0009](https://github.com/pgxsinkit/pgxsinkit/blob/main/apps/board/docs/adr/0009-hosted-public-demo.md),
[The hosted board /demo](/demo-and-harness/hosted-demo/).

The **minimal** reference (the `apps/write-api` Bun server) runs against the toolkit harness stack
instead — the smallest possible `@pgxsinkit/server` deployment:

```bash
cp .env.example .env
bun run infra:harness:up   # PostgreSQL + Electric reference stack (allow_subqueries,tagged_subqueries)
bun run dev:api            # the @pgxsinkit/server reference server
```

## How the toolkit is verified

The toolkit is proven against **real** services in Podman compose stacks — never mocks. Three
verification lanes back it:

- **Integration suites** (`tests/integration`) stand up an isolated, ephemeral PostgreSQL + Electric
  stack and assert the topology end-to-end: write validation, the in-database apply, membership
  fan-out, RLS auth context, and eventual convergence in local PGlite.
- **Board demo smoke** drives the demo's full deployment topology — GoTrue → Envoy → the bundled edge
  functions → Electric — proving the governed path the unit and integration suites stub out (auth, the
  proxy's claim-driven read filter, and the apply's RLS actor switch).
- **Performance lab** (`apps/perf-lab`, `tests/performance`) measures the write/sync cycle under load.

Each lane provisions its own services, applies the current schema, runs, and tears everything down —
so a green suite means the whole topology, not a mocked slice of it, actually converged.
