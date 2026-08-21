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
the full read and write paths against a trimmed, but version-matched, self-hosted **Supabase +
Circuits** stack: Postgres, GoTrue auth, an Envoy gateway, durable-streams, the Circuits engine, and
three toolkit edge functions —

- **`board-write`** — the governed mutation ingress (`POST /api/mutations`).
- **`board-sync`** — the read path's **control plane**: `/sync/v1/subscribe`, `/sync/v1/refresh`,
  `/sync/v1/barrier`. It compiles each shape's row filter, mints stream tokens, and proxies the
  engine's convergence barrier.
- **`board-stream`** — the **edge**, on its own origin: it verifies a stream token, checks the grant,
  and proxies durable-streams bytes. No claims resolver, no database.

Its job is twofold:

- **Example code** — a working reference for wiring `createSyncClient`, staging and flushing
  optimistic writes, reading reactively from PGlite, and surfacing convergence/conflict state.
- **A hands-on view of the behaviour** — somewhere to watch offline-first sync, membership fan-out,
  optimistic writes, and conflict convergence working end-to-end.

It uses a Linear-style domain (Teams, Issues, Channels, Messages). It is one _consumer_ of pgxsinkit —
not pgxsinkit itself, and not any downstream product's data layer. Run it:

```bash
mise install && bun install
bun run infra:up      # the board stack + the board's migrations
bun run seed:board    # GoTrue identities + deterministic fixtures
bun run dev:board     # the Vite client
```

The board uses Supabase's **asymmetric auth** (ES256 session tokens verified via JWKS, with
`sb_publishable_`/`sb_secret_` keys — no legacy HS256); see board
[ADR-0007 — Supabase asymmetric auth only](https://github.com/pgxsinkit/pgxsinkit/blob/main/apps/board/docs/adr/0007-supabase-asymmetric-auth-only.md).

The public hosted instance of the board is **retired and no longer available** — see
[The hosted board /demo](/demo-and-harness/hosted-demo/).

The **minimal** reference (the `apps/write-api` Bun server) runs against the toolkit harness stack
instead — the smallest possible `@pgxsinkit/server` deployment:

```bash
cp .env.example .env
bun run infra:harness:up   # PostgreSQL + durable-streams + the Circuits engine
bun run dev:api            # the @pgxsinkit/server reference server
```

## How the toolkit is verified

The toolkit is proven against **real** services in Podman compose stacks — never mocks. Three
verification lanes back it:

- **Integration suites** (`tests/integration`) stand up an isolated, ephemeral PostgreSQL +
  durable-streams + Circuits engine stack and assert the topology end-to-end: write validation, the
  in-database apply, membership fan-out, RLS auth context, and eventual convergence in local PGlite.
  The stream edge runs in-process there, which is also what lets a test revoke an entitlement between
  polls.
- **Board demo smoke** drives the demo's full deployment topology — GoTrue → Envoy → the bundled edge
  functions → the engine and durable-streams — proving the governed path the unit and integration
  suites stub out (auth, the control plane's claim-driven row filter, and the apply's RLS actor
  switch).
- **Performance lab** (`apps/perf-lab`, `tests/performance`) measures the write/sync cycle under load.

Each lane provisions its own services, applies the current schema, runs, and tears everything down —
so a green suite means the whole topology, not a mocked slice of it, actually converged.
