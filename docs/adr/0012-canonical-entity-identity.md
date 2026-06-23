# Canonical entity identity and a composite-PK-correct applier

Status: accepted (2026-06-23)

The write path identifies the row a mutation targets by an **entity key**. Tracing it exposed two
defects that the Convergence model ([ADR-0011](0011-convergence-model.md)) cannot tolerate, because
that model keys on a single canonical identity:

1. **The in-database applier is not composite-PK correct.** `buildTableBranch`
   (`packages/server/src/mutations/plpgsql-apply.ts:67`) takes `primaryKey.columns[0]` and builds the
   update/delete `WHERE` on **only the first PK column**. The client half already supports composite
   PKs — `schema.ts` emits `PRIMARY KEY (a, b)` and the overlay/journal/reconcile key on **all**
   `pkColumnNames` — so a writable composite-PK table is half-built: a client-side composite PK that
   the server applies against one column, matching too many rows. `create` is unaffected (it inserts
   the full projected payload); only update/delete are wrong.

2. **The identity is keyed inconsistently across the wire.** The mutation payload is sent
   **column-keyed** (`toSqlColumnPayload`), but the entity key is sent **property-keyed**
   (`entity_key_json` built from `pkPropertyKeys`), while the applier reads it by **column name**
   (`v_entity_key->>'<columnName>'`). For any table where the drizzle property name differs from the
   column name this silently reads NULL and matches no row — invisible today only because the sole
   tested writable PK is `id` (property == column).

Both are foundational for ADR-0011: a Convergence model that keys on a canonical PK tuple cannot be
built on an identity that is sometimes property-named, sometimes column-named, and only ever matched
on its first column.

## Decision

1. **Define one canonical Entity identity: the table's server primary-key columns, by column name,
   with typed values.** It is the same in every representation — the wire mutation, the in-database
   applier, the local journal/overlay PK columns (already column-named), and `entity_key_json` (which
   becomes a faithful serialization of the canonical identity, no longer property-keyed). The public
   `update(table, entityKey, patch)` / `delete(...)` API stays **property-keyed** for drizzle
   ergonomics and maps to the canonical form **once, at the entry boundary** (the single place
   `toSqlColumnPayload` already maps the payload). Past that boundary, nothing is keyed by property
   name.

2. **Complete the applier to operate over the full PK tuple.** The generated update/delete `WHERE` is
   built over **every** server PK column, each with its own type cast derived from the registry (the
   same `getSQLType()` source `create` already uses) — not `columns[0]`. This finishes the half-built
   composite-PK capability rather than gating it (chosen over rejecting composite-PK writable tables:
   rejecting a capability the client half already implements is the worse footgun).

3. **The Entity identity is the server primary key, and a writable table's local projection must carry
   it.** For a writable table the identity is `entry.primaryKey` (the server PK), because the applier
   targets the server table — never the client `clientProjection.localPrimaryKey`. Registry validation
   rejects a writable table whose local synced projection omits a server PK column (it would break the
   overlay↔synced join and the sync-state view's identity). This keeps the journal, overlay, read
   model, applier, and the ADR-0011 sync-state view all keyed on the same identity.

## Consequences

- Writable composite-PK tables work end-to-end; the latent property≠column single-PK bug is fixed by
  the same canonicalization (decision 1), for free.
- ADR-0011's Convergence model has the single canonical identity it assumes; the sync-state view and
  the resolver key on the same columns as the journal/overlay/applier.
- Cost: touches every `entity_key_json` producer/consumer in `mutation.ts` plus the public-API
  boundary map, and the applier's `WHERE` generation. Pre-launch, so no persisted-data migration
  (no-legacy rule).
- A new registry-validation rule can reject existing writable tables whose `localPrimaryKey` diverges
  from the server PK identity (an intended, reviewable break).

## Proving it

- A composite-PK writable fixture (two-column PK) with an update and a delete asserting **exactly one**
  server row is affected — the core regression for decision 2.
- A writable table whose PK property name differs from its column name, asserting the entity key still
  resolves the right row — the latent bug from decision 1.
- A registry-validation test rejecting a writable table whose local projection omits a server PK column.

References: `CONTEXT.md` (Entity identity, Mutation applier, Mutation journal, Overlay);
[ADR-0011](0011-convergence-model.md) (the Convergence model that depends on a single canonical
identity); [ADR-0004](0004-one-registry-interpreter.md) (registry-driven generation; the property↔column
mapping resolver); [ADR-0010](0010-convergence-barrier.md) (the barrier keys on this identity);
`tmp/agents/sync-system-improvement-worklog.md` (ISS-02).
