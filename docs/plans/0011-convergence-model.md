# Plan — ADR-0011: The Convergence model

Implements [ADR-0011](../adr/0011-convergence-model.md). Goal: make the **Convergence model** a
single named owner of how local optimistic state converges to server state — owning the shared
barrier predicate, generating a per-table `<table>_sync_state` **view** (derived, never a stored
copy), and pinning the event model — so "what is this entity's convergence state?" has one
authoritative, queryable answer and **observation can never drift from resolution**.

Build **after** [ADR-0012](../adr/0012-canonical-entity-identity.md) (the model keys on the
canonical identity) and [ADR-0010](../adr/0010-convergence-barrier.md) (which already introduced
`buildOverlayResolutionPredicate` as a shared module — this plan **re-homes** it into the owning
module and adds the view around it). No data-plane merge and no shared mutable control table —
both were rejected (they would break [ADR-0006](../adr/0006-local-schema-evolution.md)
droppability / add the [ADR-0004](../adr/0004-one-registry-interpreter.md) drift disease).

Depends on / coordinates with: [ADR-0010](../adr/0010-convergence-barrier.md) (the barrier this
model owns), [ADR-0012](../adr/0012-canonical-entity-identity.md) (the canonical PK identity the
view and resolver key on), [ADR-0004](../adr/0004-one-registry-interpreter.md) (registry-driven
generation), [ADR-0005](../adr/0005-mutation-convergence.md) (the convergence **driver** in
`convergence.ts` — _when_ to converge — kept distinct from this _model_ — _how_ an entity
resolves), [ADR-0006](../adr/0006-local-schema-evolution.md) (droppability preserved),
[ADR-0015](../adr/0015-stale-write-conflict-policy.md) (the `conflict_state` slot reserved here,
filled later). `CONTEXT.md`: Convergence model, Convergence barrier, Server version.

Each phase ends `validate`-green; the agree-across-orderings proof runs in the Podman
integration lane.

## Phase 1 — The owning module

- Create the **Convergence model** module that owns: `buildOverlayResolutionPredicate` (re-homed
  from the shared module ADR-0010 introduced), the sync-state view generator
  (`buildSyncStateView`), and the event-model spec (Phase 4). `schema.ts` consumes it to emit
  the trigger **and** the view as DDL; `mutation.ts` consumes the same predicate in
  `reconcileTable`.
- Keep it **distinct** from the convergence _driver_ (`convergence.ts`, ADR-0005): the driver
  schedules _when_ to converge; the model defines _how_ an entity resolves. No change to the
  driver here.
- No behaviour change yet — this phase is the move + single home, with the existing barrier
  tests re-pointed at the module.

## Phase 2 — The per-table sync-state view (derived, not stored)

- Generate `<table>_sync_state` per **writable** table (DDL emitted by `schema.ts`), **distinct
  from the Read model**, computed over synced + overlay + journal and reactive in PGlite. It
  exposes per entity: `observed_server_version` (= `synced.updated_at_us`),
  `acked_server_version` (the acked journal row), `pending_count` (a journal `COUNT`),
  `has_acked_unobserved_write` (= acked > observed), `local_delete_pending`, and a
  `conflict_state` slot (reserved for ADR-0015).
- **Per-table real PK columns**, never a generic `entity_key_json` view (that was rejected — it
  discards the indexable PK and denormalises facts).
- Keep the **Read model lean** (it already carries `overlay_kind`, the everyday optimistic
  signal) so plain data reads never pay the heavier convergence join; an app that wants per-row
  status joins the sync-state view on the PK.

## Phase 3 — Anti-drift: one predicate, two consumers

- The view's status `CASE` derives from the **same** `buildOverlayResolutionPredicate` the
  resolver's journal-clear `DELETE … WHERE` uses — one SELECT-able boolean, two consumers. The
  view never re-computes "resolved" independently.
- Test (the property that earns the single module): the `<table>_sync_state` status and the
  resolver **agree** for the same entity across all barrier orderings (ack-before-echo,
  echo-before-ack, stale-echo).

## Phase 4 — Event model wiring

- Make each event map to the derived state per the ADR-0011 table: local enqueue → overlay
  upsert + journal append (recording `base_server_version` for ADR-0015); sent → `sending`;
  acked → `acked` + `server_updated_at_us` stamped, entity shows `acked_unobserved` until the
  echo catches up; Electric insert/update observed → barrier runs, resolved entities clear;
  Electric delete observed → resolved by synced-row absence; resolution → clear only through the
  shared predicate; conflict detected → `conflict_state` recorded (ADR-0015); shape must-refetch
  → subscription reset + re-derive from fresh synced rows.
- **Reserve** the `conflict_state`/`base_server_version` hook on the journal (same pattern as
  the existing `registry_version` stamp) **without** implementing the policy — that is
  [ADR-0015](../adr/0015-stale-write-conflict-policy.md).
- **Build note:** `conflict_state` reuses the existing `conflict_reason` journal column (surfaced by
  the view). `base_server_version` is **reserved as a nullable journal column but left unstamped** —
  what counts as the "base" the write was authored against (the synced Server version only, or the
  read-model value _including_ a prior optimistic write) is the crux of the conflict policy, so the
  stamping semantics belong to [ADR-0015](../adr/0015-stale-write-conflict-policy.md), not here. The
  ADR-0011 proofs do not depend on it.

## Phase 5 — Proofs

- The agree-across-orderings test (Phase 3) — the single-predicate guarantee.
- A test asserting `has_acked_unobserved_write` is **true exactly between ack and echo**, false
  otherwise.
- A test asserting the Read model is unchanged for plain reads (no convergence join leaked into
  it) and that droppability (ADR-0006) still holds — dropping the read cache does not touch
  overlay/journal authority.

## Acceptance

- One Convergence-model module owns the barrier predicate, the view generator, and the event
  model; it is distinct from the ADR-0005 driver.
- Each writable table has a generated `<table>_sync_state` view, per-table real PK, derived from
  synced + overlay + journal, exposing the convergence fields incl. a reserved `conflict_state`.
- The view and the resolver share one predicate and agree across every barrier ordering.
- The Read model stays lean; ADR-0006 droppability and the read/write transaction decoupling are
  preserved (no data-plane merge, no shared mutable control table).
- `validate` green; the agree-across-orderings and `has_acked_unobserved_write` proofs green.
