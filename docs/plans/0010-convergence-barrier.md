# Plan — ADR-0010: Convergence barrier

Implements [ADR-0010](../adr/0010-convergence-barrier.md). Goal: resolve an acked optimistic
write by a **Server-version barrier**, not by key-match — clear the Overlay row and Mutation
journal entry only once the synced echo's Server version has reached the write's acked
version — and make that Server version (`updated_at_us`) **strictly monotonic per row** so a
stale or wall-clock-skewed echo can never clear a write early. The barrier rule is expressed
**once** and shared by both clearing sites.

Build **after** [ADR-0012](../adr/0012-canonical-entity-identity.md): the barrier keys on the
canonical Entity identity, and Phase 3 here layers the `GREATEST` expression onto 0012's
tuple-correct `update` branch in the same applier file.

Depends on / coordinates with: [ADR-0012](../adr/0012-canonical-entity-identity.md) (the
canonical identity the barrier and the journal-clear key on),
[ADR-0004](../adr/0004-one-registry-interpreter.md) (registry-driven generation; the shared
predicate resolves the Server-version column from the registry),
[ADR-0011](../adr/0011-convergence-model.md) (the Convergence model that will _own_ this
predicate and the sync-state view — this plan introduces the shared predicate the model later
consumes), [ADR-0005](../adr/0005-mutation-convergence.md) /
[ADR-0006](../adr/0006-local-schema-evolution.md) (the quarantine + registry-validation
surfaces this extends).

Each phase ends `validate`-green; the stale-echo and backwards-clock regressions run in the
Podman integration lane against real Electric + Postgres.

## Phase 1 — One shared barrier predicate

- Add `buildOverlayResolutionPredicate(context)` in a shared module (consumed by both
  `schema.ts` and `mutation.ts`), resolving the Server-version column from the registry per
  [ADR-0004](../adr/0004-one-registry-interpreter.md). It emits the conjunct
  `journal.server_updated_at_us <= <synced|NEW>.updated_at_us` against the relevant relation
  alias. A runtime SQL function was rejected (heavier in PGlite, redundant when both sites
  already generate registry-driven SQL).
- No behaviour change yet — the predicate is introduced and unit-tested in isolation
  (correct column resolution, correct alias) before either site adopts it.

## Phase 2 — Wire both clearing sites to the predicate

- **Trigger** (`schema.ts` per-table reconcile trigger): the acked-create/update journal-clear
  gains the barrier conjunct; the **overlay-clear stays** "clear once no journal rows remain
  for the entity". `delete` resolution is unchanged (synced-row **absence**; deletes carry no
  Server version).
- **Flush path** (`reconcileTable`, `mutation.ts:1784-1816`): replace the
  "PK-match only — no timestamp gate" clear with the same `buildOverlayResolutionPredicate`
  output. The two sites now emit one rule; they can no longer drift.
- Keep **both** sites — each covers one ack/echo ordering (ADR-0010 decision 5):
  _ack-before-echo_ → `reconcileTable` holds, the later echo's trigger clears;
  _echo-before-ack_ → the trigger's `NOT EXISTS journal` guard clears nothing, the post-flush
  `reconcileTable` clears on ack.
- Tests: both orderings, asserting the overlay clears exactly once and only on the real echo.

## Phase 3 — Strictly-monotonic Server version (applier)

- In `packages/server/src/mutations/plpgsql-apply.ts`, the `update` SET for the
  Server-version managed field becomes
  `updated_at_us = GREATEST(<clock_us>, <table>.updated_at_us + 1)` so a row's version
  strictly increases on every write and can never repeat or step backwards under NTP skew.
  The self-reference is valid because it lands on 0012's tuple-correct `update` branch (and is
  preserved set-based later by [ADR-0014](../adr/0014-bulk-apply-ordering-safety.md), where
  `t` is the `UPDATE … FROM` target).
- The ack token and the echo token stay the **same** column (`route.ts:529` reads exactly the
  column the echo carries), so a write's own echo clears it by equality.

## Phase 4 — Hard-require a Server version on writable tables

- Add a registry-validation rule: a **writable** synced table **must** declare a
  `nowMicroseconds`-on-update managed field (the Server version, conventionally
  `updated_at_us`); one without it is **rejected** at validation. Chosen over the ADR-0006
  warn-and-degrade pattern deliberately — optimistic convergence is unsound without a per-row
  version, and the footgun cost outweighs the soft-path flexibility.
- Tests: a writable table without a Server-version managed field is rejected; a read-only
  table without one is fine.

## Phase 5 — Proofs

- Integration (Podman, real Electric + Postgres): force a **stale same-key echo to arrive
  between ack and the real echo** and assert the overlay is **not** cleared early — the core
  regression the barrier exists to catch.
- **Two rapid same-entity writes under a backwards wall clock**, asserting the first write's
  echo does not clear the second (proves the `GREATEST` monotonicity).
- The registry-validation rejection (Phase 4) at the unit level.

## Acceptance

- An acked create/update's overlay + journal clear only when the synced echo's Server version
  reaches the acked version; a stale lower-version echo never clears it.
- The barrier rule exists in exactly one place (`buildOverlayResolutionPredicate`) and both
  the trigger and `reconcileTable` emit it; the "PK-match only" comment and code are gone.
- `updated_at_us` is strictly monotonic per row via `GREATEST(clock, current + 1)`.
- A writable synced table without a Server version is rejected at registry validation.
- `delete` resolution is unchanged (absence-gated).
- `validate` green; the stale-echo and backwards-clock regressions green in the integration
  lane.
