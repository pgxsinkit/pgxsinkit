---
title: The hosted board /demo
description: The public hosted board is retired. What the demo:build script and the reset workflow still do, for anyone hosting their own copy.
sidebar:
  label: Hosted /demo
---

**The hosted board demo is retired. There is no longer a public instance at
`pgxsinkit.github.io/demo`.** The managed read-path service it ran against is being shut down, and the
read path it used was the classic one this toolkit no longer ships.

To see the board, run it locally — it is the same `apps/board` code, and it exercises the full read
and write paths:

```bash
mise install && bun install
mkcert -install       # one-time: trust the local CA so the browser accepts the gateway's TLS cert
cp .env.example .env
bun run infra:up      # the board stack via Podman compose
bun run seed:board    # GoTrue identities + deterministic fixtures
bun run dev:board
```

See [Demo & harness](/demo-and-harness/) for what the stack contains and what each lane proves.

The rest of this page documents the publishing and reset tooling that still ships in the repository.
It is here for anyone who wants to host **their own** copy of the board; none of it points at a live
instance any more.

## Building the board as a static subpath artifact

`bun run demo:build` builds `apps/board` into `apps/docs/dist/demo/`, so a docs deploy and a board
build can publish as **one artifact**. Two things make that static build work under a subpath:

- **Subpath assets** — the script sets the Vite base to `/demo/` and outputs into the docs `dist/`.
- **Hash routing** — it sets `VITE_BOARD_HASH_ROUTING=1`, flipping the router to hash history
  (`/demo/#/login`). GitHub Pages serves the **root** `/404.html` for any unknown path, and that 404
  belongs to the docs site — so a path-based deep-link into `/demo/login` would render the docs 404.
  Hash routing keeps every route under `/demo/index.html`, so deep-links and refreshes always boot the
  SPA. Local dev keeps clean path URLs.

The board runs in [worker mode](/concepts/worker-mode/), so the static build also ships a
**SharedWorker chunk** (the sync engine — `board-sync.worker.ts`) alongside the app bundle; Vite emits
and fingerprints it under `/demo/` like any other asset. A visitor on a browser without `SharedWorker`
transparently falls back to the in-process engine (correct, just on the main thread), so the build
works everywhere — it only loses the off-thread isolation on that browser.

## Offline return

A signed-in visitor who closes the board and reopens it without connectivity boots to a usable board.
A small runtime-capture **service worker** (no precache — it caches only what that visitor's own boots
already fetched) replays the app shell and the PGlite engine assets; the data is whatever each table's
declared retention kept in the local store — every eager table, plus the Admin's chat once activated.
The Member's chat is ephemeral by design and instead shows an explicit connection-needed state, as does
sign-in itself — the capability is offline _return_, not first-visit offline. Board
[ADR-0010](https://github.com/pgxsinkit/pgxsinkit/blob/main/apps/board/docs/adr/0010-offline-return.md).

## Resetting a public instance (purge → migrate → reseed)

A public, writable board needs a way to undo whatever visitors do to it. `.github/workflows/demo-reset.yml`
is that tool, run on `workflow_dispatch`: `purge:board` **drops every migration-created board object**
(a model-derived drop list plus the `drizzle` bookkeeping schema), `db:board:migrate` **re-applies the
latest committed history from scratch**, and `seed:board` **recreates the seeded fixtures**.

Because the schema is rebuilt, not just the rows, such a database is **effectively ephemeral** — the
same posture as every other database these migrations target. A rewritten or collapsed migration
history (`docs/runbooks/regenerate-migrations.md`) ships by simply dispatching the workflow; the
function bundles are the separate `bun run board:cloud:functions` step, explicitly targeted by
`BOARD_SUPABASE_PROJECT_REF`.

All three steps are the same scripts used locally, pointed at a remote project via env — no containers
and no Pages deploy, just the GoTrue admin API plus the project's database over a session pooler (role
privileges, not the connection path, are what the DDL needs).

## What's verified

The static build is exercised by `bun run demo:build`. The **local stack is the CI-gated proof of the
topology** (`bun run test:integration:board`); anything you deploy from these scripts is yours to
verify.
