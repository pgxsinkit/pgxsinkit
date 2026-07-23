---
title: Timestamps
description: Microsecond integers, carried across boundaries as decimal strings — the sync truth.
sidebar:
  order: 6
---

pgxsinkit uses a single, deliberate timestamp model. It can look surprising, but it is intentional
and load-bearing for convergence.

## The model

- `created_at_us` and `updated_at_us` are the **authoritative** time fields.
- They are stored in PostgreSQL as `BIGINT` **microseconds since the Unix epoch**.
- They cross API and sync boundaries as **decimal strings** (e.g. `"1718900000000000"`), to avoid
  JavaScript number-precision loss on 64-bit integers.
- They are the **sync truth**. Human-readable timestamp projections can be added if operationally
  useful, but they are never what convergence is decided on.

## Why microseconds, and why strings

- **Microseconds** give enough resolution to order rapid successive writes without collisions.
- **Decimal strings** survive the JSON boundary intact. A 64-bit microsecond value exceeds
  `Number.MAX_SAFE_INTEGER`, so sending it as a JSON number would silently corrupt it. Strings keep
  it exact from Postgres → server → client and back.

## Where it shows up

- The write path returns the server `updated_at_us` in each ack.
- The client clears an optimistic overlay row only once the read path echoes a row whose
  `updated_at_us` is **at least as new** as the acked value — this is how the optimistic write and
  the synced truth reconcile. See [The write path](/concepts/write-path/).

## What not to do

- Don't treat these as millisecond JS timestamps — they are microseconds.
- Don't parse them into `number` on the wire — keep them as strings until you intentionally convert.
- Don't introduce a separate "real" timestamp column and sync on that; `*_us` is the truth.
