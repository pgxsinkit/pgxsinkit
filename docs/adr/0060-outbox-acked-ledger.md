# The Outbox keeps acked rows as a ledger

Status: accepted (2026-09-12) — amends [ADR-0053](0053-queue-shaped-event-ingestion.md) decision 2

## Context

ADR-0053 decision 2 makes the Outbox's shape **public contract** for one stated reason: "apps may compose
pending rows with down-synced aggregates into best-guess views". A consumer now does exactly that — a
language module composing staged events over a synced per-item aggregate — and the lane is one column short
of supporting it.

Verdict settlement deletes an `acked` row the moment the server says `acked`. But `acked` means **enqueued**,
not folded: the event is on its queue, the consumer runner has not delivered it yet, the app's fold has not
run, and the folded aggregate has not synced back down. A composition that counts "rows still in the Outbox"
plus "the synced aggregate" therefore **dips** across that whole window — the row vanishes at the ack, the
aggregate does not include it yet, and the value jumps back up seconds later when the down-sync lands. Online,
on a healthy deployment, on the happy path. It is not a sync bug; it is the direct consequence of deleting at
the earliest of three sequential events.

The obvious library-side fix — delete the row when the fold lands — **is impossible, by construction**. The
Outbox stops at the queue. The lane knows the ingestion endpoint accepted an envelope and nothing whatsoever
about what happens afterwards: which consumer folds it, into what, whether that consumer's write is even
synced to this client, or how the app would recognise its own event in the result. ADR-0053 decision 6 makes
the point from the other side — delivery is at-least-once with no inter-batch order, and the fold's identity
is the app's `eventId` dedupe, in the app's own store. A "deleted after fold" signal would require the library
to model every consumer's data model, which is the opposite of what this lane is.

What the library CAN do is stop destroying the evidence so early, and let the app decide when the acked row
has stopped mattering.

## Decision

1. **An acked row is stamped, not deleted.** The Outbox gains `acked_at_us BIGINT NULL` (the `bigintText`
   convention of every other `_us` column). Settlement UPDATEs it to the ack time instead of running the
   delete, and the row stays. `refused` and `rejected` are unchanged: still deleted, still reported — the
   ledger exists to bridge an ack to a fold, and neither of those will ever be folded. `deferred` is
   unchanged too: it is not terminal, so its row was always staying anyway.

   One index serves the column: **`(acked_at_us, seq)`**. It covers both new access patterns as range
   scans — the pending predicate `acked_at_us IS NULL` (ordered by `seq`, so batch assembly still needs no
   sort) and the sweep's `acked_at_us <= cutoff`. A partial index on `seq` `WHERE acked_at_us IS NULL` would
   be marginally tighter for the pending side and would leave the **sweep** with no index at all: it targets
   exactly the rows such an index excludes, which in a ledger-enabled store are most of the table.

2. **Retention is client config, and its default is `0` — today's semantics, at today's cost.**
   `events.ackedRetentionMs` joins the Event-lane tuning on `createSyncClient` / `defineSyncWorker` (never
   the registry: ADR-0053's consequences already put cadence there, and this is the same kind of deployment
   tuning). It is validated at construction like every other value — a finite number `>= 0`; `0` is
   meaningful, so the floor is not 1.

   At `0` an `acked` verdict takes the **delete** path, in the same statement as the terminal ones: no stamp,
   no sweep, no extra round trip. That is a real fast path rather than a degenerate retention, because the
   default must not tax every consumer for a feature one consumer needs. Above `0` the ledger is on, and a
   sweep deletes rows whose `acked_at_us` is older than the retention. The sweep runs at the **top of each
   flush pass** — before the batch-level backoff gate, because retiring rows the server already acked is
   store-local bookkeeping that owes the network nothing — and **once at runtime construction**, where it
   runs whatever the retention is. That construction sweep is what retires rows a previous run stamped under
   a since-removed retention; afterwards a retention-`0` runtime can produce no stamped row at all, which is
   why its flush passes skip the sweep entirely.

3. **"Pending" means `acked_at_us IS NULL`, everywhere.** A retained row has HAD its verdict, so it is
   invisible to: the drain signal `{ empty }` (ADR-0053's semantics are "events awaiting a server verdict",
   and a lit "pending events" indicator for the whole retention would be a lie), batch assembly (re-posting
   an acked row would be a duplicate delivery the `eventId` dedupe has to absorb — traffic the ledger must
   not create), `diagnostics().outbox`, and the non-forced `destroy()` refusal on both client forms. The
   Outbox is no longer "the set of things owed"; the set of things owed is the `acked_at_us IS NULL` subset,
   and every library surface that meant the former now says the latter.

4. **The DDL is CREATE-only. A store that predates the column is reset at the consumer's cutover.** There is
   no `ALTER`, no adoption path, and no runtime tolerance for a store without the column. This is the
   library's greenfield posture applied unchanged — nothing preceding the current local-store shape shipped,
   and compatibility with a store that predates a column is not a thing this library carries. The local
   store is a read cache plus an Outbox; a cutover resets it, and a migration written for stores nobody is
   carrying forward would be the more expensive of the two options.

5. **The public surface grows by exactly two things**: the `events.ackedRetentionMs` option and the
   `acked_at_us` column on `OutboxTable`. No new export, no verdict-shaped API, no second observation
   surface. The composition rule is documented where a consumer meets it — on `getOutboxTable` and in
   `OUTBOX_TABLE`'s column contract: **a best-guess view reads `acked_at_us IS NULL` for pending rows, and
   may keep counting an acked row until its own synced row's stamp accounts for it, or until the retention
   elapses and the sweep retires it.** That grace window is the consumer's ledger, and the whole reason the
   column exists.

## Alternatives considered

**The consumer keeps its own shadow ledger in an app table.** Nothing in the library changes: on each
`onEventLaneReport` (or after each flush) the app copies what it thinks was acked into a table of its own and
composes from that. It duplicates library-owned state — the app would be maintaining a second, partial copy
of the Outbox — and it **races the delete**: the report carries `refused`/`rejected` but deliberately never
carries `acked` (ADR-0053 decision 2: a successful append-only lane would drown the app in its own volume),
so the app's only signal that a row was acked is that the row vanished. A ledger built on "it's gone, so it
must have been acked" cannot distinguish an ack from a `refused` it also did not see, and it has no ack
timestamp of its own. The library holds the fact; the library should hold the row.

**A count-bearing or fold-aware drain signal.** Adding `{ pendingCount }`, or a third state between "pending"
and "gone", would let the app compose off the signal instead of the table. ADR-0053 already rejected counts on
this signal (stale by construction when emitted on transitions, a worse live query when emitted per change),
and a fold-aware state is the thing the library provably cannot know. The signal stays `{ empty }`; richer
questions stay queries against the Outbox, which is precisely what the public shape is for.

**Default the retention to something positive** (say 30s), so the dip is fixed for everyone with no
configuration. Rejected: it silently changes what the Outbox MEANS for every existing consumer — rows now
linger, `SELECT count(*) FROM pgxsinkit_outbox` stops answering "how much is owed", and a store's disk
footprint grows with volume rather than with backlog — to solve a problem only a composing consumer has. The
exerciser makes the point: the Board demo appends `board_issue_viewed` and composes nothing, so a positive
default would buy it retention it has no use for. A consumer that needs the ledger knows it needs the ledger.

**Delete on ack but re-insert on a "fold detected" signal.** Considered only long enough to state it: it needs
the same impossible knowledge as decision 2's rejected fix, and it would put the library in the business of
writing rows the server never verdicted.

## Consequences

- **The default path is byte-for-byte what it was.** At `ackedRetentionMs: 0` settlement runs the same single
  delete, no pass runs a sweep, and the only added cost anywhere is the `acked_at_us IS NULL` conjunct on the
  pending reads — served by the new index, on a column that is always NULL.
- **With the ledger on, the Outbox holds more than what is owed.** Its size is now "backlog + retention
  window × append rate", so the retention is sized to the deployment's ack→fold→sync latency plus margin, not
  to how much history someone would like. It is not an archive: ADR-0053's replay-is-an-archive-scan pattern
  is still the consumer's own store.
- **An app composing over the Outbox must read `acked_at_us IS NULL`,** not "the row exists". That is the one
  behavioural obligation this ADR places on a consumer, and it is stated on the two surfaces a consumer
  actually reads (`getOutboxTable`, `OUTBOX_TABLE`) plus the Event-lane concept page, the production-operating
  page, and the `core` / `operating` skills. The vocabulary grows by one term — **Acked ledger** — and the
  Outbox's and Drain signal's CONTEXT.md entries stop saying "acked rows are deleted" / "is empty".
- **Coverage** rides the existing Event-lane unit lanes: the DDL column/index in `event-outbox-append`, the
  settlement split, the sweep's boundary, the never-re-posted invariant and the retention's validation in
  `event-lane-flush`, the lifecycle position (drain signal, `diagnostics`, a destroy that proceeds over a
  retained row) in `event-lane-lifecycle`, and the same `diagnostics` answer across the worker bridge in
  `event-lane-bridge`.
- **A store provisioned before this column is not upgraded** — it is reset. That is the CREATE-only decision
  restated as an operational fact, and the only one in this ADR that a consumer has to act on.
