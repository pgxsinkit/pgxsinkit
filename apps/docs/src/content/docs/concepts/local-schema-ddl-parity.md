---
title: Local schema & DDL parity
description: What the generated local PGlite schema replicates from Postgres, what it never will, and what it might.
sidebar:
  order: 7
---

The client runs a local PGlite database whose schema is **generated** from your sync registry. It is
a **read cache plus write-staging buffer** — not a mirror of your Postgres schema. Expecting full
parity is the most common cause of confusion here, so this page is precise about the boundary.

The governing fact behind everything below: **the client only ever holds a filtered subset of rows**
(whatever the shapes stream down), and **the server is always the integrity and security authority**.

## What the local schema generates today

From the registry, `generateLocalSchemaSql` emits:

- **Enum types** — `CREATE TYPE … AS ENUM` for every enum on a projected column. (You do **not**
  hand-provide enums; they are automatic. The `prepareLocalDbBeforeSchema` hook is only for
  _non-enum_ prerequisite objects.)
- **The synced table** — its projected columns, their types (including arrays), `NOT NULL`, and the
  primary key (single or composite).
- **For writable tables:** the [overlay](/concepts/write-path/) table, the mutation journal + its
  sequence and indexes, a **reconcile trigger + function** that clears overlay/journal rows when the
  sync echo arrives, and a **read-model view** that unions the overlay over the synced row.

That is the whole of it. In particular, the synced table carries **no defaults, no constraints
beyond the primary key, and no foreign keys** today.

## Never local — server authority, by nature

These belong to the server and will not be replicated locally; doing so would be redundant at best
and divergent at worst:

- **Row-level security, policies, and governance enforcement.** Security is asserted when a write
  reaches Postgres — see [The write path](/concepts/write-path/).
- **Triggers, functions, and materialized views** (other than the client's own reconcile trigger and
  read-model view).
- **Managed-field values** (e.g. owner via `authUid`, `created_at_us`/`updated_at_us` via
  `nowMicroseconds`). These are deliberately assigned by the database, not defaulted locally.

## Not yet local — gaps we intend to narrow

These are currently omitted but are **fidelity gaps**, not principles. The intent is to narrow them
over time on a **best-effort basis against the synced subset** — catching obvious violations before a
flush, while the server stays authoritative:

- **Static (non-managed) column defaults** — could prefill a staged row to match what the server
  would produce.
- **CHECK constraints** and **generated columns** — single-row and locally computable, so they could
  validate or derive before flush.
- **FOREIGN KEY** and **UNIQUE** — only ever enforceable against the rows the client holds (the
  parent may be unsynced; uniqueness is unknowable across a partial dataset), so any local form is
  explicitly best-effort and never a substitute for the server check.

Until then, validate user input on the client (e.g. with Zod) and rely on the server to reject what
PGlite would not.

## Practical implications

- Don't rely on a local default, CHECK, FK, or UNIQUE firing **today** — they aren't emitted yet.
- Because the local schema has **no foreign keys**, you never need `deferrableConstraints` for the
  _local_ apply — even when a child and its parent sync in one consistency group. `deferrableConstraints`
  governs only the **server** apply, where the FKs are real and a batch may stage a parent and child
  together.
- Enums _are_ created locally; other prerequisite objects go through `prepareLocalDbBeforeSchema`.
- Treat the server as the only place integrity and security are guaranteed; the local schema exists
  to serve fast offline reads and to stage optimistic writes.
