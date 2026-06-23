# Bulk apply on both paths, without the set-based ordering hazard

Status: accepted (2026-06-23)

Both the read-path Sync applier and the write-path Mutation applier currently degrade to one SQL
statement per row for the common case: the read apply bulk-loads only *leading* inserts and then
applies each update/delete one at a time (`packages/client/src/sync/index.ts:309-346`), and the
in-database applier loops `jsonb_array_elements` with one dynamic `EXECUTE` per mutation
(`packages/server/src/mutations/plpgsql-apply.ts`). Steady-state replication and multi-write flushes
are exactly the cases this penalises.

The obvious fix — `UPDATE … FROM (VALUES …)` / `INSERT … SELECT … json_to_recordset(...)` — carries a
subtle correctness hazard. **These are joins.** When the source relation contains more than one row
matching the same target primary key, PostgreSQL uses **one arbitrary matching row** and the result is
**unspecified** (the documented `UPDATE … FROM` behaviour). So a naive bulk apply that puts multiple
same-PK rows in one statement is silently wrong. The per-row loops are correct today precisely because
they apply same-PK operations in order, last-wins. Any bulk apply must therefore guarantee **at most one
source row per target PK** — and the two paths reach that guarantee differently.

## Decision

1. **Read path — fold each PK's batch to one net operation before bulking (in the Shape inbox).** A
   drained read batch can hold several operations for one PK across LSNs. Before any bulk statement runs,
   the Shape inbox (ADR-0011 / ISS-06) replays each PK's operations in LSN order down to **one net
   operation**:
   - trailing `delete` ⇒ **DELETE**;
   - any `insert` with no trailing delete ⇒ **INSERT** with merged final values;
   - only `update`s ⇒ **UPDATE** with merged values;
   - `[delete, insert]` ⇒ **INSERT** (re-created); `[delete, update]` is malformed and rejected.

   The applier then runs exactly three bulk statements per shape — `INSERT`, `UPDATE … FROM (VALUES …)`,
   `DELETE … USING (VALUES …)` — and because each PK folds into exactly **one** of them, no PK is touched
   by two statements, so their order within the (atomic) commit is irrelevant. The fold lives in the
   *pure* Shape inbox, so it is property-tested against random same-PK sequences with the oracle
   *fold-then-bulk ≡ ordered per-row apply*. Folding preserves the faithful-apply rule (a net `INSERT` is
   a plain `INSERT`, so a genuine PK collision still surfaces rather than silently upserting — commit
   `de12bb6`) and the per-row reconcile trigger (it fires once on the final row, so the ADR-0010 barrier
   is unaffected).

2. **Write path — apply set-based, safe by the Per-entity flush serialization invariant.** The Mutation
   applier groups a batch by `(table, kind)` and applies each group set-based via `json_to_recordset`.
   Its safety from the join hazard rests on the **Per-entity flush serialization** invariant
   (`CONTEXT.md`): `readPendingBatchRows` (`mutation.ts:1376-1386`) selects a mutation only when no
   earlier same-entity mutation is still owed, so a POSTed batch holds **at most one operation per
   Entity identity** — no same-PK duplicates, regardless of the batch-size limit. Set-based apply
   preserves everything the per-row path did: managed-field expressions as `SELECT`/`SET` columns —
   including ADR-0010's `updated_at_us = GREATEST(clock_us, t.updated_at_us + 1)` (the self-reference
   works because `t` is the `UPDATE … FROM` target) and `auth.uid()`; the per-batch RLS actor context
   (set once at function entry); per-entity ack `serverUpdatedAtUs` read in one `SELECT … WHERE pk IN
   (…)`; and whole-batch failure semantics (a runtime apply failure is already a single-transaction
   whole-batch 500 today, so set-based apply does not regress per-mutation attribution, which lives in
   pre-apply Zod validation — ADR-0005).

3. **The invariant is a tested release gate.** Because correctness — not just performance — now depends
   on Per-entity flush serialization, it gets an explicit test: stage multiple pending mutations for one
   entity and assert a flush batch contains at most one per entity, across the batch-size limit, the
   dedupe path, and create-then-update of a new entity. If that confidence ever lapsed, the fallback is
   the same per-PK fold as the read path, applied server-side — the invariant makes it unnecessary.

## Consequences

- Steady-state read apply scales with distinct PKs per commit, not row count; server apply scales with
  distinct `(table, kind)` groups, not mutation count — less time in the commit transaction and under
  `SET CONSTRAINTS ALL DEFERRED`.
- The ordering hazard is closed **by construction** on both paths (read: fold to one row per PK; write:
  the serialization invariant), each pinned by a test, so a future "optimisation" cannot quietly
  reintroduce it.
- The read-path fold belongs to the Shape inbox, so it is pure and property-testable — a direct payoff of
  the ISS-06 split.

## Proving it

- Read: a property test asserting fold-then-bulk equals ordered per-row apply over random same-PK
  operation sequences (insert→update, update→delete, delete→insert, mixed).
- Write: the Per-entity flush serialization gate (decision 3), plus a test that set-based apply preserves
  the GREATEST monotonicity, `auth.uid()`, and per-entity ack timestamps.

References: `CONTEXT.md` (Shape inbox, Sync applier, Mutation applier, Entity identity, Per-entity
flush serialization); [ADR-0010](0010-convergence-barrier.md) (the `GREATEST` monotonicity the set-based
update must preserve); [ADR-0011](0011-convergence-model.md) / ISS-06 (the Shape inbox the fold lives in);
[ADR-0009](0009-internalize-read-path-sync.md) (the apply ladder being widened);
[ADR-0005](0005-mutation-convergence.md) (per-mutation validation attribution, unchanged);
`tmp/agents/sync-system-improvement-worklog.md` (ISS-03, ISS-04).
