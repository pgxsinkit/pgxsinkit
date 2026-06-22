# Plan — ADR-0004: One registry interpreter

Implements [ADR-0004](../adr/0004-one-registry-interpreter.md). Goal: a single
identifier/literal resolver, a registry fingerprint primitive, and `rowTransform`
relocated out of the client-named bucket.

Depends on: nothing. Unblocks: [ADR-0006](../adr/0006-local-schema-evolution.md)
(fingerprint).

## Phase 1 — One identifier/literal resolver

- New module in `packages/contracts/src` (e.g. `sql-identifier.ts`) owning:
  - the canonical "simple identifier" definition (one regex),
  - the `RESERVED_SQL_KEYWORDS` set,
  - `quoteIdentifier`, `maybeQuoteIdentifier`, `qualifyIdentifier(schema, name)`,
  - `quoteSqlStringLiteral` / literal escaping.
- Delete and re-route the divergent copies:
  - `client/src/schema.ts:379,473,482,486` + its local `RESERVED_SQL_KEYWORDS`.
  - `client/src/mutation.ts:1783,1791` (**fixes** the latent public-schema bare-name
    bug — qualify must quote-when-needed, not return bare).
  - `server/mutations/plpgsql-apply.ts:15`.
  - `schema/governance.ts:126`, `schema/performance.ts:385`.
  - `contracts/supabase-rls.ts:52` — reconcile its identifier definition (it allows
    uppercase and _throws_); decide one rule and route through the shared module
    (assert-helpers may stay, but on the shared "simple identifier" definition).
- Tests: a focused unit suite for the resolver, incl. reserved words (`group`,
  `order`), uppercase, dotted qualification, and embedded quotes. Add a regression
  test that a reserved-word table name round-trips through the mutation path.

## Phase 2 — Registry fingerprint

- New `fingerprintRegistry(registry)` in `contracts` → a stable hash over the
  shape-relevant fields (table keys, column names/types/array dims/enums, primary
  keys, local primary keys, projection, omitted columns, governance/managed
  fields). Order-independent; excludes functions (`rowTransform`, `customWhere`) and
  cosmetic fields.
- Tests: identical registries → identical fingerprint; any shape change → different;
  reordering keys → same.
- This is the primitive ADR-0006 stamps onto journal entries and diffs.

## Phase 3 — Relocate `rowTransform`

- Move `rowTransform` (and `RowTransformContext`) from `clientProjection` to a
  server-projection concept in `contracts/src/config.ts` /
  `contracts/src/registry.ts`.
- Update consumers: `server/electric-proxy.ts:144`, the registry types, and tests
  (`tests/unit/electric-proxy.test.ts` `secureItemsRegistry`).
- No legacy: rename cleanly; no compatibility alias.

## Acceptance

- One resolver; the five copies gone; reserved-word regression test green.
- `fingerprintRegistry` stable and shape-sensitive, with tests.
- `rowTransform` no longer under a client-named key; validate green.
