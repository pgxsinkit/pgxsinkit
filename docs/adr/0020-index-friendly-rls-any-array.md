# Index-friendly RLS: `= ANY(ARRAY(subquery))` for runtime-resolved id-sets

Status: accepted (2026-06-28)

pgxsinkit's RLS policy builders filter a governed table by a set of ids resolved **at runtime** from
the request — the containers a caller belongs to (a `membership` table read), or the scopes granted in
the caller's JWT (`buildSupabaseGrantScopeNativePolicies`, reading
`app_metadata.authorization.grants`). The natural way to write that is `col IN (subquery)`, and that is
what the builders emitted.

The runtime-resolved set is **opaque to the planner**: its value comes from `current_setting(...)`
(the JWT) or from a subquery keyed off it, so Postgres has no statistics for it. It estimates the
subquery at a default cardinality (tens of thousands of rows, when the real answer is a handful) and
costs `col IN (subquery)` as a **hashed semi-join** — which it satisfies with a **sequential scan** of
the whole governed table, ignoring the index on `col`.

The `rls-read` performance track (`tests/performance/rls-read-load.perf.test.ts`) measured the cost at
160k rows. The direct-read path (a query under `SET ROLE authenticated` + claims, i.e. what a
non-synced read endpoint runs) was **20–45× slower** than the equivalent Electric shape query, which is
fast only because the proxy resolves the same ids in JS and injects them as **literals** the planner
can index:

| shape (indexed, 160k rows) | `IN (subquery)` p95 | literal-IN shape query p95 | ratio |
| -------------------------- | ------------------- | -------------------------- | ----- |
| membership fan-out         | 27 ms               | 1.1 ms                     | 24×   |
| JWT grant-scope            | 23 ms               | 0.5 ms                     | 45×   |

The `EXPLAIN` was unambiguous: `Parallel Seq Scan … Filter: (ANY (col = (hashed SubPlan 1)))`, with the
estimate off by ~235× (`rows=47059` vs `actual rows=200`). Note the InitPlan claim-hoisting idiom
(`(select current_setting(...))`, ADR-era Supabase guidance) was already in place and *was* working —
the JWT is parsed once, not per row — but hoisting the **claim** does not fix the **plan**: the seq
scan is driven by the predicate *shape*, not by how often the claim is read.

## Decision

1. **The RLS builders emit `col = ANY(ARRAY(subquery))`, never `col IN (subquery)`, for a
   runtime-resolved id-set.** `ARRAY(subquery)` materializes the (uncorrelated) set once as an
   InitPlan, and `col = ANY(<array>)` is a `ScalarArrayOpExpr` the planner drives as a **bitmap index
   scan** on `col`. The rewrite is **semantically identical** to `IN` — it only changes the form the
   planner can index. This applies to every containment leaf: membership SELECT, the membership
   write-state gate, the grant-scope containment, and the board demo's own `memberOfTeam` / channel
   policies.

2. **The fix is the predicate shape, not a cardinality hint.** We tested a `STABLE … RETURNS SETOF
   uuid` resolver with a `ROWS 8` declaration: the hint corrected the estimate, but
   `col IN (SELECT fn())` kept the semi-join shape and **still seq-scanned**. Restructuring beats
   hinting.

3. **The scope/container column must be indexed.** The whole point is to enable the index scan; the
   `rls-read` track measures `{with, without index}` so a missing index shows up as a regression, and
   the index belongs in the consumer's schema for any governed table reached by a direct read.

## Considered options

- **`col IN (subquery)`** — the prior form. Rejected: hashed semi-join → sequential scan on a
  runtime-resolved set; 20–45× slower at scale.
- **`ROWS`-hinted `SECURITY DEFINER` function + `IN (SELECT fn())`** — rejected empirically: the
  cardinality hint did not change the plan (still a seq scan). Postgres has no comment-style plan hints,
  and the one stock "hint" (function `ROWS`) did not move this plan.
- **Per-transaction planner GUCs** (`SET LOCAL enable_seqscan = off`, `cursor_tuple_fraction`) — a
  direct-read endpoint *could* set these since it owns its transaction, but they are a blunt,
  whole-statement sledgehammer that an RLS policy cannot carry and that distorts unrelated joins.
  Rejected as the general mechanism; a deployment may still reach for them.
- **The `pg_hint_plan` extension** (real Oracle-style hints) — rejected: an extension dependency the
  Electric/Supabase Postgres image would have to carry. pgxsinkit targets stock Postgres, and the
  restructure makes it unnecessary.
- **Resolve the id-set in the app and inject literals at the direct-read endpoint** (mirroring what the
  Electric proxy does for the shape `where`, via `resolveGrantScopeIds`) — viable and still available as
  belt-and-suspenders, but it makes RLS-alone insufficient and duplicates the resolver on a third
  surface. With `= ANY(ARRAY(…))` the policy is fast on its own, so injection is an option, not a
  requirement.

## Consequences

- **RLS-alone direct reads are fast by construction.** After the change, the same `rls-read` track
  reports `membership` 27 ms → **0.89 ms** and `grant-scope` 23 ms → **0.70 ms** — at or below the
  Electric shape query. A non-synced read endpoint running the policy pays roughly what the synced
  shape query already costs, and does **not** need to inject literals for performance. (This retracts an
  earlier working conclusion that direct reads would have to inject literals to be viable; that was true
  only of the `IN (subquery)` form.)
- **Optimal for small authz sets — the case pgxsinkit targets** (a handful of grants, a user's
  containers). For a pathological *huge* set, `= ANY(ARRAY)`'s per-element index probing could lose to a
  hashed semi-join; that is not the authorization shape, and it is documented rather than guarded.
- **The synced read path is unchanged.** Electric still receives a literal `IN (…)` `where` from the
  proxy resolver; only the **RLS** surface (writes, and any direct read) changes. The two surfaces are
  still generated from one declaration and remain semantically equal.
- The change touches the shipped `@pgxsinkit/contracts` builders and therefore the demo and board
  migrations, which were regenerated; consumers (emergent, the board) adopt it on the next dependency
  bump and migration regeneration.

## Implementation status

Implemented and validated.

- Builders: `membershipMatch`, `membershipWriteGate`, and the grant-scope containment in
  `packages/contracts/src/supabase-rls.ts`; the board's own `memberOfTeam` / channel policies in
  `packages/board-schema/src/policies.ts`. Unit tests assert the `= any(array(…))` form
  (`tests/unit/contracts-supabase-rls.test.ts`, `tests/unit/contracts-grant-scope-rls.test.ts`).
- Evidence and regression guard: the `rls-read` track measures `baseline / shape-query / RLS` across
  `{correct, naive} × {index, no-index}`, plus the `anyarray` and `fnrows` experiment variants and the
  `EXPLAIN ANALYZE` capture that proved the cause. The reproducible track and its knobs live in
  `tests/performance/README.md`.
- Correctness is pinned by the contracts RLS unit suites, the membership-fanout/asymmetric-read/
  write-state-gating integration suites, and the board smoke lane; behaviour is unchanged.

References: `tests/performance/README.md` (the RLS read track + its knobs);
[ADR-0019](0019-row-filters-as-drizzle-fragments.md) (the Electric read-path `where` these policies
mirror); `CONTEXT.md` (Parity boundary — RLS is the server's authority).
