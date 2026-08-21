---
title: The read path
description: Rows stream PostgreSQL → the Circuits engine → durable-streams → PGlite, granted by a control plane and gated at the edge.
sidebar:
  order: 4
---

The read path streams rows from Postgres **through ElectricSQL's Circuits engine and
durable-streams** to the client and keeps local PGlite up to date — nothing goes from Postgres to the
client directly. The app reads exclusively from PGlite; it never queries Postgres or the engine
directly at read time.

## The flow

```
PostgreSQL  →  Circuits engine  →  durable-streams  →  the edge  →  PGlite (local)
```

1. **Shapes** define what a client may see. Every shape declares one of two tiers, and _which field it
   declares_ is what picks the tier:

   - **Private** — `rowFilter` fuses the caller's claims into the predicate. One shape per subject;
     the right home for data whose row set genuinely differs per user, which is most data.
   - **Shared** — `scope` names the columns whose values key the shape family, and a separate
     entitlement rule maps claims to the scope values a subject may read. One shape per scope value,
     shared by every entitled subject.

   Declaring both is refused at definition time, so a shape's tier is evident from its authoring and
   can never be ambiguous.

   A private-tier filter yields a **predicate AST**, built with the `p.*` builders over real Drizzle
   column objects — no SQL text exists on this path at any point, and each comparison is type-checked
   against the column it names. Membership fan-out (a container row streaming to every member) is one
   of the shipped policy families, and every family ships a read-path mirror that generates the
   predicate from the very same columns object you hand the policy builder — one declaration, both
   surfaces, so a rename or a typo can never leave a row writable but unreadable:

   ```ts
   import { buildMembershipShapePredicate } from "@pgxsinkit/contracts";

   // The same object `buildSupabaseMembershipNativePolicies(…)` takes; write-only fields are ignored.
   const membership = {
     containerColumn: widgets.containerId,
     membershipTable: memberships,
     membershipContainerColumn: memberships.containerId,
     membershipSubjectColumn: memberships.memberId,
   };

   shape: {
     rowFilter: () => ({
       customPredicate: (claims) => buildMembershipShapePredicate(membership, claims),
     }),
   }
   ```

   That builds "the row's container is one the subject is a member of" as a first-class subquery node
   over the membership table — the engine maintains the inner set incrementally and shares it across
   every shape referencing the same subquery — and denies with
   [`DENY_ALL_PREDICATE`](/api/contracts/variables/deny_all_predicate/) when the claims carry no
   subject.

   Reach for a hand-built predicate only past the shipped families — and then still through `p.*`,
   which takes the same real column objects and carries the subject as a typed JSON scalar rather than
   text that has to be escaped:

   ```ts
   import { DENY_ALL_PREDICATE, p, type Predicate } from "@pgxsinkit/contracts";

   shape: {
     rowFilter: (columns) => ({
       customPredicate: (claims): Predicate => {
         if (!claims.sub) return DENY_ALL_PREDICATE;
         return p.in(
           columns.containerId,
           p.subquery(memberships.containerId, p.eq(memberships.memberId, claims.sub)),
         );
       },
     }),
   }
   ```

   The subquery must be **uncorrelated**: its inner `where` reads the membership table's own columns
   only, never the outer row's. See
   [Authoring a registry → cross-table filters](/start/getting-started/) for the full pattern and the
   `null` (no filter, every row) vs `DENY_ALL_PREDICATE` (no rows) trap.

2. **The Circuits engine** ingests Postgres logical replication and maintains each shape, created
   through its native `POST /shapes` with the predicate AST. The stream itself lives in
   **durable-streams**, not in the engine.

3. **The control plane** (`/sync/v1/subscribe`, `/sync/v1/refresh`, `/sync/v1/barrier`, mounted by
   `createSyncServer` when it is configured with `readPath`) is where read authorization happens. The
   client names a **shape key and nothing else**: the control plane compiles the private tier's
   predicate from the caller's verified claims — or expands a shared shape to every scope the subject
   is entitled to — creates the shape, and hands back the granted stream paths together with a
   short-lived **signed stream token**. A request it cannot resolve a subject for is answered `401`.

4. **The edge** (`createStreamGate`, mounted at `/v1/stream`) serves the durable-streams reads: it
   verifies the stream token, checks the grant against the live entitlement set, and proxies bytes.

5. **PGlite** subscribes through `@pgxsinkit/client`'s own reader (`readShapeStream`, over
   `@durable-streams/client`) and applies the stream into local tables. The app reads from there.

## The edge is the gate

Clients address neither the engine nor durable-streams directly in a deployed system, and read
authorization is split across the two surfaces above: the control plane decides **what a subject may
subscribe to** and mints a capability saying so, and the edge decides **whether that capability still
grants this stream** on every read. Predicates were resolved at shape creation, so there is no
per-read filtering and no per-read rewriting at the edge — it is a gate, not a pipeline — and an
entitlement set that is catching up, stale or unavailable **denies**.

Losing entitlement means losing the _subscription_, not losing rows: the client takes `403` on its
next poll, truncates that scope, and unsubscribes.

Treat synced tables in PGlite as **replication
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

This is the read-side twin of optimistic writes returning down the read path: the write is visible
immediately only because you read the overlay view; the base table catches up when the committed row
streams back.

## Reaching the generated relations directly (factories)

`entry.table` / `entry.view` are the handles app code reads through. Underneath, a writable table
generates a small cluster of relations — the synced read cache, the `_overlay` optimistic table, the
`_mutations` journal, the `_sync_state` convergence view, and the `_read_model` overlay view — plus the
`pgxsinkit_local_meta` key/value table. `@pgxsinkit/client` exports a typed factory per relation so
**diagnostics, tests, and tooling** can author queries against them as tier-① Drizzle objects instead of
hand-written SQL:

```ts
import { getOverlayTable, getSyncStateView, getJournalTable } from "@pgxsinkit/client";

// Typed by property key when the registry is concretely typed:
const overlay = getOverlayTable(registry, "report");
db.select({ id: overlay.id, kind: overlay.overlayKind }).from(overlay);

// Convergence state for a table (pending count, conflict/quarantine state):
const syncState = getSyncStateView(registry, "report");
db.select({ pending: syncState.pendingCount, conflict: syncState.conflictState }).from(syncState);
```

The full family is `getSyncedLocalTable`, `getOverlayTable`, `getJournalTable`, `getSyncStateView`,
`getReadModelView`, and `getLocalMetaTable`.

Two things set these apart from the entry handles:

- **They fill the gaps the entry handles leave.** `entry.table` / `entry.localTable` are already
  schema-qualified (built with the registry's schema, and enforced to match it), so for the synced read
  cache the factory only earns its keep by tracking a `clientProjection.syncedTable` rename. But
  `entry.view` (the `_read_model` view) is built **unqualified**, so a store in a non-public local schema
  must author it through `getReadModelView`; and the `_overlay`, `_mutations`, and `_sync_state` relations
  have **no entry handle at all** — these factories are the only Drizzle objects for them. Each factory
  memoizes per `(registry, tableKey)` (`getLocalMetaTable` per local schema), so repeated calls return the
  same object.
- **Typing follows the registry you pass.** With a concretely-typed registry the synced / overlay /
  read-model objects carry the entry's real per-column types (`overlay.col`, `$inferInsert`, `.values()`
  all typecheck by property key); with a bare `SyncTableRegistry` they degrade to an index-signature
  shape reached by bracket access (`overlay["col"]`). `getJournalTable` and `getSyncStateView` are
  **always** conservatively indexed for their entity/PK columns, because the PK name set is not
  recoverable at the type level — but they key those columns differently: the journal keys PK columns by
  **DB column name** (`journal["author_id"]`), the sync-state view by the entry's **drizzle property key**
  (`syncState["authorId"]`). The fixed runtime/state columns stay typed on both.

**When not to use them.** In app code, prefer the guarded `client.query((c) => …)` read path above: it
activates lazy relations for you and reads through `entry.table` / `entry.view`. The factories are for
reading the generated relations _directly_ (a test asserting overlay/journal state, a perf harness, a
diagnostic that inspects `_sync_state`) — they complement the guarded read path, they do not replace it.

## Live queries: dedup, keep-alive, and diagnostics

A reactive read (`useLiveDrizzleRows`, `useLiveQueryRaw`, or `client.subscribeLiveRows`) opens a **local
SQL live query** over PGlite: it materialises the query once and then re-runs and diffs it on every write
that touches its tables, pushing changed rows to your component. That is one of three independent lifetimes,
and keeping them apart is what makes the behaviour predictable:

- **Shape lifetime** — what a table _syncs_ from the server (the registry's `subscription`/`retention`). This
  is the network stream, unrelated to any query you run locally.
- **Local SQL live-query lifetime** — the PGlite registration + diff for one live query. This is what the
  query manager below owns.
- **Domain projection lifetime** — the models your app builds _from_ live rows. That is yours to hold; the
  library never sees it.

**Dedup is automatic and free.** Identical live queries share a single PGlite registration. Ten components —
or ten browser tabs on a shared worker — mounting the same query cost **one** materialisation and **one**
re-run + diff per relevant write, fanned out to every subscriber. You do not opt in and nothing changes in
your code; it is keyed on the executed SQL + bound params, so two reads that differ only in a `where` value
stay separate, as they must.

**Keep-alive** trades re-materialisation for a bounded idle cost. By default a live query is torn down the
instant its last consumer unmounts, so re-mounting it (navigating away and back) re-materialises it — which
for a heavy aggregate can cost hundreds of milliseconds. Opt a hot query into a grace period and a re-mount
within the window reuses the warm registration instantly:

```ts
// Per-subscription hint — retain THIS query for 30s after its last consumer leaves.
const { rows } = useLiveDrizzleRows(
  (c) => c.drizzle.select().from(c.views.offering).orderBy(c.views.offering.createdAtUs),
  [],
  { keepAliveMs: 30_000 },
);
```

```ts
// Worker/client-wide policy: a default grace period plus hard budgets (LRU-evicted past them).
defineSyncWorker({
  registry,
  controlPlaneUrl,
  streamBaseUrl,
  batchWriteUrl,
  liveQueries: {
    defaultKeepAliveMs: 0, // default: no retention — tear down on last unmount
    maxRetainedQueries: 16, // most retained (zero-subscriber) queries kept
    maxRetainedRows: 50_000, // most rows held across all retained queries
  },
});
```

The same `liveQueries` block is accepted by `createSyncClient` and governs the in-process client identically.

**Why the default is 0.** A retained zero-subscriber query is not free: PGlite live queries cannot be paused,
so it still pays a full re-run + diff on **every** write to its tables for as long as it is held. Retention
is a win only for a query that is genuinely hot (frequently re-mounted) and write-cold; for a write-hot query
it can cost more over its idle life than the one re-materialisation it saves. So keep-alive is opt-in per hot
query rather than on globally.

**Permanence is a mounted subscriber, not a setting.** There is deliberately no "retain forever" knob. For a
fixed hot set — the handful of queries your whole app leans on — mount them in a root provider that never
unmounts. That keeps exactly one live registration alive for the app's lifetime, and every route that reads
the same query dedups onto it for free. Keep-alive covers the transient case (a route you leave and return
to); a mounted subscriber covers the permanent case.

**Observe it** with `client.liveQueryDiagnostics()`: a snapshot of the manager's live entries — an opaque
fingerprint digest, subscriber and row counts, setup and refresh timings, and retention state per entry. It
carries **no** SQL text, bound values, or row data, so it is safe to log or surface in support tooling.

```ts
for (const q of await client.liveQueryDiagnostics()) {
  console.log(q.digest, "subscribers:", q.subscriberCount, "rows:", q.rowCount, "retained:", q.retained);
}
```

## Hard prerequisites

Three things the read path needs from the deployment underneath it:

- **Postgres running `wal_level = logical`.** The engine opens its own replication slot. Supabase's
  Postgres image already ships it — check with `postgres -C wal_level` rather than re-adding flags.
- **An explicit table list for the engine, never `*`.** `ELECTRIC_CIRCUITS_PG_TABLES` names the tables
  it ingests, by bare name. `*` introspects every `public` table carrying a primary key, which sweeps
  in tables that were never sync state.
- **A gateway speaking HTTP/2 to browsers.** One long-poll is held per stream, so a subject in K
  scopes holds K concurrent connections; without HTTP/2 they hit the browser's
  ~6-connections-per-origin ceiling and the sync stalls.

Read authorization fails **closed** at both surfaces: the control plane answers `401` when it cannot
resolve a subject, so no shape is created and no stream is granted; the edge answers `403` when the
token does not grant the stream or the entitlement behind it is gone, including while its own
entitlement subscription is still catching up.
