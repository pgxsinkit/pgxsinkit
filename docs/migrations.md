# Migration Workflow

This document defines the canonical path from Drizzle table definitions to provisioned dev, staging, and prod databases with sync-ready support functions.

## Ownership model

1. Drizzle schema files own relational structures (tables, columns, indexes):
   - packages/demo/src/schema.ts
   - packages/server/src/operations-log/schema.ts
2. Drizzle migration SQL in drizzle/ is the deployable history for schema changes.
3. Sync support functions for bulk-plpgsql-artifact are SQL artifacts generated from the registry and committed to infra/sql/functions/.
4. Runtime startup checks in the write API verify prerequisites, but are not the primary deployment mechanism for staging/prod.

## End-to-end workflow

1. Edit schema sources.
2. Generate migration SQL.
   - Command: bun run db:generate
3. Generate governance migration SQL from typed registry metadata when needed.
   - Command: bun run db:generate:governance
   - If the generated SQL matches the latest governance migration for the same name, the command skips creating a new migration directory.
4. Review generated migration SQL under drizzle/.
5. Regenerate sync function artifacts when registry or mutation strategy changes.
   - Command: bun run sync:function:generate
6. Commit schema files, migration SQL, registry metadata changes, and function artifacts in one changeset.
7. Apply migrations to target database.
   - Dev/local: bun run db:push
   - Staging/prod: apply the same migration set via your deployment runner.
8. Apply governance SQL when auth helpers / RLS policies are required and not already provisioned by your environment bootstrap.
   - Command: bun run db:apply:governance
9. For bulk-plpgsql-artifact deployments, apply function artifact SQL.
   - Command: bun run db:apply:sync-function
10. Verify artifact function is installed before starting write-api in artifact mode.

- Command: bun run db:verify:sync-function

11. Start write-api with backend matching provisioned state.
    - Example: WRITE_API_BACKEND=bulk-plpgsql-artifact bun run dev:api
12. If governance RLS is enabled for any registry table, provide validated JWT claims to createSyncServer via resolveAuthClaims.
13. Expect POST /api/mutations to return 401 in artifact mode when RLS is enabled but claims are missing.
14. Expect POST /api/mutations to return a clear 500 about missing auth helpers when governance SQL has not been applied.
15. Run validation and integration checks.
    - Commands:
      - bun run format-check
      - bun run lint-check
      - bun run typecheck
      - bun run test:integration:contract
      - bun run test:integration:implementation

## Current auth and ownership migrations

1. The ownership/audit rollout is represented in schema migrations with:
   - owner_id and modified_by on authors and todos
   - user_id and index on operations_log
2. Governance migration generation now emits:
   - Supabase-compatible auth helper functions
   - best-effort authenticated role bootstrap
   - RLS policies for demo tables using owner or admin checks
3. If role switching is not permitted in a target environment, auth helper SQL falls back gracefully and still sets JWT claim settings used by auth.uid()/auth.jwt().

## Environment rollout contract

1. Dev:
   - Use bun run infra:up to bootstrap infra, apply schema, and apply the latest committed governance migration.
   - Prefer bulk-plpgsql for iteration speed, or bulk-plpgsql-artifact when validating prod parity.
2. Staging:
   - Apply the exact migration set intended for prod.
   - Apply and verify sync function artifact if staging uses artifact backend.
   - Run contract integration suite before promotion.
3. Prod:
   - Apply migrations first.
   - Apply and verify sync function artifact.
   - Deploy write-api with WRITE_API_BACKEND=bulk-plpgsql-artifact.
   - Keep staging and prod backend modes aligned.

## Deferred constraint requirement

1. The artifact backend transaction path executes SET CONSTRAINTS ALL DEFERRED.
2. This only affects constraints declared DEFERRABLE in PostgreSQL.
3. The todos->authors FK DEFERRABLE migration is generated from typed registry governance metadata via `bun run db:generate:governance` and is included in the latest `drizzle/*_registry_governance/migration.sql`.

## Supabase-compatible auth helpers

1. Governance generation emits auth helper SQL when any governance RLS config is enabled.
2. The artifact batch function calls validates claims when p_rls_enabled=true.

## Proof coverage

1. Integration test coverage now includes out-of-order parent/child batch writes in:
   - tests/integration/write-api.integration.test.ts
2. Expected behavior is asserted for both backends:
   - bulk-plpgsql: fails and rolls back with immediate constraint checks.
   - bulk-plpgsql-artifact: succeeds with deferred checks under DEFERRABLE FK.

## Remaining implementation steps

1. Add CI checks to fail when function artifacts are stale relative to registry/strategy changes.
2. Add a release runbook for rollback behavior after partial deployment failures.
