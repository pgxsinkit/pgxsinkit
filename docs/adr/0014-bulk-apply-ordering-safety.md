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
   - `insert` with no delete in the run ⇒ **INSERT** with merged final values (a *plain* insert —
     a genuine PK collision still surfaces);
   - only `update`s ⇒ **UPDATE** with merged values;
   - re-created (`[delete, … , insert, …]`, no trailing delete) ⇒ **DELETE then INSERT**: the delete
     clears the **pre-existing** row so the insert cannot collide with it. (Folding this to a *plain*
     INSERT — the obvious reading — is wrong: under faithful replication the local row mirrors the
     server, so a `[delete, insert]` means the row *did* exist and is being replaced; dropping the
     delete leaves the old row in place and the INSERT collides. This was corrected from the literal
     decision during the Phase 2 build, where the property test runs against non-empty initial state.)
   - `[delete, update]` (update after a delete) is malformed for a faithful stream — an update asserts
     the row exists — and is rejected.

   The applier then runs exactly three bulk statements per shape, **in the order `DELETE … USING
   (VALUES …)` → `INSERT` → `UPDATE … FROM (VALUES …)`**. Every PK folds into exactly **one** net op
   except a re-created PK, the *only* PK in two statements (its delete and its insert) — and running
   DELETE before INSERT is exactly what makes that safe (faithful to the per-row `DELETE`-then-`INSERT`).
   Every other PK is touched by one statement, so the rest of the order is irrelevant within the
   (atomic) commit. The fold lives in the
   *pure* Shape inbox, so it is property-tested against random same-PK sequences with the oracle
   *fold-then-bulk ≡ ordered per-row apply*. Folding preserves the faithful-apply rule (a net `INSERT` is
   a plain `INSERT`, so a genuine PK collision still surfaces rather than silently upserting, as pinned by
   the Shape inbox tests) and the per-row reconcile trigger (it fires once on the final row, so the
   ADR-0010 barrier is unaffected).

2. **Write path — apply set-based, safe by the Per-entity flush serialization invariant.** The Mutation
   applier groups a batch by `(table, kind, payload column-set)` and applies each group set-based via
   `jsonb_to_recordset` (one statement per group, replacing the per-mutation `EXECUTE` loop). Grouping
   by the column-set too — refined during the Phase 4 build, the same shape the read-path fold reaches
   (decision 1) — keeps each `UPDATE … FROM` / `INSERT … SELECT` statement's column list uniform, since
   a sparse update sets only the columns it changed. `mutationSeq` is local to each table journal, so
   groups run in ascending position in the submitted JSON array, captured with `WITH ORDINALITY`.
   That array position is the batch-global order and keeps parent groups before dependent child groups
   (FK-safe; the batch already `SET CONSTRAINTS ALL DEFERRED`). Its safety from the join hazard rests on
   the **Per-entity flush serialization** invariant
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
- Write: the Per-entity flush serialization gate (decision 3), a cross-table test in which table-local
  mutation sequences overlap, plus tests that set-based apply preserves the GREATEST monotonicity,
  `auth.uid()`, and per-entity ack timestamps.

References: `CONTEXT.md` (Shape inbox, Sync applier, Mutation applier, Entity identity, Per-entity
flush serialization); [ADR-0010](0010-convergence-barrier.md) (the `GREATEST` monotonicity the set-based
update must preserve); [ADR-0011](0011-convergence-model.md) / ISS-06 (the Shape inbox the fold lives in);
[ADR-0009](0009-internalize-read-path-sync.md) (the apply ladder being widened);
[ADR-0005](0005-mutation-convergence.md) (per-mutation validation attribution, unchanged);
`tmp/agents/sync-system-improvement-worklog.md` (ISS-03, ISS-04).
