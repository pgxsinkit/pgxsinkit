# OPFS-repacked testing strategy

This document maps the normative contract to executable coverage. Test names below are stable
substrings; a renamed or removed test must update this map in the same change.

## Coverage layers

| Contract area                                                                                                  | Primary coverage                                                                                      |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Pure planning, replay, validation, path bounds, and allocator partition                                        | `pglite-opfs-repacked-state.test.ts`, including the multi-seed reference-filesystem command sequences |
| Canonical formats, bounded readers, writer/reader closure, and projected-base sizing                           | `pglite-opfs-repacked-codec.test.ts`                                                                  |
| Bootstrap, exact activation authority, longest-valid-log-prefix recovery, and recreate-only identity rejection | `pglite-opfs-repacked-recovery.test.ts`                                                               |
| Data-before-metadata operations, zero barriers, strict ordering, and poison                                    | `pglite-opfs-repacked-operations.test.ts`                                                             |
| Two-repack quarantine, projected replacement, forced-strict activation, and quota retry                        | `pglite-opfs-repacked-repack.test.ts`                                                                 |
| Port operation labels and browser-failure persistence outcomes                                                 | `pglite-opfs-repacked-port.test.ts` and `pglite-opfs-repacked-fault-campaign.test.ts`                 |
| PGlite construction, awaited host sync, cleanup, and poison delivery                                           | `pglite-opfs-repacked-adapter.test.ts` and `pglite-opfs-repacked-workload.test.ts`                    |
| Actual OPFS handles and worker, tab, and browser termination                                                   | `tests/e2e/opfs-repacked/opfs-repacked.browser.test.ts`                                               |

The generated fault campaign discovers every persistent `write`, `truncate`, and `flush` occurrence
from the deterministic port's immutable operation inventory. At both 8 KiB and 64 KiB it injects
short writes, throw-before, partial-then-error, and full-then-error outcomes, then terminates with all
effects absent, all full, arena-only, metadata-only, or partial-write decisions. Its oracle checks
stable bytes, valid-prefix recovery, allocator counts, absence of cross-owner aliases, exact repack
authority, and poison where an ambiguous live continuation is forbidden.

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

## Browser and host termination lanes

The browser lane uses production Vite bundles, a dedicated worker, Chromium, and actual OPFS sync
access handles. It covers hard worker termination after a strict boundary, tab closure, persistent
profile browser close/restart, relaxed-prefix recovery, and an injected real-handle flush failure
followed by a cache-only query. The structural wrapper used for the last case delegates all storage
operations to real OPFS handles and exists only in the browser test bundle.

The PGlite workload test exercises transactions, updates, deletes, concurrent submitted reads,
constant four-handle ownership, strict close, and exact reopen through the package factory. No test in
this package claims completed-flush protection from power loss, media failure, or external edits.

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
