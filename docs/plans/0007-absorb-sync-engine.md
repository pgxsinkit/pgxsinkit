# Plan — ADR-0007: Absorb sync-engine into the client

Implements [ADR-0007](../adr/0007-absorb-sync-engine.md). Goal: remove the
`@pgxsinkit/sync-engine` published package; move its shape-orchestration into
`@pgxsinkit/client` as an internal module; keep `@pgxsinkit/pglite-sync` as the
internal adapter.

Depends on: best sequenced after/with [ADR-0005](../adr/0005-mutation-convergence.md)
(retries/instrumentation land in the client's internal module) and coordinated with
[ADR-0008](../adr/0008-docs-prove-interface.md) (install/docs updates).

## Steps

1. Move `packages/sync-engine/src/index.ts` into `packages/client/src/` as an
   internal module (e.g. `shape-sync.ts`); it keeps importing `@pgxsinkit/pglite-sync`.
2. Update `client/src/index.ts:21` to import from the internal module instead of
   `@pgxsinkit/sync-engine`. Re-export only what is genuinely public (likely
   nothing — it was a wrapper).
3. Remove the `packages/sync-engine` package: delete the directory, drop it from the
   workspace, build ordering (`scripts/build-public-packages.ts`), release config,
   and `apps/web/vite.config.ts:13` alias.
4. Update docs/install (ADR-0008): drop `@pgxsinkit/sync-engine` from the
   getting-started install list and the packages page; reconcile the generated
   reference.
5. Verify the published surface: `@pgxsinkit/client` no longer lists sync-engine as
   a dependency; the demo and integration lanes build and pass.

## Acceptance

- `@pgxsinkit/sync-engine` no longer exists or publishes; `client` owns the
  orchestration internally over the vendored adapter; validate + integration green;
  no doc references a consumer-facing sync-engine package.

## Note

If a second sync adapter or external caller emerges, reintroduce the seam
deliberately — do not pre-empt it now.
