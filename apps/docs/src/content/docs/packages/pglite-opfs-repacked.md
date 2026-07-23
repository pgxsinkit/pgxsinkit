---
title: OPFS-repacked PGlite storage
description: Construct and operate a constant-four-handle OPFS filesystem for a browser-worker PGlite database.
sidebar:
  label: OPFS-repacked PGlite
---

`@pgxsinkit/pglite-opfs-repacked` stores a complete PGlite virtual database directory inside four
exclusively owned OPFS files. Its handle count stays four as the database creates virtual files. Use
it when the native one-sync-handle-per-file OPFS layout would approach a browser or process limit.

## Requirements

- Run PGlite in a worker scope where an actual `createSyncAccessHandle()` open succeeds. Chromium and
  Firefox grant it in dedicated workers and deny it in SharedWorkers. Real macOS and iOS Safari grant
  it in SharedWorkers (full boot/persist/reopen verified 2026-07-21). Method presence is not proof.
- Do not run the database on the window main thread. Playwright WebKitGTK denies synchronous handles
  in both worker kinds and exercises the IndexedDB fallback; that is not evidence against real Safari.
- Give each database its own otherwise-empty OPFS directory. The package owns the directory in full.
- Use a PGlite build containing the upstream initdb filesystem-cleanup fix until that fix is available
  in a release. The storage package does not depend on fork-only durability state.

The package itself accepts an OPFS directory handle and does not choose a worker topology. For a
cross-browser pgxsinkit app, prefer `@pgxsinkit/client`'s
[capability-driven worker mode](/concepts/worker-mode/): it probes the SharedWorker, runs directly there
on Safari, and elects a dedicated engine worker on Chromium and Firefox.

## Create and close

`createOpfsRepackedPGlite` is the only supported construction path:

```ts
import { createOpfsRepackedPGlite } from "@pgxsinkit/pglite-opfs-repacked";

const root = await navigator.storage.getDirectory();
const directory = await root.getDirectoryHandle("my-database", { create: true });

const pg = await createOpfsRepackedPGlite({
  directory,
  durability: "relaxed",
  extentSize: 64 * 1024,
  pglite: {
    // Normal PGlite options, including extensions.
  },
});

try {
  await pg.exec("SELECT 1");
} finally {
  await pg.close();
}
```

The factory owns PGlite's `dataDir`, `fs`, and `relaxedDurability` fields and rejects them inside
`pglite`. It retains the filesystem adapter, performs a strict sync after successful initialization,
and closes every acquired handle after failed initialization or shutdown.

## One durability authority

The VFS option is the only physical-durability choice:

- `"relaxed"` is the default. Ordinary awaited host syncs assert health and perform any due deferred
  repack without physically flushing routine work. Termination may lose an unflushed suffix, while
  recovery keeps the longest valid metadata-log prefix and never exposes bytes from an earlier extent
  owner.
- `"strict"` flushes arena data before metadata on every awaited host sync. Successful query return is
  a strict boundary.

PGlite always uses its awaited host path. A non-awaited host argument raises
`DurabilityModeMismatchError` and poisons the live instance; it is a construction error, not an
override. Successful initialization, repack activation, and close from an open instance always use
strict ordering in either mode.

## Extent and directory identity

For a new store, `extentSize` accepts 8 KiB–16 MiB in 8 KiB increments and defaults to 64 KiB. An existing
store's identity is authoritative. Supplying another valid value raises `ExtentSizeMismatchError`
without changing it.

The directory contains exactly `arena.bin`, `metadata-a.bin`, `metadata-b.bin`, and `activation.bin`.
An extra entry or wrong entry kind raises `UnexpectedStoreEntryError` before owned content changes. A
second live owner raises `StoreOwnedError`.

## Recreate after a format change

Each package build accepts one exact format identity. On `StoreRecreationRequiredError`, close every
owner, remove the complete dedicated directory, and create a fresh one:

```ts
await pg.close();
await root.removeEntry("my-database", { recursive: true });
```

Do not copy individual owned files into the fresh directory. `CorruptStoreError` means the activated
authority is invalid; restore an external backup or recreate. The VFS fails closed rather than guessing
another authority.

## Failure boundaries

The guaranteed model covers worker, tab, process, and browser termination; unflushed writes may be
absent, partial, or independently present; completed flushes remain stable. It does not promise
recovery after power loss, media failure, arbitrary external edits, or mysteriously missing activated
files.

All storage errors expose stable classes. Store-level errors carry a string `storeCode`; wrapped errors
retain `cause`. `StoreFailedError` means the live instance is poisoned: close and reopen, then inspect
its cause. See the [generated API reference](/api/pglite-opfs-repacked/readme/) for the complete error
surface.
