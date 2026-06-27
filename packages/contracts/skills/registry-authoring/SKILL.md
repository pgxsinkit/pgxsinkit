---
name: registry-authoring
description: >-
  Load when defining or changing a pgxsinkit sync registry with @pgxsinkit/contracts —
  defineSyncRegistry / defineSyncTable, table sync modes, managed fields, conflict policy, read-path row
  filters, and RLS. Teaches the rules that throw or fail closed if missed: every readwrite table needs a
  server-version managed field plus a conflictPolicy (no default), authUid/nowMicroseconds fields are
  server-assigned and rejected in client payloads, enum columns in a shape where must be cast to text,
  the read filter and the RLS policy must derive from one predicate, and the in-database apply function
  is provisioned by the pgxsinkit-generate CLI as a drizzle-kit migration. Load before authoring a
  registry, adding a writable table, or wiring row-level security.
metadata:
  type: core
  library: "@pgxsinkit/contracts"
  library_version: "0.1.32"
  source: https://pgxsinkit.github.io/start/getting-started/
---

# Authoring a pgxsinkit registry

The registry (`defineSyncRegistry` over `defineSyncTable`) is the single source of truth both paths read
from — the read proxy and the write apply function are generated from it, so getting the registry right
is what keeps read and write authorization from drifting.

## Writable tables have two hard requirements (or it throws)

`defineSyncRegistry` **throws** unless every `mode: "readwrite"` table declares **both**:

1. A **server version** — a `nowMicroseconds`-on-`update` managed field, conventionally `updated_at_us`
   (a `bigint` microsecond column). Optimistic convergence keys on it; the `reject-if-stale` conflict
   policy compares the write's base version against it.
2. A **`conflictPolicy`** — `"reject-if-stale"` or `"last-write-wins"`. There is **no silent default**,
   because a silent last-write-wins is exactly the data loss the choice exists to surface.

```ts
widgets: defineSyncTable({
  tableName: "widgets",
  mode: "readwrite",
  makeColumns: () => ({
    id: uuid("id").primaryKey(),
    label: varchar("label", { length: 120 }).notNull(),
    ownerId: uuid("owner_id"),
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(nowMicros),
  }),
  conflictPolicy: "reject-if-stale", // REQUIRED — no default
  governance: {
    managedFields: [
      { column: "updatedAtUs", applyOn: ["create", "update"], strategy: "nowMicroseconds" },
      { column: "ownerId", applyOn: ["create"], strategy: "authUid" },
    ],
  },
}),
```

## Managed fields are server-assigned — never send them

A field with a `nowMicroseconds` or `authUid` strategy is stamped by the apply function. The write API
**rejects** a client write payload that _includes_ a managed field, and the create-validation schema
**omits** managed-on-create fields. So: do not put `updated_at_us` or the owner column in a client
`create`/`update` payload; let the server assign them. (Both rules exist because the apply function
independently stamps these, so a client value would either be overwritten or rejected.)

## Read-path filtering: `customWhere` runs in Electric, not Postgres

A table's `shape.rowFilter.customWhere` builds the Electric shape `where`. **Electric** evaluates it (not
Postgres), so **return a Drizzle `SQL` fragment built from the table's columns** — reference each column
through `c(column)` and embed request-derived values directly: they become **bound `$n` params**, never
hand-escaped literals.

```ts
import { c, DENY_ALL } from "@pgxsinkit/contracts";

function widgetsReadFilter(claims) {
  if (isAdmin(claims)) return null; // null = no filter (all rows visible)
  if (!claims.sub) return DENY_ALL; // sql`false` — the deny-all sentinel (no rows visible)
  return sql`${c(widgets.ownerId)} = ${claims.sub}`; // claims.sub is a bound $1 param
}
```

Two Electric where-grammar rules: columns must be **plain** (unqualified) — `c()` emits the bare name
(`"owner_id"`), never the Drizzle-default qualified `"widgets"."owner_id"` (Electric rejects that); and an
**enum column must be cast to text** — `${c(widgets.role)}::text = 'manager'`. Subqueries must be
self-contained (not correlated). Returning a raw **string** is the escape hatch — escape any embedded
value yourself with `escapeSqlLiteral` (a string is NOT escaped for you); return `DENY_ALL` (not `"1 = 0"`)
to block all rows.

**Inline (all-in-one `defineSyncTable`) — `rowFilter` as a function of the columns.** The example above
references `widgets.ownerId`, which assumes the table is built _elsewhere_ (e.g. a separate schema file the
registry imports). When you declare a table and its filter together in **one** `defineSyncTable` call, the
table object doesn't exist yet at the call site — so don't fall back to hand-written column-name strings.
Give `shape.rowFilter` a **function of the built columns** (the same typed columns `extras` receives) and
keep using `c()`:

```ts
defineSyncTable({
  tableName: "widgets",
  makeColumns: () => ({ id: uuid("id").primaryKey(), ownerId: uuid("owner_id") }),
  shape: {
    rowFilter: (columns) => ({
      customWhere: (claims) => (claims.sub ? sql`${c(columns.ownerId)} = ${claims.sub}` : DENY_ALL),
    }),
  },
});
```

A static `RowFilterSpec` (`rowFilter: { customWhere }`) still works unchanged — reach for the function form
only when you need typed, rename-safe column refs inside an all-in-one definition. **Prefer it over the
string escape hatch:** a `customWhere` that returns `null`/`""` means _no filter — all rows visible_, so a
hand-built owner filter that returns `null` for "no claim" silently exposes every row; the typed form makes
`DENY_ALL` the obvious deny.

## RLS: derive read and write from the same Drizzle columns

Authorization runs in two engines (Postgres RLS for writes; the Electric `where` for reads). Build both
from the **same Drizzle columns** so a row can never be readable-but-unwritable (or the reverse) through a
column rename or a typo:

- Common shapes: `buildSupabaseOwnerOrAdminNativePolicies({ role, ownerColumn })` and
  `buildSupabaseMembershipNativePolicies({ role, containerColumn, membershipTable, … })` (from
  `@pgxsinkit/contracts`). They take **real Drizzle columns** and derive the governed table name from
  them, so call them inside `defineSyncTable`'s `extras: (t) => …` callback (where the columns carry their
  table), not the `policies:` array.
- Beyond them (e.g. collaborative any-member writes): compose your own with `pgPolicy` + Drizzle operators
  (`and`/`or`/`eq`) over the columns. Use the official `drizzle-orm/supabase` helpers for the auth leaves —
  `authUid` (emits `(select auth.uid())`, the Supabase per-statement-eval performance idiom, not a per-row
  bare `auth.uid()`), `authenticatedRole`, etc. Inline a literal with `eq(col, value).inlineParams()` (the
  value stays type-checked against the column and is inlined into the DDL — a bare `$n` is something
  `CREATE POLICY` cannot carry). Drop to raw `sql` only for things with no Drizzle equivalent: a SECURITY
  DEFINER membership helper or a `current_setting('request.jwt.claims')` admin check. Inline such a
  predicate rather than referencing a not-yet-created SQL function — `CREATE POLICY` needs it to exist
  first. For "compare OLD vs NEW" rules (column immutability), RLS cannot help (`WITH CHECK` sees only NEW,
  `USING` only OLD) —
  use a `BEFORE UPDATE` trigger.

Give drizzle-kit `entities: { roles: { provider: "supabase" } }` in `drizzle.config.ts` so it treats the
Supabase roles (`authenticated`/`anon`/`service_role`/…) as externally managed — referenced in a policy's
`to:` but never created or dropped.

## Provision the apply function from the registry

The write path applies through one in-database PL/pgSQL function, `pgxsinkit_apply_mutations`. Generate
the drizzle-kit migration that installs it with the published `pgxsinkit-generate` CLI (a `bin` of
`@pgxsinkit/server`), run from your project, then apply it through your normal migration flow:

```bash
bun run pgxsinkit-generate --registry ./sync-registry.ts --export registry \
  --project-dir ./db --config drizzle.config.ts --name sync_artifact
```

## Common mistakes

- Omitting `conflictPolicy` or the server-version field on a `readwrite` table (throws).
- Putting a managed field (`updated_at_us`, owner) in a client write payload (rejected).
- In a `customWhere`: comparing an enum without `::text`, qualifying a column (use `c()` for a bare ref),
  or hand-escaping a value into a string instead of binding it via a Drizzle `sql` fragment.
- Letting the read filter and RLS policy diverge instead of building both from the same Drizzle columns.
- Calling the native policy builders in the `policies:` array (they need `extras: (t) => …` to derive the
  table from the columns), or referencing a custom SQL function in `CREATE POLICY` before it exists.
- In a hand-written policy: bare `auth.uid()` instead of `authUid` (per-row vs per-statement), or a bound
  literal (`eq(col, x)`) where `CREATE POLICY` needs an inlined one (`eq(col, x).inlineParams()`).

For the surrounding model (two paths, one write path, fail-closed subquery flag), load the `core` skill
from `@pgxsinkit/client`. Full prose: <https://pgxsinkit.github.io/start/getting-started/>.
