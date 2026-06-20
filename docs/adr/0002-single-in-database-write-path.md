# Single in-database write path; retire the strategy/backend/artifact seam

Status: accepted (2026-06-19)

pgxsinkit began as a set of experiments to find the sweet spot for syncing client
writes back to Postgres. The experiments converged on a clear winner: push the
apply logic into the database and consume mutations in bulk — a single PL/pgSQL
function applies a flushed batch in one in-database call. The losing strategies
were first exiled to an `experimental/` section and have since been deleted
outright; only the winner remains.

But the *shape* of the old world survived the experiments. The one surviving path
still wore a selectable-strategy costume: a `backend` option on the server, a
`WRITE_API_BACKEND` environment knob, single-member union types
(`BulkMutationBackend`, `OpsLogBackend`), a module named `plpgsql-strategy.ts`,
and the enum-flavoured string `bulk-plpgsql-artifact` threaded through the code
and tests. Worse, `README.md` and `docs/architecture.md` still pointed readers at
`@pgxsinkit/server/experimental` and `@pgxsinkit/client/experimental` export
subpaths that no longer exist. The net effect: every reader — human or AI agent —
inferred a choice that was never there, went looking for backends and exports that
had been removed, and burned time reconstructing a model the code no longer
matched. A session even mistook the repo for emergent's data layer and tried to
add emergent migrations to the demo.

## Decision

1. **There is exactly one write path, and it is named as such.** An app stages
   write intent locally (overlay + durable journal in PGlite), the client flushes
   it through the write API, and a single in-database PL/pgSQL function applies the
   batch. This is the toolkit's central finding, not one option among several.

2. **Retire the selectable-backend seam entirely.** Remove the `backend` server
   option, the `WRITE_API_BACKEND` env var, and the single-member union types
   (`BulkMutationBackend`, `OpsLogBackend`). There is nothing to select.

3. **Purge the strategy/backend/artifact vocabulary from code and docs.** Rename
   `plpgsql-strategy.ts` to a neutral module, and rename the database function
   `pgxsinkit_apply_batch_mutations` → `pgxsinkit_apply_mutations` (a new migration
   generated via the regenerate-migrations runbook, applied on a DB reset). The
   canonical terms are now **write path** and **mutation applier** (see
   `CONTEXT.md`).

4. **Git history is the only record of the retired experiments.** No compatibility
   shims, no deprecated aliases. pgxsinkit is pre-1.0 and emergent is its only
   consumer; it adapts on the next dependency bump.

## Considered options

- **Keep the seam as documented-but-fixed** (one allowed value, clearly labelled).
  Rejected: it preserves the "one option that looks like many" smell that caused
  the confusion in the first place, for no benefit — there is no roadmap to a
  second backend.
- **Remove the seam but keep the descriptive DB function name.** Reasonable, and
  lower churn, but leaves "artifact"-era naming in the one place every operator
  reads (the function call). We chose full consistency over saving one migration.

## Consequences

- Breaking API change for the published `@pgxsinkit/server` package (the `backend`
  option and `WRITE_API_BACKEND` disappear). Acceptable pre-1.0.
- The function rename requires a regenerated migration; the DB reset/apply step is
  the maintainer's, per the migrations runbook.
- `README.md`, `docs/architecture.md`, and the new docs site describe a single
  write path with no selector; the stale `experimental/*` references are removed.
