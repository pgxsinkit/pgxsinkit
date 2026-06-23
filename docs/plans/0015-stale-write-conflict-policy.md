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
