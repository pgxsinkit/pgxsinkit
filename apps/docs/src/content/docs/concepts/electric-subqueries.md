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

## Fan-out when the membership changes

The subquery is what makes membership fan-out _live_. When a row is added to the subquery's **source**
table — a new `memberships` row granting a subject access to a container — Electric re-evaluates the
dependent shapes and streams every newly-matched container row to that subject's **live** shape
subscription. Removing the membership streams the deletes. This is the mechanism behind an
"add-member → the whole container appears" moment: the new member's open client receives the
container's rows without re-subscribing.

The important qualifier is **live**. The delta arrives on an actively-followed shape (the long-poll a
running client holds). A fresh `offset=-1` snapshot request that resumes an existing shape handle is
served from the handle's materialised log and will not show a source-table change that post-dates it —
so don't probe fan-out by re-fetching `offset=-1`; observe it on the live subscription (or force a
brand-new shape). A toolkit consistency group ties the container's tables to a shared LSN frontier so
the rows that fan out this way commit together, with no broken-join flicker.

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
