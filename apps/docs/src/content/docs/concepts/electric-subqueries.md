---
title: The Electric subquery requirement
description: The mandatory ElectricSQL feature flag, fail-closed behaviour, and the enum→text rule.
sidebar:
  order: 5
---

This is a **hard prerequisite**, not an optimisation — and because it lives in ElectricSQL's
configuration rather than in pgxsinkit's code, it is easy to stand up a stack without it.

## The flag

pgxsinkit uses cross-table subquery `where` clauses for membership fan-out — a row in a container
streams to every member of that container:

```sql
container_id IN (SELECT container_id FROM memberships WHERE member_id = <subject>)
```

The shape proxy forwards this verbatim as the ElectricSQL shape `where`, so it depends on a flagged
preview capability:

```bash
# ElectricSQL >= 1.7 (subquery where is a flagged preview; the demo and tests pin 1.7.4)
ELECTRIC_FEATURE_FLAGS=allow_subqueries,tagged_subqueries
```

Any deployment consuming pgxsinkit must run Electric with this flag. The repo's `infra/compose`
pins `electricsql/electric:1.7.4` and sets it.

## It fails closed

Without the flag, Electric rejects any subquery `where` with HTTP 400:

```json
{ "where": ["Subqueries are not supported"] }
```

The sync then fails **closed** — no rows stream. It never silently falls back to streaming unfiltered
data. A blank client is the symptom of a missing flag; a data leak is not a failure mode here.

## Membership changes converge the local store — both ways, even offline

The subquery is what makes a membership change _reactive_, in **both** directions, against the
subject's already-running shape — no re-subscribe:

- **Grant** — a new `memberships` row gives a subject access to a container. Electric re-evaluates the
  dependent shapes (a tagged _move-in_) and the toolkit **materialises** every newly-matched container
  row into that subject's local store. This is the "add-member → the whole container appears" moment.
- **Revoke** — deleting the `memberships` row. Electric signals that the rows have left the shape (a
  tagged _move-out_) and the toolkit **evicts** them. A row reachable through a second, independent
  membership survives — it leaves only once its **last** grant is gone.

This convergence holds **live and across an offline gap**. A client following the shape applies the
change at once; a client that was disconnected when the membership changed converges on **reconnect** —
the resume from its persisted offset replays the change. So a revoked member's container does not linger
in their local store while they are offline (a security property, not only a UX one), and a newly-added
member's container appears the moment they are back.

The one thing that does **not** observe the delta is a fresh `offset=-1` snapshot of an existing handle:
it is served from the handle's materialised log and won't reflect a source-table change that post-dates
it. That is a probing artifact, not the running client's path — observe convergence on the live
subscription or a normal resume, never by re-fetching `offset=-1`. A toolkit consistency group ties the
container's tables to a shared LSN frontier, so the rows that move in or out this way commit together,
with no broken-join flicker.

## The enum→text rule

A second consequence of Electric's where-grammar: a PostgreSQL `enum` column referenced in a shape
`where` must be **cast to `text`**:

```sql
"role"::text = 'manager'    -- supported
"role" = 'manager'          -- rejected: invalid syntax for type enum
```

A literal cast to the enum type (`'manager'::role`) is also unsupported. Cast the **column** to text.
The enum column itself stays an enum everywhere else — RLS and the write path keep using it natively,
so there is no enum→text migration (which would in any case fail while an RLS policy depends on the
column).
