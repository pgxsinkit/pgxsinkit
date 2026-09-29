---
title: Packages
description: What each @pgxsinkit/* package is and when you need it.
sidebar:
  label: Overview
---

pgxsinkit ships as a set of focused packages. Most apps install `client`, `server`, and `contracts`,
plus `react` for React bindings. The client runs its local store on [pgwasm](/packages/pgwasm/), the
toolkit's own Postgres-in-WebAssembly runtime, and brings it as a dependency; install the pgwasm packages
yourself only to use them directly.

## Published packages (the product)

| Package                         | Install when you…                                                                                                                                                                                            | Runtime             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| **`@pgxsinkit/contracts`**      | always — shared Zod schemas, the sync registry types (tables **and** event-stream registration), and the transport DTOs every lane uses.                                                                     | shared              |
| **`@pgxsinkit/server`**         | you run the server — `createSyncServer`, the apply-function builder, the read path's control plane (`/sync/v1/*`) and stream edge (`createStreamGate`), and the event lane's ingest route + consumer runner. | any `fetch` runtime |
| **`@pgxsinkit/client`**         | you build the client — local overlay + mutation journal, batch flush, read wiring over the local pgwasm store, and the event Outbox + its flush loop.                                                        | browser / pgwasm    |
| **`@pgxsinkit/react`**          | you want React hooks/bindings over the client.                                                                                                                                                               | React               |
| **`@pgxsinkit/pgwasm`**         | you use the local Postgres directly — `createPgwasm`, live queries, the Drizzle driver, the wire protocol, or the constant-handle OPFS-repacked store (`/opfs`) in a capability-proven worker.               |
| **`@pgxsinkit/pgwasm-c`**       | you supply the C Postgres build yourself — to warm its files early (`createCBuild({ assets })`), start from the prepopulated data directory, or load `amcheck`.                                              |
| **`@pgxsinkit/pgwasm-pg-dump`** | you run `pg_dump` against a pgwasm database in the same page, worker or Bun process.                                                                                                                         |
| **`@pgxsinkit/pgwasm-repl`**    | you want an interactive SQL prompt (a React component) over a pgwasm database or a client's inspection surface.                                                                                              | browser worker      |

## Internal packages (not published)

| Package                 | What it is                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@pgxsinkit/schema`     | the harness/reference sync registry — a membership fixture. Example code; your app defines its own registry. |
| `@pgxsinkit/test-utils` | shared helpers for the integration and unit suites.                                                          |

## How they fit the two paths (and the event lane)

- **Write path:** your app uses `@pgxsinkit/client` to stage + flush; `@pgxsinkit/server` validates
  against `@pgxsinkit/contracts` and applies via the in-database function. See
  [The write path](/concepts/write-path/).
- **Read path:** `@pgxsinkit/client` subscribes through the server's control plane and reads the
  granted durable-streams through its stream edge — its own reader lives in `src/circuits/`
  (`subscription-client.ts`, `stream-source.ts`, `shape-group.ts`, `stream-inbox.ts`, `group-sync.ts`),
  transport included (`long-poll.ts`); `src/sync/` keeps only the applier (`apply.ts`, `fold.ts`, `copy.ts`,
  `subscription-state.ts`). See [The read path](/concepts/read-path/).
- **Event lane** (only if your registry declares `streams`): `@pgxsinkit/contracts` registers the streams
  and defines the wire contracts; `@pgxsinkit/client` stages appends in the local Outbox and flushes them;
  `@pgxsinkit/server` mounts the ingest route, provisions the queues, and hosts the consumer runner. It is
  not a sync path at all — no overlay, no echo, no conflict. See [The event lane](/concepts/event-lane/).

API-level details will live in the [API reference](/reference/) (generated from the package sources).
For the pgwasm packages — the runtime, the C build, the OPFS-repacked store's construction, durability,
and recreation contract, `pg_dump` and the REPL — see [pgwasm](/packages/pgwasm/), and for what a build is,
[Postgres builds](/concepts/postgres-builds/).
