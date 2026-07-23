# Runbook: temporary `@electric-sql/pglite` fork override

**Status: TEMPORARY.** Remove once upstream `@electric-sql/pglite` releases the initdb-fs-leak fix
(upstream PR [#1060](https://github.com/electric-sql/pglite/pull/1060), from branch
`fix/initdb-inner-instance-fs-leak`) and the transaction-end sync fix (branch
`fix/transaction-end-sync`, upstream PR pending). Those two fixes are the **only** fork changes any
pgxsinkit code is allowed to depend on; see the policy section below.

## Why

An OPFS `options.fs` lane opens PGlite via `PGlite.create({ fs })`. Plain upstream
`@electric-sql/pglite@0.5.4` leaks the user-provided `fs` into the inner initdb instance, whose
second `init()` collides with resources the outer instance already holds (fatal for OPFS sync
access handles), which breaks that path on fresh stores. The maintained fix is published as `@pgxsinkit/pglite@0.5.4-pgx.11`
(dist-tag `pgx`), consumed from **public npm** (`registry.npmjs.org`). Beyond the initdb-fs-leak fix, `-pgx.5`
also carries: the `close()` drain of the
in-flight relaxed-durability sync (the uncaught `InvalidStateError` / flaky idb hang the bench exposed), and the
opfs-ahp diagnosability work — fail-fast pool init (silent wedge → catchable error), debug-gated `[opfs-ahp]`
init tracing reachable from the `opfs-ahp://` dataDir path via PGlite's `debug` option, and a
`recentSyscallErrors` ring buffer on the filesystem base class (field evidence from the storage bench). `-pgx.6`
adds the IDBFS durability hardening. `-pgx.7` adds the non-exclusive relaxed-sync rejection latch
and the transaction-end sync fix (`transaction()` previously resolved without performing or
scheduling any filesystem sync for its COMMIT/ROLLBACK); `-pgx.8` is its byte-identical republish
(the npm `-pgx.7` mirror is non-canonical — see the publishing section). `-pgx.9` completes the
transaction-end sync fix for already-closed transactions (explicit `tx.rollback()` followed by a
throwing callback; a terminal `COMMIT` that itself fails) without masking the transaction's own
error. `-pgx.10` repairs two regressions the `-pgx.6` hardening introduced (caught by this repo's
full validation lane): the raw-protocol entry points gained an unconditional await that starved
pglite-tools' synchronous pg_dump socket bridge (every `exportData`/`exportDiagnostics` failed with
"server closed the connection unexpectedly"), and the sync-failure latch also caught _awaited_
non-exclusive failures, replaying them at the next `syncToFs()` and shadowing
`pglite-opfs-repacked`'s `StoreFailedError` poison contract. The latch is now scoped to detached
relaxed syncs and the exclusive-execution lane. `-pgx.11` removes IDBFS from that exclusive lane
entirely: it had made every query — reads included — wait out the in-flight whole-FS IndexedDB
snapshot, collapsing relaxed to strict (~80ms/op measured, bulk lanes timing out). Relaxed IDBFS is
back on upstream's contract (background snapshots race queries; a crash mid-snapshot can lose the
tail), keeping the Web Locks single-owner lock, failed-init cleanup, detached-failure latch, close()
drain + final strict sync, and the distinct-mtime snapshot guard. `-pgx.11` is the version to pin.

The root `package.json` therefore aliases the dependency for the whole workspace:

```jsonc
"overrides": {
  "@electric-sql/pglite": "npm:@pgxsinkit/pglite@0.5.4-pgx.11"
}
```

The `@pgxsinkit/client` and `@pgxsinkit/react` peer ranges are widened to
`">=0.5.4-pgx.0 <0.5.5"` so the pre-release satisfies them without warnings.

## Policy: no package may require fork-only behavior

The fork carries two classes of change, and the distinction is load-bearing for whether "temporary"
stays true:

- **Load-bearing bugfixes with open upstream PRs.** The initdb-fs-leak fix
  ([#1060](https://github.com/electric-sql/pglite/pull/1060)) — required for the custom-`fs` lane;
  the transaction-end sync fix (branch `fix/transaction-end-sync`, PR pending) — required for
  transaction durability on **every** lane, `pglite-opfs-repacked` included: it is a plain host
  correctness bug that will almost certainly merge short-term, so per the no-workaround policy the
  packages deliberately rely on the pinned fork host instead of shipping local shims; and the `formatQuery`
  positional-params fix ([#1056](https://github.com/electric-sql/pglite/pull/1056)). These are
  expected to merge; each one shipping upstream shrinks the override's reason to exist, and #1060
  plus the transaction fix shipping removes it.
- **Internal reliability improvements to other drivers and host paths.** The IDBFS durability
  hardening, the opfs-ahp instrumentation, the `close()` drain of in-flight relaxed sync, and the
  non-exclusive relaxed-sync rejection latch. These improve drivers we bench or fall back to, but
  **no pgxsinkit package may depend on them** — they are not API surface.

In particular, `pglite-opfs-repacked` (ADR-0048) must run correctly against **plain upstream host
semantics**: its factory always constructs PGlite with `relaxedDurability: false` (the host awaits
every sync) and owns failed-init cleanup itself, so it needs no fork host hooks — no
`#fsSyncFailure` latch, no `#pendingFsSync` drain, no `syncRequiresExclusiveExecution`. The
rejection latch is an upstream PR candidate (it fixes a genuine swallowed-background-rejection bug
for every filesystem); if upstream merges it, detached relaxed host sync becomes an optional
performance mode — never a correctness requirement, never a pin.

## Publishing a new fork version (`@pgxsinkit/pglite`)

**This flow is fork-specific and manual — it is NOT the `bun run release:npm` standard.** For our
own libraries we are upstream: versions derive from git tags, CI publishes to GitHub Packages, and
`release:npm` mirrors a _tagged release_. The fork inverts all of that: we track **upstream's**
version with a hand-bumped `-pgx.N` suffix, there is no CI publish, and every step runs from the CL
in the fork checkout (`~/dev/pgxsinkit/pglite`, branch `pgx-publish`).

Both legs are scripted in the fork (`packages/pglite/scripts/publish-pgx.mjs`, committed on
`pgx-publish`). Prerequisites:

- `packages/pglite/release/` contains the WASM build artifacts (`build:js` only bundles JS/DTS and
  copies these; no WASM rebuild).
- `tmp/agents/npmrc-ghpackages` (fork repo, gitignored) — two lines:
  `@pgxsinkit:registry=https://npm.pkg.github.com` and
  `//npm.pkg.github.com/:_authToken=<PAT with packages:write>`.
- `~/.npmrc` contains the npmjs auth token (`//registry.npmjs.org/:_authToken=<npm token>`) — the
  npm leg publishes with **bun**, which reads `~/.npmrc` only.
- `packages/pglite/package.json` `publishConfig` must contain **only** `"access": "public"` — never
  a `registry` key (the `-pgx.2` lesson; the script refuses to publish otherwise).

Steps, from `packages/pglite` on `pgx-publish`:

1. Rebase/cherry-pick the change onto `pgx-publish`, hand-bump the version in
   `packages/pglite/package.json` to `<upstreamBase>-pgx.<N+1>` (fork exception to the "never
   hand-edit version" rule — the base must mirror the upstream version being forked), commit.
2. `pnpm publish:pgx:gh` — builds and publishes to GitHub Packages (the canonical build output) with
   dist-tag `pgx`, then verifies the registry lists the version.
3. `pnpm publish:pgx:npm` — downloads the exact GitHub Packages tarball, verifies its shasum,
   uploads it **verbatim with `bun publish`**, and re-verifies byte-identity against both
   registries. bun is load-bearing here: `pnpm publish <tarball>` ignores the tarball and re-packs
   the source directory (observed on `-pgx.7`: unrewritten manifest, dropped LICENSE — that npm
   version is content-safe but non-canonical; never pin it).
4. Consume: bump the alias in this repo's root `package.json` `overrides` to the new version (the
   `>=0.5.4-pgx.0 <0.5.5` peer ranges already cover it) and `bun install`.

(`pgx` is the authoritative channel tag; the scripts always pass `--tag pgx`, so publishes never
move `latest`. On **npm** the registry refuses to delete `latest` — an early publish left it on
`0.5.4-pgx.5` until it was manually repointed at the canonical `pgx` version via the dist-tags API;
after a publish, re-point it or accept that it lags. GitHub Packages carries only `pgx`. The
re-point one-liner — no `npm` CLI, token read from `~/.npmrc`, add `-H "npm-otp: <code>"` if 2FA
gates writes:

```bash
curl -X PUT "https://registry.npmjs.org/-/package/@pgxsinkit%2fpglite/dist-tags/latest" \
  -H "Authorization: Bearer $(sed -n 's|^//registry.npmjs.org/:_authToken=||p' ~/.npmrc)" \
  -H "Content-Type: application/json" \
  -d '"<the just-published -pgx.N version>"'
```

)

## Registry auth (historical — no longer needed)

The fork was originally published to GitHub Packages (`npm.pkg.github.com`), which requires a
`read:packages` token even for public reads. That forced install-time registry auth everywhere: a
generated (gitignored) `bunfig.toml` `[install.scopes]` block locally (`bun run registry:setup` from
`bunfig.toml.example`), and a `.npmrc` + `packages: read` in every CI job that installed.

**That machinery has been removed.** `@pgxsinkit/pglite@0.5.4-pgx.9` is now mirrored **byte-identical**
on public npm (same tarball flow as the `@pgxsinkit/*` npm release — `bun run release:npm` downloads the
exact GitHub Packages tarball and republishes it under dist-tag `pgx`). A plain `bun install` resolves
the aliased fork from `registry.npmjs.org` with **no auth** — no `registry:setup`, no `bunfig.toml`
`[install.scopes]`, no CI `.npmrc`/`packages: read` for the install. In `bun.lock`, an empty source
field means the configured default registry; the package identity and integrity hash pin the result.

The committed `bunfig.toml` now carries **only** the shared `[test]` preload (it is no longer generated
or gitignored). The GitHub Packages **publish** job (`.github/workflows/github-packages.yml`) keeps its
own `.npmrc` + `packages: write` — that authenticates the publish of `@pgxsinkit/*` and is unrelated to
this override.

> Note: `bun publish` (and the byte-identical mirror flow) reads auth from `~/.npmrc` only —
> `NPM_CONFIG_USERCONFIG` is a pnpm/npm-ism that bun does not honor.

## Removing this override (when upstream ships the fix)

The install-auth wiring is already gone; only the override itself and the widened peer ranges remain:

1. Bump `@electric-sql/pglite` (and `@electric-sql/pglite-prepopulatedfs`) to the fixed upstream version.
2. Delete the `overrides` (and its `//overrides` note) from the root `package.json`.
3. Restore/adjust the `@electric-sql/pglite` peer ranges in `packages/client` + `packages/react` if the
   fixed version is a plain release (no `-pgx` pre-release needed).
