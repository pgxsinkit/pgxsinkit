---
title: The two paths
description: Read and write are separate, asymmetric paths — not one bidirectional channel.
sidebar:
  order: 2
---

pgxsinkit moves data in two directions over **two different mechanisms**. They are not symmetric and
they are not one channel — the read path carries the read direction only, never writes.

## Read path: server → client

```
PostgreSQL  →  Circuits engine  →  durable-streams  →  PGlite
```

Postgres is the source of truth. ElectricSQL's Circuits engine maintains **shapes** (filtered row
sets, including membership fan-out) over the logical replication stream and publishes each one into
durable-streams; the client subscribes through the pgxsinkit control plane and reads those streams
through the stream edge, where they land in local PGlite. The app reads from PGlite. This path is live
and continuous. See [The read path](/concepts/read-path/).

## Write path: client → server

```
client  →  write route  →  PostgreSQL
```

Local edits do **not** travel back through the read path. They are staged locally, flushed as a batch to
a typed write route on the pgxsinkit server, and applied to Postgres by a single in-database
function. See
[The write path](/concepts/write-path/).

## Why the asymmetry matters

- **The read path is read transport only.** There is nothing to write to: a mutation that isn't sent
  to the write route never reaches Postgres, and therefore never comes back down the read path.
- **The loop closes through Postgres.** A local write becomes durable only once the server applies
  it; it becomes _visible to other clients_ only once the read path streams it back down. The client holds
  the optimistic value in an overlay until that echo returns (see
  [The write path](/concepts/write-path/) and [Timestamps](/concepts/timestamps/)).
- **Synced tables are replication targets.** Application code must never mutate a synced table
  directly — those rows are owned by the read path. All writes go through the mutation runtime.

## Not everything is sync state

The two paths above are the **sync rail**, and they are what this page is about. Beside them sits a third,
non-sync lane for data that was never sync state: high-volume, append-only client facts (view logs,
interaction events) that are never edited, never conflict, and are never read back down. Those go on
[the event lane](/concepts/event-lane/) — an append into a local Outbox, flushed to an ingestion endpoint
and handed to a queue and your own consumer callback. It has no overlay, no echo and no conflict
resolution, so the asymmetry above simply does not arise for it. Everything that _is_ sync state still
obeys the one rule.

## The one rule

> Read from PGlite. Write through the write route. Never write to a synced table directly, and never
> expect the read path to carry a write.

## Composition is yours

The registry keeps **one table's** read filter and write policy in agreement — that is its job, and it
does it from a single declaration. What it cannot see is a rule that spans tables and rails.

An example: an invite table's RLS legitimately lets an offering-scoped teacher create an invite, and an
acceptance worker later mints a membership row from it. Both policies are correct alone; together they can
break "this offering only ever has one member", because the worker's semantics appear in no per-table
declaration.

So when something writes rows as a **consequence** of other rows, the invariants of the **output** table
are the ones at stake — re-check them against current state when the worker runs, rather than trusting that
the input row's authorization already settled it. And test at the composition seam, driving the worker or
route end to end: per-table policy tests structurally cannot fail on a composition hole.
