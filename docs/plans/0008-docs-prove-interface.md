# Plan — ADR-0008: Documentation proves the product interface

Implements [ADR-0008](../adr/0008-docs-prove-interface.md). Goal: a packed
downstream fixture as the doc source of truth, a gate that notices drift, and the
standing contradictions fixed.

Depends on: coordinates with [ADR-0007](../adr/0007-absorb-sync-engine.md) (package
topology) and [ADR-0006](../adr/0006-local-schema-evolution.md) (registry-diff
check in the check surface).

## Phase 1 — Cheap fixes now (independent of the fixture)

- `README.md:80` — correct release wording to match
  [ADR-0001](../adr/0001-unified-ts-release-versioning-tooling-standard.md)
  (tag-derived, no bump).
- `docs/architecture.md:3` — reconcile "four boundaries" vs the three headings.
- Remove `@pgxsinkit/sync-engine` from the getting-started install list (ADR-0007)
  and reconcile the direct-install-vs-transitive contradiction on the packages page.
- The five missing READMEs: either remove `README.md` from those `files` arrays or
  (preferred) generate package READMEs at packaging time from one template +
  manifest. Pick one and apply consistently.
- Include or intentionally exclude `sync-engine`/`pglite-sync` from the generated
  reference, consistently with ADR-0007.

## Phase 2 — Downstream fixture as source of truth

- A minimal consumer fixture (its own tiny workspace) that: defines a registry,
  stands up `createSyncServer` + `createSyncClient`, and runs a read+write
  round-trip.
- Pack the public packages locally (`bun pm pack` / the release tarballs) and
  install them into the fixture so the test exercises the **published** surface
  (`exports`/`types`/`main`), not the source.
- Smoke-test the offline-capable parts in CI; the DB/Electric round-trip stays in
  the integration lane.

## Phase 3 — Gate learns to notice drift

- Add a docs-site build step to CI.
- Add the packed-fixture smoke test to CI.
- Wire the ADR-0006 `registry-check` into the consumer-facing check surface (advisory
  here; the consumer decides blocking).

## Phase 4 — `target: "bun"` investigation

- Determine whether `scripts/build-public-packages.ts:88` `target: "bun"` produces
  output correctly consumable by a Vite / React Native downstream, using the
  packed-fixture smoke test. If not, switch the browser packages to a
  browser/neutral target. Decide with evidence, not assumption.

## Acceptance

- Standing contradictions fixed; getting-started reflects reality; the five package
  READMEs exist. **(Phase 1 done)**
- A packed-fixture smoke test proves the published install path; CI builds the docs.
  **(Phases 2–3 — deferred; need packing the built artifacts + a CI/docs-build step)**
- `target` decision made on fixture evidence. **(Phase 4 — deferred; depends on the
  fixture)**
