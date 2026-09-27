# Supplying the Postgres build, and the build refusals

A store runs on a **Postgres build** — `cBuild` from `@pgxsinkit/pgwasm-c` by default — and belongs to the
build that created it. Full page: <https://pgxsinkit.github.io/concepts/postgres-builds/>.

## Where the build is supplied

- `createSyncClient({ build })` — the in-process client and the tab of a worker-mode app.
- `defineSyncWorker({ build })` — a worker-entry option, never on the wire; e.g. `createCBuild({ assets })`
  over assets warmed inside the worker.
- `createPgwasmClient(storePath, { build })` — the eager spare-store create. It runs the exact same create the
  client does internally (the `live` extension, the build's warm, the `boot pgwasm.create` stamp). A rejected
  `precreatedPgwasm` falls back to the `storePath` create path on the same `build`.

`createCBuild({ assets })` takes a `Promise<CBuildAssets>` (`{ postgresWasmModule, initdbWasmModule, fsBundle }`,
whose URLs `cBuildArtefacts` holds). A rejected `assets` falls back to the build's own lazy load; the warm never
fails the boot. The client awaits the build's `prepare()` (an unfinished warm) before it starts the
`boot pgwasm.create` stamp, so `phases.pgwasmCreateMs` measures the create alone. The board demo's
`apps/board/src/board/pgwasm-warm.ts` (`warmCBuildAssets()`) reads the URLs from `cBuildArtefacts`, compiles
them from the login route, and stamps `boot pgwasm build warm`.

## Worker mode: don't hand the engine the tab's compiled modules

The engine loads the build's own assets deliberately. The tab's warm still serves it by priming the
same-origin HTTP cache the worker fetches from. Handing the engine a pre-compiled `WebAssembly.Module` benched
NET-NEGATIVE: it forces compile-to-completion before instantiate (forfeiting the build's streaming-load
pipelining), and the engine realm's only overlap window is the placement/handshake gap, so the compile just
competes for CPU at spawn.

## The declaration and the check

The registry declares the build as `storage.build` (`"c"`, the default, or `"pgrust"`; see the contracts
`registry-authoring` skill). The declaration only names it; the app supplies the build as code. Before any
store is touched, the client checks the supplied build — and an adopted `pgwasmInstance` / `precreatedPgwasm`
through its own `pg.build` — against the declaration.

## The typed refusals (permanent: fix the input, never retry)

- `StorageBuildMismatchError` (`@pgxsinkit/contracts`): the supplied or adopted build is not the declared one.
  Fix the build at the named site, or correct `storage.build` together with a fresh store path.
- `BuildMismatchError` (`@pgxsinkit/pgwasm`): the data directory or backup was made by another build.
- `DataFormatMismatchError` (`@pgxsinkit/pgwasm`): the directory or backup is another data format.
- `BuildMarkerUnreadableError` (`@pgxsinkit/pgwasm`): the directory's build marker can't be read.
- `StorageDeclarationRefusedError`: two declarations explicitly disagree (e.g. a dynamic declaration on the
  wire vs the registry's).

These are not transient, so the client's bounded OPFS open retry propagates them at once. A store backup
(`exportStore()`) restores only into the build that made it.
