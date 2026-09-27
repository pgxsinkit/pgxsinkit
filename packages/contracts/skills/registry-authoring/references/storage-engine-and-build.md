# `storage.engine` and `storage.build`

Both are part of the store's **identity**, like `backend`: one declaration binds every open of every store
minted from the registry, and changing either means minting a fresh store under a fresh path — never
reopening an existing one.

## `storage.engine` — a different store engine

`storage: { engine: { module: "/store-engine/factory.js" } }`. `module` is an absolute or origin-relative module
URL. pgxsinkit `import()`s it in whichever scope is minting and takes its **default export** — or, failing
that, a named `createStore` — as the store factory: `(storePath: string, backendOverride?: "memory") =>
Promise<PgwasmClient>`, the same signature as `defineSyncWorker`'s `createStore` option. That module then
answers for the store instead of the built-in `createPgwasmClient`. Absent (the default) is the built-in
store. The module owns its own assets (derive them from `import.meta.url`), its storage layout under the store
path, and its environment requirements; serve it same-origin. A module that will not load, or exports no
factory, fails the mint loudly naming the module — it never falls back to the built-in store.
Full prose: <https://pgxsinkit.github.io/concepts/worker-mode/#declaring-a-different-store-engine>.

## `storage.build` — the Postgres build

`storage: { build: "c" }`. `build` names the Postgres build that owns every store minted from the registry:
`"c"` (the default, `cBuild` from `@pgxsinkit/pgwasm-c`) or `"pgrust"`. A data directory belongs to the build
that created it, so a different build is a different store. The declaration only names the build; the app
supplies the build itself as code (the `build` option of `createSyncClient`, `defineSyncWorker` and
`createPgwasmClient`), and a supplied or adopted build that is not the declared one fails with
`StorageBuildMismatchError` before any store is touched. A bare table map declares it with
`attachSyncRegistryStorage`. It may also travel on the wire with a dynamic declaration; an explicit
disagreement between the two is a `StorageDeclarationRefusedError`. Leave it at the default unless the app
runs another build. Full prose: <https://pgxsinkit.github.io/concepts/postgres-builds/>.
