---
title: The Electric subquery requirement
description: The mandatory ElectricSQL feature flag, fail-closed behaviour, and the enum→text rule.
sidebar:
  order: 5
---

This is a **hard prerequisite**, not an optimisation. It is also the one prerequisite most likely to
be missed, because it lives in ElectricSQL's configuration rather than in pgxsinkit's code.

## The flag

pgxsinkit uses cross-table subquery `where` clauses for membership fan-out — a row in a container
streams to every member of that container:

```sql
container_id IN (SELECT container_id FROM memberships WHERE member_id = <subject>)
```

The shape proxy forwards this verbatim as the ElectricSQL shape `where`, so it depends on a flagged
preview capability:

```bash
# ElectricSQL >= 1.6 (still flagged as of 1.7.2)
ELECTRIC_FEATURE_FLAGS=allow_subqueries,tagged_subqueries
```

Any deployment consuming pgxsinkit must run Electric with this flag. The repo's `infra/compose`
pins `electricsql/electric:1.7.2` and sets it.

## It fails closed

Without the flag, Electric rejects any subquery `where` with HTTP 400:

```json
{ "where": ["Subqueries are not supported"] }
```

The sync then fails **closed** — no rows stream. It never silently falls back to streaming unfiltered
data. A blank client is the symptom of a missing flag; a data leak is not a failure mode here.

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
