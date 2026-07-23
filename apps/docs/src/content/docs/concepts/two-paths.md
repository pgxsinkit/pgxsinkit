---
title: The two paths
description: Read and write are separate, asymmetric paths — not one bidirectional channel.
sidebar:
  order: 2
---

pgxsinkit moves data in two directions over **two different mechanisms**. They are not symmetric and
they are not one channel — Electric carries the read direction only, never writes.

## Read path: server → client

```
PostgreSQL  →  ElectricSQL  →  PGlite
```

Postgres is the source of truth. ElectricSQL streams **shapes** (filtered row sets, including
membership fan-out) to the client, where they land in local PGlite. The app reads from PGlite. This
path is live and continuous. See [The read path](/concepts/read-path/).

## Write path: client → server

```
client  →  write route  →  PostgreSQL
```

Local edits do **not** travel back through Electric. They are staged locally, flushed as a batch to
a typed write route on the pgxsinkit server, and applied to Postgres by a single in-database
function. See
[The write path](/concepts/write-path/).

## Why the asymmetry matters

- **You cannot "write to Electric."** Electric is read transport only. A mutation that isn't sent to
  the write route never reaches Postgres, and therefore never comes back down the read path.
- **The loop closes through Postgres.** A local write becomes durable only once the server applies
  it; it becomes _visible to other clients_ only once Electric streams it back down. The client holds
  the optimistic value in an overlay until that echo returns (see
  [The write path](/concepts/write-path/) and [Timestamps](/concepts/timestamps/)).
- **Synced tables are replication targets.** Application code must never mutate a synced table
  directly — those rows are owned by the read path. All writes go through the mutation runtime.

## The one rule

> Read from PGlite. Write through the write route. Never write to a synced table directly, and never
> expect Electric to carry a write.
