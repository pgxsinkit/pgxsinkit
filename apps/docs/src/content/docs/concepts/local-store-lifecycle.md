---
title: Local store lifecycle
description: Reset or delete local stores deliberately — drop the read cache, destroy a running store supervised, or destroy a dead store's artifacts by path.
sidebar:
  order: 10
---

The sync engine keeps a real database in the browser. Three purpose-named levers reset or delete it,
and they are **not interchangeable** — each answers a different question. Pick by what you want to
keep and whether the store is running.

## Which lever to use

| You want to…                                             | Store state     | Use                           |
| -------------------------------------------------------- | --------------- | ----------------------------- |
| Keep the store, drop synced rows, and resync in place    | running         | `client.dropReadCache()`      |
| Delete this store entirely, from a client attached to it | running         | `client.destroy()`            |
| Delete a store nobody is attached to, by path            | **not** running | `destroyStoreArtifacts(path)` |

### `client.dropReadCache()` — resync in place

Clears the synced read cache and re-fills it from the server; the store, its schema, the optimistic
overlay, and the mutation journal survive. This is the "my synced data looks wrong, start the read
path over" lever — nothing local-only is lost. It serialises through the same lifecycle slot as
exports, so it can never interleave a running backup.

### `client.destroy()` — supervised destruction of a running store

The attached client's own destroy: it first asks the worker for the attached-tab count and **refuses
with `StoreDestroyRefusedError` while peer tabs hold the store**, checks the journal for owed
mutations (refused unless `force`), quiesces the engine (SW-direct teardown is acknowledged before
anything is deleted), then removes every artifact. Use it for "delete my data" flows initiated from a
signed-in, attached client.

### `destroyStoreArtifacts(storePath)` — a dead store, by path

The path-addressed companion for stores **nobody is attached to**: obsolete paths a preference change
left behind, wipe flows enumerating known paths, cleanup of stores whose client is long gone. It
removes the full artifact set — the OPFS store directory, the commitment sentinel, the meta record,
**and** the IndexedDB database — backend-agnostic (delete-if-present on both), with a bounded retry
around the OPFS delete for VFS ownership-lock lag.

Its precondition is documented, not probed: called on a path a live engine still holds, the delete
throws the ownership error after the bounded retry — loud, and **safely re-runnable** (the sequence is
idempotent and phase-recorded; a store marked `deleting` is refused for boot, so a re-run completes
the destruction). Keep failed paths on your own retry list and try again next boot. An idb-only sweep
of `indexedDB.databases()` is **not** a substitute — it leaks the OPFS arena, which is where the bulk
of an opfs-backed store lives.

### `quiesceStoreWorker(worker)` — by-path teardown, the destroy companion

`destroyStoreArtifacts`' "not running" precondition is documented, not probed — so on a backend that
keeps its connection held while its worker lives, you must MAKE the store not-running first.
`quiesceStoreWorker(worker, opts?)` is that lever: give it a worker factory of the same shape
`attachSyncClient` takes (`() => new SharedWorker(url, { name: storePath })` — the library stays
DOM-free), and it reaches the store's SharedWorker by name, posts the storage declaration, queries
placement, and tears the engine home down **by path**. For an SW-direct home (idbfs, real-Safari
opfs) it sends `engine-teardown` and **awaits** the reserved ack the host posts only after it has
stopped the engine and released the backend connection — resolving `{ engineHome, toreDown: true }`.
For an elected home it resolves `{ engineHome, toreDown: false }` and sends nothing: the elected
dedicated engine dies with its owning tab, so its store is already released.

Why it matters is a backend split. OPFS releases its sync-access handles when the engine goes idle,
so an obsolete opfs path is deletable soon after its last document leaves. **idbfs does not** — PGlite
holds its IndexedDB connection for the engine's whole life, and the board's workers are
`extendedLifetime` (they outlive their spawning document), so an idbfs predecessor keeps `deleteDatabase`
`blocked` across a reload until the browser reaps the worker. Quiescing it first releases the
connection so the very next destroy wins.

Compose the two, best-effort:

```ts
await quiesceStoreWorker(() => new SharedWorker(url, { name: storePath })).catch(() => {});
await destroyStoreArtifacts(storePath);
```

The `.catch` is deliberate: a quiesce timeout is **not** proof of teardown (the promise rejects on a
`timeoutMs` deadline, default 6s), and it must not abort the destroy — `destroyStoreArtifacts`' own
ownership-lag retry then reports honestly, leaving a still-held path on your retry list for next boot.
Omit `storage` (no opinion) so a worker bound to an older declaration is never refused. It is
idempotent and safe on an already-dead store (a fresh spawn boots no engine; its teardown closes an
empty host), so call it unconditionally on every obsolete path — see ADR-0050.

## The preference-change pattern: fresh path + background destruction

A store's [storage declaration](/concepts/worker-mode/#the-storage-declaration-on-the-wire-adr-0050)
(backend, durability) is **immutable** — bound at first contact, refused on conflict (ADR-0050). So a
runtime storage toggle never re-homes an existing store. The pattern, as the board demo implements it:

1. **Obsolete first, atomically.** Under your cross-tab lock, drop every store binding and record the
   dropped **exact store paths** on an obsolete list. This runs _before_ the new preference is
   written, so an interruption leaves dropped bindings under the old preference — never old paths
   bound under the new one.
2. **Write the preference and reload.** The fresh boot mints new stores under fresh random paths;
   they bind the new declaration on first contact.
3. **Quiesce-then-destroy obsolete paths in the background.** At each boot, walk the obsolete list
   and, per path, **tear the store's worker down** with `quiesceStoreWorker` (best-effort) before
   `destroyStoreArtifacts` — fire-and-forget, never awaited on the sign-in path. The teardown step is
   what makes idbfs converge: an `extendedLifetime` idbfs predecessor holds its IndexedDB connection
   across the reload, so a bare destroy would sit `blocked` forever; quiescing releases the connection
   so the destroy wins immediately. A path still held after a failed quiesce simply **stays listed**
   for the next boot's retry; the list itself is the resume state. No retirement barrier — the only
   thing said to the old worker is the by-path `engine-teardown`, and even that is best-effort.

Back up before you purge: [`exportStore()`](/concepts/export-and-restore/) produces the lossless
tarball a later `restoreFrom` boot can seed a fresh store from — including a store you are about to
obsolete.
