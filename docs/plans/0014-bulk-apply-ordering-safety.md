# Plan — ADR-0014: Bulk apply on both paths, without the set-based ordering hazard

Implements [ADR-0014](../adr/0014-bulk-apply-ordering-safety.md). Goal: widen both appliers
from one-SQL-statement-per-row to **set-based bulk**, while closing the same-PK join hazard
(`UPDATE … FROM` / `INSERT … SELECT json_to_recordset(…)` use **one arbitrary** matching row
when the source holds duplicate PKs) **by construction** on each path — the read path folds
each PK's batch to one net op in the **Shape inbox**, the write path leans on the **Per-entity
flush serialization** invariant — each pinned by a test so a later "optimisation" cannot
quietly reintroduce the hazard.

Build **after** [ADR-0012](../adr/0012-canonical-entity-identity.md) (the write-path set-based
`WHERE` keys on the full PK tuple) and **after** [ADR-0010](../adr/0010-convergence-barrier.md)
(the set-based update must preserve `GREATEST` monotonicity). Phase 1 realises the ISS-06
read-path split (the Shape inbox), which has no separate ADR/plan.

Depends on / coordinates with: [ADR-0012](../adr/0012-canonical-entity-identity.md) (full PK
tuple), [ADR-0010](../adr/0010-convergence-barrier.md) (`GREATEST` self-reference, preserved
because `t` is the `UPDATE … FROM` target; the per-row reconcile trigger must still fire once),
[ADR-0009](../adr/0009-internalize-read-path-sync.md) (the COPY/json/insert apply ladder being
widened; the Consistency-group commit boundary, unchanged),
[ADR-0005](../adr/0005-mutation-convergence.md) (per-mutation validation attribution stays in
pre-apply Zod — unchanged), [ADR-0016](../adr/0016-deferred-read-path-optimisations.md) (the
pure Shape inbox a future ingest log would attach to). `CONTEXT.md`: Shape inbox, Sync applier,
Mutation applier, Per-entity flush serialization.

Each phase ends `validate`-green; the steady-state backfill and set-based write proofs run in
the Podman integration lane against real Electric + Postgres.

## Phase 1 — Stand up the Shape inbox (the ISS-06 read-path split, behaviour-preserving)

- Extract the pure buffering/staging out of the mixed streaming-and-apply in
  `packages/client/src/sync/index.ts` into a **Shape inbox** module: it receives a shape's
  raw change/control messages, holds them ordered by LSN, and exposes a **drained batch** up to
  the committed frontier. No database I/O lives here.
- **No fold and no behaviour change yet** — the Sync applier still applies the drained batch
  exactly as today (leading inserts bulk-loaded, remaining update/delete per-row,
  `sync/index.ts:309-346`). This phase only isolates the pure seam so the fold can be added and
  property-tested in Phase 2.
- Unit: the inbox preserves LSN order and frontier semantics for a single shape and within a
  Consistency group (the group's inboxes still advance/commit together — ADR-0009 Phase 4).

## Phase 2 — Read path: fold each PK's batch to one net operation (in the Shape inbox)

- Add the fold to the Shape inbox: replay each primary key's operations in LSN order down to
  **one net op** —
  - trailing `delete` ⇒ **DELETE**;
  - any `insert` with no trailing delete ⇒ **INSERT** with merged final values;
  - only `update`s ⇒ **UPDATE** with merged values;
  - `[delete, insert]` ⇒ **INSERT** (re-created); `[delete, update]` is malformed ⇒ rejected.
- Preserve the **faithful-apply** rule: a net `INSERT` stays a plain `INSERT` (not an upsert),
  so a genuine PK collision still surfaces (commit `de12bb6`).
- Preserve the **ADR-0010 barrier**: the per-row reconcile trigger fires once on the final
  applied row per PK, so overlay resolution is unaffected.
- **Property test** (the payoff of the pure seam): _fold-then-bulk ≡ ordered per-row apply_
  over random same-PK operation sequences (insert→update, update→delete, delete→insert, mixed).

## Phase 3 — Read path: three bulk statements per shape

- The Sync applier consumes the folded batch and runs **exactly three** statements per shape —
  `INSERT`, `UPDATE … FROM (VALUES …)`, `DELETE … USING (VALUES …)` — each with **one row per
  PK**, so no PK is touched by two statements and their order within the (atomic) commit is
  irrelevant.
- Integrate with the ADR-0009 apply ladder: the ladder still chooses _how_ the INSERT
  materialises its rows (COPY for all-scalar, `json_to_recordset` for array/json, batched
  INSERT floor); the `UPDATE`/`DELETE` source relations materialise type-aware the same way
  (`VALUES` for scalar PKs+payloads, `json_to_recordset` where array/json columns are present).
- The three statements run inside the existing per-shape / Consistency-group commit
  transaction — the commit boundary is unchanged.
- Integration: a steady-state backfill with many same-PK updates applies correctly through the
  three bulk statements; a grouped pair still commits atomically.

## Phase 4 — Write path: set-based apply in the Mutation applier

- In `packages/server/src/mutations/plpgsql-apply.ts`, group a flushed batch by
  `(table, kind)` and apply each group **set-based** via `json_to_recordset`, replacing the
  `jsonb_array_elements` loop with one dynamic `EXECUTE` per group.
- The `update`/`delete` join/`WHERE` keys on the **full server PK tuple**
  ([ADR-0012](../adr/0012-canonical-entity-identity.md)).
- Preserve everything the per-row path did, now as set columns:
  - managed-field expressions as `SELECT`/`SET` columns — including ADR-0010's
    `updated_at_us = GREATEST(clock_us, t.updated_at_us + 1)` (self-ref valid: `t` is the
    `UPDATE … FROM` target) and `auth.uid()`;
  - the **per-batch RLS actor context**, set once at function entry (unchanged);
  - **per-entity ack** `serverUpdatedAtUs` read in one `SELECT … WHERE pk IN (…)`;
  - **whole-batch failure** semantics — a runtime apply failure is already a single-transaction
    whole-batch 500 today, so set-based apply does not regress per-mutation attribution (which
    lives in pre-apply Zod validation, ADR-0005).
- Safety from the join hazard rests on **Per-entity flush serialization**: `readPendingBatchRows`
  (`mutation.ts:1376-1386`) selects a mutation only when no earlier same-entity mutation is
  still owed, so a POSTed batch holds **at most one operation per Entity identity** — no
  same-PK duplicates, regardless of the batch-size limit.

## Phase 5 — The serialization invariant as a tested release gate

- Because correctness (not just performance) now depends on Per-entity flush serialization, add
  an explicit gate test: stage multiple pending mutations for one entity and assert a flush
  batch contains **at most one per entity**, across (a) the batch-size limit, (b) the dedupe
  path, and (c) create-then-update of a new entity.
- Document the fallback in the plan only (a server-side per-PK fold mirroring the read path) —
  do **not** build it; the invariant makes it unnecessary, and the gate guards the invariant.

## Phase 6 — Proofs

- **Read** (unit/property): fold-then-bulk ≡ ordered per-row apply (Phase 2). **Read**
  (integration): the steady-state same-PK backfill (Phase 3).
- **Write** (unit): the serialization gate (Phase 5) plus a test that set-based apply preserves
  the `GREATEST` monotonicity, `auth.uid()`, and per-entity ack timestamps. **Write**
  (integration, Podman, real Postgres): a multi-write flush across several `(table, kind)`
  groups applies correctly with per-entity acks.

## Acceptance

- Read apply scales with **distinct PKs per commit**, not row count; the fold lives in the pure
  Shape inbox and is property-tested; faithful-apply and the ADR-0010 barrier are unaffected.
- Write apply scales with **distinct `(table, kind)` groups**, not mutation count; set-based via
  `json_to_recordset` over the full PK tuple; preserves managed fields, the per-batch RLS
  context, per-entity ack, and whole-batch failure semantics.
- The ordering hazard is closed **by construction** on both paths (read: fold to one row per PK;
  write: the serialization invariant), each pinned by a test.
- Per-entity flush serialization is a tested release gate.
- `validate` green; the read property test, the write proofs, and the integration backfill green.
