# Read projections: a derived second client shape over an owned table

Status: accepted (2026-06-30) — implemented across `@pgxsinkit/contracts` (`defineReadProjection`),
`@pgxsinkit/server` (shapeKey-based proxy resolution), and `@pgxsinkit/client` (shapeKey request
identity); 480 unit tests pass. Greenfield: `shape.electricTable` had no consumer, so no backwards
compatibility was owed — it was reshaped freely.

## Context

`defineSyncTable` conflates two responsibilities that coincide for almost every table:

1. **Owning a physical table** — `entry.table = pgTable(tableName, …)`: the object drizzle-kit migrates,
   Postgres RLS guards, and the apply function is generated for. Exactly one entry owns each physical table.
2. **Defining a client shape** — `entry.shape` (shapeKey, where, column allow-list) + a local PGlite table
   (`entry.localTable`) + a `_read_model` view.

The two are 1:1 for nearly all tables, so the conflation is invisible. Promoting emergent's LTI AGS
line-item admin panel onto the sync rail surfaced the first case that needs **a second client shape over an
existing physical table**: the admin console wants `assessment_definition` *titles* (id, offering, type,
title, state, version) without the heavy authoring jsonb (`test_structure`, `rubric_schema`,
`source_provenance_payload`), under an admin offering→org row filter — while the learner keeps reading the
same physical rows through the full, membership-filtered shape.

Two things made the original expression of that bad:

- **`shape.electricTable: "assessment_definition"`** was the only way to point a second entry at an
  existing physical table. A bare string in a config bag, syntactically identical to the field that
  *creates* tables, it did not communicate "this entry owns no table; do not migrate it" — a pure
  footgun: typo it, point it at the wrong table, or export the entry's stray `.table` into a drizzle-kit
  schema barrel and mint a phantom physical table.
- **The engine resolved shapes by physical (electric) target.** The read proxy mapped an incoming
  request to an entry via `resolveEntryByElectricTarget` (`electricTable ?? shape.tableName`), and the
  client sent that same physical target in the `table` param. Two entries sharing a physical table both
  matched, so the proxy returned the first or 403'd the projection's local name. The second shape was
  unresolvable even with `electricTable` set.

## Decision

### 1. `defineReadProjection(owner, opts)` — derive the projection from the owner

A read projection is authored by deriving it from the **owning entry**, not by hand-configuring a source:

```ts
export const assessmentDefinitionSyncEntry = defineSyncTable({
  tableName: "assessment_definition",
  makeColumns: makeAssessmentDefinitionColumns,
  shape: { rowFilter: (c) => ({ customWhere: offeringMembershipFanOut(c.offeringId) }) },
});

export const assessmentDefinitionAdminSummary = defineReadProjection(assessmentDefinitionSyncEntry, {
  as: "assessment_definition_admin_summary",                                  // distinct local identity + shapeKey
  columns: ["offeringId", "assessmentType", "title", "state", "versionNo", "updatedAtUs"], // typed subset; PK kept
  rowFilter: (c) => ({
    customWhere: buildAdminOfferingOrgRowFilterWhere(c.offeringId),
    revision: "assessment-definition-admin-summary-1",
  }),
});
```

The returned entry:

- **Owns nothing.** `entry.table` IS `owner.table` (the same object) — no new `pgTable` to migrate or to
  leak into a drizzle-kit barrel. Only `localTable` (named `as`) and `shape` are its own; `readProjection`
  is set so apply/RLS/migration generators skip it.
- **DRY columns via `omitColumns`.** The subset is expressed as `clientProjection.omitColumns` over the
  owner's **own** column definitions (reused, never restated), so every column-derivation helper
  (`deriveSyncColumnTypes` / `classifyTableApplyStrategy` / `getProjectedColumnNames`), which read
  `entry.table` minus `omitColumns`, yields the right subset for the client while `entry.table` stays the
  physical table. The primary key is always kept.
- **Source is derived, never named.** The physical Electric target comes from the owner
  (`getTableConfig(owner.table).name`) — there is no consumer-facing source field to get wrong.
- **Light wire.** When a subset is requested, the kept columns become the Electric `columns` allow-list,
  so an omitted (heavy jsonb) column is never *fetched*, not merely stripped after.
- **Readonly.** A projection has no write path; the `rowFilter` callback receives the OWNER's full
  columns (the `customWhere` runs in Electric on the physical table, so it may reference a column the
  subset omits).

`asReadonly` (ADR-0025) is unchanged and orthogonal: it re-derives the **same** table's entry as readonly
for a *different client*. `defineReadProjection` introduces a **new registry key** with a **different
local table and a narrower shape** over an existing physical table.

### 2. The source-table field is internal and derived — never a consumer input

There is no valid consumer reason to set the source table by hand (a projection over a non-owner table
passes that table *reference*; a Postgres view can't be Electric-synced; a `pgTable`'s name *is* its SQL
name; a projection-of-projection still resolves to one source). A hand-set string can only be redundant or
wrong. So `electricTable` is **removed from every consumer input type** (`ShapeSpecInput`), kept only on
the resolved `ShapeSpec` the engine reads on egress; `defineReadProjection` is its sole writer.
`attachSyncRegistrySchema` qualifies a projection's (bare) `electricTable` the same way it qualifies an
owner's own target, so both shapes hit one schema-qualified table on egress.

### 3. The engine resolves shapes by a unique shape key, not by physical target

The client sends the shape's **`shapeKey`** as the ingress `table` param; the proxy resolves the entry by
`shape.shapeKey` (`resolveEntryByShapeKey`) for the forward decision, the row-filter/column derivation,
and the response-path omit/rowTransform lookup; it consults the physical target **only on egress**, to set
the upstream Electric `table`. For an owner, `shapeKey == tableName == physical`, so the wire is unchanged;
only a projection sends a distinct key (`as`). This is the change that makes two shapes over one table
resolvable; the combinator guarantees `as` (hence `shapeKey`) is unique.

### 4. Registry uniqueness keys on local/shape identity; ownership is structurally single

`defineSyncRegistry` rejects two entries sharing a **local/shape identity** (`shape.tableName ??
getTableConfig(entry.table).name`) — owner `assessment_definition` and projection
`assessment_definition_admin_summary` are distinct. "Two owners of one physical table" is *unexpressable*:
only `defineSyncTable` mints owners, and `defineReadProjection` never does. The migration footgun is then
**structurally absent** — a projection produces no new `pgTable`, so there is nothing to export into a
drizzle-kit barrel and nothing to migrate. A consumer-side guard (e.g. "no `readProjection` entry's local
table appears in the migrated set") drops to optional belt-and-suspenders.

### 5. RLS lives on the owner, not the projection

A projection adds no DDL to a table it does not own. The owner's physical table must carry an RLS policy
permitting the projection's reads (e.g. an admin offering→org `SELECT` branch), authored in the owner's
`extras`. The projection's `customWhere` must be a subset of what that RLS allows — read and write
authority still derive from the same columns (ADR-0019).

## Consequences

- **DX:** the call site reads as what it is ("a read projection of this table"); the source is never
  hand-named; columns are reused; readonly is implied; the footgun is removed by construction.
- **Implementation note:** the combinator builds the local table + base shape via `defineSyncTable` (reusing
  the owner's `makeColumns`, kept on the entry as an internal field), then replaces `table` with the
  owner's and sets `shape.electricTable` + `readProjection`. Reshaping past the spread requires one
  documented cast at that boundary — the runtime is exercised by the proxy + combinator unit tests.
- **Minor cost:** a subset projection sets both the Electric `columns` allow-list (so heavy columns aren't
  fetched) and `omitColumns` (so client metadata is the subset); the response-path strip then runs as a
  no-op. A future optimisation could skip the strip when an allow-list already excludes the columns.
- **Scope (v1): readonly projections only.** A second *writable* shape over one physical table is out of
  scope (it would need its own write-unit/apply story, ADR-0022) and is deferred until a use case appears.
- **Consumer (emergent):** unblocks a light `assessment_definition` admin-summary entry → the LTI AGS
  line-item panel becomes sync-native with real titles, no heavy jsonb to admins, no learner resync.

## Alternatives considered

- **Status quo: bare `shape.electricTable` string.** Rejected — footgun, and it did not work (the engine
  resolved by physical target).
- **Single shared entry, widened `customWhere` for admins.** Works for *light* tables (the `offering`
  precedent) but cannot give one client a different column set than another (the projection is per-entry,
  not per-client), so it would ship the heavy jsonb to admins and force a learner resync on the revision
  bump. Does not generalise.
- **Co-located `readProjections` inside `defineSyncTable`.** Bloats the owner constructor; each projection
  is its own registry entry anyway. Rejected.
- **Method form `owner.readShape({ … })`.** Viable, arguably more obvious; rejected for consistency with
  the free-function `asReadonly(entry)`.
- **A settable source field "for the manual case."** Rejected — there is no valid manual case; a nicer
  name for a footgun is still a footgun.
