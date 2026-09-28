# The C build's supply chain

Status: accepted (2026-09-27). Amends [ADR-0062](0062-absorb-pglite-as-pgwasm.md) decision 9 (the
C build's home is a new patch-series repository, not the renamed fork) and
[ADR-0063](0063-build-permanence-and-storage-build.md)'s consequences (how a store crosses a data
format change is an open question that blocks the first Postgres major). This ADR records the
pgxsinkit-facing side; the build repository's own mechanics are its
[ADR-0001](https://github.com/pgxsinkit/pgwasm-postgres/blob/main/docs/adr/0001-postgres-as-a-patch-series.md).

Status note (2026-09-27): pgxsinkit adopted pgwasm-postgres `18.3.0` in `b47b056` (`pgwasm:pin`, the
release-asset fetch, the data-format refusal) and `c69580a` (the provenance of the artefacts).

Status note (2026-09-28): pgxsinkit adopted pgwasm-postgres `18.6.1`, the first release built with
Emscripten 6.0.10 and so the first to enforce decision 7's browser floor, in `905deb2` (the pin, the host's
`EmscriptenSjLj` unwind, the dead `WASM_PREFIX` removed, the NOTICEs) and `ae02603` (a wrong-size filesystem
bundle is refused before the glue runs, since Emscripten 6's file packager swallows the throw). The
consumer docs state the floor (getting-started, Postgres builds, pgwasm) from the same adoption.

Status note (2026-09-28): the IDB Playwright lane of decision 4's contract gate now also proves cross-build
continuity (`a4f1090`): each earlier build pinned in `tests/e2e/pgwasm-idb/continuity-builds.ts`, first
`18.6.0` (Emscripten 3.1.74, pgxsinkit 0.4.1), writes an `idb://` store, marked and unmarked, that the pinned
build must read back identically and write to, in Chromium and WebKit. A pin change that moves the toolchain
therefore meets stores the previous releases wrote; when a release that shipped goes out of the pin, it
joins that list.

Status note (2026-09-28): pgxsinkit adopted pgwasm-postgres `18.6.2` in `a81456f` (the pin; the artefacts
renamed `postgres.{js,wasm,data}`; the compiled filesystem root and install prefix `/pgwasm`, and with it the
IndexedDB database `/pgwasm/<name>` and Web Lock `pgwasm-idbfs:/pgwasm/<name>`; pgwasm-c's `idbDatabaseName`
exported so the client's `storeIndexedDbDatabaseName` derives from it) and `3e49a44` (`pglite` dropped from
module names). **This release requires refreshing local stores**: no store created by PGlite or an earlier
pgxsinkit release is supported, with no migration or shim; apps destroy and re-sync them. `idb://` stores
written under `/pglite` are not even opened (the database name changed), and the library does not delete the
old `/pglite/*` databases (the prefix is PGlite's own too; another app on the origin may own them). That is the
maintainer's decision for this release only, not a general policy. No store of the unreleased `18.6.1` pin
exists outside tests, so nothing between `18.6.1` and `18.6.2` needs carrying over. The IDB lane's continuity list is
emptied by design (`18.6.0` dropped); `18.6.2` becomes its first entry when a later release is pinned. The
consumer docs say it once (Coming from PGlite, "Existing data"), including that unsynced local writes stay
behind in the old store.

## Context

[ADR-0062](0062-absorb-pglite-as-pgwasm.md) decision 9 keeps Postgres compilation out of pgxsinkit: a
build package pins an artefact release by version and checksum. It planned the C build's home as
`pgxsinkit/postgres-pglite` renamed to `pgxsinkit/pgwasm-postgres`. Until now `@pgxsinkit/pgwasm-c` and
`@pgxsinkit/pgwasm-pg-dump` republished ElectricSQL's PGlite 0.5.8 artefacts byte for byte, fetched from
npm tarballs.

Those artefacts were built from `electric-sql/postgres-pglite` at `b133782`: upstream `REL_18_3` plus
22 commits. ElectricSQL starts each major's fork from an upstream tag and does not rebase it onto later
releases, so minors lag by several releases and majors by months; upstream has since tagged
`REL_18_4` and `REL_18_6`.

`pgxsinkit/pgwasm-postgres` now exists as a small repository that holds the upstream pin, a series of
five patches derived from `b133782`, and an overlay of the files ElectricSQL added; Postgres source never
enters its history. Its ADR-0001 records what it established on 2026-09-27:

- The series and overlay reproduce `b133782`'s tree, and a build of it in a pinned builder image
  reproduced ElectricSQL's 0.5.8 artefacts byte for byte (all but `amcheck.tar.gz`'s archive bytes,
  which carry the moment of ElectricSQL's `make install`).
- `18.3.0` is the first release whose bytes are its own. It builds only what ships (Postgres's own
  modules and `amcheck`), and computes `pglite.wasm`'s export list from the shipped modules' imports:
  under the old list an encoding conversion threw out of the wasm and ended the backend.
- An engine gate runs there before a tag: a clean apply of the series, the build, the export-list diff,
  the data-format check, the prepopulated data directory's check, and Postgres's regression suite against
  a recorded baseline. The release job rebuilds the tag from scratch and publishes only when its manifest
  is identical to the gated build's.
- Postgres refuses a data directory whose `pg_control` disagrees with the build's compile-time values:
  `ReadControlFile()` compares twelve fields, and `XLogReaderValidatePageHeader()` checks the WAL page
  magic. Those thirteen values are the compatibility tuple. It changes with a major, and equally with a
  change of the build's own flags (a wasm64 build turns on `FLOAT8_BYVAL`).

[ADR-0063](0063-build-permanence-and-storage-build.md) made a build's identity its name plus an on-disk
compatibility version, and settled how a store moves to another build. It did not settle how a store
moves to a release of the same build with another data format.

## Decision

1. **The C build's home is `pgxsinkit/pgwasm-postgres`,** a small patch-series repository (the upstream
   pin, the patches, the overlay), not the renamed fork. `pgxsinkit/postgres-pglite` is archived as the
   provenance of `b133782`. This amends ADR-0062 decision 9; the rest of that decision stands, and
   pgxsinkit still never compiles Postgres.

2. **Releases.**
   - Tags are `<pg major>.<pg minor>.<revision>` (`18.3.0`, `18.3.1`, `18.6.0`), derived from the tags
     and the upstream pin, never hand-edited.
   - `version()` names the build (`pgwasm-postgres <tag>`:
     `PostgreSQL 18.3 (pgwasm-postgres 18.3.0) on wasm32-unknown-emscripten, …`), and
     `C_BUILD_IDENTITY.release` matches it.
   - Releases are GitHub release assets with a manifest and `SHA256SUMS`.
   - Every release is reproducible, and the release job publishes only what the engine gate built.

3. **Adoption is `bun run pgwasm:pin <tag>`.** It pins both build packages, `pgwasm-c` and
   `pgwasm-pg-dump`, from one release: `pg_dump` always ships with its server, since it refuses a server of a
   newer major. There is no cross-repo automation; the pin change is an ordinary commit here.

4. **The contract gate runs on the pin change:** `validate:full`, the IDB Playwright lane, and the
   integration lanes, through their package scripts. The pin is a content change, so the content cache
   re-runs what depends on `pgwasm-c` by itself; nothing bypasses the cache. A release that fails the
   contract gate is superseded by a new revision (`18.3.1` …), never retracted.

5. **Postgres majors are adopted deliberately:** when a feature needs it, or when the current major is
   within 12 months of its end of life (18: November 2030).
   - Each release's `data-format.json` declares `dataFormat` plus the compatibility tuple.
   - `pgwasm:pin` carries `dataFormat` into the build identity and refuses a release whose `dataFormat`
     differs from the current identity's.
   - **Open question:** how existing stores cross a `dataFormat` change. The candidates are a destroy
     and re-sync gated on a drained Outbox, or an in-browser dump and restore that loads both builds
     once. It blocks the first major: `pgwasm:pin` refuses every release that changes `dataFormat`.
     This amends ADR-0063's consequences.

6. **The prepopulated data directory comes from the release** (`prepopulated.tar.gz`): made by the
   release's own initdb, deterministic, and unmarked. `pgwasm` adds the build marker on restore.

7. **Browser floor: Safari/iOS 18.4, Chrome 137, Firefox 131.** It takes effect with the release that
   first enforces it (planned: `18.6.1`, the move to the latest Emscripten), and the consumer docs change
   then, not now. Safari 18.4 is where standard wasm exceptions (`exnref`) arrive, which give wasm-native
   setjmp/longjmp and `PG_TRY` without JavaScript `invoke_*` trampolines; tail calls, extended-const and
   SIMD come with it.

## Considered options

- **Rename the fork and keep it** (ADR-0062 decision 9 as written). Tooling would live on per-version
  branches while scheduled workflows run only from the default branch, the repository would stay in
  ElectricSQL's fork network, and a clone would carry all of Postgres's history.
- **Keep pinning ElectricSQL's npm tarballs.** Minors would keep lagging upstream, and a fix to the C
  build (the export list that crashed encoding conversions) would have no release to come from.
- **Cross-repo automation**, a pgwasm-postgres release opening the pin PR here. A pull request opened
  with `GITHUB_TOKEN` triggers no CI, and a cross-repo PR needs a standing token or GitHub App, for what
  is one command.
- **Adopt each major when it ships.** The port is the cheap part of a major; the expensive part is every
  store crossing the data format, which is still open.
- **A floor of iOS 18.0.** Every iOS 18 device can run 18.7, so 18.4 excludes no device 18.0 would
  include.

## Consequences

- A change to the C build crosses two repositories: a pgwasm-postgres release through its engine gate,
  then a pin commit here through the contract gate.
- `SELECT version()` identifies the exact build a store runs, and `C_BUILD_IDENTITY.release` says the
  same in code.
- The build packages' `NOTICE`s describe the pgwasm-postgres release they ship; ElectricSQL's
  attribution stays, for the patches and overlay derived from its fork.
- No release that changes the compatibility tuple can be adopted until decision 5's open question is
  decided.
- The Emscripten move changes the glue under `pgwasm-c`'s host code, so that release's pin carries host
  changes through the contract gate.

References: [ADR-0062](0062-absorb-pglite-as-pgwasm.md), [ADR-0063](0063-build-permanence-and-storage-build.md),
pgwasm-postgres [ADR-0001](https://github.com/pgxsinkit/pgwasm-postgres/blob/main/docs/adr/0001-postgres-as-a-patch-series.md).
