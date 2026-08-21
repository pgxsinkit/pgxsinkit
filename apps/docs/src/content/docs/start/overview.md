---
title: What is pgxsinkit?
description: An offline-first sync toolkit for Postgres, ElectricSQL's Circuits engine, Drizzle, and PGlite — what you install, and how its two paths fit together.
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
Writes do not travel back down the read path; the read and write sides use different mechanisms.

|                 | Read path                                                 | Write path                                     |
| --------------- | --------------------------------------------------------- | ---------------------------------------------- |
| Direction       | server → client                                           | client → server                                |
| Route           | `PostgreSQL → Circuits engine → durable-streams → PGlite` | `client → write route → PostgreSQL`            |
| Carries         | live shape streams (rows)                                 | batches of staged mutations                    |
| Read transport? | yes (durable-streams)                                     | **no** — writes never go through the read path |

See [The two paths](/concepts/two-paths/) for why the asymmetry matters, then
[The write path](/concepts/write-path/) and [The read path](/concepts/read-path/) for each side.

## Browser storage

For browser apps, capability-driven storage is the default. A real OPFS probe at boot puts
the constant-four-handle `opfs-repacked` engine directly in a SharedWorker on macOS/iOS Safari, or in one
Web-Locks-elected dedicated worker on Chromium and Firefox. A registry can force IndexedDB
(`storage.backend: "idbfs"`), and the no-SharedWorker fallback stays on IndexedDB. The app still attaches
through one `attachSyncClient` surface; inspect the BootReport instead of branching on browser names. See
[Worker mode](/concepts/worker-mode/).

## Hard prerequisites

Three, and none is optional:

- **PostgreSQL with `wal_level = logical`.** The Circuits engine ingests logical replication and
  creates its own replication slot. Supabase's Postgres images already ship `wal_level = logical`;
  verify with `postgres -C wal_level` rather than assuming.
- **An explicit table list for the engine, never `*`.** `ELECTRIC_CIRCUITS_PG_TABLES` names the tables
  the engine replicates. `*` introspects every `public` table with a primary key, which sweeps in
  tables you never meant to publish (the write-side operations log among them).
- **A gateway that speaks HTTP/2.** The client holds one live long-poll per synced stream, so a subject
  with several scopes exhausts the browser's ~6-connections-per-origin HTTP/1.1 cap and writes starve
  behind them. See [Deploying the server](/start/deploying-the-server/).

## Where to go next

- [Getting started](/start/getting-started/) — install and wire a minimal read + write.
- [Core concepts](/concepts/) — the mental model, in five short pages.
- [Packages](/packages/) — which `@pgxsinkit/*` package does what.
