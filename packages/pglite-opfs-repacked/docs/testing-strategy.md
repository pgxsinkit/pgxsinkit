# OPFS-repacked testing strategy

This document maps the normative contract to executable coverage. Test names below are stable
substrings; a renamed or removed test must update this map in the same change.

## Coverage layers

| Contract area                                                                                                  | Primary coverage                                                                                            |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Pure planning, replay, validation, path bounds, and allocator partition                                        | `pglite-opfs-repacked-state.test.ts`, including the multi-seed reference-filesystem command sequences       |
| Canonical formats, bounded readers, writer/reader closure, and projected-base sizing                           | `pglite-opfs-repacked-codec.test.ts`                                                                        |
| Bootstrap, exact activation authority, longest-valid-log-prefix recovery, and recreate-only identity rejection | `pglite-opfs-repacked-recovery.test.ts`                                                                     |
| Data-before-metadata operations, zero barriers, strict ordering, and poison                                    | `pglite-opfs-repacked-operations.test.ts`                                                                   |
| Two-repack quarantine, projected replacement, forced-strict activation, and quota retry                        | `pglite-opfs-repacked-repack.test.ts`                                                                       |
| Port operation labels and browser-failure persistence outcomes                                                 | `pglite-opfs-repacked-port.test.ts` and `pglite-opfs-repacked-fault-campaign.test.ts`                       |
| PGlite construction, awaited host sync, cleanup, and poison delivery                                           | `pglite-opfs-repacked-adapter.test.ts` and `pglite-opfs-repacked-workload.test.ts`                          |
| Actual OPFS handles and worker, tab, and browser termination                                                   | `tests/e2e/opfs-repacked/opfs-repacked.browser.test.ts`                                                     |
| Synchronous broker wire protocol, chunking, errno pass-through, per-client fd ownership, and detach            | `pglite-opfs-repacked-broker-operations.test.ts`, `-broker-transport.test.ts`, `-broker-lifecycle.test.ts`  |
| Commit durability across a crash at a chosen store call, through the PGlite factory, both durability modes     | `pglite-opfs-repacked-crash-reopen.test.ts` (see [Crash and reopen](#crash-and-reopen-through-the-factory)) |

The broker suites run both thread arrangements deliberately. `-broker-operations` and
`-broker-transport` put the store and the blocking `serveForever()` loop in a Worker and block the
CLIENT on the test thread, which is the production shape (a coordinator worker with futex-parked
backends); bun permits `Atomics.wait` on the test thread, so no inversion is needed. `-broker-lifecycle`
inverts it — the broker runs the async `serve()` loop on the test thread and the clients block inside
Workers — because those cases assert on the SERVER's own state (which descriptors it still holds,
which clients it still serves), and that also proves `serve()` services a client with no coordinator
worker anywhere.

The generated fault campaign discovers every persistent `write`, `truncate`, and `flush` occurrence
from the deterministic port's immutable operation inventory. At both 8 KiB and 64 KiB it injects
short writes, throw-before, partial-then-error, and full-then-error outcomes, then terminates with all
effects absent, all full, arena-only, metadata-only, or partial-write decisions. Its oracle checks
stable bytes, valid-prefix recovery, allocator counts, absence of cross-owner aliases, exact repack
authority, and poison where an ambiguous live continuation is forbidden: every failed metadata append,
strict-sync flush, and arena write that made no progress. (Until 2026-09-25 the metadata-append arm
named a label the store never uses, `txn.append`, so it checked nothing; it names
`metadata.log.append` now.)

## Normative fault matrix

|   # | Scenario                                                           | Named regression(s)                                                                                                                                                                                                                           |
| --: | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | Orphan replacement, close, allocation, strict sync, termination    | `open orphans pin quarantine until closure across physical replacements`                                                                                                                                                                      |
|   2 | Relaxed unlink, attempted reuse, zero barrier, termination         | `a relaxed unlink never permits destructive reuse before two replacements`                                                                                                                                                                    |
|   3 | Free, one replacement, termination                                 | `termination after one replacement recovers the extent still quarantined`                                                                                                                                                                     |
|   4 | Free, two replacements, reuse, termination before allocation frame | `termination before a post-repack allocation frame leaves durable zero residue harmless`                                                                                                                                                      |
|   5 | Projected tail trim with arena flush failure                       | `arena flush failure cannot publish a projected tail reclamation`                                                                                                                                                                             |
|   6 | Inactive metadata partial write or flush failure                   | `every pre-activation persistence failure leaves the exact live state retryable`; generated repack campaign                                                                                                                                   |
|   7 | One invalid and one valid digest-matched activation slot           | `one invalid activation slot still requires the valid slot to match its selected base`; `integrity-invalid envelopes never classify version-looking bytes as another format`                                                                  |
|   8 | Two invalid activation slots                                       | `two invalid slots activation layout fails closed without owned-file mutation`                                                                                                                                                                |
|   9 | Equal or non-consecutive activation sequences                      | `equal sequences activation layout fails closed without owned-file mutation`; `non-consecutive sequences activation layout fails closed without owned-file mutation`                                                                          |
|  10 | Two slots name the same metadata file                              | `the same metadata file activation layout fails closed without owned-file mutation`                                                                                                                                                           |
|  11 | Selected activation mismatches its base                            | `selected activation must exactly match metadata identity, generation, end, and digest`; `inactive partial metadata is ignored but a corrupt selected base never falls back`                                                                  |
|  12 | Full CRC-invalid final frame                                       | `streaming replay truncates a full invalid frame and every later byte only after validation`                                                                                                                                                  |
|  13 | Invalid frame followed by valid bytes                              | `streaming replay truncates a full invalid frame and every later byte only after validation`                                                                                                                                                  |
|  14 | Ambiguous activation write or flush                                | `an ambiguous activation write poisons and reopen selects one exact authority`; `activation flush errors poison and reopen resolves whether the flush took effect`                                                                            |
|  15 | Huge CRC-valid transition                                          | `a CRC-valid huge transition is discarded before arena growth`                                                                                                                                                                                |
|  16 | Many valid frames at the hard limit                                | `many small frames stop at the hard frame bound with fixed-size streaming reads`                                                                                                                                                              |
|  17 | Metadata append partial or persisted-then-error                    | `ambiguous metadata append reopens at either complete transaction boundary`; generated ordinary campaign                                                                                                                                      |
|  18 | Data write partial-then-error                                      | `extending writes commit and return only the known positive prefix`; `writeFile commits a known partial file then surfaces the underlying failure`; generated ordinary campaign                                                               |
|  19 | Shrink, reopen, extend                                             | `cross-extent data, descriptor offsets, and zeroed extension persist`                                                                                                                                                                         |
|  20 | Shrink, extension-zero failure, retry                              | `a failed extension zero barrier leaves the old size and retry exposes only zeros`                                                                                                                                                            |
|  21 | Shrink, extend, termination with unflushed gap zeros               | `termination after shrink and unflushed extension never exposes pre-shrink bytes`                                                                                                                                                             |
|  22 | Frame or projected-base limit rejection before mutation            | `active-log exhaustion rejects mixed operations before arena mutation`; state-machine limit and projected-size tests                                                                                                                          |
|  23 | Recursive mkdir strict reopen                                      | `recursive mkdir strict reopen preserves exact mode and timestamps`                                                                                                                                                                           |
|  24 | `__proto__`, root, mode zero, invalid numbers                      | `recursive mkdir records every choice and replays to exactly the same state`; `the path parser treats root explicitly and rejects non-canonical paths`; `invalid numeric inputs are rejected without state mutation`                          |
|  25 | Pre-activation partial bootstrap residue                           | `canonical partial bootstrap residue is reset and completed`; `every bootstrap write prefix is restartable or a complete initial activation`                                                                                                  |
|  26 | Empty metadata with arena payload                                  | `empty metadata with arena extent payload fails closed instead of bootstrapping`                                                                                                                                                              |
|  27 | Extra or wrong-kind directory entry                                | `the production port rejects extra entries before creating or acquiring owned files`                                                                                                                                                          |
|  28 | Integrity-valid identity for another format                        | `integrity-valid unsupported identities win over trailing layout corruption`                                                                                                                                                                  |
|  29 | Integrity-invalid envelope with version-looking bytes              | `integrity-invalid envelopes never classify version-looking bytes as another format`                                                                                                                                                          |
|  30 | 8 KiB and 64 KiB creation profiles                                 | complete parameterized codec, recovery, operation, and repack suites; all generated and seeded-random crash-fault campaigns                                                                                                                   |
|  31 | Invalid extent size                                                | `invalid extent sizes reject before any port operation or store mutation`                                                                                                                                                                     |
|  32 | Omitted extent option                                              | `bootstraps and reopens through RepackedVfs at extent size %i`                                                                                                                                                                                |
|  33 | Conflicting supplied extent option                                 | `directory ownership, exclusive ownership, extent options, and size failures reject cleanly`                                                                                                                                                  |
|  34 | Quarantine pressure grows immediately and defers replacement       | `quarantine pressure is deferred while normal allocation grows immediately`                                                                                                                                                                   |
|  35 | Quota exhaustion permits exactly two replacements and one retry    | `arena quota exhaustion runs exactly two inline repacks and retries allocation once`                                                                                                                                                          |
|  36 | Quota retry failure does not loop                                  | `a failed quota retry performs no third repack and leaves the operation uncommitted`                                                                                                                                                          |
|  37 | Relaxed ordinary write performs no ordinary flush                  | `awaited relaxed sync asserts health without flushing ordinary writes`; generated ordinary campaign                                                                                                                                           |
|  38 | Strict arena-before-metadata ordering                              | `strict sync flushes dirty arena before metadata and stops on the first error`                                                                                                                                                                |
|  39 | Replacement activation and relaxed close force strict ordering     | generated repack campaign; `relaxed close forces a strict barrier, attempts every close, and preserves the first flush cause`                                                                                                                 |
|  40 | Single explicit durability interface                               | adapter public-surface conformance plus `a non-awaited host sync poisons on first observation`                                                                                                                                                |
|  41 | Failure during acquisition and host initialization                 | `every partial production-port acquisition failure releases the handles already acquired`; retained-adapter regressions for `BaseFilesystem.init`, WASM startup, `initialSyncFs`, initdb, engine initialization, and extension initialization |
|  42 | Deferred-repack poison reaches a cache-only query                  | `a due deferred repack failure poisons the triggering sync and the next cache-only query`                                                                                                                                                     |
|  43 | Close from failed state performs cleanup only                      | `strict sync failure poisons and failed close skips persistence`; `an awaited durability failure rejects its query, poisons cache-only queries, and still closes every handle`                                                                |
|  44 | Host passes `true` to `syncToFs`                                   | `a non-awaited host sync poisons on first observation`                                                                                                                                                                                        |
|  45 | Unsupported integrity-valid arena identity                         | `integrity-valid unsupported identities win over trailing layout corruption`                                                                                                                                                                  |
|  46 | Missing, short, or integrity-invalid activated arena header        | `activated stores reject missing, short, or integrity-invalid arena headers without mutation`                                                                                                                                                 |
|  47 | Same-version arena/metadata extent identity mismatch               | `same-version arena and selected metadata extent identities must agree`                                                                                                                                                                       |
|  48 | Multiple close failures                                            | `relaxed close forces a strict barrier, attempts every close, and preserves the first flush cause`; `failed-init cleanup attempts every close, preserves its first cause, and is idempotent`                                                  |
|  49 | Arena data write without progress, or failed metadata append       | `an arena write that makes no progress poisons with a coded failure that every later call repeats`; `normal rejection appends nothing and an ambiguous append poisons`; generated ordinary campaign                                           |

## Browser and host termination lanes

The browser lane uses production Vite bundles, a dedicated worker, Chromium, and actual OPFS sync
access handles. It covers hard worker termination after a strict boundary, tab closure, persistent
profile browser close/restart, relaxed-prefix recovery, and an injected real-handle flush failure
followed by a cache-only query. The structural wrapper used for the last case delegates all storage
operations to real OPFS handles and exists only in the browser test bundle.

`relaxed worker termination after N commits and before the next sync reopens every returned commit on
disk` runs in a persistent profile, so the handles write real files: eight relaxed commits, the last
seven past any metadata flush, then `worker.terminate()`, and a fresh worker finds all eight, intact,
with an index scan agreeing with a sequential scan.

The PGlite workload test exercises transactions, updates, deletes, concurrent submitted reads,
constant four-handle ownership, strict close, and exact reopen through the package factory. No test in
this package claims completed-flush protection from power loss, media failure, or external edits.

## Crash and reopen through the factory

`pglite-opfs-repacked-crash-reopen.test.ts` answers what a client finds after the worker dies between a
commit and the store's next sync. `test/support/crash-opfs.ts` is the platform: the directory the
factory's `OpfsRepackedPort` talks to, numbering every call the store makes. A kill at call `k` freezes
the platform's persistent state there (a write at `k` may tear) while the process runs on, so the
engine closes instead of leaking. Each frozen state is materialized four ways: **applied** (everything
the platform accepted — a terminated worker), **flushed** (nothing unflushed survived — the most
pessimistic image the contract admits), and the two mixes (**arena-applied**, **metadata-applied**).
Each distinct image is reopened by the store alone (recovery must replay exactly the complete metadata
frames the image holds) and through the factory (the table must be a commit prefix, an index scan must
equal a sequential scan, every payload must be the one written, `verify_heapam` and
`bt_index_check(heapallindexed)` must be clean, and the store must take a new commit and a clean close).

The workload is PGlite on a strict-closed seed, 64 KiB extents: commits c1–c8 insert a row each, commit
9 inserts 2,000 rows in one statement (8 MB of arena writes, over the 4 MiB amortization threshold), an
explicit `strictSync()`, then c10–c12. The promise asserted first is the floor — strict: every commit
that returned before the power died; relaxed: every commit the last strict boundary covered (a
`strictSync()`, a repack activation, a close). Every image met it. What each image showed (commits
visible: applied / flushed / arena-applied / metadata-applied) is then asserted exactly, as
documentation:

| Power dies in                                  | strict: dying step, images       | relaxed: dying step, images                 |
| ---------------------------------------------- | -------------------------------- | ------------------------------------------- |
| c5's WAL write, torn in half                   | c5 — 4 / 4 / 4 / 4               | c5 — 4 / 4 / 4 / 4                          |
| c5's metadata append naming its heap extension | c5 — 5 / 4 / 5 / 4               | c5 — 5 / 4 / 5 / 4                          |
| c5's metadata append, torn in half             | c5 — 5 / 4 / 5 / 4               | c5 — 5 / 4 / 5 / 4                          |
| after the append, before the flush             | c5 (arena flush) — 5 / 4 / 5 / 4 | c6 (c5 returned, unflushed) — 5 / 4 / 5 / 4 |
| between c5's arena flush and metadata flush    | c5 — 5 / 5 / 5 / 5               | —                                           |
| after the flush: c5 returned                   | c6 — 5 / 5 / 5 / 5               | —                                           |
| c8 returned, before the next sync              | bulk — 8 / 8 / 8 / 8             | bulk — 8 / 4 / 8 / 4                        |
| the bulk's middle arena write, torn in half    | bulk — 8 / 8 / 8 / 8             | bulk — 8 / 8 / 8 / 8                        |
| after the bulk's last append, before its flush | bulk — 9 / 8 / 9 / 8             | bulk (amortization flush) — 9 / 8 / 9 / 8   |
| after that flush: the bulk returned            | c10 — 9 / 9 / 9 / 9              | strictSync (metadata flush) — 9 / 9 / 9 / 9 |
| `strictSync()` returned                        | —                                | c10 — 9 / 9 / 9 / 9                         |
| c12 returned, before close                     | close — 12 / 12 / 12 / 12        | close — 12 / 9 / 12 / 9                     |

No image was unrecoverable, torn frames were never replayed, and no image showed a partially applied
page (`data_checksums=on` verifies every page the scans and `amcheck` read). What the table documents
beyond the promise:

- **The arena alone decides.** In every row applied = arena-applied and flushed = metadata-applied.
  PGlite's WAL segment is preallocated and written in place, so no WAL record needs a metadata frame to
  be found, and redo re-extends any relation whose growth the metadata log lost. Unflushed metadata
  lost no commit here. (Not covered: a WAL segment switch, which creates and renames a segment file
  through the metadata log.)
- **A terminated worker keeps every commit that returned**, in both modes, plus a dying commit whose WAL
  write completed (c5 at its append; the bulk before its flush) — visible, never acknowledged.
- **Relaxed without unflushed writes keeps every commit written before the last arena flush of any
  kind**, not only the last strict boundary: a zero barrier (allocating a reused extent flushes the
  arena) made c2–c4 durable during c5 and c5–c8 durable during the bulk; the arena-only amortization
  flush alone made the bulk recoverable. Its loss window is the commits since the last arena flush
  (c5–c8 at "c8 returned"; c10–c12 at "c12 returned").
- **`fsync=off` changes nothing for PGlite**, which always boots Postgres with `-F` and never forwards a
  guest fsync to the store: both columns are its only behaviour. A pgrust host that stops forwarding
  guest fsyncs as store-wide strict syncs moves its relaxed stores from the strict column's boundaries
  (one per WAL flush) to the relaxed column's.

A rejected store lever (arena growth in 4 MiB chunks, coalesced extent writes, skipping zero writes
past the high-water mark, holding metadata appends until the next sync) must pass this file: the
structural locators fail loudly if a commit's WAL-write/append/flush shape changes, and the images must
still meet the floor; a changed observation must be re-recorded here deliberately.

**Fixed (2026-09-25): a transient platform write failure inside a commit could be acknowledged.** Found
by this file. When an arena write made no progress the store rethrew the platform's own error without
poisoning. PGlite's filesystem bridge (`tryFSOperation`) maps a thrown error to an errno only if it has
a truthy numeric `code`, and its main loop (`execProtocolRawSync`) ran `_PostgresMainLoopOnce()` inside a
catch that swallowed everything but its longjmp sentinel. So a plain `Error`, or a `DOMException` whose
legacy code is 0 (`UnknownError`), thrown by the commit's WAL write unwound Postgres out of `XLogWrite`
and vanished: the statement resolved, strict's sync flushed a store that never received the WAL, and a
reopen did not have the commit. A coded error (`QuotaExceededError`, legacy code 22, which PGlite read
as the errno `EFBIG`) failed the commit, but the engine then spun forever on its next statement, a
synchronous loop that makes no platform call.

The store half. An arena write the platform rejected before confirming a byte, and a failed metadata-log
append, now poison the store and throw `StoreFailedError` (`code` 29, `EIO`, the platform's error as
`cause`), and every later call throws the same until close (README "Durability", matrix row 49).
Through PGlite, Postgres gets `EIO` in `XLogWrite`, PANICs, and the commit rejects with `could not write
to log file …: I/O error`; nothing reaches the platform after the failed write; every image reopens
without the commit. `strict: a transient platform write failure in a commit's WAL write fails the commit
and poisons the store` asserts all of it for an uncoded `DOMException`, a plain `Error`, and a coded
`DOMException`. One consequence is pinned by `an awaited durability failure rejects its query, poisons
cache-only queries, and still closes every handle`: a query that reaches a poisoned store now fails
with Postgres's own I/O error (SQLSTATE 58030), where the store's exception used to be swallowed and
the failure surfaced only at the host sync.

The PGlite half is a fix in the `@pgxsinkit/pglite` fork after 0.5.8-pgx.1. The main loop fails the
instance on any exception that is not the Emscripten unwind or longjmp it uses for Postgres errors, so
the failing statement rejects naming the cause, every later statement throws that failure at once, and
`close()` releases the filesystem without running the aborted engine's shutdown; `tryFSOperation`
maps an error without a code to `EIO`. Until the pin moves past 0.5.8-pgx.1 the statement after such a
failure still spins, synchronously, so no test timeout can catch it: `strict: after a failed WAL write
the next statement throws the same failure and close releases every handle` stays `test.todo` until
then.

Still open on 0.5.8-pgx.1: the store's retryable platform failures (zero barriers, arena growth, reads)
surface the platform's own error and do not poison, by design (rows 4 and 20, `ambiguous fresh arena
growth leaves no metadata and is safely retryable`). A PGlite statement that hits an uncoded one is
still swallowed by that host's main loop; the fork fix reports it to Postgres as `EIO`.

## Conformance record — 2026-07-21

- The systematic deterministic-port campaign passed at both 8 KiB and 64 KiB: 175 focused tests and
  6,633 assertions across the codec, operation, repack, recovery, adapter, workload, and generated
  fault suites. The generated campaign includes seeded random command, fault, termination, and
  durability sequences. Every one of the 48 normative rows above names its executable regression.
- The actual-OPFS Chromium lane passed all five hard-termination and poison-delivery cases: worker
  termination, tab closure, persistent browser restart, relaxed-prefix reopen, and a real-handle flush
  failure delivered to the causing and next cache-only queries.
- Host regressions prove the factory's initial strict barrier, one awaited sync per serialized query,
  terminal non-awaited-mode detection, deferred-repack poison delivery, and handle cleanup after
  `BaseFilesystem.init`, WASM startup, initial sync, initdb, engine-init, and extension-startup
  rejection. Lifecycle regressions prove cleanup attempts every handle and close from a poisoned
  instance performs no persistence.
- The shared browser benchmark passed its recorded sequential, random, transaction-latency, and bulk
  write targets in Chromium 149 and Firefox 151 for both extent profiles and durability modes. The
  awaited-host boundary added 0.0386 ms/query in the 5,000-query diagnostic. Recovery, allocator,
  replacement, heap, zero-barrier, space, flush, and handle budgets are executable in
  [`performance.md`](./performance.md).
