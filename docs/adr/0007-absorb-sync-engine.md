# Absorb sync-engine into the client

Status: accepted (2026-06-22)

`packages/sync-engine` is a single 165-line `index.ts`. Its only product caller is
`client/src/index.ts:21` (`apps/web/vite.config.ts:13` is a build alias, not a
consumer). Its only adapter is `@pgxsinkit/pglite-sync`. `docs/architecture.md:13`
calls it a narrow wrapper kept as "a stable place to layer retries,
instrumentation, and version-specific patches later."

One caller, one adapter — the seam is hypothetical. Deleting the package moves its
small implementation into the single caller; it does not spread complexity across
callers (the deletion test marks it shallow). It nonetheless costs a published
package, build/release ordering, and docs surface — and `getting-started.md:33`
tells consumers to install it directly while the packages page calls it transitive.

## Decision

1. **Absorb sync-engine's shape-orchestration into `@pgxsinkit/client`** as an
   internal module. Stop publishing `@pgxsinkit/sync-engine`.

2. **Keep the vendored Electric implementation (`@pgxsinkit/pglite-sync`) as the
   internal sync adapter.** That vendoring boundary against upstream churn is real
   and stays. What collapses is the redundant package *wrapper*, not the adapter.

3. **Re-establish the seam only when it becomes real.** If a second real caller or
   a second sync adapter appears, reintroduce the seam then — one adapter makes a
   seam hypothetical; two make it real.

4. **Update docs and install instructions** (the getting-started install list, the
   packages page, the generated reference) to drop sync-engine as a consumer-facing
   package. (Coordinated with [ADR-0008](0008-docs-prove-interface.md).)

## Consequences

- One fewer published package, build step, and docs-drift source.
- `client` depends directly on the vendored adapter — acceptable, since the adapter
  is the thing with real value and the wrapper added none.
- The "retries/instrumentation later" rationale is preserved: that work now lands
  in the client's internal module and aligns with
  [ADR-0005](0005-mutation-convergence.md)'s convergence driver, without a
  standalone package.

## Implementation status

Done. `packages/sync-engine/src/index.ts` moved to
`packages/client/src/shape-sync.ts` (an internal module of the client); `client`
imports it directly and depends on the vendored `@pgxsinkit/pglite-sync` in place of
the removed wrapper. The `@pgxsinkit/sync-engine` package is deleted — dropped from the
build/release list (`scripts/build-public-packages.ts`), the tsconfig path map, and the
`apps/web` dependency + Vite alias (it was never imported in `apps/web/src`). The unit
test became `tests/unit/shape-sync.test.ts`; the integration harnesses and the
client-reset mock import the internal module directly. Nothing of the wrapper is
re-exported from `@pgxsinkit/client`'s public surface. Install-doc updates ride with
[ADR-0008](0008-docs-prove-interface.md).

References: [ADR-0005](0005-mutation-convergence.md) (where retries/instrumentation
land); [ADR-0008](0008-docs-prove-interface.md) (docs/install updates);
[docs/plans/0007-absorb-sync-engine.md](../plans/0007-absorb-sync-engine.md).
