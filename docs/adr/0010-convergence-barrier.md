# Convergence barrier: resolve optimistic state by Server version, not key-match

Status: accepted (2026-06-23)

The local **Read model** unions the **Overlay** over the synced read cache, so the app
reads optimistic values where a write is staged and synced values otherwise. An acked
write's Overlay row and **Mutation journal** entry must be cleared once — and only once —
the server's version of that write has synced back, or the read model flips to a value
that is neither the optimistic write nor the converged server state.

Today that clearing happens in two places with the same defect:

- the flush-path `reconcileTable` (`packages/client/src/mutation.ts:1784-1816`) clears a
  create/update overlay on `status='acked' AND server_updated_at_us IS NOT NULL AND
  <pk-match>` — its own comment says **"PK-match only — no timestamp gate"**;
- the generated per-table reconcile trigger (`packages/client/src/schema.ts:155-175`)
  fires on the synced echo and clears on `<pk-match> AND NOT EXISTS <journal>`.

Neither checks that the echo it is reacting to **is actually the acked write**. A stale
echo for the same key — an older buffered update, or another actor's concurrent write —
satisfies the key-match and clears the overlay before our write has synced, so the read
model briefly (or, under reordering, durably) shows older server state. `docs/architecture.md:31`
already documents the intended invariant ("acked overlays clear only after the synced echo
reaches the acknowledged server `updated_at_us`"); the code never implemented it.

`delete` is **not** part of this defect. A delete carries no server timestamp
(`readServerUpdatedAtUs`, `packages/server/src/mutations/route.ts:529`, reads the
now-removed row and returns nothing), and its overlay/journal are already resolved by
synced-row **absence**, which is correct for convergence. Distinguishing "absent because
my delete landed" from "absent because the row left my shape via the row filter / another
actor deleted it" is a conflict-attribution concern deferred to the future stale-write /
conflict-policy work (ISS-10), not convergence.

## Decision

1. **An acked optimistic write is resolved by a Server-version barrier, not by key-match.**
   An acked create/update's Overlay row and Mutation journal entry are cleared only once the
   synced echo's **Server version** has reached the write's acked Server version. Concretely
   the acked-create/update journal-clear gains one conjunct:

   ```
   AND journal.server_updated_at_us <= <synced|NEW>.updated_at_us
   ```

   and the overlay-clear remains "clear once no journal rows remain for the entity". A stale
   echo (lower Server version) no longer clears the write; the real echo does.

2. **The Server version is the existing `updated_at_us` token, made strictly monotonic per
   row.** We do not introduce a new version column. The server-managed update expression
   becomes `updated_at_us = GREATEST(<clock_us>, <table>.updated_at_us + 1)`, so a row's
   Server version strictly increases on every write and can never repeat or step backwards
   under wall-clock (NTP) skew. This closes the only remaining hazard — two rapid same-entity
   writes with an inverted wall clock, where the first write's echo would otherwise satisfy
   the second write's barrier and clear it prematurely. The ack token and the echo token are
   the same value (`route.ts:529` reads exactly the column the echo carries), so a write's
   own echo always clears it by equality.

3. **A Server version is mandatory for a writable synced table; registry validation rejects
   one without it.** A writable synced table must declare a `nowMicroseconds`-on-update
   managed field (the Server version, conventionally `updated_at_us`). Optimistic convergence
   is unsound without a per-row version — the barrier degenerates to today's flicker-prone
   key-match — so this is a hard requirement enforced at registry validation rather than a
   silent degraded fallback. (Chosen over the ADR-0006 warn-and-degrade pattern deliberately:
   the cost of the footgun outweighs the consumer-flexibility the soft path preserves.)

4. **The barrier predicate is expressed once and shared by both clearing sites.** Both the
   trigger generator (`schema.ts`) and `reconcileTable` (`mutation.ts`) emit the barrier from
   a single `buildOverlayResolutionPredicate(context)` in a shared module, resolving the
   Server-version column from the registry — one source of the rule, no drift, consistent
   with [ADR-0004](0004-one-registry-interpreter.md). A runtime SQL function was rejected:
   heavier in PGlite and redundant when both sites already generate registry-driven SQL.

5. **Both clearing sites are kept; each covers one ack/echo ordering.** *ack-before-echo*: the
   trigger cannot have fired (no synced change yet), so `reconcileTable` holds the overlay —
   with the barrier it sees the old Server version and correctly does not clear; the later
   echo fires the trigger and clears. *echo-before-ack*: the trigger fires while the journal
   row is still `sending` (its `NOT EXISTS journal` guard clears nothing), so the post-flush
   `reconcileTable` is what clears on ack. Neither site alone is sufficient.

## Consequences

- The optimistic→stale→fresh flicker is eliminated; the code finally matches the documented
  invariant, and the trigger and flush path can no longer drift (one predicate).
- The barrier reads the Server version from the **local synced table** (a column kept current
  because it always changes on a write), so it is independent of Electric's `replica` mode —
  `changes_only` and `full` both work.
- ISS-10 (stale-write / conflict policy) inherits a genuinely monotonic per-row version to
  build conflict detection on, at no extra cost.
- Cost: the applier's update for the Server-version field now self-references the row's
  current value (`GREATEST(…, <table>.updated_at_us + 1)`); a new registry-validation rule
  can reject existing writable tables that lack a Server version (a reviewable, intended
  break).
- `delete` resolution is unchanged (absence-gated); delete distinguishability stays out of
  scope (→ ISS-10).

## Proving it

- A test that forces a **stale same-key echo to arrive between ack and the real echo** and
  asserts the overlay is not cleared early (the core regression the barrier exists to catch).
- A test for **two rapid same-entity writes under a backwards wall clock** asserting the
  first write's echo does not clear the second write (proves the `GREATEST` monotonicity).
- A registry-validation test asserting a writable table without a Server version is rejected.

References: `CONTEXT.md` (Server version, Convergence barrier, Overlay, Mutation journal,
Read model); [ADR-0004](0004-one-registry-interpreter.md) (shared registry interpreter);
[ADR-0005](0005-mutation-convergence.md) / [ADR-0006](0006-local-schema-evolution.md)
(quarantine + registry validation surfaces this builds on); ISS-10 (stale-write / conflict
policy — delete distinguishability, conflict attribution);
`tmp/agents/sync-system-improvement-worklog.md` (ISS-01).
