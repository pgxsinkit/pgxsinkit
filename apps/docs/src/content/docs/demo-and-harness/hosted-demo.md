---
title: The hosted board /demo
description: How the public board demo is built into the docs deploy and reset nightly to stay clean.
sidebar:
  label: Hosted /demo
---

The board runs as a public, always-on demo at **[pgxsinkit.github.io/demo](https://pgxsinkit.github.io/demo/)**
— sign in as a seeded identity and try offline-first sync, membership fan-out, optimistic writes, and
conflict convergence in the browser, with zero setup. It is the same `apps/board` code as the local and
[cloud](/demo-and-harness/board-on-cloud/) runs, backed by a managed Supabase Cloud + Electric Cloud
project. Board
[ADR-0009](https://github.com/pgxsinkit/pgxsinkit/blob/main/apps/board/docs/adr/0009-hosted-public-demo.md).

## How it is published

The board is built into `apps/docs/dist/demo/` as a step in the **docs deploy** (`.github/workflows/docs.yml`),
so the docs site and the demo deploy as **one artifact** to the `pgxsinkit.github.io` repo. The docs deploy
replaces the whole publish (`force_orphan`), so co-publishing — not a second workflow — is what keeps the
demo from being clobbered.

Two things make the static build work under a subpath:

- **Subpath assets** — `bun run demo:build` sets the Vite base to `/demo/` and outputs into the docs `dist/`.
- **Hash routing** — the build sets `VITE_BOARD_HASH_ROUTING=1`, flipping the router to hash history
  (`/demo/#/login`). GitHub Pages serves the **root** `/404.html` for any unknown path, and that 404 belongs
  to this docs site — so a path-based deep-link into `/demo/login` would render the docs 404. Hash routing
  keeps every route under `/demo/index.html`, so deep-links and refreshes always boot the SPA. Local dev and
  `board:cloud:dev` keep clean path URLs.

## Reset nightly

The demo is **public and writable** — anyone can create and move issues and post chat. A separate workflow,
`.github/workflows/demo-reset.yml`, runs the seed script on a nightly cron (`0 3 * * *`) plus
`workflow_dispatch`, which **truncate-cascades every board table and recreates the seeded fixtures**. Any
vandalism (offensive issue titles, chat spam) is gone by morning, and a manual run resets it on demand.

It is the same `seed:board` used locally and by `board:cloud:seed`, pointed at the cloud project via env —
no Postgres/Electric containers, no Pages deploy, just the GoTrue admin API + the project's database via the
Supavisor **session** pooler.

## Operator setup

The public demo points at a real project provisioned per the
[board-on-cloud runbook](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/runbooks/board-on-cloud.md).
On top of that one-time setup, the hosted demo needs:

| GitHub setting               | Kind              | Purpose                                                                                                                                                                                                          |
| ---------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEMO_BOARD_SUPABASE_URL`    | variable (public) | Project URL — baked into the build; the reset's GoTrue admin gateway.                                                                                                                                            |
| `DEMO_BOARD_PUBLISHABLE_KEY` | variable (public) | `sb_publishable_…` key — baked into the build as the `apikey`.                                                                                                                                                   |
| `DEMO_BOARD_SECRET_KEY`      | secret            | `sb_secret_…` key — the reset's admin API auth.                                                                                                                                                                  |
| `DEMO_BOARD_DATABASE_URL`    | secret            | **Session pooler** connection (pooler host, port 5432, user `postgres.<ref>`) — the reset truncates + inserts as `postgres`. Not the direct connection: it is IPv6-only, and GitHub-hosted runners have no IPv6. |
| `PGXSINKIT_PAGES_DEPLOY_KEY` | secret            | Already required by the docs deploy.                                                                                                                                                                             |

The build values are **variables, not secrets** on purpose: the project URL and publishable key are public
(they ship in client JS), and gating the demo build on a variable lets a fork get a clean docs deploy with the
demo step skipped.

Then, on the Supabase project:

- **Set `BOARD_ALLOWED_ORIGINS`** to include `https://pgxsinkit.github.io` (a CORS origin is scheme + host —
  the `/demo` path is irrelevant) alongside your localhost dev origins, and redeploy secrets
  (`bun run board:cloud:secrets`). Without this the functions reject the github.io origin's requests.
- **Disable open email signups** (Auth settings). The reset truncates all board **rows** regardless of author
  (so vandal content is always wiped) but only deletes the **fixture** auth identities — disabling signups
  keeps the user set to exactly the seeded fixtures.
- **Activate the Electric subquery preview on your source** — see
  [The Electric subquery requirement](/concepts/electric-subqueries/). Without it, ordinary members'
  membership-scoped shapes 400 while admin works.

## What's verified

The static build is exercised by `bun run demo:build`; the **live page is operator-verified**, like the rest
of the cloud path (it needs the managed backend). The local stack remains the CI-gated proof of the topology
(`bun run test:integration:board`, 8/8).
