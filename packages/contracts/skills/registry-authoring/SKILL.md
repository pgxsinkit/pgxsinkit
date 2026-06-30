---
name: registry-authoring
description: >-
  Load when defining or changing a pgxsinkit sync registry with @pgxsinkit/contracts —
  defineSyncRegistry / defineSyncTable, table sync modes, managed fields, conflict policy, read-path row
  filters, and RLS. Teaches the rules that throw or fail closed if missed: every readwrite table needs a
  server-version managed field plus a conflictPolicy (no default), authClaim/nowMicroseconds managed
  fields are server-assigned and rejected in client payloads, enum columns must be cast to text,
  the read filter and the RLS policy must derive from one predicate, and the in-database apply function
  is provisioned by the pgxsinkit-generate CLI as a drizzle-kit migration. Also covers per-client mode
  projection (ADR-0025): one authoritative registry with `asReadonly` projections when a table is
  readwrite for one client and readonly for another, guarded by `assertReadContractPreserved`. Load before
  authoring a registry, adding a writable table, presenting a table read-only to one client, or wiring
  row-level security.
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
      // Stamp the owner from the verified `sub` claim. (`auth.uid()` is just claimPath: ["sub"].)
      { column: "ownerId", applyOn: ["create"], strategy: "authClaim", claimPath: ["sub"] },
    ],
  },
}),
```

## Managed fields are server-assigned — never send them

A managed field is stamped by the apply function under the verified request claims. Two strategies:

- **`nowMicroseconds`** — `clock_timestamp()` microseconds (the audit columns; the `updated_at_us`-on-update
  field is the strictly-monotonic server version).
- **`authClaim`** — a value read from a verified JWT claim at a JSON `claimPath`. This is the **single**
  claim-stamping strategy: `["sub"]` is the auth subject (the old `auth.uid()` owner idiom), and
  `["app_metadata", "person_id"]` (etc.) is any app-minted identity — one mechanism, not a `sub`-only
  special case. `cast` is optional and **defaults to the target column's own SQL type** (a `uuid` column
  needs none); the path segments must be plain identifiers (they are emitted into the apply-function DDL).

The write API **rejects** a client write payload that _includes_ a managed field, and the create-validation
schema **omits** managed-on-create fields. So: do not put `updated_at_us` or a claim-stamped owner column in
a client `create`/`update` payload; let the server assign them. (The apply function independently stamps
these, so a client value would either be overwritten or rejected. The optimistic overlay still fills an
`authClaim` create field locally from the decoded claim, so the row renders attributed immediately.)

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

## Cross-table filters: compose a self-contained subquery from the typed columns, never a string

A **membership fan-out** — "sync a row only if the subject belongs to its container" — is a `customWhere`
whose predicate is a **subquery over another table** (`container_id IN (SELECT … FROM memberships …)`).
Author it the same typed way as an owner filter, never as a hand-built string: `c()` for every column
(bare, as Electric needs), the **table object** for the `FROM`, and the subject as a **bound param**.
Factor the subquery into a small helper so the read filter — and any narrower variant — share one
definition (the read-path twin of the membership RLS predicate):

```ts
import { c, DENY_ALL, type JwtClaims } from "@pgxsinkit/contracts";
import { sql, type SQL } from "drizzle-orm";

// The containers a subject belongs to, as a self-contained subquery: bare columns via c(), the FROM
// from the table object, the subject bound as $n. The subquery references `membership`'s OWN columns,
// so its bare names resolve to its own FROM — it is self-contained, not correlated.
function memberContainers(subject: string): SQL {
  return sql`select ${c(membership.containerId)} from ${membership} where ${c(membership.memberId)} = ${subject}`;
}

function widgetsReadFilter(claims: JwtClaims): SQL {
  if (!claims.sub) return DENY_ALL; // no claim → deny (NOT null, which would expose every row)
  return sql`${c(widgets.containerId)} in (${memberContainers(claims.sub)})`;
}
```

What the typed form buys over a string: the columns stay rename-safe and existence-checked, and the
subject is a `$n` param (`params: ["…"]`), never an escaped literal — so a quote in the value can't break
or inject the predicate. **Subqueries nest by interpolation** — wrap one `sql` fragment in another to
narrow a fan-out (e.g. a group _within_ an offering): `` sql`${c(post.offeringId)} in (${memberOfferings(sub)}) and (${c(post.groupId)} is null or ${c(post.groupId)} in (${memberGroups(sub)}))` `` (each `${sub}`
is its own bound param). Two constraints hold: the subquery must stay **self-contained** (not correlated —
it gets its own `FROM`, so bare names resolve to it), and the subquery `where` is the **flagged Electric
preview** — run Electric with `allow_subqueries,tagged_subqueries` or the shape fails closed (no rows).
On **managed Electric Cloud** that preview is activated per source by Electric staff on request (no
self-serve toggle yet; default-on intended) — ask Electric to enable it, or self-host Electric.
Combine with the function form when the table is defined all-in-one: the row's own column comes from
`(columns) => …`, the foreign table + its columns are imported already-built.

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

## Multi-client: one authoritative registry, readonly projections (ADR-0025)

When the same table is `readwrite` for one client and `readonly` for another (a teacher writes a row a
learner only reads, or the reverse), `mode` is **per-client**, not a property of the table. Define it
**once** in an authoritative registry at its writable capability and project it per client. `mode` is baked
at `defineSyncTable` time and drives the overlay/journal machinery + the `_read_model` view, so a
hand-spread `{ ...entry, mode: "readonly" }` is **broken** (it keeps a view over overlay state the readonly
client never creates). Use `asReadonly`, which re-derives a true readonly entry — drops the overlay/journal
projection, the view, and `conflictPolicy`/`governance`/`writeMode`; keeps columns, primary key, synced
table, and the shape/row filter.

```ts
import { asReadonly, assertReadContractPreserved } from "@pgxsinkit/contracts";

const authoritativeRegistry = defineSyncRegistry({ posting_restriction: postingRestrictionEntry }); // readwrite
const teacherRegistry = defineSyncRegistry({ posting_restriction: postingRestrictionEntry });
const learnerRegistry = defineSyncRegistry({ posting_restriction: asReadonly(postingRestrictionEntry) });

// Fail closed if a projection ever diverges the data it syncs (columns / pk / row-filter shape):
assertReadContractPreserved(authoritativeRegistry, teacherRegistry, { label: "teacher" });
assertReadContractPreserved(authoritativeRegistry, learnerRegistry, { label: "learner" });
```

- **Generate the server (apply function + proxy) from the authoritative registry** — the apply function
  emits a branch for every table and stamps managed fields / reject-if-stale from the entry's write
  contract, so it must see the writable entry. A claims-branching `customWhere` then serves every client.
- A projection may differ **only** in write capability and lifecycle (`subscription`/`retention`/group),
  never in the read contract — `assertReadContractPreserved` enforces it (it can't see the `customWhere`
  body, so bump `rowFilter.revision` on a logic change).
- The full registry fingerprint differs between the writable and readonly variants — expected and fine:
  it is client-local (guards each client's own store rebuild) and the server never sees it.

## A second shape over one table: read projections (ADR-0027)

`asReadonly` reuses the **same** table+columns for another client. When you instead need a **different,
narrower shape over an existing physical table** — a light column subset and/or a different row filter,
under a distinct local identity — use `defineReadProjection(owner, …)`. The first use: a learner reads the
full `assessment_definition` (heavy QTI jsonb) while an admin reads only titles, admin-scoped.

```ts
import { defineReadProjection } from "@pgxsinkit/contracts";

export const assessmentDefinition = defineSyncTable({ tableName: "assessment_definition", makeColumns /* … */ });

export const assessmentDefinitionAdminSummary = defineReadProjection(assessmentDefinition, {
  as: "assessment_definition_admin_summary", // distinct local table + shapeKey
  columns: ["offeringId", "assessmentType", "title", "state"], // typed subset of owner keys; PK always kept
  rowFilter: (c) => ({ customWhere: adminOrgFilter(c.offeringId), revision: "admin-summary-1" }),
});
```

- It **owns no table**: its `table` IS the owner's, so nothing new is migrated and there is nothing to
  leak into a drizzle-kit schema barrel. Only its `localTable` (named `as`) and shape are its own.
- `columns` is a typed subset of the owner's keys (the PK is always kept); the owner's column definitions
  are reused (never restated), and the subset becomes the Electric `columns` allow-list so an omitted
  (heavy) column is **never fetched**, not merely stripped.
- The physical Electric table is **derived** from the owner — you never name a source string (the old
  `shape.electricTable` is internal-only and not a consumer input). The `rowFilter` callback receives the
  OWNER's full columns (the `customWhere` runs in Electric on the physical table, so it may reference a
  column the subset omits).
- It is **readonly**; put it in the authoritative registry under its own key and in the reading client's
  registry. RLS for its reads lives on the **owner** (a projection adds no DDL to a table it doesn't own);
  its `customWhere` must be a subset of what that RLS allows. The proxy resolves each shape by its unique
  `shapeKey`, so the owner and the projection coexist over one physical table.

## Common mistakes

- Omitting `conflictPolicy` or the server-version field on a `readwrite` table (throws).
- Putting a managed field (`updated_at_us`, owner) in a client write payload (rejected).
- In a `customWhere`: comparing an enum without `::text`, qualifying a column (use `c()` for a bare ref),
  or hand-escaping a value into a string instead of binding it via a Drizzle `sql` fragment.
- Letting the read filter and RLS policy diverge instead of building both from the same Drizzle columns.
- Declaring a _second_ owning `defineSyncTable` to read an existing physical table (a phantom table, and
  the registry rejects the duplicate local identity) — use `defineReadProjection` for a second shape.
- Calling the native policy builders in the `policies:` array (they need `extras: (t) => …` to derive the
  table from the columns), or referencing a custom SQL function in `CREATE POLICY` before it exists.
- In a hand-written policy: bare `auth.uid()` instead of `authUid` (per-row vs per-statement), or a bound
  literal (`eq(col, x)`) where `CREATE POLICY` needs an inlined one (`eq(col, x).inlineParams()`).
- Hand-spreading `{ ...entry, mode: "readonly" }` to downgrade a writable table for a read-only client
  (keeps a `_read_model` view over overlay state that client never creates) — use `asReadonly`.

For the surrounding model (two paths, one write path, fail-closed subquery flag), load the `core` skill
from `@pgxsinkit/client`. Full prose: <https://pgxsinkit.github.io/start/getting-started/>.
