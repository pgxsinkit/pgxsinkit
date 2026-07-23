---
title: What is pgxsinkit?
description: An offline-first sync toolkit for Postgres, ElectricSQL, Drizzle, and PGlite — what you install, and how its two paths fit together.
---

pgxsinkit is an **offline-first sync toolkit**: the `@pgxsinkit/*` packages you install to give a
local-first app a Postgres-backed read path and a write path, with per-row access control on both —
Postgres row-level security on the write path, and a matching row filter on the read path.

## A library, not an app

pgxsinkit is a standalone open-source **library** — the published `@pgxsinkit/*` packages are what you
install and depend on. The repository also carries a demo app and a verification harness, but those
exist to show the toolkit working and to keep it honest against real infrastructure; they are not the
product, and not any application's data layer. See [Demo & harness](/demo-and-harness/).

## The two paths

pgxsinkit is built around two **separate, asymmetric** paths — they are not one bidirectional channel.
Writes do not travel back through Electric; the read and write sides use different mechanisms.

|           | Read path                           | Write path                                |
| --------- | ----------------------------------- | ----------------------------------------- |
| Direction | server → client                     | client → server                           |
| Route     | `PostgreSQL → ElectricSQL → PGlite` | `client → write route → PostgreSQL`       |
| Carries   | shape streams (live rows)           | batches of staged mutations               |
| Electric? | yes (the read transport)            | **no** — writes never go through Electric |

See [The two paths](/concepts/two-paths/) for why the asymmetry matters, then
[The write path](/concepts/write-path/) and [The read path](/concepts/read-path/) for each side.

## Browser storage

For browser apps, capability-driven storage is the default. A real OPFS probe at boot puts
the constant-four-handle `opfs-repacked` engine directly in a SharedWorker on macOS/iOS Safari, or in one
Web-Locks-elected dedicated worker on Chromium and Firefox. A registry can force IndexedDB
(`storage.backend: "idbfs"`), and the no-SharedWorker fallback stays on IndexedDB. The app still attaches
through one `attachSyncClient` surface; inspect the BootReport instead of branching on browser names. See
[Worker mode](/concepts/worker-mode/).

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
