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
  library_version: "0.2.5"
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
    updatedAtUs: bigint("updated_at_us", { mode: "bigint" }).notNull().default(clockMicrosecondsSql),
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

**Column types don't constrain sync.** The read-path backfill picks a bulk-insert tier (COPY / JSON /
per-row `INSERT`) statically from a table's Drizzle column types; enum columns and `GENERATED ALWAYS AS
IDENTITY` primary keys are fully supported (enum labels round-trip through COPY/JSON, and a synced
identity PK keeps the server's value via `OVERRIDING SYSTEM VALUE`), so you never need to avoid them for
sync's sake.

## The `primaryKey` spec emits the physical PRIMARY KEY — it is the single source of truth

`defineSyncTable` **emits** the `primaryKey` spec as the server table's physical `PRIMARY KEY` constraint,
named `` `${tableName}_pkey` `` — Postgres's default inline-PK constraint name (which drizzle's own naming
does not produce), so DDL declared through pgxsinkit agrees with plain-Postgres inline-PK DDL and
drizzle-kit sees no rename churn against a real database. The spec was runtime-only metadata until a
consumer had drizzle-kit DROP a live composite key — seeing no PK in the generated DDL — so it now drives
DDL directly.

- **Composite / non-`id` key:** `primaryKey: ["org_id", "person_id"]` (default `["id"]`). Constraint
  columns follow spec order.
- **Custom constraint name:** the object form `primaryKey: { name: "org_person_pk", columns: [...] }`.
- **Single-column key, idiomatic drizzle:** declaring `id: uuid("id").primaryKey()` on the column is
  allowed and equivalent — it must match the spec, and emission is skipped (the column already carries the
  constraint). A custom constraint name cannot be combined with a column-level `.primaryKey()` (a named
  constraint needs `defineSyncTable` to emit it).
- **Rejected:** a table-level `primaryKey(...)` passed through `extras`/`policies`, and more than one
  column-level `.primaryKey()` — declare composite keys via the `primaryKey` option instead.

## `applyMode` — CDC insert-apply policy (default stays strict)

`applyMode` chooses how a **server CDC insert** for this table is applied on the client (ADR-0045).

- **`"insert"` (default):** a CDC insert is a plain INSERT with no conflict clause, so a genuine
  primary-key collision **surfaces** (the ADR-0014 invariant — a synced cache table is
  server-authoritative, and a duplicate insert is a real bug). Do not change this without a reason below.
- **`"upsert"`:** server CDC inserts are applied idempotently as `INSERT … ON CONFLICT (pk) DO UPDATE`
  (or a pk-targeted `DO NOTHING` for a pk-only table); the authoritative server row overwrites the
  provisional local row.

**When to use `"upsert"`:** only when this table legitimately receives locally-**derived** provisional
rows — e.g. a local trigger on another synced table writes a provisional row here, and the server
independently creates the same row, so its CDC insert would otherwise collide (23505) and degrade the
engine. It routes all three CDC-insert paths (initial bulk snapshot, steady-state fold, per-message)
through the idempotent applier. Declare the exception where it lives; never weaken the default repo-wide.

## Managed fields are server-assigned — never send them

A managed field is stamped by the apply function under the verified request claims. Two strategies:

- **`nowMicroseconds`** — `clock_timestamp()` microseconds (the audit columns; the `updated_at_us`-on-update
  field is the strictly-monotonic server version). The stamp is the canonical `public.pgxsinkit_clock_us()`
  database function (one home for the clock semantics — `clock_timestamp()`, never `now()`), installed by the
  **utilities migration** (`renderPgxsinkitUtilitiesMigration` / `pgxsinkit-generate --utilities`) which must
  be the **first folder** in your migration chain, before the schema and the generated sync-artifact.
- **`authClaim`** — a value read from a verified JWT claim at a JSON `claimPath`. This is the **single**
  claim-stamping strategy: `["sub"]` is the auth subject (the old `auth.uid()` owner idiom), and
  `["app_metadata", "person_id"]` (etc.) is any app-minted identity — one mechanism, not a `sub`-only
  special case. `cast` is optional and **defaults to the target column's own SQL type** (a `uuid` column
  needs none); the path segments must be plain identifiers (they are emitted into the apply-function DDL).

The write API **rejects** a payload that _includes_ a managed field, and the create-validation schema
**omits** managed-on-create fields. So: never put `updated_at_us` or a claim-stamped owner column in a
client `create`/`update` payload; let the server assign them (a client value would be overwritten or
rejected). The optimistic overlay still fills an `authClaim` create field locally from the decoded claim,
so the row renders attributed immediately.

## Omitted columns are invisible to the write path — by design

`clientProjection.omitColumns` columns are **server-only**: they exist on the Postgres table but not on the
client, and the apply function reads **only a table's projected columns** from a write payload. A payload key
that is not a writable (projected) column splits into exactly two cases:

- **A projected-away / server-only column** (one you listed in `clientProjection.omitColumns`) sent
  _explicitly_ in a `create`/`update` payload is **400-rejected** by the write route's projected-field check.
  It is _not_ silently dropped, and the write does **not** succeed.
- **An unknown non-column key** (a typo, a stale field the table no longer has) is **silently ignored by the
  apply function** — that write collapses to a bare server-version (`updated_at_us`) bump and still acks
  `succeeded`. To make that silence observable, the write API emits **one structured `console.warn` per
  (table, key) per process** naming the dropped key — a diagnostic, not a rejection, fired _only_ here and
  never for a projected-away column (which is rejected, not dropped).

The rule that follows: **write a server-only (omitted) column outside the sync rail** — a server-side
`UPDATE`, a trigger, or a managed field (`governance.managedFields`). Do not try to set it from a client
payload; the route rejects it.

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
references `widgets.ownerId`, so it assumes the table is built _elsewhere_. Declaring a table and its
filter in **one** call, the table object doesn't exist yet — so don't fall back to column-name strings:
give `shape.rowFilter` a **function of the built columns** (the typed columns `extras` gets), still with `c()`:

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

The column callback is the only authoring form. **Prefer a typed SQL fragment over the raw string escape
hatch:** a `customWhere` that returns `null`/`""` means _no filter — all rows visible_, so an owner filter
that returns `null` for "no claim" silently exposes every row; the typed form makes `DENY_ALL` the obvious
deny.

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
preview** — run Electric with `allow_subqueries,tagged_subqueries` or the shape fails closed (no rows). On
**managed Electric Cloud** that preview is activated per source by Electric staff on request (no self-serve
toggle yet; default-on intended) — ask Electric to enable it, or self-host. Combine with the function form
when the table is defined all-in-one: the row's own column comes from `(columns) => …`, the foreign table
and its columns are imported already-built.

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
- **Do not hand-write the read half — every policy family ships its read-path mirror.** Electric cannot
  read RLS, so the shape `where` must re-derive the same visible set in JS, from the same declaration:
  `buildOwnershipShapeWhere(ownerColumn, claims.sub)`, `buildOwnerOrAdminShapeWhere(ownerColumn, claims)`
  (admin → `null`, i.e. no filter, mirroring the policy's bypass branch),
  `buildMembershipShapeWhere(columns, claims)` (pass the **same** options object you gave the policy
  builder — write-only fields are ignored), and `buildGrantScopeAccessShapeWhere(scopeColumn, claims, …)`
  (bypass grant → `null` too; bare `resolveGrantScopeIds` + `buildGrantScopeShapeWhere` cannot see it).
  Return each straight from `customWhere`; they deny with `DENY_ALL`, so the filter probes claims-dependent.
- Two properties of the mirrors to keep in mind: they cover **SELECT only** (a shape `where` filters a read
  stream — the owner/manager and write-gate branches stay with the INSERT/UPDATE/DELETE policies), and the
  two surfaces render containment in **different dialects on purpose** — RLS emits `= ANY(ARRAY(select …))`
  for the InitPlan/index-scan discipline, Electric emits plain `IN (subquery)`, which is what its shape
  grammar accepts.

Give drizzle-kit `entities: { roles: { provider: "supabase" } }` in `drizzle.config.ts` so it treats the
Supabase roles (`authenticated`/`anon`/`service_role`/…) as externally managed — referenced in a policy's
`to:` but never created or dropped.

## Composition obligations: two correct policies can still break an invariant

The registry keeps ONE table's read filter and write policy from drifting. A domain invariant usually spans
several tables and rails — and no registry feature can see that composition. Worked example: an invite
table's RLS legitimately grants an offering-scoped teacher INSERT; an invite-acceptance worker then mints a
membership row. Each policy is correct in isolation; the composition violates "this offering only ever has
one member". The worker's semantics are invisible to per-table declarations, so the obligation is the
consumer's — permanently.

When you add a worker, route, or trigger that writes rows as a CONSEQUENCE of other rows:

- List the invariants the OUTPUT table participates in — not just the input table's. The output is where
  the violation lands.
- For each one, ask: does the composed path enforce it, or does it assume the input row's policies already
  did? "The input was authorized" is not "the output is valid".
- Re-derive at mint time, don't trust the input: re-check the invariant against current state when the
  worker runs — the input row may be stale (or its authority revoked) by then.
- Pin it with a test at the composition seam (drive the worker/route end-to-end), not only with per-table
  policy tests — per-table tests structurally cannot fail on a composition hole.
- Record the invariant where the next author will look: the registry entry's comment (and its `rowClass` /
  `assertRegistryInvariant` coverage if you use them — the assertion audits per-entry rendered artifacts
  and can never see worker composition).

## Provision the apply function from the registry

The write path applies through one in-database PL/pgSQL function, `pgxsinkit_apply_mutations`. Generate
the drizzle-kit migration that installs it with the published `pgxsinkit-generate` CLI (a `bin` of
`@pgxsinkit/server`), run from your project, then apply it through your normal migration flow:

```bash
bun run pgxsinkit-generate --registry ./sync-registry.ts --export registry \
  --project-dir ./db --config drizzle.config.ts --name sync_artifact
```

The apply function and the audit/version column DEFAULTs both **call** the canonical
`public.pgxsinkit_clock_us()` microsecond clock, so its **utilities migration must be the first folder in
the chain** — generate it once with `--utilities`, passing an early-sorting folder name:

```bash
bun run pgxsinkit-generate --utilities \
  --project-dir ./db --config drizzle.config.ts --name 20200101000000_pgxsinkit_utilities
```

## Multi-client: one authoritative registry, readonly projections (ADR-0025)

When the same table is `readwrite` for one client and `readonly` for another (a teacher writes a row a
learner only reads, or the reverse), `mode` is **per-client**, not a property of the table: define it
**once** in an authoritative registry at its writable capability and project it per client. `mode` is baked
at `defineSyncTable` time and drives the overlay/journal machinery + the `_read_model` view, so a
hand-spread `{ ...entry, mode: "readonly" }` is **broken** (it keeps a view over overlay state the readonly
client never creates). Use `asReadonly`: it re-derives a true readonly entry — dropping the overlay/journal
projection, the view, and `conflictPolicy`/`governance`/`writeMode`, keeping columns, primary key, synced
table, shape/row filter and `rowClass`.

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
- `columns` is a typed subset of the owner's keys, and the projection's local table carries the owner's
  **real per-column types restricted to exactly those keys** (Picked from the owner), so a projection row
  typechecks by property key with no casts. The PK is always kept **at runtime**, but the type is a safe
  **under-claim**: a PK column not in `columns` is still synced yet **absent from the type** — list it to
  read it typed. The owner's column definitions are reused (never restated), and the subset becomes the
  Electric `columns` allow-list, so an omitted (heavy) column is **never fetched**, not merely stripped.
- The physical Electric table is **derived** from the owner — you never name a source string (the old
  `shape.electricTable` is internal-only and not a consumer input). The `rowFilter` callback receives the
  OWNER's full columns (the `customWhere` runs in Electric on the physical table, so it may reference a
  column the subset omits).
- It is **readonly**; put it in the authoritative registry under its own key and in the reading client's
  registry. RLS for its reads lives on the **owner** (a projection adds no DDL to a table it doesn't own);
  its `customWhere` must be a subset of what that RLS allows. The proxy resolves each shape by its unique
  `shapeKey`, so the owner and the projection coexist over one physical table.

### Redacting projection: a secure "window" over a keyed table

A projection can carry its own `serverProjection` (an egress `rowTransform`, resolved by the projection's
`shapeKey`) — e.g. stream a `jsonb` item body while stripping the answer key per row. When the transform
must READ a column outside the client shape (a `keysWithheld` control flag), list it in
`serverOnlyColumns`: it joins the Electric fetch allow-list (so the transform sees it) yet stays omitted
from the client keep-set. Egress order is **transform first, then omission** — the flag is stripped after.

```ts
export const secureItemWindow = defineReadProjection(secureItem, {
  as: "secure_item_window",
  columns: ["payload", "metadata"], // client keep-set (PK always kept)
  serverProjection: {
    rowTransform: (row) => (row.keys_withheld === true ? { ...row, payload: stripKey(row.payload) } : row),
  },
  serverOnlyColumns: ["keysWithheld"], // fetched for the transform, never on the client wire
});
```

`serverOnlyColumns` requires BOTH `serverProjection.rowTransform` and `columns`, and must be disjoint from
`columns` and the PK — each is a loud error.

**No inheritance — enforced.** A projection does NOT inherit its owner's `serverProjection`: an inherited
transform whose input column is absent from the projection's fetch list would read `undefined` and silently
fail OPEN (serving the un-redacted body). Since a bare projection over a redacting owner would therefore
egress the RAW owner row, `defineReadProjection` THROWS when the owner declares an egress `rowTransform`
unless the projection declares its posture — either your own `serverProjection` (usually the same fn) +
`serverOnlyColumns` for its control inputs, or the explicit opt-out `serverProjection: "unredacted"` (only
after confirming the kept columns leak nothing; it attaches no transform but records the raw-egress decision
at the definition site). `"unredacted"` over a transform-less owner is itself rejected — a stale opt-out
would silently pre-authorize a leak if the owner later gains a transform.

## Classify rows and assert registry invariants (ADR-0052)

`assertReadContractPreserved` pins ONE table. A privacy rule ("nothing private streams to an anonymous
caller") spans MANY entries and BOTH engines — and an invariant written over a hand-listed set of tables
silently stops covering the registry the moment someone adds an entry.

```ts
export const registry = defineSyncRegistry({
  rowClasses: ["directory", "team-scoped"], // YOUR vocabulary; declaring it makes rowClass MANDATORY
  tables: { profile, team, issue }, // …on every entry, at module eval, every offender named at once
});

assertRegistryInvariant(registry, {
  name: "team-scoped rows are invisible to an anonymous caller",
  appliesTo: ["team-scoped"], // classes (or a predicate); an undeclared class / zero matches throws
  claimsFixtures: { anonymous: {}, member: { sub: memberId }, admin: adminClaims },
  holds: ({ fixtureName, renderedWhere, renderedPolicies }) =>
    fixtureName !== "anonymous" ||
    (renderedWhere?.where === "false" && renderedPolicies.every((p) => p.using !== "true")) ||
    "anonymous is not denied on one of the two surfaces", // reported as `entry (fixture): reason`
});
```

So a table added next month cannot inherit the obligation invisibly (omit `rowClasses` and `rowClass` is
unconstrained, as the bare registry-map form always is). Projections carry the class (`asReadonly`,
`asEphemeral`; `defineReadProjection` inherits the owner's, overridable). Each cell gets that persona's
RENDERED artifacts — `renderedWhere` is the proxy's own `buildRowFilterShape(…)` (`null` = unfiltered),
`renderedPolicies` the table's RLS as inline SQL — so one predicate covers both surfaces, and ALL failing
cells are aggregated into one error. `rowClass` is authoring metadata, deliberately in NEITHER fingerprint
(classifying never wipes a store's cache); the registry **lock** carries it, so losing a class is a `risky`
diff. It complements `RowFilterSpec.revision` and never replaces it: only `revision` makes a `customWhere`
logic change move the fingerprint (rebuilding the cache, resetting the subscription), while the assertion
renders that logic — for the fixtures you hand it, and no others.

## Storage declaration: `storage.backend` and `storage.durability` (browser stores)

The registry carries the browser store's storage contract — `SyncRegistryDefinition.storage`,
`{ backend?: "opfs" | "idbfs"; durability?: "relaxed" | "strict" }`. It lives on the registry, not on a
minting surface, worker entry, or attach site, because both properties follow the DATA: one declaration
binds every open of every store minted from that registry, so no tab can disagree with another.

- **`backend`** (default `"opfs"`) — `"opfs"` is the normal boot on every platform: the toolkit probes
  OPFS sync-access at boot and runs the `opfs-repacked` engine wherever handles are granted, falling back
  automatically to in-SharedWorker idbfs (declared durability kept) only where the platform provides no
  OPFS sync access anywhere. `backend: "idbfs"` is the one opt-out — no probe, no election, the engine
  boots in the SharedWorker on idb. Where the engine runs is never a consumer knob; the only decision you
  declare is whether to force idb.
- **`durability`** (default `"relaxed"`) — relaxed returns the local write before the physical flush and
  schedules it asynchronously; `"strict"` awaits the flush per commit. Relaxed is right for a sync toolkit
  (the write is instant, the server is the source of truth, and the loss window is one recent action);
  declare `"strict"` only for local-only data you cannot re-derive and cannot lose on a crash (ADR-0047).

The declaration scopes the **browser** store only; Node mints stay `file://` and export clones stay memory.

## Consistency groups: scope them to the joined cluster

`consistencyGroup` binds tables onto one shape stream committing **atomically** at a shared LSN frontier —
a reader never sees one grouped table advanced past another for the same server transaction. Default is
none (per-table singleton, independent frontier). Three scoping rules:

1. **Group the transactionally-joined cluster** — tables written together in one server transaction and
   rendered joined (FK parent + children). That is what the atomic frontier protects; if the app otherwise
   needs post-ack re-reads to hide half-applied transactions, the tables belong in a group.
2. **Quiet members are affordable.** Pre-ADR-0033 a rarely-written reference table could hold its whole
   group for a full long-poll cycle (~41s on CDN-fronted Electric); the live-tail sibling nudge now caps
   that at ~one catch-up round trip per gated commit. Don't keep a lookup table out of its natural group.
3. **Don't group "everything".** Every gated commit nudges each lagging member — scope a group to the
   joined cluster; unrelated clusters go in separate groups or stay singletons.

All members of a group must agree on `subscription`, `retention`, `writeMode` (or the registry rejects it).

## Common mistakes

- Omitting `conflictPolicy` or the server-version field on a `readwrite` table (throws).
- Putting a managed field (`updated_at_us`, owner) in a client write payload (rejected).
- Trying to write an `omitColumns` (server-only) column from a client payload — the write route
  **400-rejects** it (an unknown non-column typo is instead silently dropped, surfaced by a per-process
  `console.warn`); write them outside the sync rail (a server `UPDATE`, a trigger, or a managed field).
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
