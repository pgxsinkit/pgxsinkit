# Content-addressed validate caching and per-file unit-test selection

Status: accepted (2026-07-24)

## Context

The pre-commit gate (`validate` → `check:fast`) runs a full typecheck, full oxlint, and a
hand-curated ~80-file `test:unit:fast` subset on **every** commit, including doc-only ones. Worse,
across a single unit of work the same green unit tests execute 3–4 times: individual `bun test` runs,
then `validate`, then `validate:full`, then the commit hook re-running `validate`. Nothing remembers
that an identical working tree already passed. With 130 PGlite/WASM-heavy unit files, this is a
significant velocity drag.

Turbo — used in the sibling repos to cache validation and keep a full guard in the commit hook — does
not fit here: it caches at **task** granularity, but pgxsinkit's tests are centralized in `tests/**`
and import across every workspace package, so there is no per-package test task to hash and splitting
tests per package would fracture genuinely cross-package suites.

## Decision

Reimplement turbo's semantics — *fingerprint the inputs, skip the stage if an identical fingerprint
already passed* — at the granularity that fits this repo, as pgxsinkit-local tooling (ADR-0001, the
immutable cross-repo standard, is unchanged; this is merely a better *implementation* of its "keep
`validate` quick" rule).

1. **Content-addressed, not diff-based.** Fingerprints hash the *working-tree contents* of a stage's
   inputs (via `sha256`), so repeated identical runs dedup and dirty/rebased/amended trees are handled
   correctly. Git-diff-vs-HEAD selection is rejected — it assumes HEAD was green and cannot dedup a
   tree it already ran seconds ago.

2. **A `run-if-changed` wrapper fronts every expensive stage, each with its OWN input set.** typecheck,
   lint, electric:check, and sync:function:check are gated by the `CODE` set: `sha256` over
   `git ls-files -co --exclude-standard` (tracked **and** untracked-not-ignored) minus a tiny, auditable
   denylist (`docs/**`, `apps/docs/**`, `**/*.md`, `brand/**`, `LICENSE`, `NOTICE`). A **single global
   fingerprint is rejected**: `docs:adr:check` and `skills:validate` read files that denylist excludes
   (`docs/adr/**` and the decisions page; `packages/*/skills/**/SKILL.md`), so a shared fingerprint
   would false-green the very change those stages exist to catch. Instead each validator hashes exactly
   what it reads — for `skills`, that includes the latest **git tag**, since its pin check compares to
   the tag (a non-file input no content hash would otherwise capture). `CODE` stays fail-closed
   (forgetting to denylist something irrelevant only skips less); the validators' risk is under-listing
   their inputs, caught by the uncached CI/`validate:refresh` run.

3. **The test stage additionally gets per-file selection.** Each `tests/unit/*.test.ts` is
   fingerprinted over its transitive import closure plus global inputs (`tests/support/**`, `bun.lock`,
   `bunfig.toml`, the runner + selector scripts, tsconfigs, `mise.toml`). A file whose fingerprint
   already passed is skipped; the rest feed the existing `run-unit-tests.ts` sharder. The curated
   `test:unit:fast` list is **retired** — selection replaces it, so `validate` now guards the whole
   suite (including the ~50 files never gated before) while running only what a change can affect. A
   green entry is written **only** by `select-unit-tests.ts`, and **only** for a file that ran in full —
   the whole file, with no `bun test` narrowing (`-t`/`--only`/`--shard`/`--changed`), inside a shard
   that exited 0. The raw `run-unit-tests.ts` and ad-hoc `bun test <file> -t …` write nothing: a passing
   subset must never certify the file.

4. **The graph is built with `Bun.Transpiler().scanImports()`** (native, no new dependency) and is
   strictly **fail-closed**: a test whose closure contains a parse failure, an unresolvable specifier,
   a computed dynamic import (detected by a textual-`import(`-count surplus, since the transpiler
   silently omits them), or a non-literal `mock.module` target is marked **ungraphable and always
   runs**. A test that reads a repo file **off-graph** (an fs *read* — not a temp write — in the test or
   a non-global closure file) must be declared in a small `fsInputs` map (today just
   `public-package-set` and `public-package-artifacts`); a new undeclared reader is force-run with a
   warning. Merely importing `node:fs` is **not** the trigger — the ~30 tests that import it only to
   write temp scratch (directly or via the global `tests/support/pglite.ts`) are graphed normally, so
   selection still pays off. Doubt always resolves to *run it*, never to *skip it*.

5. **CI is the definitive backstop; the forced run is the local one.** The cache lives in the
   gitignored `.buildcache/`; CI (`CI=true`) always runs full and uncached. Because CI fires only on
   PRs and `push: [main]` — not on the per-commit `develop` workflow — `bun run validate:refresh`
   (`PGXSINKIT_FORCE=1 bun run validate:full`: ignore cache, run everything, refresh the registry) is
   the local backstop run once per work-unit, mirroring CI before work leaves the machine. Default
   `validate`/`validate:full` stay cached for
   speed. Selection ships **active immediately**: a graph miss can only ever surface as a red CI (or
   forced-run) result, never a shipped regression.

## Consequences

- Doc-only commits and repeated identical `validate`/`validate:full`/commit-hook runs cost ~zero
  tests; the full suite executes about once per work-unit locally.
- `validate`'s first run after a real code edit runs the *affected* set, not a fixed curated subset —
  broader coverage than before on narrow edits, and it auto-picks-up new test files.
- Editing a heavily re-exported core/barrel module re-runs most of the suite (module-level closure
  granularity, deliberately conservative).
- A wrong denylist entry or a graph miss is a *local* skip that CI/forced-run still catches — the
  failure mode is "green locally, red in CI," never a false pass in `main`.
- New tooling to maintain: `scripts/run-if-changed.ts`, `scripts/select-unit-tests.ts`, the `CODE`
  denylist, each validator's per-stage input set, and the `fsInputs` map.

## Considered and rejected

- **Turbo per-package test split** — fractures cross-package suites; no within-package scoping.
- **Vitest `--changed`** — diff-based rather than cache-based; would abandon `bun test`.
- **Growing the hardcoded `test:unit:fast` list** — the status quo; drifts in both directions.
- **Coarse whole-suite caching only** (no import graph) — solves the repetition and doc-change pains
  with zero under-invalidation risk, but re-runs all 130 on any code edit; rejected in favor of
  per-file selection with coarse retained as the fallback.
- **Report-only burn-in before trusting** — rejected; it withholds the very velocity win being sought,
  and CI already provides the backstop.
