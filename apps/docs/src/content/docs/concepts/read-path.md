---
title: The read path
description: Shapes stream Postgres → Electric → PGlite, through an ownership-enforcing proxy.
sidebar:
  order: 4
---

The read path streams rows from Postgres **through ElectricSQL** to the client and keeps local PGlite
up to date — nothing goes from Postgres to the client directly. The app reads exclusively from PGlite;
it never queries Postgres or Electric directly at read time.

## The flow

```
PostgreSQL  →  ElectricSQL  →  shape proxy  →  PGlite (local)
```

1. **Shapes** define what a client may see — a table plus a `where` filter. Filters can be
   cross-table subqueries, e.g. membership fan-out where a container row streams to every member:

   ```sql
   container_id IN (SELECT container_id FROM memberships WHERE member_id = <subject>)
   ```

2. **ElectricSQL** turns each shape into a live stream from Postgres.
3. **The shape proxy** (`proxyElectricShapeRequest`, served by the pgxsinkit server — `createSyncServer`
   mounts it at `/api/shape` by default, but the path is yours to choose) forwards shape requests to
   Electric and **enforces owner filtering** for protected tables unless the caller is an admin. In
   the real path, clients talk to the proxy, not to Electric directly.
4. **PGlite** subscribes through `@pgxsinkit/client`'s internal Electric ingest engine (`src/sync/`,
   ADR-0009) and applies the stream into local tables. The app reads from there.

## The proxy is the gateway

Reads do not hit Electric directly in a deployed system — they go through the shape proxy, which is
where ownership is enforced. Treat synced tables in PGlite as **replication
targets**: they are written by this path and must never be mutated by application code (writes go
through [the write path](/concepts/write-path/)).

## Hard prerequisite

Subquery `where` (used for fan-out) is a flagged ElectricSQL preview feature. The proxy forwards the
`where` verbatim, so Electric must run with `allow_subqueries,tagged_subqueries`. Without the flag
Electric rejects the shape with HTTP 400 and the sync fails **closed** — no rows stream, never an
unfiltered fan-out. See [The Electric subquery requirement](/concepts/electric-subqueries/).
