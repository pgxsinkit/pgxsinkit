# Stale-write conflict policy: detect by Server version, choose per table

Status: accepted (2026-06-23)

The Convergence model ([ADR-0011](0011-convergence-model.md)) reserved per-mutation
`base_server_version` and `conflict_state` hooks for the one thing it does not yet do: tell a user
their offline write was based on server state that has since moved. Today the behaviour is **implicit
last-write-wins** — a concurrent edit is silently clobbered, with no signal. For the toolkit's target
(complex multi-device staff/admin apps) that silent loss is the central hazard, and it should be a
*chosen* behaviour, not an accident.

This ADR establishes the conflict *model*; the full build is the largest remaining sync feature and
follows once the simpler items land.

## Decision

1. **Conflicts are detected server-side by Server version.** Every writable row has a strictly-
   monotonic **Server version** (ADR-0010). A mutation carries the **Base server version** it was
   authored against; at apply, the Mutation applier compares the row's *current* Server version to that
   base. `current > base` ⇒ the write is **stale** (an external write interleaved). `create` has no
   base — its conflict is a PK collision, a separate concern.

2. **Base capture distinguishes own chains from external writers.** Naively stamping `base` at enqueue
   would self-conflict an entity's own successive edits (m1 advances the row, then m2 sees `current >
   base` from m1). Per-entity flush serialization (ADR-0014) makes the correct base computable:
   - **chain head** (first staged write on the entity) → `base` = the synced Server version the user saw
     at enqueue (so a genuine external write between view and apply is caught);
   - **chained write** → `base` = its predecessor's Server version, resolved at flush (the predecessor is
     already acked, by serialization).

   So `current > base` flags only *external* interference, never the entity's own chain.

3. **The Conflict policy is a required per-table declaration; no silent default.** Each writable table
   declares one. v1 offers **`last-write-wins`** (apply the stale write anyway — today's behaviour, but
   now a named choice) and **`reject-if-stale`** (reject and surface). **`field-merge`** (apply only the
   changed fields over the current row — needs the base field *values* on the wire and a merge strategy)
   and **`custom-resolver`** (a client re-resolution protocol) are reserved; the policy enum is designed
   to take them. Making the choice mandatory makes silent clobbering impossible.

4. **A reject-if-stale conflict keeps local work and resolves as a new write.** The conflicting mutation
   moves to a **distinct terminal `conflicted` status** (with `conflict_state` set) — not `quarantined`,
   which is *structural* invalidity with a different resolution path. The optimistic **Overlay is kept
   and marked conflicted, never reverted**, so the user's edit is not silently lost; the read model keeps
   showing it. Because the synced table already holds the current server value, the app reads both sides
   (overlay + synced) to build a resolution/diff UI with no new storage. The server's outcome carries the
   current Server version. **Resolution is a new mutation** with a fresh Base server version (decision 2),
   so a resolved conflict flows through normal convergence with no special transition; **discard** clears
   the overlay + conflicted entry. Surfaced via a dedicated `onConflict` callback and the sync-state
   view's `conflict_state` (distinct from `onQuarantine`).

## Consequences

- The Convergence model is complete: every entity's state — optimistic, acked-unobserved, converged,
  pending-delete, **conflicted** — has one authoritative, surfaced answer.
- Silent last-write-wins becomes impossible; where it is wanted it is a conscious per-table choice.
- Resolved conflicts need no special machinery — they are ordinary new mutations.
- This is the **third hard-require** (after the Server version and the server-PK-in-projection rules);
  accepted as consistent with the toolkit's footgun-averse stance, but noted as an accumulation.
- `field-merge` is the policy the gradebook-style, per-cell target will most want; deferring it means
  row-level `reject-if-stale` is the coarse interim there. It is the likely next addition.

## Proving it

- A test where an external write advances the row between a mutation's base and its apply, asserting the
  stale write is detected and handled per the table's policy.
- A test that an entity's own chained edits (m1, m2) under `reject-if-stale` do **not** self-conflict
  (the base-capture rule, decision 2).
- A test that a `conflicted` mutation keeps its overlay and that a resolution mutation converges normally.

References: `CONTEXT.md` (Base server version, Conflict policy, Server version, Convergence model,
Overlay, Per-entity flush serialization); [ADR-0011](0011-convergence-model.md) (the reserved hooks this
fills); [ADR-0010](0010-convergence-barrier.md) (the monotonic Server version detection rests on);
[ADR-0014](0014-bulk-apply-ordering-safety.md) (Per-entity flush serialization that makes chained-base
resolution possible); [ADR-0005](0005-mutation-convergence.md) (the attribution/terminal-state machinery
reused); `tmp/agents/sync-system-improvement-worklog.md` (ISS-10).
