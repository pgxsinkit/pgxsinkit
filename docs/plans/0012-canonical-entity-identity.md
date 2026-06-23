# Plan — ADR-0012: Canonical entity identity and a composite-PK-correct applier

Implements [ADR-0012](../adr/0012-canonical-entity-identity.md). Goal: collapse the
write-path row identity onto **one canonical Entity identity** — the table's server
primary-key columns, by column name, with typed values — so the wire mutation, the
in-database applier, the local journal/overlay keys, and `entity_key_json` all name a row
the same way, and the applier matches on the **full PK tuple** instead of `columns[0]`.

This is the foundational item: [ADR-0011](../adr/0011-convergence-model.md) keys on a single
canonical identity, and [ADR-0010](../adr/0010-convergence-barrier.md)'s barrier resolves on
it. Build it first.

Depends on / coordinates with: [ADR-0004](../adr/0004-one-registry-interpreter.md) (the
shared registry interpreter / `sql-identifier` resolver and the property↔column mapping),
[ADR-0011](../adr/0011-convergence-model.md) (the Convergence model that assumes this single
identity), [ADR-0010](../adr/0010-convergence-barrier.md) (built next, on top of this
applier). Pre-launch: no persisted-data migration (no-legacy rule).

Each phase ends `validate`-green; the composite-PK and property≠column applier proofs run in
the Podman integration lane against real Postgres.

## Phase 1 — One canonical identity at the boundary (client)

- Add a single boundary mapper: the public `update(table, entityKey, patch)` /
  `delete(table, entityKey)` API stays **property-keyed** for drizzle ergonomics and maps to
  the canonical **column-keyed, typed** identity exactly once, at the entry boundary — the
  same place `toSqlColumnPayload` already maps the payload. Reuse the ADR-0004
  property↔column resolver; do not hand-roll a second mapping.
- Make `entity_key_json` a faithful serialization of the canonical identity (column-named),
  no longer built from `pkPropertyKeys`. Sweep **every** `entity_key_json` producer and
  consumer in `mutation.ts` (enqueue, `readPendingBatchRows`, `reconcileTable`, dedupe,
  overlay/journal keying) so nothing past the boundary is keyed by property name.
- No public-interface change; the property-keyed API surface is unchanged.
- Tests: a table whose drizzle **property name differs from its column name** — assert the
  staged `entity_key_json` is column-keyed and the overlay/journal rows key on the column,
  not the property (the latent NULL-match bug from ADR-0012 decision 1).

## Phase 2 — Composite-PK-correct applier (server)

- In `packages/server/src/mutations/plpgsql-apply.ts`, rewrite `buildTableBranch` so the
  generated `update`/`delete` `WHERE` is built over **every** server PK column, each with its
  own type cast derived from the registry (`getSQLType()`, the same source `create` already
  uses) — delete the `primaryKey.columns[0]` shortcut.
- The applier reads each PK component from the canonical (column-keyed) entity key
  (`v_entity_key->>'<columnName>'::<type>`), which Phase 1 guarantees is column-named.
- `create` is unchanged (it already inserts the full projected payload).
- Keep the per-row branch shape for now (set-based apply is [ADR-0014](../adr/0014-bulk-apply-ordering-safety.md));
  this phase only fixes correctness of the match, not the apply strategy.

## Phase 3 — Registry validation: the identity is the server PK

- For a writable table the Entity identity is `entry.primaryKey` (the **server** PK), never
  `clientProjection.localPrimaryKey` — the applier targets the server table.
- Add a registry-validation rule (in the ADR-0004 interpreter's validation surface): reject a
  writable table whose **local synced projection omits a server PK column** (it would break
  the overlay↔synced join and the ADR-0011 sync-state view's identity), and reject a writable
  table whose `localPrimaryKey` diverges from the server PK identity. An intended, reviewable
  break (no-legacy, pre-launch).
- Tests: a writable table missing a server PK column from its projection is rejected; a
  writable table with a divergent `localPrimaryKey` is rejected.

## Phase 4 — Proofs

- Unit: the property≠column resolution (Phase 1) and the registry-validation rejections
  (Phase 3) against the PGlite/registry harness.
- Integration (Podman, real Postgres): a **composite-PK writable fixture** (two-column PK)
  with an `update` and a `delete`, asserting **exactly one** server row is affected — the core
  regression for Phase 2. The same fixture proves end-to-end that the client composite-PK
  half (already emitted by `schema.ts`) and the server applier now agree.

## Acceptance

- One canonical Entity identity (server PK, column-named, typed) everywhere past the API
  boundary; the public API stays property-keyed and maps once.
- `entity_key_json` is a faithful column-keyed serialization; no `mutation.ts` path keys by
  property name.
- The applier's `update`/`delete` `WHERE` covers the full PK tuple with per-column casts;
  `columns[0]` is gone.
- A composite-PK writable table updates/deletes exactly one server row; a property≠column PK
  resolves the right row; the registry rejects a writable table missing a server PK column or
  with a divergent `localPrimaryKey`.
- `validate` green; the composite-PK and property≠column proofs green in the integration lane.
