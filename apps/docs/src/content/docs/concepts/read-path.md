---
title: The read path
description: Shapes stream Postgres → Electric → PGlite, through an ownership-enforcing proxy.
sidebar:
  order: 4
---

The read path streams rows from Postgres **through ElectricSQL** to the client and keeps local PGlite
up to date — nothing goes from Postgres to the client directly. The app reads exclusively from PGlite;
it never queries Postgres or Electric directly at read time.

## The flow

```
PostgreSQL  →  ElectricSQL  →  shape proxy  →  PGlite (local)
```

1. **Shapes** define what a client may see — a table plus a `where` filter. Filters can be
   cross-table subqueries, e.g. membership fan-out where a container row streams to every member:

   ```sql
   container_id IN (SELECT container_id FROM memberships WHERE member_id = <subject>)
   ```

   Author that predicate with the typed Drizzle helpers, never as a hand-built string — `c()` for each
   (bare) column, the table object for the `FROM`, and the subject as a **bound param** (so a quote in
   the value can't inject the predicate). Factor the subquery into a helper to share it with any narrower
   variant:

   ```ts
   import { c, DENY_ALL } from "@pgxsinkit/contracts";
   import { sql, type SQL } from "drizzle-orm";

   const memberContainers = (subject: string): SQL =>
     sql`select ${c(memberships.containerId)} from ${memberships} where ${c(memberships.memberId)} = ${subject}`;

   const widgetsReadFilter = (claims) =>
     claims.sub ? sql`${c(widgets.containerId)} in (${memberContainers(claims.sub)})` : DENY_ALL;
   ```

   The subquery must be **self-contained** (not correlated). See
   [Authoring a registry → cross-table filters](/start/getting-started/) for the full pattern and the
   `null` (no filter) vs `DENY_ALL` (no rows) trap.

2. **ElectricSQL** turns each shape into a live stream from Postgres.
3. **The shape proxy** (`proxyElectricShapeRequest`, served by the pgxsinkit server — `createSyncServer`
   mounts it at `/api/shape` by default, but the path is yours to choose) forwards shape requests to
   Electric and **enforces owner filtering** for protected tables unless the caller is an admin. In
   the real path, clients talk to the proxy, not to Electric directly.
4. **PGlite** subscribes through `@pgxsinkit/client`'s internal Electric ingest engine (`src/sync/`,
   ADR-0009) and applies the stream into local tables. The app reads from there.

## The proxy is the gateway

Reads do not hit Electric directly in a deployed system — they go through the shape proxy, which is
where ownership is enforced. Treat synced tables in PGlite as **replication
targets**: they are written by this path and must never be mutated by application code (writes go
through [the write path](/concepts/write-path/)).

## Reading from the local store

The app reads through the client's guarded query — never hand-written SQL. For a **pure-Drizzle** read,
pass the builder callback directly to `client.query((c) => …)`: pgxsinkit scans the compiled
[Drizzle](https://orm.drizzle.team) SQL and activates + awaits every registry relation the query touches
(FROM, JOIN, subquery, WHERE) before it runs — there is nothing to declare. The call resolves to the
**rows array** directly. Inside the callback, reach a relation through a directly-imported synced
table/view object, `c.drizzle`, or `c.views`.

If the builder embeds a raw ``sql`…` `` fragment — which can name a relation as a bare identifier the scan
cannot see — use `client.queryRaw({ use, build })` instead and list those relations in `use`, so they are
activated before the query runs. Pure Drizzle never needs `use`. (The reactive equivalents follow the same
split: `useLiveDrizzleRows` for pure reads, `useLiveQueryRaw({ use, build })` for raw fragments.)

:::tip[Lint the split]
`@pgxsinkit/client` ships an oxlint rule that enforces this at authoring time. Enable it in your
`.oxlintrc.jsonc` and it flags a raw ``sql`…` `` fragment on the pure path (use `queryRaw`) and a redundant
`use` on a pure builder (autofixable) — the two facts the type system can't see:

```jsonc
{
  "jsPlugins": ["@pgxsinkit/client/oxlint"],
  "rules": { "pgxsinkit/guarded-query-purity": "error" },
}
```

The rule versions with the `@pgxsinkit/client` you have installed. (oxlint `jsPlugins` is currently alpha.)
:::

Which relation you select **from** depends on the entry's mode:

- A **readonly** entry syncs only its base table — read it from the entry's `.table`.
- A **readwrite** entry also has a `_read_model` **overlay view** that merges your own optimistic
  (not-yet-synced) writes over the synced base rows. Read it from the entry's `.view`, **not** its
  `.table`. Selecting the base table of a readwrite entry omits your own pending writes, so a just-issued
  create / edit / delete does not appear locally until it round-trips through Postgres and streams back.

```ts
// readonly entry → base table
client.query((c) => c.drizzle.select({ id: catalogResource.table.id }).from(catalogResource.table));

// readwrite entry → overlay view, so your own optimistic writes are included
const reportView = registry.report.view!; // `.view` is populated only for readwrite entries
client.query((c) => c.drizzle.select({ id: reportView.id }).from(reportView));
```

This is the read-side twin of optimistic writes returning through Electric: the write is visible
immediately only because you read the overlay view; the base table catches up when the committed row
streams back.

## Hard prerequisite

Subquery `where` (used for fan-out) is a flagged ElectricSQL preview feature. The proxy forwards the
`where` verbatim, so Electric must run with `allow_subqueries,tagged_subqueries`. Without the flag
Electric rejects the shape with HTTP 400 and the sync fails **closed** — no rows stream, never an
unfiltered fan-out. See [The Electric subquery requirement](/concepts/electric-subqueries/).
