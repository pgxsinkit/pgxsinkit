---
name: operating
description: >-
  Load when wiring @pgxsinkit/pglite-opfs-repacked into a browser worker, choosing a worker scope,
  choosing relaxed or strict
  durability, handling store-open failures, or deleting and recreating a store after a format identity
  change. Covers the factory-only construction seam, dedicated-directory ownership, the constant four
  OPFS handles, worker requirements, extent-size identity, awaited PGlite host syncs, close behavior,
  the supported browser-termination model, and the stable error remedies. Load before constructing,
  operating, or recovering an OPFS-repacked PGlite database.
metadata:
  type: task
  library: "@pgxsinkit/pglite-opfs-repacked"
  library_version: "0.2.2"
  source: https://pgxsinkit.github.io/packages/pglite-opfs-repacked/
---

# Operating an OPFS-repacked PGlite database

Use `createOpfsRepackedPGlite` and no other construction path. The factory retains the adapter, forces
PGlite onto its awaited sync path, performs a strict sync before returning a successfully initialized
database, and closes all four handles after failed initialization or shutdown.

## Construct it in a capability-proven worker

Create one otherwise-empty OPFS directory per database and pass its handle to the factory:

```ts
import { createOpfsRepackedPGlite } from "@pgxsinkit/pglite-opfs-repacked";

const root = await navigator.storage.getDirectory();
const directory = await root.getDirectoryHandle("app-database", { create: true });
const pg = await createOpfsRepackedPGlite({
  directory,
  durability: "relaxed",
  extentSize: 64 * 1024,
});
```

Require a successful `createSyncAccessHandle()` open in the executing scope; method presence is not
proof. Chromium and Firefox grant it in dedicated workers and deny it in SharedWorkers. Real macOS
and iOS Safari grant it in SharedWorkers (full boot/persist/reopen verified 2026-07-21). Do not run
the database on the window main thread. A store owns exactly four handles regardless of its virtual
file count.

This package accepts a directory handle and does not choose placement. For a cross-browser
pgxsinkit app, use `@pgxsinkit/client`: capability-driven placement is automatic (there is no placement
option), and a boot-time OPFS probe decides the engine's home — Safari runs the engine in the
SharedWorker; Chromium and Firefox elect a dedicated engine worker. Playwright WebKitGTK denies the
capability in both scopes and exercises the IndexedDB fallback; do not generalize that result to Safari.

The `pglite` option accepts ordinary PGlite configuration such as extensions. Never pass `dataDir`,
`fs`, or `relaxedDurability`; the factory owns all three and rejects them.

## Choose durability once

- `durability: "relaxed"` (default): an ordinary awaited host sync asserts health and performs any due
  deferred repack without running the per-query strict sequence. After at least 4 MiB of accumulated
  arena writes it may perform an extra arena-only amortization flush. Termination may lose an unflushed
  suffix, but recovery keeps the longest valid metadata-log prefix and never crosses extent owners.
- `durability: "strict"`: every awaited host sync flushes arena data before metadata. Successful query
  completion is a strict durability boundary.

PGlite itself is always configured to await `syncToFs()`. A `true` host argument proves construction
was bypassed, raises `DurabilityModeMismatchError`, and poisons the instance. Do not introduce another
durability option at a call site.

Successful initialization, repack activation, and close from an open instance always use strict
ordering. Close from a poisoned instance attempts no persistence and still releases all handles.

## Reopen and recreate

`extentSize` is chosen only for a new store: 8 KiB–16 MiB, aligned to 8 KiB, default 64 KiB. The persisted
identity controls reopen. Omit the option or pass the same value; a different valid value raises
`ExtentSizeMismatchError` without changing the store.

`StoreRecreationRequiredError` means this build does not accept the directory's format identity. Close
all owners, delete the complete directory externally, and create fresh:

```ts
await pg.close();
await root.removeEntry("app-database", { recursive: true });
```

Never copy individual owned files into the fresh directory. `CorruptStoreError` is different: the
activated authority is invalid, so restore an external backup or recreate. The VFS fails closed and
does not select another apparent generation.

## Handle errors by class

- `FsError`: fix the caller operation; non-terminal.
- `StoreLimitError`: recover space or let repack run; some exhausted identities require recreation.
- `StoreOwnedError`: another live instance owns an exclusive handle; close it and retry.
- `UnexpectedStoreEntryError`: the directory is not dedicated and empty; choose a correct directory.
- `ExtentSizeMismatchError`: omit `extentSize` or use the stored value.
- `DurabilityModeMismatchError`: terminal factory-wiring error; close and rebuild through the factory.
- `StoreFailedError`: the live instance is poisoned; close/reopen and inspect `cause`.
- `StoreClosedError`: stop using the adapter.

The guaranteed model covers worker, tab, process, and browser termination; unflushed writes may be
absent, partial, or independently present; completed flushes remain stable. Power loss, media failure,
arbitrary external edits, and mysteriously missing activated files are outside the guarantee and fail
closed.

Full prose: <https://pgxsinkit.github.io/packages/pglite-opfs-repacked/>.
