# Subquery move-in: applying Electric's live snapshot rows in the local store

Status: accepted (2026-06-29) — Slices 1 & 2 implemented and tested (Electric 1.7.4)

## Context

[ADR-0023](0023-subquery-move-out-tagged-reconciliation.md) fixed the **move-out** half of Electric's
tagged-subquery protocol (a revoked membership now evicts the rows it kept). It assumed the **move-in**
half — a row *entering* a member's shape when a membership is *added* — was "already handled by the insert
path" (0023, protocol note + decision 1). Dogfooding the board demo proved that assumption wrong:

> Removing a user from a group correctly removes their board + tickets (move-out, ADR-0023). But **adding**
> a user to a group does **not** show the new group/board until a full tab reload. It updated on removal,
> which is surprising.

A reload "fixes" it because a reload re-snapshots the shape from scratch — which is the tell for what is
actually wrong.

### Root cause — a move-in row is a *snapshot* row with no LSN, and the inbox dedup drops it

The same direct-to-Electric reproduction used for ADR-0023
([`tmp/agents/electric-subquery-moveout/`](../../tmp/agents/electric-subquery-moveout/), `./run.sh`)
captures exactly what a live move-in puts on the wire (Electric 1.7.4,
`ELECTRIC_FEATURE_FLAGS=allow_subqueries,tagged_subqueries`). Adding `membership(bob, growth)` to a live
shape yields, in **one** batch:

```jsonc
{ "headers": { "event": "move-in", "txids": [750],
               "patterns": [ { "value": "3252d9cab8268bc76ce21e7015cf7d35", "pos": 0 } ] } }

// the row entering the shape — note `is_move_in` and NO `lsn` / NO `last` header
{ "key": "\"public\".\"items\"/\"item1\"",
  "value": { "id": "item1", "room_id": "growth", "body": "secret ticket" },
  "headers": { "operation": "insert", "is_move_in": true,
               "active_conditions": [true],
               "tags": ["3252d9cab8268bc76ce21e7015cf7d35"] } }

{ "headers": { "control": "snapshot-end", "xmin": "751", "xmax": "751", "xip_list": [] } }
{ "headers": { "control": "up-to-date", "global_last_seen_lsn": "1" } }
```

The move-in row is delivered as a **mini-snapshot** (`is_move_in: true`, bracketed by `snapshot-end`),
**not** a replication-stream change — so unlike a CDC `insert` it carries **no `lsn` and no `last`**. The
engine's `readReplicationHeaders` ([`sync/index.ts`](../../packages/client/src/sync/index.ts)) floors a
missing `lsn` to `0`, then `ShapeInbox.ingestChange`
([`sync/shape-inbox.ts`](../../packages/client/src/sync/shape-inbox.ts)) drops it via its already-seen
guard `if (lsn <= completeLsnFor(shape)) return;`. On the **initial** snapshot the frontier is still `-1`,
so `0 > -1` and the rows land (which is why a reload works). On a **live** move-in the frontier has long
since advanced past `0`, so `0 <= frontier` and **every move-in row is silently dropped**. The trailing
`up-to-date` then advances the frontier and commits nothing.

This is the exact asymmetry the bug report describes, and it is symmetric in origin with ADR-0023: there we
dropped the `move-out` *event*; here we drop the `move-in` *snapshot rows*. Both come down to "a message
that does not look like an ordinary LSN-keyed change is discarded".

### Why the move-in insert can't just bypass the dedup

A move-in is an **existing** row entering scope, so unlike a CDC `insert` (a brand-new row) it can already
be present locally — via an independent grant (the multi-grant case ADR-0023 decision 4 already protects
on the move-out side), or because a resume re-delivers it from before the move-in's offset. The steady-state
fold deliberately applies inserts as a **plain `INSERT`** so a genuine PK collision surfaces (ADR-0014).
Feeding move-in rows through that path would turn an expected "already present" into a spurious commit
failure → retry → `degraded`. Move-in needs its own, idempotent application.

## Decision

Mirror the move-out design (ADR-0023): a dedicated inbox channel + an idempotent apply at the commit
boundary. Five points:

1. **Route `is_move_in` inserts to a per-shape move-in buffer, not the LSN-keyed change buffer.** In the
   engine loop, a change message with `headers["is_move_in"] === true` is buffered via a new
   `inbox.ingestMoveIn(shape, message)` (mirroring `ingestMoveOut`). These rows carry no LSN, so — like the
   move-out patterns — they cannot key the LSN-ordered `changes` map; they are drained and applied in the
   next `commitUpToLsn`, which the trailing `up-to-date` triggers. The commit loop also fires on a pending
   move-in (`inbox.hasPendingMoveIns()`), so a move-in lands even if no change advanced the frontier.

2. **Apply move-in rows idempotently (upsert), before the fold.** A new `applyUpsertsToTable`
   ([`sync/apply.ts`](../../packages/client/src/sync/apply.ts)) does `INSERT … ON CONFLICT (pk) DO UPDATE`
   (refresh to the move-in's authoritative value; `DO NOTHING` for a pk-only table). It runs **before** the
   change fold for the shape, so a same-commit update to a just-moved-in row lands on a present row. The
   plain-`INSERT` "collisions must surface" invariant of the CDC path is intentionally **not** used here —
   for a move-in an already-present row is expected, not a bug. Eviction-style consistency (the reconcile
   trigger) still fires on the upsert.

3. **Record move-in tags by *union*, not replace.** A move-in **adds** a reason a row is in the shape, so
   its tags are inserted with `ON CONFLICT DO NOTHING` (a new `addShapeRowTags` in
   [`sync/tags.ts`](../../packages/client/src/sync/tags.ts)) — it never clears tags the row already carries
   from an independent grant. This is deliberately **stronger** than reading `tags` as authoritative: it is
   correct whether Electric sends the full reason-set or just the newly-added grant on a move-in, so move-out
   eviction afterwards stays correct under multi-grant **without** depending on the move-in's tag cardinality.
   A subsequent **regular** change for the same row still replaces with its authoritative full set
   (`applyShapeTagSync`, ADR-0023 decision 5), so union-then-replace converges to the right set either way.

4. **The `move-in` `EventMessage` stays a no-op.** Its `patterns` are redundant with the inserts' `tags`,
   and the data we need (value + tags) is in the `is_move_in` inserts. We keep the event branch (so nothing
   is "silently dropped" — ADR-0023 decision 1) but it drives nothing; the inserts do.

5. **`must-refetch` / desync are unchanged.** A re-snapshot delivers rows as ordinary initial-snapshot
   inserts (frontier rewound to `-1`, so they land) and rebuilds tags from scratch; the move-in buffer is
   cleared on `resetShape` like the other inbox channels. No new desync handling is needed beyond ADR-0023's.

## Alternatives considered

- **Exempt `is_move_in` rows from the inbox dedup and let the existing fold apply them** — rejected: the
  fold's plain `INSERT` collides on an already-present (multi-grant / re-delivered) row, and assigning the
  rows a synthetic LSN to survive dedup couples correctness to "the causing write advanced the WAL by
  exactly the right amount". A dedicated buffer + idempotent upsert is both simpler to reason about and
  symmetric with the move-out channel.
- **Replace tags on move-in (treat `tags` as authoritative, as a regular change does)** — rejected: if
  Electric sends only the newly-added grant on a move-in (not the full set), a replace would drop an
  independent grant's tag and a later move-out would wrongly evict a still-authorised row. Union is safe
  under both interpretations, at no extra cost.
- **Treat a move-in as a per-shape `must-refetch`** (re-snapshot the whole shape) — rejected for the same
  reason as on the move-out side: correct but a sledgehammer that re-streams the entire shape on every
  membership change.

## Delivery — two slices, both required (neither is optional)

A membership can be added whether or not the client was watching. As with ADR-0023, this splits into two
slices that **both land under this ADR with their own passing integration test** — the offline case is not
parked and not a maybe.

### Slice 1 — live move-in (client watching at the moment the membership is added)

Decisions 1–5. Steps: the inbox move-in channel (`shape-inbox.ts`); `addShapeRowTags` (`tags.ts`);
`applyUpsertsToTable` (`apply.ts`); the engine wiring in `commitUpToLsn` + the loop trigger (`index.ts`).

**Acceptance:** a new integration test *"fans a newly-added member's rows into their LIVE shape (move-in)"*
(`membership-fanout`): subscribe a non-member (sees nothing), add the membership server-side, assert the
workspace's rows appear with no reload — plus unit tests for the inbox channel, the upsert idempotency, and
the tag-union (a row already held by grant A, moved-in via grant B, ends with **both** tags).

### Slice 2 — offline / resumed move-in (added while the client was shut down)

**The case:** a member is added while their client is unsubscribed/offline; on reconnect the now-visible
rows must materialise. The resume from the persisted offset replays the move-in snapshot rows (they sit in
the durable log after the offset), and Slice 1's handling applies them. The same local store is reused
across two sessions so the second resumes from the first's persisted offset (not a fresh snapshot).

**Acceptance:** a new integration test *"fans a member's rows in across an OFFLINE gap: added while
unsubscribed, materialised on resume"* (`membership-fanout`): session 1 syncs as a non-member (0 rows) and
unsubscribes; the membership is added while offline; session 2 resumes on the **same** store and the rows
appear after catch-up.

## Consequences

- Adding a member now materialises their board + tickets **live (Slice 1) and across an offline gap
  (Slice 2)** — symmetric with ADR-0023's revocation, closing the last gap in the tagged-subquery read path
  with no Electric change.
- One new idempotent apply path (`applyUpsertsToTable`) and one new tag helper (`addShapeRowTags`), both
  subquery-only and off the path for every non-subquery shape and every CDC insert.
- The direct-Electric repro now documents **both** directions (move-in and move-out) and remains the basis
  of an upstream-quality protocol reference.
