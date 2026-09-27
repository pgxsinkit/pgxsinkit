---
title: Postgres builds
description: What a Postgres build is, why a store belongs to the build that created it, how to declare and supply one, and what to do about each build refusal.
sidebar:
  order: 11
---

The local store is a real PostgreSQL database, run by [pgwasm](/packages/pgwasm/). pgwasm is the runtime;
the compiled Postgres it runs is a separate piece of code called a **build**. The build you get by default
is the C build, `cBuild` from `@pgxsinkit/pgwasm-c`: PostgreSQL 18 compiled to WebAssembly. A build is an
object implementing the `PostgresBuild` contract from `@pgxsinkit/pgwasm/build`, and it carries an
identity: a `name` (`"c"` for the C build) and a `dataFormat` number.

Most apps never pick a build: every client, worker and store uses `cBuild` unless told otherwise. This
page matters when you supply a build yourself (to warm its files early, or to run another one), adopt a
database you created, or restore a backup.

## A store belongs to its build

A data directory records the build that created it, and the record is permanent. A store's build is fixed
when the store is created: pgwasm refuses to open it with any other build, and refuses to restore a
[store backup](/concepts/export-and-restore/) into any build but the one that made it. The refusal comes
before anything is written, so a mismatched open never damages the store.

A different build is therefore a **different store**. To move users to another build, declare it and let
the client mint a fresh store under a fresh path, and destroy the old path's artifacts afterwards (see
[Local store lifecycle](/concepts/local-store-lifecycle/)). A synced table re-syncs from the server; a
local-only table has no server copy, so export what you need to keep before you switch.

Data directories created before builds were recorded carry no marker. They were all made by the C build,
so the C build opens them; any other build refuses them.

## Declaring the build: `storage.build`

The registry's storage declaration names the build, next to `backend` and `durability`:

```ts
export const registry = defineSyncRegistry({
  tables: {/* … */},
  storage: { build: "c" }, // the default; "pgrust" names the Rust build
});
```

`storage.build` is `"c"` (the default) or `"pgrust"` (a bare table map declares it with
`attachSyncRegistryStorage`). Like the rest of the declaration it is part of the
store's identity: one value binds every open of every store minted from that registry, and a store's
declaration is never changed in place. It may also travel on the wire with the rest of a dynamic
declaration ([Worker mode](/concepts/worker-mode/#the-storage-declaration-on-the-wire-adr-0050)); an
explicit disagreement between the two is a `StorageDeclarationRefusedError`.

The declaration only **names** the build. pgxsinkit never loads a build from that string: the build is
code, and your app supplies it.

## Supplying the build

Three sites create a store, and each takes a `build` option. Leave it out and the site uses `cBuild`.

```ts
import { createCBuild } from "@pgxsinkit/pgwasm-c";

// In the tab (a client that owns its store):
const client = await createSyncClient({ registry, build: createCBuild({ assets }) /* … */ });

// In a sync worker (every store the worker mints: its own boot, provisions and spares):
defineSyncWorker({ registry, build: createCBuild({ assets }) });

// A store created ahead of the client:
const store = createPgwasmClient(storePath, { build: createCBuild({ assets }) });
```

A worker's `build` is a worker-entry option, never sent over the wire: code cannot cross it. The usual
reason to pass `createCBuild({ assets })` is to warm the build's files early (see
[Operating in production](/start/operating-in-production/#pre-warming-the-postgres-build)); a rejected warm
falls back to the build's own load and never fails the boot.

pgxsinkit checks the build against the declaration **before any store is touched**:

- at a mint, against the build the site supplies (`createSyncClient`, `defineSyncWorker`,
  `createPgwasmClient` when the client threads a declaration to it);
- on a database the client adopts, against the build that database reports as `pg.build`: a
  `pgwasmInstance` you created, a `precreatedPgwasm`, or the result of a worker's `createStore` factory.

Declaring `"pgrust"` and supplying no build is a mismatch: the default is the C build.

## The refusals

All four are typed, carry a stable `name` that survives bundle copies and the worker bridge, and are
never retried: a store open that fails with one fails at once, because retrying cannot change the answer.

### `StorageBuildMismatchError` (`@pgxsinkit/contracts`)

The registry declares one build and the code supplied or adopted another. It carries `declared`,
`supplied` and `site` (which of `createSyncClient`, `defineSyncWorker`, `createPgwasmClient`,
`pgwasmInstance`, `precreatedPgwasm` or `createStore` checked), and the same three fields in `detail`, so a
tab attached to a worker can read them after the error crossed the bridge.

**What to do.** It is a wiring error, found before anything was opened. Pass the declared build at the
named site (`createSyncClient({ build })`, `defineSyncWorker({ build })`), or correct `storage.build` if the
declaration is what is wrong.

### `BuildMismatchError` (`@pgxsinkit/pgwasm`)

The data directory, or the backup being restored, was created by another build. It carries `expected`
(the build and data format you supplied), `found` (the recorded build, or `"unmarked"`), and `source`
(`"data-directory"` or `"backup"`). Nothing was written.

**What to do.** Open the store with the build that created it. If the app has moved to another build on
purpose, the old store cannot come along: mint a fresh store under a fresh path and let it re-sync, and
destroy the old one. For a backup, restore it into a client running the backup's own build.

### `DataFormatMismatchError` (`@pgxsinkit/pgwasm`)

The build is right but the data directory or backup is in a data format this release of the build does not
read. It carries `expected`, `found` and `source`.

**What to do.** Run a release of the build that reads that data format, or treat the store as one to
replace: mint a fresh store and let it re-sync.

### `BuildMarkerUnreadableError` (`@pgxsinkit/pgwasm`)

The data directory's build marker cannot be read: it is corrupt, or a newer pgwasm wrote it. It carries the
marker's `raw` text. Nothing was written.

**What to do.** If a newer release of your app opened this store, run that release again (downgrading
under a store a newer pgwasm marked is not supported). Otherwise treat the store as damaged: restore a
backup, or destroy it and let it re-sync.

## See also

- [pgwasm](/packages/pgwasm/): the runtime, the C build, and the OPFS-repacked store.
- [Export & restore](/concepts/export-and-restore/): store backups are build-bound.
- [Registry entry options](/concepts/registry-entry-options/#registry-storage-storagebuild): the
  `storage.build` field.
