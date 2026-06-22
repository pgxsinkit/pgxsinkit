# Documentation proves the product interface

Status: accepted (2026-06-22); implemented

`getting-started.md` is narrative, not executable for a downstream consumer: step 1
("define your registry") has no code, step 3 mentions `createSyncServer` inline with
no example, and the only runnable commands are repo-workspace scripts —
`bun run sync:function:generate` (`:52`), `infra:up`/`dev:api`/`dev:web` (`:77-79`)
— none of which exist after `bun add`.

The drift is broader. Six manifests list `README.md` in `files`; only
`packages/pglite-sync/README.md` exists. `README.md:80` says release is
"bump → tag → publish", contradicting [ADR-0001](0001-unified-ts-release-versioning-tooling-standard.md)
(tag-derived, no bumps). The install list tells users to add
`@pgxsinkit/sync-engine` (removed by [ADR-0007](0007-absorb-sync-engine.md)).
`architecture.md:3` says "four boundaries" but lists three headings. The generated
reference excludes `sync-engine`/`pglite-sync` though both were published. `dist` is
untracked, and nothing packs and imports the published artifacts, so wrong
`exports`/`types`/`main` — or a `target: "bun"` browser-bundling problem
(`scripts/build-public-packages.ts:88`) — would pass `validate`. The root
`validate`/`check` chain (`package.json:42`, `:11`) never builds the docs site, so
all of this drifts invisibly.

## Decision

1. **One minimal downstream example is the documentation's source of truth.** A
   tiny consumer fixture defines a registry, stands up server + client, and runs a
   read+write round-trip. It is compiled, packed against the released (or
   locally-packed) artifacts, and smoke-tested. `getting-started` and the package
   READMEs are derived from — or verified against — it.

2. **The validate gate learns to notice drift.** Add a docs-build step and the
   packed-fixture smoke test (the offline-capable parts) to CI, and wire the
   [ADR-0006](0006-local-schema-evolution.md) registry-diff check into the
   consumer-facing check surface. Heavy DB/Electric parts stay in the integration
   lane.

3. **Fix the standing contradictions now** (cheap, independent of the fixture):
   correct the README release wording to match ADR-0001; generate-or-remove the
   five missing READMEs (prefer generating package READMEs at packaging time from
   one template + manifest); drop sync-engine from the install list (ADR-0007); fix
   "four boundaries / three headings" and the sync-engine direct-install vs
   transitive contradiction; include or intentionally exclude
   `sync-engine`/`pglite-sync` from the generated reference, consistently.

4. **Investigate `target: "bun"` for the browser packages** (`react`/`client`/
   `pglite-sync`): confirm whether the published output is correctly consumable by a
   Vite / React Native downstream, or whether a browser/neutral target is required.
   Decide based on the packed-fixture smoke test.

## Consequences

- Onboarding becomes copy-runnable and cannot silently rot.
- Distribution correctness (`exports`/`types`/`target`) gains an executable proof.
- Maintenance cost is one small fixture plus a docs-build CI step — acceptable
  before 1.0; the alternative is shipping a broken install path.

## Implementation status

- **Decision 3 (standing contradictions) — done.** The README release wording now
  matches [ADR-0001](0001-unified-ts-release-versioning-tooling-standard.md)
  (tag-derived, no bump); `docs/architecture.md` says "three boundaries"; the
  getting-started install list and the docs packages/reference pages drop
  `@pgxsinkit/sync-engine` (removed by [ADR-0007](0007-absorb-sync-engine.md)); and the
  five `files`-declared package READMEs now exist (`contracts`, `client`, `server`,
  `react` gained minimal stubs; `pglite-sync` already had one).
- **Decisions 1, 2 (packed downstream fixture + the gate) — done.**
  `scripts/fixture-smoke.ts` (`bun run fixture:smoke`) builds the public packages, packs
  them with `bun pm pack`, installs the tarballs into a throwaway consumer workspace
  (sibling `workspace:*` deps redirected to the local tarballs via bun `overrides`), and
  runs a smoke that imports from **every** published entry point (`contracts` / `client` /
  `server` / `react`) and exercises the offline surface (registry definition →
  `generateLocalSchemaSql` → `fingerprintRegistry` → `buildRegistryLock`/`runRegistryCheck`
  → convergence driver). This proves the published `exports`/`types`/`main` and dependency
  graph, not the in-repo source. A new `docs-and-fixture` CI job builds the docs site (the
  TypeDoc API reference + Starlight) and runs the fixture smoke; neither needs
  Postgres/Electric. The committed package-README stubs are kept (generating them at
  packaging time remains a future refinement, not a correctness gap).
- **Decision 4 (`target: "bun"` investigation) — done; no change needed.** The built dist
  contains **no** `bun:` imports and **no** `node:` builtins in the browser-facing packages
  (`client` / `contracts` / `pglite-sync`); with `packages: "external"` the output is clean
  portable ESM. The fixture (run under Bun) proves Bun consumption, and the absence of
  runtime-specific imports means a Vite / React Native bundler can consume it unchanged, so
  `target: "bun"` stays.

References: [ADR-0001](0001-unified-ts-release-versioning-tooling-standard.md)
(release model); [ADR-0006](0006-local-schema-evolution.md) (registry-diff check);
[ADR-0007](0007-absorb-sync-engine.md) (package topology);
[docs/plans/0008-docs-prove-interface.md](../plans/0008-docs-prove-interface.md).
