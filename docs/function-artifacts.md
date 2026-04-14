# Sync Function Artifacts

This document defines how to manage SQL artifacts required by WRITE_API_BACKEND=bulk-plpgsql-artifact.

## Required function

1. Function name: public.pgxsinkit_apply_batch_mutations
2. Signature: (jsonb, text, boolean, boolean, jsonb)
3. Purpose: apply full batch payload inside PostgreSQL using one entry function, with optional RLS auth context propagation.

## RLS contract for artifact mode

1. When any registry table enables governance RLS, the artifact backend expects validated JWT claims from the server runtime.
2. The write API must provide claims through createSyncServer resolveAuthClaims so the batch function can call auth.set_auth_context(claims).
3. If RLS is enabled and claims are missing/invalid, POST /api/mutations returns 401.
4. Governance migrations generate Supabase-compatible auth helpers when RLS is enabled:
   - auth.set_auth_context(claims jsonb)
   - auth.uid()
   - auth.jwt()
5. The write API enriches batch payloads with ownership/audit fields only when the target table declares those columns, avoiding invalid-column writes for unrelated tables.

## Artifact location

1. Generated artifact file:
   - infra/sql/functions/pgxsinkit_apply_batch_mutations.sql
2. Source inputs:
   - packages/demo/src/registry.ts
   - packages/server/src/mutations/bulk/plpgsql-strategy.ts

## Commands

1. Generate artifact SQL from current registry and strategy:
   - bun run sync:function:generate
2. Apply artifact SQL to DATABASE_URL:
   - bun run db:apply:sync-function
3. Verify function exists with the expected signature:
   - bun run db:verify:sync-function
4. For RLS-enabled registries, apply governance SQL before starting artifact mode:
   - bun run db:apply:governance

## Update workflow

1. Modify registry or mutation strategy.
2. Regenerate artifact SQL.
3. Commit the regenerated artifact in the same PR as code changes.
4. Apply migrations in target environment.
5. Apply artifact SQL in target environment.
6. Verify function installation.
7. Deploy write-api in bulk-plpgsql-artifact mode.

## Promotion expectations

1. Staging and prod should use the same artifact backend mode before promotion.
2. Do not rely on startup runtime generation for artifact mode.
3. Treat artifact SQL as deployable infrastructure code.

## Failure modes

1. Missing function:
   - Symptom: write-api startup fails verification for bulk-plpgsql-artifact.
   - Resolution: apply artifact SQL, then rerun verification.
2. Missing governance auth helpers:
   - Symptom: POST /api/mutations returns a clear 500 about missing auth.set_auth_context/auth.uid/auth.jwt.
   - Resolution: apply governance SQL, then retry the request.
3. Drift between code and artifact:
   - Symptom: behavior mismatch after deployment.
   - Resolution: regenerate artifact, apply again, rerun contract tests.
4. Deferred constraints not effective:
   - Symptom: FK violations despite artifact backend.
   - Resolution: ensure relevant FKs are declared DEFERRABLE in migrations.
