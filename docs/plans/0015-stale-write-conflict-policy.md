# Plan — ADR-0015: Stale-write conflict policy

Implements [ADR-0015](../adr/0015-stale-write-conflict-policy.md). Goal: turn today's **implicit
last-write-wins** into a **chosen** behaviour — detect a stale write server-side by comparing the
row's current **Server version** to the mutation's **Base server version**, under a **required
per-table Conflict policy** (v1: `last-write-wins` | `reject-if-stale`), routing a rejected write
to a distinct terminal **`conflicted`** state that keeps the optimistic Overlay, with resolution
as an ordinary new mutation.

This is the **largest remaining sync feature**; build it **last**, once the simpler items land.

Depends on / coordinates with: [ADR-0010](../adr/0010-convergence-barrier.md) (the strictly-
monotonic Server version detection rests on), [ADR-0011](../adr/0011-convergence-model.md) (the
reserved `base_server_version`/`conflict_state` hooks on the journal and the sync-state view that
surfaces them), [ADR-0014](../adr/0014-bulk-apply-ordering-safety.md) (Per-entity flush
serialization, which makes chained-base resolution computable at flush),
[ADR-0012](../adr/0012-canonical-entity-identity.md) (the canonical identity the detection keys
on), [ADR-0005](../adr/0005-mutation-convergence.md) (the terminal-state + attribution machinery
reused; `conflicted` is distinct from `quarantined`). `CONTEXT.md`: Base server version, Conflict
policy, Server version, Convergence model.

Each phase ends `validate`-green; the external-write-interleave and no-self-conflict proofs run
in the Podman integration lane against real Postgres.

## Phase 1 — Capture the Base server version on the journal

- Add `base_server_version` per mutation on the Mutation journal (same stamp pattern as
  `registry_version`). It is **not** naively stamped at enqueue — that would self-conflict an
  entity's own chain. Capture per ADR-0015 decision 2:
  - **chain head** (first staged write on the entity) → `base` = the synced Server version the
    user saw at enqueue (so a genuine external write between view and apply is caught);
  - **chained write** → `base` = its predecessor's Server version, **resolved at flush** (the
    predecessor is already acked, by Per-entity flush serialization, ADR-0014).
- Test (before any detection lands): an entity's own chained edits (m1, m2) compute bases such
  that they would **not** self-conflict — the base-capture rule in isolation.

## Phase 2 — Required per-table Conflict policy

- Add a `conflictPolicy` declaration to the **writable**-table registry: **required, no silent
  default**. v1 enum `{ last-write-wins, reject-if-stale }`; shape the enum so `field-merge` and
  `custom-resolver` slot in later without a breaking change.
- Registry validation **rejects** a writable table that declares no policy — the **third
  hard-require** (after the Server version and the server-PK-in-projection rules), accepted as
  consistent with the footgun-averse stance.
- Test: a writable table with no `conflictPolicy` is rejected; both v1 values are accepted.

## Phase 3 — Server-side detection in the applier

- In `packages/server/src/mutations/plpgsql-apply.ts`, at apply compare the targeted row's
  **current** Server version to the mutation's `base_server_version`. `current > base` ⇒ the
  write is **stale** (an external write interleaved). `create` has **no** base — its conflict is
  a PK collision, a separate concern, unchanged.
- Branch on the table's policy:
  - `last-write-wins` → apply the stale write anyway (today's behaviour, now a **named choice**);
  - `reject-if-stale` → do **not** apply; return a conflict outcome carrying the row's current
    Server version.
- Set-based safe: the comparison is a `WHERE`/`SELECT` column over the full PK tuple
  (ADR-0012), composes with the ADR-0014 `json_to_recordset` group apply.

## Phase 4 — `conflicted` terminal state, kept overlay, resolution-as-new-mutation

- A `reject-if-stale` conflict moves the mutation to a **distinct terminal `conflicted`** status
  (with `conflict_state` set) — **not** `quarantined` (which is _structural_ invalidity with a
  different resolution path).
- The optimistic **Overlay is kept and marked conflicted, never reverted**, so the user's edit is
  not silently lost; the Read model keeps showing it. Because the synced table already holds the
  current server value, the app reads both sides (overlay + synced) to build a resolution/diff UI
  with **no new storage**.
- Surface via a dedicated **`onConflict`** callback and the ADR-0011 sync-state view's
  `conflict_state` (distinct from `onQuarantine`).
- **Resolution is a new mutation** with a fresh Base server version (Phase 1), so a resolved
  conflict flows through normal convergence with no special transition; **discard** clears the
  overlay + the conflicted entry.

## Phase 5 — Proofs

- An external write advances the row **between a mutation's base and its apply**, asserting the
  stale write is detected and handled per the table's policy (both `last-write-wins` and
  `reject-if-stale`).
- An entity's own chained edits (m1, m2) under `reject-if-stale` do **not** self-conflict (the
  base-capture rule, Phase 1, end-to-end).
- A `conflicted` mutation keeps its overlay; a resolution mutation converges normally; discard
  clears overlay + entry.

## Acceptance

- Stale writes are detected server-side by Server version vs Base server version; an entity's own
  chain never self-conflicts.
- Every writable table declares a Conflict policy; none is rejected silently; v1 offers
  `last-write-wins` and `reject-if-stale`, with `field-merge`/`custom-resolver` reserved.
- A `reject-if-stale` conflict lands in a distinct terminal `conflicted` state, keeps the
  overlay, surfaces via `onConflict` + the sync-state view, and resolves as a new mutation.
- Silent last-write-wins is impossible; where wanted it is a conscious per-table choice.
- `validate` green; the interleave, no-self-conflict, and keep-overlay/resolve proofs green in
  the integration lane.

## Build notes (BUILT — all five phases, order P2 → P1 → P3 → P4 → P5)

Built in dependency order, each phase its own `validate:full`-green commit on `develop`.

- **P2 — required Conflict policy.** `ConflictPolicy` + `CONFLICT_POLICIES` + `isConflictPolicy` in
  `config.ts`; `conflictPolicy?` on `SyncTableEntry` and the `defineSyncTable` input;
  `validateSyncTableEntry` rejects an undeclared policy on a writable table (the third hard-require,
  right after the Server-version one). Swept every writable registry: demo `authors`=last-write-wins
  / `todos`=reject-if-stale, integration `projects`=reject-if-stale + the rest last-write-wins, perf +
  test fixtures. The raw `TableSpecInput`-shaped test configs (client-sync-reset / perf-lab-pglite /
  shape-sync) bypass `validateSyncTableEntry`, so they need no policy.
- **P1 — Base server version capture.** Optional `baseServerVersion` on `mutationEnvelopeSchema`. The
  enqueue path stamps a chain head's base = the synced Server version at enqueue (captured BEFORE the
  optimistic record overwrites it); a chained write stamps NULL and resolves at flush in
  `readPendingBatchRows` via `COALESCE(base_server_version, MAX acked-predecessor
server_updated_at_us, current synced version)`; a create gets none. The resolved base is re-stamped
  into the journal at mark-as-sending and carried on the envelope.
- **P3 — server detection (the crux, the only migration-touching part).** `buildTableBranch` emits
  per-policy SQL: reject-if-stale carries `b bigint, m uuid` in the `json_to_recordset`, collects
  stale rows (`t.<serverVersion> > x.b`) into a conflict accumulator, and guards the apply with
  `(x.b IS NULL OR t.<serverVersion> <= x.b)`. `pgxsinkit_apply_mutations` now
  `RETURNS TABLE(mutation_id, table_name, current_server_version)` — a return-type change, so the DDL
  (and the regenerated migration) `DROP FUNCTION` first. `executePlpgsqlBatch` returns the conflicts;
  the handler turns each into a `conflicted` ack (HTTP 409) + a `conflicted` operations-log row.
  Migration regenerated via `bun run sync:function:generate` → `infra/drizzle/20260623235948_sync_artifact`.
- **P4 — client conflict handling.** `conflicted` added to the journal state machine (terminal,
  `sending -> conflicted`). The flush ack loop routes a `conflicted` ack to the terminal state KEEPING
  the overlay (reconcile only clears acked, so the optimistic value stays); surfaced via the new
  `onConflict` callback and the sync-state view's `conflict_state` (now scoped to `status =
'conflicted'`). `discardConflict(table, entityKey)` clears the kept overlay + conflicted entry.
  Resolution is an ordinary new mutation (its base resolves to the caught-up synced version).
- **P5 — proofs.** Unit (PGlite, real-execution): `conflict-base-capture.test.ts` (no-self-conflict),
  the detection block in `plpgsql-apply.test.ts` (both policies, update + delete, no-base, non-stale),
  `conflict-handling.test.ts` (keep-overlay / onConflict / sync-state view / discard / resolve).
  Integration (Podman, real Postgres): the interleave proof in `write-api.integration.test.ts` proves
  reject-if-stale conflicts (row keeps the external value) and last-write-wins clobbers — and that the
  regenerated `RETURNS TABLE` migration applies on a real database.

GOTCHAs found during build: the demo/test mocks had used a `conflicted` ack as a generic "rejected"
marker before the status had meaning (mutation-quarantine used it for a structural 4xx → quarantine;
overlay-state asserted quarantine) — updated to `failed`/`conflicted` per the new semantics. Manual
integration-test envelopes must use COLUMN names in the payload (`author_id`, not `authorId`) — the
applier reads `x.p->>'<column>'`.

Anton's steps: apply the regenerated sync-function migration to the dev DB
(`bun run db:migrate`); the Podman lane already applied it to fresh containers.
