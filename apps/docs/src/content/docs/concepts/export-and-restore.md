---
title: Export & restore
description: Get the local store out — a lossless backup, a support dump, or portable SQL — and boot a fresh client from a backup.
sidebar:
  order: 9
---

The sync engine holds a real database in the browser: your synced read cache, the optimistic overlay,
and the mutation journal. Three purpose-named exports let you get that data **out**, and a restore boots
a fresh client back **in** from a backup. They matter most in worker mode, where `client.pglite` is
deliberately unreachable — these methods are the only supported door to the store.

Every export resolves to `{ file, report }`: a named `File` you can download or persist, and a structured
`report` carrying phase timings and a snapshot of the mutation journal at export time.

## Which export to use

Pick by what you need the artefact **for** — the three differ in format, fidelity, and where they load.

### Store backup — `exportStore()`

A full-fidelity, PGlite-restorable tarball of the **whole** local store: synced cache, overlay, and the
mutation journal, unflushed writes included.

```ts
const { file, report } = await client.exportStore();
// file: <storeId>-<timestamp>.pgdata.tar.gz  (application/x-gzip)
```

- **Lossless.** The journal travels _inside_ the artefact, so nothing staged is dropped.
- **Offline-safe.** It never blocks and needs no network. It is the **only** lossless export a device
  with unflushed writes can take while offline.
- **PGlite-only.** It restores into a pgxsinkit client via [`restoreFrom`](#restore), not into a
  general-purpose Postgres.

Use it for device backup and migration — carry a user's whole local store to a new device without losing
work in flight. Pass `{ compression: "none" }` for an uncompressed tar, or `{ fileName }` to override the
generated name.

### Diagnostic dump — `exportDiagnostics()`

Human-readable SQL of **everything** the store holds — synced tables, the overlay and journal, the
read-model views, the reconcile machinery, and the engine's own metadata — exactly as the store holds it.

```ts
const { file } = await client.exportDiagnostics();
// file: <storeId>-<timestamp>-diagnostics.sql  (application/sql)
```

Use it as **support evidence**: attach it to a bug report so someone can read a misbehaving store as-is,
unflushed writes and all. It is evidence to read, not an artefact to restore from.

### Data export — `exportData()`

The **portable** artefact: the synced tables and the enum types they depend on — schema and data, and
nothing of pgxsinkit's machinery — as SQL that loads into a vanilla Postgres (`psql -f`).

```ts
const { file, report } = await client.exportData();
// file: <storeId>-<timestamp>-data.sql  (application/sql)
```

Use it for **data portability** — hand the synced data to a plain Postgres, free of overlay, journal,
views, and reconcile functions.

Unlike the other two, `exportData` **guards the journal**. A portable dump reflects only synced rows, so
an unflushed write would silently vanish from it — including an acknowledged write whose synced echo has
not yet landed (it still lives only in the overlay). To avoid quietly losing work, `exportData` requires a
**drained** journal:

- On a **clean** journal it exports immediately.
- On a **dirty** journal it flushes what it can and waits for convergence, bounded by
  `drainJournal: { timeoutMs }` (drain is on by default).
- A journal in a state that cannot drain — `failed`, `quarantined`, or `conflicted` — **fails fast** with
  a `DataExportDrainError` carrying the diagnostics, rather than waiting out a timeout it cannot beat.

The escape hatch is explicit:

```ts
// Export the synced state as-is; unflushed local writes are omitted.
const { file, report } = await client.exportData({ drainJournal: false });
// report.escapeHatch === true records that the drain was skipped.
```

An offline device with a clean journal exports strictly and instantly. An offline device with a **dirty**
journal cannot produce a strict data export — its lossless option is the store backup.

## One at a time

The three exports and the destructive lifecycle operations (`destroy`, `discardEphemeral`,
`dropReadCache`) all serialise through a single slot, so a wipe or rebuild can never interleave a running
export and corrupt the artefact. A second lifecycle operation attempted while one is in flight rejects
immediately with a typed `LifecycleBusyError` (naming what it collided with) rather than queueing — a
fresh artefact is better served by retrying once the first settles. Exports wait out a boot rather than
rejecting during one, so you can call them straight after construction.

## Restore

Boot a brand-new client on a store backup by passing the backup file to `restoreFrom`:

```ts
const client = await createSyncClient({
  registry,
  electricUrl,
  batchWriteUrl,
  storePath: "my-app-store",
  restoreFrom: backupFile, // a File or Blob from exportStore()
});
```

Four rules keep a restore safe:

- **Fresh target across both backends.** Restore boots a new store; it never overlays a live one. The target
  check covers both IndexedDB and the OPFS commitment/store namespace, even if the current engine would choose
  only one of them. Any existing authority raises `RestoreTargetExistsError`. Destroy the existing store first,
  then restore into the now-empty path.
- **Online iff the recovered journal is clean.** If journal recovery finds **nothing to quarantine** —
  an empty recovered journal, e.g. a server-generated bootstrap artifact — the restore boots **online**
  and resumes sync straight away (honouring `syncEnabled`/`autoSync`, exactly like a normal boot). If the
  backup carried unflushed writes, the restore boots **offline** so nothing flushes before you have
  inspected what came back. An explicit `syncEnabled: false` keeps any restore offline.
- **Recovered journal is quarantined.** Every unflushed write recovered from the backup is moved to
  `quarantined`, never auto-flushed: the write path has no mutation dedupe, so blindly replaying a
  recovered write is not safe.
- **You decide, then go online.** When there ARE quarantined writes, inspect `client.diagnostics()`, then
  for each one either discard it (`discardQuarantined`) and re-author the edit, or handle it as your app
  sees fit. Going back online is the ordinary read path resuming — reconstruct the client without
  `restoreFrom` on the next boot — not a special catch-up mode. (A clean-journal restore skips this step
  entirely: it is already online.)

In worker mode, `client.destroy()` is supervised rather than a normal RPC: it refuses peer tabs with
`StoreDestroyRefusedError`, refuses owed mutations unless `{ force: true }`, closes the engine, and deletes
both backend namespaces through a resumable `deleting` phase. A crash resumes that deletion on the next boot.

## A note on ephemeral data

Tables you declare with `retention: "ephemeral"` live as temporary (`pg_temp`) objects. **`pg_dump`
ignores temporary objects**, so ephemeral rows never appear in a diagnostic dump or a data export — the
two SQL artefacts.

The store backup is a datadir tarball rather than a `pg_dump`, so it is worth being precise about it:
measured against a live backup, ephemeral **row data does not spill into the tarball**, and an ephemeral
table is not visible in a store restored from it (a temporary relation is session-scoped and cannot be
resolved by a fresh session). If you use ephemeral retention to keep sensitive rows off durable storage,
that intent holds across all three exports.

For the exact contracts these methods honour, see the
[design decisions](/decisions/) (ADR-0035 for the exports and restore; ADR-0036 for the store path).
