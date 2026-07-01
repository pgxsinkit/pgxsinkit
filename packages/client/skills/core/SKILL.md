---
name: core
description: >-
  Load when writing or reviewing code that uses @pgxsinkit/* (client, server, contracts, react) — the
  offline-first sync toolkit for the Postgres -> ElectricSQL -> PGlite read path and the client -> write
  API -> Postgres write path. Teaches the mental model the source does not make obvious: the two paths
  are separate and asymmetric, there is exactly one write path (an in-database apply function, not
  per-table CRUD), the Electric subquery flag is mandatory and fails closed, local PGlite schema is not
  full DDL parity, and writable tables must declare a conflict policy plus managed fields. Load this
  before wiring sync, defining a registry, or debugging "writes don't appear" / "no rows stream" / "a
  removed member still sees rows".
metadata:
  type: core
  library: "@pgxsinkit/client"
  library_version: "0.1.32"
  source: https://pgxsinkit.github.io/llms-full.txt
---

# Using pgxsinkit correctly

pgxsinkit is a **toolkit**, not a database, a framework, or the demo app. The `@pgxsinkit/*` packages
are the product: `contracts` (the registry + shared types), `server` (the write API + Electric shape
proxy), `client` (local PGlite store + mutation runtime + convergence), and `react` (hooks). A consumer
installs these and wires them; they do not "run pgxsinkit".

## The one idea everything else follows from: two separate, asymmetric paths

- **Read path:** Postgres → ElectricSQL → a server-side shape **proxy** (ownership-filtered) → local
  **PGlite**. Reads are served from PGlite.
- **Write path:** client stages an optimistic local write → flushes a batch to the **write API** → one
  **in-database apply function** (`pgxsinkit_apply_mutations`) applies it under RLS → Postgres.

**Writes do not travel back to the writer through Electric.** The loop closes through Postgres: your
write lands in Postgres, then streams back to _every_ subscriber (including you) as a normal Electric
change, which clears the optimistic overlay. Do not look for a write to "come back" on the write
channel, and do not try to write through Electric — Electric is read-only here.

## There is exactly one write path

There is no per-table CRUD API and no selectable backend. Every mutation — create, update, delete —
goes through `POST /api/mutations` and is applied by the single in-database function. You provision that
function once from your registry with the `pgxsinkit-generate` CLI (a drizzle-kit migration). Do not
invent REST endpoints per table; do not write to Postgres tables directly from the client.

## Reading the local store: base table vs overlay view

Reads run against local PGlite through the client, not hand-written SQL. For a **pure-Drizzle** read, pass
the builder callback directly to `client.query((c) => …)` (the guarded read): pgxsinkit scans the compiled
SQL and activates + awaits every `lazy` relation the query touches (FROM, JOIN, subquery, WHERE) before it
runs — nothing to declare. `client.query` resolves to the **rows array directly** (not `{ rows }`). Inside
the callback, reach relations through a directly-imported synced table/view object, `c.drizzle`, or
`c.views`. Only when the builder embeds a raw ``sql`…` `` fragment (which the scan can miss) use
`client.queryRaw({ use, build })` and name those relations in `use`. `queryRow` / `queryRawRow` are the
first-row-or-null variants. (Reactive equivalents: `useLiveDrizzleRows` for pure reads,
`useLiveQueryRaw({ use, build })` for raw fragments.)

**Lint the split.** `@pgxsinkit/client` ships an oxlint rule via its `./oxlint` subpath export. Enable it
in the consuming repo's `.oxlintrc.jsonc` — `"jsPlugins": ["@pgxsinkit/client/oxlint"]` +
`"pgxsinkit/guarded-query-purity": "error"` — to catch a raw ``sql`…` `` fragment on the pure path and a
redundant `use` (autofixable), the two things the types can't. (oxlint `jsPlugins` is alpha.)

**The non-obvious rule — which relation to select FROM:**

- A **readonly** entry syncs only its **base table**. Read it from the entry's **`.table`**
  (`registry.<name>.table`). There is no overlay.
- A **readwrite** entry also generates a `_read_model` **overlay view** that merges your own optimistic
  (not-yet-synced) writes on top of the synced base rows. Read it from the entry's **`.view`**
  (`registry.<name>.view`) — **not** its `.table`. Selecting the base `.table` of a readwrite entry
  silently omits the writer's own pending writes, so a just-issued create/edit/delete will not appear
  locally until it round-trips through Postgres and streams back via Electric.

```ts
// readonly entry → base table
client.query((c) => c.drizzle.select({ id: catalogResource.table.id }).from(catalogResource.table));

// readwrite entry → overlay view, so your own optimistic writes are included
const reportView = registry.report.view!; // `.view` is populated only for readwrite entries
client.query((c) => c.drizzle.select({ id: reportView.id, status: reportView.status }).from(reportView));
```

This is the read-side twin of "writes return through Electric": your optimistic write is visible
immediately **only because you read the overlay view**; the base table catches up when Postgres streams the
committed row back. (`c.views.<name>` is the client's accessor for the same overlay views; the entry's
`.view` object is the direct handle. Type note: `.view` is typed as optional on a `SyncTableEntry`, so a
non-null assertion — `registry.<name>.view!` — is expected at the read site.)

## Non-negotiables (each fails closed or throws)

1. **The Electric subquery flag is mandatory.** Run Electric with
   `ELECTRIC_FEATURE_FLAGS=allow_subqueries,tagged_subqueries`. Without it, sync **fails closed** — no
   rows stream — which looks like a bug but is a missing flag. On **managed Electric Cloud** the flag is
   activated per source by Electric staff on request (no self-serve toggle yet; default-on intended) —
   ask Electric to enable subqueries for your source, or self-host Electric with the flag.
2. **Writable tables have two hard requirements.** `defineSyncRegistry` throws unless every `readwrite`
   table declares **both** a server-version managed field (a `nowMicroseconds`-on-update column,
   conventionally `updated_at_us`, that optimistic convergence keys on) **and** a `conflictPolicy`
   (`reject-if-stale` | `last-write-wins`). There is no silent default — a silent last-write-wins is the
   exact data loss the choice exists to surface.
3. **Managed fields are server-assigned.** Fields stamped by `authClaim` (a verified claim at a JSON path —
   `["sub"]` is the old `auth.uid()` owner idiom) / `nowMicroseconds` are set by the apply function; the
   write API **rejects** a client payload that includes them. Never send them.
4. **Enum columns in a shape `where` must be cast to `text`** — `"role"::text = 'manager'`, not
   `"role" = 'manager'`. The column stays an enum everywhere else. This is because **Electric**, not
   Postgres, evaluates the shape filter.

## Authorization runs in two engines — derive both from one predicate

A row must never be readable-but-unwritable (or the reverse). The two paths enforce auth in different
engines, so the subject is referenced two ways:

- **Write path — RLS in Postgres:** policies use `auth.uid()` / `current_setting('request.jwt.claims')`;
  the applier sets the claims before applying a batch.
- **Read path — the shape `rowFilter`:** the proxy builds the Electric `where` and **Electric** runs it, so
  a `customWhere` returns a Drizzle `SQL` fragment — reference columns through `c()` (bare, as Electric
  needs) and bind `claims.sub` as a `$n` param (no hand-escaping); enum cast to `text`; `DENY_ALL` blocks
  all rows.

Use `buildSupabaseOwnerOrAdminNativePolicies` / `buildSupabaseMembershipNativePolicies` for the common
owner/membership shapes — they take **Drizzle columns**, so call them in `defineSyncTable`'s `extras`
callback; compose your own from `pgPolicy` + Drizzle operators for anything beyond them (e.g. collaborative
any-member writes). Build the read filter and the RLS policy from the same Drizzle columns so they cannot
drift.

## Membership changes converge the local store — both ways, even offline

A subquery (membership) read filter is reactive in **both** directions, against a running client with no
re-subscribe: granting a membership **materialises** the container's rows in the member's local PGlite;
revoking one **evicts** them (a row reachable through a second membership survives until its last grant is
gone). This holds **live and across an offline gap** — a client disconnected when the membership changed
converges on reconnect (the resume replays it), so a revoked member's read access never lingers offline.
Observe it on the live subscription or a normal resume, not by re-probing a shape at `offset=-1`.

## Local PGlite schema is not full DDL parity

The local store generates enums, tables, the overlay, the journal, and convergence triggers — **not**
RLS, arbitrary triggers/functions, or managed-field defaults, and it does not enforce CHECK / FK /
UNIQUE the way Postgres does. Treat Postgres as the source of truth for integrity; do not assume a
constraint that holds server-side also holds in PGlite.

## Common mistakes

- Expecting an optimistic write to echo back on the write channel — it returns through Electric.
- Forgetting the Electric subquery flag, then debugging "no rows" as a code bug.
- Omitting `conflictPolicy` (throws) or sending a managed field in a write payload (rejected).
- Comparing an enum without `::text` in a shape filter.
- Writing directly to Postgres tables / building per-table CRUD instead of using the one write path.
- Reading a **readwrite** entry from its base `.table` instead of its `.view` overlay, so your own
  optimistic writes do not appear locally until they round-trip through Postgres.
- Assuming PGlite enforces every Postgres constraint.
- Assuming a revoked member keeps their synced rows offline — membership changes converge both ways,
  live and on resume.

## Where to look

- Concepts: the two paths, read path, write path, Electric subqueries, local-schema DDL parity, and
  timestamps (microsecond BIGINT, decimal strings across the boundary).
- For deployment and runtime/operational behavior (cold starts, convergence cadence, the HTTP/2
  connection budget, the `globalThis.__pgxsinkitDebug` latency instrumentation), load the `operating`
  skill.
- Full prose: <https://pgxsinkit.github.io/llms-full.txt>.
