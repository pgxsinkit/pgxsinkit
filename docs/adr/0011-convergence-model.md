# The Convergence model: one owner of local convergence, derived not stored

Status: accepted (2026-06-23)

Now that the read path is internalized ([ADR-0009](0009-internalize-read-path-sync.md)) and the
write path is ours, the toolkit owns both edges of the local store. But they are still two largely
separate subsystems: read sync writes the synced read cache; write sync stages optimistic intent in
the **Overlay** and **Mutation journal**. They meet only at the **Read model** view and at the
convergence point (the reconcile trigger + flush-time `reconcileTable`).

That split leaves the central offline-first question without a single owner:

> For a given entity, what does the toolkit know — local intent, server acknowledgement, observed
> Electric state, read-model visibility, conflict?

Today the answer is spread across the synced table, the overlay, the journal, a generated trigger,
and flush-time reconciliation. That distribution is *how* behaviour drifts: [ADR-0010](0010-convergence-barrier.md)
exists because the overlay-resolution rule was written twice and disagreed. The fix should not stop
at de-duplicating one predicate; the convergence ownership itself should be a single, named seam.

Two larger moves were considered and **rejected**:

- **Merging the data plane** (synced + overlay into one physical table). It does not remove the dual
  value storage — the barrier needs the server version *and* the optimistic value, so a dirtied row
  still carries both. It makes the Sync applier overlay-aware and complicates must-refetch/truncate.
  Decisively, it breaks [ADR-0006](0006-local-schema-evolution.md): the read cache is droppable
  precisely *because* it is separate from the overlay/journal authority, and merging them forces the
  "lossless offline upgrade" that ADR-0006 decision 9 deliberately deferred.
- **Materialising a per-entity `sync_entity_state` table** that both paths write. It denormalises
  facts already in the synced table and journal (`observed_server_version` *is* `synced.updated_at_us`;
  `acked_server_version` *is* the acked journal row; `pending_count` *is* a journal `COUNT`), so it
  adds a drift surface rather than removing one — the [ADR-0004](0004-one-registry-interpreter.md)
  disease. It also couples the read-apply transaction and the flush transaction (which today touch
  different tables and meet only via the on-synced-table trigger), and a generic `entity_key_json`
  identity discards the real, indexable PK columns the per-table model has.

## Decision

1. **Unify the control plane, not the data plane.** Introduce the **Convergence model** as the single
   owner of how local optimistic state converges to server state. Read sync (Sync applier) and write
   sync (mutation runtime) remain the **two edges** and keep their separate transaction paths — that
   decoupling is a concurrency feature — but neither independently decides whether an entity is
   resolved. The model is the one resolution authority.

2. **The convergence state is a derived projection, never a stored copy.** Each writable table gains a
   generated per-table sync-state view (`<table>_sync_state`), distinct from the Read model, computed
   over synced + overlay + journal and reactive in PGlite. It exposes the per-entity convergence state
   — `observed_server_version`, `acked_server_version`, `pending_count`, `has_acked_unobserved_write`
   (= acked > observed), `local_delete_pending`, and a `conflict_state` slot (decision 5). The Read
   model stays lean (it already carries `overlay_kind`, the everyday optimistic signal), so plain data
   reads never pay the heavier convergence join; an app that wants per-row status joins the sync-state
   view on the PK. **Per-table** (real PK columns), not a generic `entity_key_json` view.

3. **One module owns the convergence vocabulary.** A dedicated module (the Convergence model) owns the
   shared barrier predicate (`buildOverlayResolutionPredicate`), the sync-state view generator
   (`buildSyncStateView`), and the event model (below). `schema.ts` consumes it to emit the trigger and
   the sync-state view as DDL; `mutation.ts` consumes the same predicate in `reconcileTable`. This is
   distinct from the existing **convergence driver** (`convergence.ts`, ADR-0005), which schedules
   *when* to converge; the Convergence model defines *how* an entity resolves.

4. **Observation and resolution share one predicate (the anti-drift guarantee).** The sync-state view
   derives its convergence status from the *same* barrier predicate the resolver uses — one SELECT-able
   boolean, two consumers (the journal-clear `DELETE … WHERE` and the view's status `CASE`). The view
   never re-computes "resolved" independently, so what the UI shows and what the resolver does can never
   disagree. This is the property that earns the single module.

5. **Conflict state is per-mutation on the journal, not per-entity.** The genuinely new state ISS-10
   (stale-write / conflict policy) needs — the base server version a mutation was authored against, and
   its conflict outcome — is per *mutation*, so it lands on the Mutation journal (the same pattern as
   the existing `registry_version` stamp), and the sync-state view surfaces it per entity. The
   Convergence model reserves the hook; the policy itself is ISS-10.

### Event model (the spec the model implements; state is derived, not a mutated row)

| Event | Effect on derived state |
|---|---|
| local create/update/delete enqueued | overlay upserted; a journal mutation appended (records base server version for ISS-10) |
| mutation sent | journal row → `sending` |
| mutation acked | journal row → `acked`, `server_updated_at_us` stamped; entity shows `acked_unobserved` until the echo catches up |
| Electric insert/update observed | synced row applied; the barrier predicate runs; resolved entities clear overlay + acked journal |
| Electric delete observed | resolved by synced-row absence (deletes carry no Server version — ADR-0010) |
| resolution | clear overlay/journal only through the shared predicate (decision 4) |
| conflict detected | `conflict_state` recorded on the journal row (ISS-10); surfaced in the sync-state view |
| shape must-refetch | subscription reset + re-stream; affected entity state re-derives from the fresh synced rows |

## Consequences

- "What is this entity's convergence state?" has one authoritative, queryable answer, and observation
  can never drift from resolution (decision 4) — the class of bug ADR-0010 fixed cannot recur a layer up.
- ISS-01 (the barrier), ISS-02 (composite-PK canonical identity — foundational, since the model keys on
  a canonical PK tuple), and ISS-10 (conflict policy) now live *inside* the Convergence model rather than
  as separate tracks.
- ADR-0006 droppability and the read/write transaction decoupling are preserved (no data-plane merge,
  no shared mutable control table).
- Cost: a new generated per-table view and a new owning module; the barrier predicate must be expressible
  as a reusable boolean (usable in both `DELETE … WHERE` and a `SELECT … CASE`).

## Proving it

- A test asserting the `<table>_sync_state` status and the resolver agree for the same entity across all
  barrier orderings (the single-predicate guarantee).
- A test asserting `has_acked_unobserved_write` is true exactly between ack and echo, false otherwise.

References: `CONTEXT.md` (Convergence model, Convergence barrier, Server version, Overlay, Mutation
journal, Read model, Local schema); [ADR-0010](0010-convergence-barrier.md) (the barrier this model
owns); [ADR-0006](0006-local-schema-evolution.md) (droppability the data-plane merge would break);
[ADR-0004](0004-one-registry-interpreter.md) (registry-driven generation; the drift a materialised table
would add); [ADR-0005](0005-mutation-convergence.md) (the convergence *driver*, distinct from this
*model*); [ADR-0009](0009-internalize-read-path-sync.md) (owning both edges makes this possible); ISS-02
(composite-PK identity), ISS-10 (conflict policy);
`tmp/agents/sync-system-improvement-worklog.md` (ISS-12).
