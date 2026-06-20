# Sync Function Artifacts

This document defines how to manage the SQL artifact for the write path's in-database apply function.
There is one write path (see [adr/0002](adr/0002-single-in-database-write-path.md)); this function is
always required.

## Required function

1. Function name: public.pgxsinkit_apply_mutations
2. Signature: (jsonb, text, boolean, boolean, jsonb)
3. Purpose: apply a full batch payload inside PostgreSQL using one entry function, with optional RLS
   auth context propagation.

## RLS contract

1. When any registry table enables governance RLS, the apply function expects validated JWT claims
   from the server runtime.
2. The write API must provide claims through `createSyncServer` `resolveAuthClaims` so the apply
   function can validate them.
3. If RLS is enabled and claims are missing/invalid, POST /api/mutations returns 401.
4. The write API enriches batch payloads with ownership/audit fields only when the target table
   declares those columns, avoiding invalid-column writes for unrelated tables.

## Artifact location

1. Generated sync-function migration:
   - infra/drizzle/\*\_sync_artifact/migration.sql
2. Source inputs:
   - packages/schema/src/registry.ts
   - packages/server/src/mutations/plpgsql-apply.ts

## Commands

1. Generate the function SQL from the current registry:
   - bun run sync:function:generate
   - This creates a custom migration under infra/drizzle/.
2. Generate governance migration SQL when DEFERRABLE constraints or conditional grants change:
   - bun run db:generate:governance
   - Commit the generated infra/drizzle/\*\_registry_governance migration alongside the schema/registry change.
3. Ensure the latest committed schema, governance, and sync-function migrations have been applied
   before starting the write API:
   - bun run db:migrate

## Update workflow

1. Modify the registry or the apply function source.
2. Regenerate the function SQL.
3. Generate a governance migration too if registry governance changed.
4. Commit the regenerated migration and any new governance migration in the same PR as code changes.
5. Apply migrations in the target environment.
6. Deploy write-api.

## Promotion expectations

1. Staging and prod use the same committed function migration before promotion.
2. Do not rely on startup runtime generation.
3. Treat the function SQL as deployable infrastructure code.

## Failure modes

1. Missing function:
   - Symptom: write-api startup fails verification for pgxsinkit_apply_mutations.
   - Resolution: apply the latest committed migrations, then restart the service.
2. Missing governance auth helpers:
   - Symptom: POST /api/mutations returns a clear 500 about missing auth.uid/auth.jwt.
   - Resolution: ensure the environment bootstrap provides Supabase-compatible auth helpers, then retry the request.
3. Drift between code and the function migration:
   - Symptom: behavior mismatch after deployment.
   - Resolution: regenerate the sync-function migration, apply the latest migrations, and rerun contract tests.
4. Deferred constraints not effective:
   - Symptom: FK violations despite the apply function running.
   - Resolution: ensure relevant FKs are declared DEFERRABLE in migrations.
