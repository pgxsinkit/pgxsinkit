# Absorb PGlite as pgwasm (upstream compatibility is an anti-goal)

Status: accepted (2026-09-26). Extends [ADR-0028](0028-own-the-sync-engine-outright.md)'s anti-goal
from the sync engine down to the embedded Postgres runtime. Amends
[ADR-0048](0048-opfs-repacked-vfs.md): the store moves inside the runtime package, and its "no
fork-only host behavior" rule is retired. [ADR-0063](0063-build-permanence-and-storage-build.md)
records the store-level rules that follow from having more than one Postgres build.
Revised 2026-09-27 before implementation: filesystem mounting is build-specific (step 1 design).
Amended 2026-09-27: emergent is the only downstream consumer. Decision 10's step-3 gate and step-4
codemod cover emergent alone; genretv and magnetic are not continued as they are.

## Context

pgxsinkit runs on PGlite through a fork. The root `overrides` alias `@electric-sql/pglite` to
`@pgxsinkit/pglite@0.5.8-pgx.2`, a rebase of upstream 0.5.8 carrying the fixes the repacked store's
durability depends on (the transaction-end sync, and failing the instance on an engine exception
instead of swallowing it). Every fix travels the same road: fork commit, a publish to GitHub
Packages and npm, a pin bump here, and the steps in the fork-override runbook (deleted with the fork in step 3). Every
consumer has to carry the same override.

The maintainer's assessment (2026-09-26) is that ElectricSQL will contribute little more to PGlite
as open source. The fork's `-pgx` releases only ever changed TypeScript: the wasm pgxsinkit runs is
byte-identical to upstream 0.5.8's, built from the `postgres-pglite` tree (a PostgreSQL 18.3 fork)
inside Electric's builder image `electricsql/pglite-builder:3.1.74-7`.

A second engine is being prototyped: a multi-threaded pgrust wasm build running on our repacked
store (the `pgxsinkit/pglite-v-pgrust` bench). pgxsinkit's unit suite passed 1968 of 1987 tests on
it (2026-09-07), through the one method PGlite's `BasePGlite` builds everything else on,
`execProtocolRaw`. Supporting either engine needs a seam PGlite does not have as a public contract.

What pgxsinkit and its consumers use from the fork's 21 packages: the core (`query`, `exec`, `sql`,
`transaction`, `close`, `waitReady`, `dumpDataDir`/`loadDataDir`, `refreshArrayTypes`), `/live`,
`/basefs`, `contrib/amcheck`, `pglite-prepopulatedfs`, `pglite-tools`' `pg_dump`, `pglite-repl`, and
`drizzle-orm/pglite` (which imports `@electric-sql/pglite` by name at runtime). The core is about
8,600 lines of TypeScript.

## Decision

1. **Ownership.** PGlite's TypeScript comes into pgxsinkit as owned code, the way
   [ADR-0009](0009-internalize-read-path-sync.md) took pglite-sync. Compatibility with PGlite is an
   anti-goal in the full sense of ADR-0028 decision 1: no refresh path, no pinned-SHA tracking,
   and "matches PGlite" never justifies code shape, test shape, or a raw SQL string. The code
   arrives as a plain copy of `pgxsinkit/pglite` at `b36bf12`, not as imported history: joining
   unrelated histories needs a merge commit, and the history stays browsable in the archived fork.

2. **The package family.**

   | Package | Contents | Licence |
   | --- | --- | --- |
   | `@pgxsinkit/pgwasm` | the runtime: core, live queries, `pg-protocol`, templating, the filesystem contract (`BaseFilesystem`, `FsStats`) and the storage vocabulary (memory, IndexedDB, file), the OPFS store at `/opfs`, our Drizzle driver | MIT |
   | `@pgxsinkit/pgwasm-c` | the C build: `pglite.wasm`, `initdb.wasm`, the filesystem bundle, the `amcheck` extension files, the prepopulated data directory, and its Emscripten host code, including the memory, IndexedDB and file mounts (Emscripten built-ins) | PostgreSQL License |
   | `@pgxsinkit/pgwasm-pg-dump` | the `pg_dump` wasm and its loader (engine-neutral: it speaks the wire protocol) | PostgreSQL License |
   | `@pgxsinkit/pgwasm-repl` | the development REPL | MIT |
   | `@pgxsinkit/pgwasm-pgrust` | phase 2 only (decision 9) | AGPL-3.0 |

   `pgwasm` takes PGlite's code under its PostgreSQL License option (the README: "dual-licensed
   … you can choose which you prefer"). Provenance follows ADR-0028 decision 3's shape: a short
   header on each file derived from PGlite, and a `NOTICE` entry carrying PGlite's licence text and
   ElectricSQL's attribution. The AGPL stays inside the one package a user opts into.

   Out: `PGliteWorker`, `opfs-ahp`, the 11 extension packages, the React and Vue bindings, the
   socket server and the benchmark.

3. **The wire protocol is the seam.** `pgwasm` owns everything above it once, engine-neutrally:
   `query`, `exec`, `transaction`, `listen`, live queries, type parsers, the Drizzle driver, the
   filesystem contract, the storage vocabulary, `dataDir` parsing, the refusals and the capability
   checks. A Postgres build provides three things: `boot`, a byte channel per session, and a
   capability record (its identity, how many sessions it holds, whether it needs cross-origin
   isolation, which filesystems it supports). Each build mounts storage itself. Anything that differs
   between builds is a capability, never a branch in shared code. A user installs the build they
   want and hands it over: `createPgwasm({ build })`. Each build package exports its artefacts as
   `new URL("./…", import.meta.url)` references, so bundlers copy and fingerprint them.

4. **Our own Drizzle driver**, on drizzle's public `drizzle-orm/pg-core/async/session` base
   classes, replaces `drizzle-orm/pglite`. With it, no `@electric-sql/pglite` remains anywhere in the
   dependency graph and the override disappears.

5. **A clean break, with a small surface.** `PGlite` becomes `Pgwasm`, constructed with
   `createPgwasm()`; `ClientPGlite` becomes `PgwasmClient`. There are no compatibility aliases.
   - Kept: `query`, `exec`, `sql`, `transaction`, `live`, `dumpDataDir`/`loadDataDir`, `close`,
     `waitReady`, `refreshArrayTypes`, and `listen`/`unlisten`/`onNotification`.
   - Behind a separate entry point, `@pgxsinkit/pgwasm/protocol`: the wire-level `execProtocol*`, for
     tools such as `pg_dump`, the REPL and the bench.
   - Dropped: `clone`, `describeQuery`, `syncToFs`.

   Every kept method is a promise both builds must honour.

6. **Our store is the only OPFS filesystem.** The repacked store moves into `pgwasm` under
   `@pgxsinkit/pgwasm/opfs`, and callers pass it in explicitly. It is never resolved from a
   `dataDir` scheme: Vite builds workers as classic scripts by default, which cannot split code, so a
   lazily imported store would be inlined into every worker bundle. `opfs-ahp` is removed (ADR-0048
   records why it is disqualified), and a `dataDir` of `opfs-ahp://` fails with an error naming the
   replacement. "Repacked" remains the name of the store's on-disk format. With the store and the
   runtime in one package we own, ADR-0048's rule against relying on fork-only host behavior no
   longer has anything to protect.

7. **ESM only, for Bun and browsers.** The browser contexts are the page, dedicated workers, the
   SharedWorker the store uses on WebKit, and extension pages. Node, Deno and CommonJS are not
   supported. The file filesystem (`file://`) is what Bun uses.

8. **Held to repo standards on arrival.** The code is converted as it enters, in one bite, before
   anything publishes: pgxsinkit's full tsconfig, oxlint and oxfmt, no blanket pragmas, tests ported
   to `bun test` for what we keep. No vendor exemption path exists.

9. **Builds and their repositories.**
   - pgxsinkit never compiles Postgres. A build package pins an artefact release by version and
     checksum.
   - `pgwasm-c` first republishes the 0.5.8 artefacts byte-identical, with their sha256 recorded.
   - `pgxsinkit/postgres-pglite` becomes the C build's home as `pgxsinkit/pgwasm-postgres`,
     detached from Electric's fork network, with our own builder image. Its first job is to rebuild
     the 0.5.8 artefacts byte for byte. C changes (Postgres 18.x bumps, patches) begin only after
     that.
   - `pgxsinkit/pglite` is archived after the release, with a README pointing here, and its
     published `@pgxsinkit/pglite` versions get an npm deprecation notice.
   - **Phase 2.** `pgwasm-pgrust` enters as an experimental opt-in once pgxsinkit's unit suite and
     integration lanes are green on it. From then on a `test:pgrust` lane (the unit suite with the
     test-store seam pointed at the pgrust build) runs in CI on develop pushes and tags, outside the
     commit path and writing no cache entries. A red run skips only `pgwasm-pgrust`'s publish; its
     docs name the last `pgwasm` version it passed with. Before phase 2, the bench's lane runs only
     with the maintainer's per-run permission, as the cache rule requires. Cross-origin isolation,
     and the absence of an IndexedDB backend, are documented requirements of the opt-in, not gates.

10. **Order of work.**
    0. This ADR, ADR-0063 and the glossary.
    1. `pgwasm` without the store, and `pgwasm-c`, with their tests.
    2. `pgwasm-pg-dump`, `pgwasm-repl`, and the rest of the C build's files.
    3. The switch: the store moves to `pgwasm/opfs`; the client and React move onto `pgwasm`; our
       driver replaces `drizzle-orm/pglite`; `@electric-sql/pglite` leaves the graph; the override
       runbook retires; the docs site is rewritten. Gate: the full suite, the integration lanes,
       and emergent's, genretv's and magnetic's suites against a pre-release.
    4. One tag, the npm deprecation notices, and a codemod PR each for emergent, genretv and
       magnetic.

    The C build's reproduction runs alongside. The bench moves onto `pgwasm`'s build interface
    afterwards.

## Considered options

- **Keep the fork.** Every fix keeps crossing two repositories, two publishes and an override
  every consumer must set, for code no one upstream will review.
- **Bring the C tree and emscripten build into pgxsinkit.** One repository, but validate and CI
  take on a Postgres build and a builder container for something that rarely changes.
- **Keep PGlite's whole public interface, or its name.** Every method, and the name, would be a
  promise to behave like a product we no longer track, on two builds.
- **Keep opfs-ahp.** No consumer uses it, and it is the buggy filesystem ADR-0048 replaced.

## Consequences

- One repository, one release and one version for the runtime, its store and its tools.
- The runtime can report things the fork forced us to work around, such as the store knowing its
  own location (the client's hidden persistence marker goes).
- Consumers change imports and names once, driven by a codemod.
- Ownership does not erase origin: the `NOTICE` attribution is permanent.
- Open question before phase 2's first public release: how far the AGPL reaches when an unmodified
  pgrust module loads into someone's web app.

References: [ADR-0009](0009-internalize-read-path-sync.md), [ADR-0028](0028-own-the-sync-engine-outright.md),
[ADR-0048](0048-opfs-repacked-vfs.md), [ADR-0049](0049-capability-driven-engine-placement.md),
[ADR-0063](0063-build-permanence-and-storage-build.md).
