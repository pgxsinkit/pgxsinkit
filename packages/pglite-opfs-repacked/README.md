# `@pgxsinkit/pglite-opfs-repacked`

A constant-handle OPFS filesystem for PGlite. It packs a complete virtual database directory into
four exclusively owned files, avoiding the per-virtual-file sync-access-handle growth of PGlite's
native OPFS filesystem.

The package is browser-only and must run in a worker scope where an actual
`createSyncAccessHandle()` open succeeds. Chromium and Firefox grant that capability in dedicated
workers but deny it in SharedWorkers. Real macOS and iOS Safari grant it in SharedWorkers (verified
2026-07-21 by a full boot, persist, and reopen). Never infer support from method presence, and do not
run the database on the window main thread.

This low-level package does not choose a worker topology. Cross-browser pgxsinkit apps should use
`@pgxsinkit/client` capability placement: it probes the SharedWorker, runs directly there on Safari,
and elects a dedicated engine worker on Chromium and Firefox. Playwright's WebKitGTK build is not a
proxy for real Safari here: it denies synchronous handles in both worker kinds and therefore exercises
the IndexedDB fallback.

## Construct a database

`createOpfsRepackedPGlite` is the only supported construction path. Give each store a dedicated,
otherwise empty directory:

```ts
import { createOpfsRepackedPGlite } from "@pgxsinkit/pglite-opfs-repacked";

const opfsRoot = await navigator.storage.getDirectory();
const directory = await opfsRoot.getDirectoryHandle("example-database", { create: true });

const pg = await createOpfsRepackedPGlite({
  directory,
  durability: "relaxed",
  extentSize: 64 * 1024,
  pglite: {
    // Normal PGlite options, including extensions, may go here.
  },
});

try {
  await pg.exec("SELECT 1");
} finally {
  await pg.close();
}
```

The factory owns PGlite's `dataDir`, `fs`, and `relaxedDurability` options. Supplying any of those
inside `pglite` throws. The returned PGlite instance owns the adapter; `close()` closes all four
handles even when shutdown reports an error.

## Durability

`durability` is selected once at construction and defaults to `"relaxed"`:

- `"relaxed"` does not run the per-query strict sequence. Routine boundaries assert health and may
  perform an extra arena-only amortization flush after at least 4 MiB of accumulated arena writes;
  a due repack still uses forced-strict activation. After termination, recovery returns the longest
  valid metadata-log prefix and never exposes bytes from an earlier extent owner.
- `"strict"` flushes arena data before metadata on every awaited host sync. A successful query has a
  stable strict boundary.

PGlite always runs with its awaited host path. Its sync boolean is not a second durability setting;
observing a non-awaited sync is a terminal `DurabilityModeMismatchError`. Successful initialization,
repack activation, and an open-state close always perform strict ordering regardless of the
selected mode.

The guaranteed failure model covers worker, tab, process, or browser termination, independently
present unflushed writes, and completed flushes remaining stable. It does not promise recovery from
power loss, media failure, arbitrary external edits, or missing files in an activated store.

## Extent size and directory ownership

`extentSize` is a creation-time option from 8 KiB through 16 MiB in 8 KiB increments; 64 KiB is the
default. On reopen, the stored value is authoritative. Supplying another valid value raises
`ExtentSizeMismatchError` without changing the store.

The dedicated directory is owned in full and contains exactly:

```text
arena.bin
metadata-a.bin
metadata-b.bin
activation.bin
```

An extra entry or an owned name with the wrong kind raises `UnexpectedStoreEntryError`. A second live
owner raises `StoreOwnedError`.

## Recreate-only format

Each build accepts one exact format identity. `StoreRecreationRequiredError` means close every live
instance, delete the complete dedicated directory, and create a fresh store. No package operation
copies bytes into the new format.

```ts
await pg.close();
await opfsRoot.removeEntry("example-database", { recursive: true });
```

`CorruptStoreError` instead means activated bytes no longer form a recoverable store. Restore an
external backup or delete and create fresh. The VFS never guesses another authority.

## Stable errors

Store errors expose a stable string `storeCode`; `FsError` carries PGlite-compatible numeric `code`,
plus optional `operation` and `path`. Wrapped errors retain their original `cause`.

| Error                          | Action                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `FsError`                      | Correct the path, descriptor, type, or flags; the store remains usable.           |
| `StoreLimitError`              | Free space, allow a repack, or recreate if the exhausted identity cannot advance. |
| `StoreRecreationRequiredError` | Delete the complete dedicated directory and create fresh.                         |
| `CorruptStoreError`            | Restore an external backup or recreate; opening fails closed.                     |
| `StoreOwnedError`              | Close the other live owner, then retry.                                           |
| `UnexpectedStoreEntryError`    | Use an empty dedicated directory.                                                 |
| `ExtentSizeMismatchError`      | Omit `extentSize` on reopen or supply the stored value.                           |
| `DurabilityModeMismatchError`  | Use the package factory; the live instance is poisoned.                           |
| `StoreFailedError`             | Close and reopen; inspect `cause` for the first terminal failure.                 |
| `StoreClosedError`             | Stop using the closed adapter.                                                    |

The package targets plain PGlite host semantics. Until the upstream initdb filesystem-cleanup fix is
available in a release, consumers need a PGlite build containing that fix; no fork-only durability
state is required.

See the [consumer guide](https://pgxsinkit.github.io/packages/pglite-opfs-repacked/), the
[worker-placement guide](https://pgxsinkit.github.io/concepts/worker-mode/), and
[ADR-0048](https://github.com/pgxsinkit/pgxsinkit/blob/main/docs/adr/0048-opfs-repacked-vfs.md).
