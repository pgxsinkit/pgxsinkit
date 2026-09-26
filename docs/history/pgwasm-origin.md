# Where pgwasm came from

> **Historical record.** This file records what `@pgxsinkit/pgwasm` and `@pgxsinkit/pgwasm-c` were
> made from in step 1 of [ADR-0062](../adr/0062-absorb-pglite-as-pgwasm.md). The code is owned
> outright and diverges freely: compatibility with PGlite is an anti-goal, and nothing here is a
> reason to keep a file shaped like its source.

## Source

- **Repository:** the `@pgxsinkit/pglite` fork of ElectricSQL's PGlite (`github.com/pgxsinkit/pglite`),
  branch `pgx-publish`.
- **Commit:** `b36bf12387b1af05c5b5b00f1e3fba3ee581266a` (2026-09-25), published as `0.5.8-pgx.2`.
- **Artefacts:** the C build runs the six files `@electric-sql/pglite` 0.5.8 published (`pglite.js`,
  `pglite.wasm`, `pglite.data`, `initdb.js`, `initdb.wasm`, `amcheck.tar.gz`), pinned by tarball
  integrity and per-file sha256 in `packages/pgwasm-c/src/artefact-pins.ts` and fetched by the root
  `postinstall`. They are not built from the fork.
- **Licences:** PGlite under its PostgreSQL License option (© ElectricSQL); pg-protocol under
  node-postgres' MIT (© Brian Carlson) as adapted by ElectricSQL; the Drizzle driver from drizzle-orm
  (Apache-2.0, © Drizzle Team); the type parsers credit postgres.js (Unlicense). Attributions are in
  each package's `NOTICE`, the root `NOTICE` and the file headers.

`w:` is `packages/pgwasm/`; `c:` is `packages/pgwasm-c/`.

## `packages/pglite/src`

| Source                                                                                                   | Became                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                                                                                               | w: `src/index.ts`, a new barrel                                                                                                                                                                                                                                                                                               |
| `pglite.ts`                                                                                              | split: the instance, its state, persist scheduler, failure latch, exchange sink, notifications, dump/load and close to w: `src/core/pgwasm.ts` and `src/create.ts`; the Emscripten instance, main loop, `/dev/blob`, callbacks, startup packet and single-mode start to c: `src/host/postgres-instance.ts` and `src/build.ts` |
| `base.ts`                                                                                                | w: `src/core/pgwasm.ts` (query, exec, sql, transaction, runExclusive, array types)                                                                                                                                                                                                                                            |
| `interface.ts`                                                                                           | w: `src/interface.ts`                                                                                                                                                                                                                                                                                                         |
| `types.ts`                                                                                               | w: `src/types.ts`                                                                                                                                                                                                                                                                                                             |
| `parse.ts`                                                                                               | w: `src/core/parse.ts`                                                                                                                                                                                                                                                                                                        |
| `templating.ts`                                                                                          | w: `src/templating.ts`                                                                                                                                                                                                                                                                                                        |
| `utils.ts`                                                                                               | w: `src/live/format-query.ts` and `src/live/debounce-mutex.ts`                                                                                                                                                                                                                                                                |
| `errors.ts`                                                                                              | w: `src/errors.ts`, with the new typed errors                                                                                                                                                                                                                                                                                 |
| `extensionUtils.ts`                                                                                      | c: `src/host/extensions.ts`                                                                                                                                                                                                                                                                                                   |
| `initdb.ts`                                                                                              | c: `src/host/initdb.ts` and `src/host/paths.ts`                                                                                                                                                                                                                                                                               |
| `initdbModFactory.ts`, `postgresMod.ts`                                                                  | c: `src/host/emscripten.ts` (owned types); the glue imports in c: `src/artefacts.ts`                                                                                                                                                                                                                                          |
| `argsParser.ts`                                                                                          | rewritten as c: `src/host/command-line.ts`                                                                                                                                                                                                                                                                                    |
| `fs/base.ts`                                                                                             | split: `BaseFilesystem` and its errors to w: `src/fs/base-filesystem.ts`; the Emscripten adapter to c: `src/host/vfs-mount.ts`                                                                                                                                                                                                |
| `fs/index.ts`                                                                                            | split: `dataDir` parsing to w: `src/core/storage.ts`; mount selection to c: `src/host/mounts/index.ts`                                                                                                                                                                                                                        |
| `fs/memoryfs.ts`, `fs/idbfs.ts`, `fs/nodefs.ts`                                                          | c: `src/host/mounts/memory.ts`, `idb.ts`, `file.ts` (with `storage-mount.ts` and `vfs.ts`)                                                                                                                                                                                                                                    |
| `fs/tarUtils.ts`                                                                                         | split: the archive to w: `src/tar/` and `src/core/data-dir-archive.ts`; walking and writing the data directory to c: `src/host/data-dir.ts`                                                                                                                                                                                   |
| `live/index.ts`, `live/interface.ts`                                                                     | w: `src/live/index.ts`, `src/live/interface.ts`                                                                                                                                                                                                                                                                               |
| `contrib/amcheck.ts`                                                                                     | c: `src/contrib/amcheck.ts`                                                                                                                                                                                                                                                                                                   |
| `fs/opfs-ahp.ts`, `worker/index.ts`, the other 33 `contrib/*`, `definitions/tinytar.d.ts`, `polyfills/*` | dropped (ADR-0062 decision 2; tinytar replaced by the owned codec)                                                                                                                                                                                                                                                            |

## Other fork packages

| Source                                                          | Became                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/pg-protocol/src/*`                                    | w: `src/protocol/wire/*`, surfaced by `@pgxsinkit/pgwasm/protocol` |
| `packages/pglite-utils/src/utils.ts` (`toPostgresName`, `uuid`) | w: `src/core/names.ts`                                             |
| `packages/pglite-utils/src/utils.ts` (artefact loading)         | c: `src/host/artefact-loader.ts`                                   |
| drizzle-orm's `pglite` driver (not in the fork)                 | w: `src/drizzle/*`                                                 |

New, with no source: w: `src/build/seam.ts` (the build seam), w: `src/core/marker.ts` (the build
marker, ADR-0063), w: `src/core/mutex.ts`, w: `src/core/internals.ts`, w: `src/tar/tar.ts` (replacing tinytar),
c: `src/host/exit-code.ts`, c: `src/artefact-pins.ts` and `scripts/pgwasm-artefacts.ts`.

## Tests

| Fork test                                                                                                                 | Became                                                                         |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `basic`, `array-types`, `dump`, `exec-protocol`, `notify`, `live`, `query-sizes`, `templating`, `types`, `user`           | `tests/unit/pgwasm-<same name>.test.ts` (`exec-protocol` as `pgwasm-protocol`) |
| `format.test.js`                                                                                                          | `pgwasm-live-format-query.test.ts`                                             |
| `utils.test.ts`                                                                                                           | `pgwasm-live-debounce.test.ts`                                                 |
| `transaction-sync.test.ts`                                                                                                | `pgwasm-transaction-persist.test.ts`                                           |
| `non-exclusive-sync-failure.test.ts`                                                                                      | `pgwasm-persist-failure.test.ts`                                               |
| `sync-exec-prologue.test.ts`                                                                                              | `pgwasm-protocol.test.ts`                                                      |
| `main-loop-exception.test.ts`                                                                                             | `pgwasm-c-failure.test.ts`                                                     |
| `initdb-fs-option.test.ts`                                                                                                | `pgwasm-c-initdb.test.ts`                                                      |
| `instantiation.test.ts`                                                                                                   | `pgwasm-create.test.ts`                                                        |
| `targets/runtimes/*`                                                                                                      | `pgwasm-c-filesystems.test.ts`                                                 |
| the engine-feature tests (`plpgsql`, `triggers`, `fts.*`, `xml`, `largeobjects`, `drop-database`, `message-context-leak`) | `pgwasm-c-engine-features.test.ts`                                             |
| `contrib/amcheck.test.js`                                                                                                 | `pgwasm-c-amcheck.test.ts`                                                     |
| `targets/web/base.js`, `targets/web/idbfs-correctness.test.web.js`                                                        | `tests/e2e/pgwasm-idb/` (Chromium and WebKit)                                  |
| `packages/pg-protocol` tests                                                                                              | `pgwasm-protocol-wire.test.ts`                                                 |
| `clone`, `describe-query`, the other contrib tests, `targets/deno`, the `opfs-ahp` and `PGliteWorker` cases               | dropped with what they tested                                                  |
