---
title: What is pgxsinkit?
description: pgxsinkit is a sync toolkit, proven by a demo and a harness — not a demo repository.
---

pgxsinkit is an **offline-first sync toolkit**: the `@pgxsinkit/*` packages you install to give a
local-first app a Postgres-backed read path and write path, with row-level security honoured on both
ends.

## It is a toolkit, proven by a harness

This is the single most important thing to get right, because the repository contains three things
and only one of them is the product:

- **The toolkit** — the published `@pgxsinkit/*` packages. **This is the product.** It is what you
  install and depend on.
- **The demo app** (`apps/web`) — a reference application that drives the toolkit end-to-end so a
  human can see it work. It is example code for consumers, not the product.
- **The harness** (`tests/integration`, `apps/perf-lab`) — container-backed suites that prove the
  toolkit against real PostgreSQL, ElectricSQL, and PGlite. It hardens the product, it is not the
  product.

The repository is **not** any particular application's data layer. It is a standalone open-source
library with a generic example domain (authors, todos, projects). If you are reading the source and
see "demo," read it as _"the thing that exercises the library,"_ never as _"throwaway scaffolding."_

## The two paths

pgxsinkit is built around two **separate, asymmetric** paths. They are not one bidirectional
channel — getting this wrong is the second most common misunderstanding.

|           | Read path                           | Write path                                |
| --------- | ----------------------------------- | ----------------------------------------- |
| Direction | server → client                     | client → server                           |
| Route     | `PostgreSQL → ElectricSQL → PGlite` | `client → write API → PostgreSQL`         |
| Carries   | shape streams (live rows)           | batches of staged mutations               |
| Electric? | yes (the read transport)            | **no** — writes never go through Electric |

See [The two paths](/concepts/two-paths/) for why the asymmetry matters, then
[The write path](/concepts/write-path/) and [The read path](/concepts/read-path/) for each side.

## A hard prerequisite

pgxsinkit relies on ElectricSQL's subquery `where` support for membership fan-out, which is a
**flagged** preview feature. You must run Electric with
`ELECTRIC_FEATURE_FLAGS=allow_subqueries,tagged_subqueries`. Without it the sync fails **closed** —
no rows stream, never an unfiltered fan-out. This is not optional. See
[The Electric subquery requirement](/concepts/electric-subqueries/).

## Where to go next

- [Getting started](/start/getting-started/) — install and wire a minimal read + write.
- [Core concepts](/concepts/) — the mental model, in six short pages.
- [Packages](/packages/) — which `@pgxsinkit/*` package does what.
