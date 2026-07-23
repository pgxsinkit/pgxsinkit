# OPFS-repacked performance record

Measurements were taken on 2026-07-20 on Linux x86-64 with Bun 1.3.14, headless Chromium 149,
and Firefox 151. Browser results use actual OPFS sync-access handles and construct the database only
through `createOpfsRepackedPGlite`. The deterministic core profile uses the same `RepackedVfs` seam
with the in-memory persistence port so recovery and replacement work can be measured without browser
storage noise.

These are coarse regression budgets, not cross-machine promises. Correctness invariants take
precedence over every target.

## Targets and results

| Workload                                                            | Acceptance target | 8 KiB measured | 64 KiB measured |
| ------------------------------------------------------------------- | ----------------: | -------------: | --------------: |
| 128-frame warm recovery                                             |          <= 50 ms |         7.4 ms |          1.2 ms |
| 14,000-frame warm recovery                                          |         <= 500 ms |     128–134 ms |        93–95 ms |
| Recovery observed heap delta                                        |        <= 128 MiB |  10.4–12.5 MiB |        18.9 MiB |
| Replacement p95 over 15 samples                                     |         <= 300 ms |     124–126 ms |        86–94 ms |
| Replacement observed heap delta                                     |        <= 128 MiB |    <= 25.3 MiB |     <= 80.2 MiB |
| 32-extent ownership-change zero barrier                             |         <= 100 ms |     8.6–9.7 ms |    19.2–24.0 ms |
| 4,000-operation allocator per-op cost / 1,000-operation per-op cost |            <= 2.0 |           0.57 |    same profile |
| Open handle count                                                   |         exactly 4 |              4 |               4 |

The 14,000-frame store held 1,570,890 metadata-log bytes. Recovery streamed those frames; no
unbounded frame collection appeared. Repeated replacement encoded the current metadata base in
linear time. The allocator scaling ratio decreased rather than growing, so the measured path does
not exhibit O(n²) behavior. Heap figures are coarse process-wide observations sampled at operation
boundaries after collecting before the baseline; the 128 MiB budget deliberately accommodates
runtime collection timing rather than treating it as VFS-retained memory.

The ownership-change scenario held 32 extents in quarantine: 256 KiB at 8 KiB and 2 MiB at 64 KiB.
After two replacements and reuse, the arena remained at its 33-extent high-water mark, with zero
available and zero quarantined extents. Reuse issued exactly one zero-barrier flush. This is the
intended bounded space amplification: quarantine delays reuse but does not copy live arena data.

## Browser database results

The shared storage bench supports `--repacked-extent-size=8192|65536` and both durability modes. The
flush matrix times 200 individual insert transactions.

| Engine/profile   | Relaxed p95 | Strict p95 |  Target |
| ---------------- | ----------: | ---------: | ------: |
| Chromium, 8 KiB  |      1.4 ms |     1.0 ms | <= 5 ms |
| Chromium, 64 KiB |      1.1 ms |     0.8 ms | <= 5 ms |
| Firefox, 8 KiB   |      2.0 ms |     2.0 ms | <= 5 ms |
| Firefox, 64 KiB  |      2.0 ms |     2.0 ms | <= 5 ms |

Bulk-write targets are at least 15,000 rows/s for a 10,000-row transaction and at least 500 rows/s
for 2,000 separate autocommit statements. All four extent/durability trials passed:

| Engine/profile   | Relaxed one transaction | Strict one transaction | Relaxed autocommit | Strict autocommit |
| ---------------- | ----------------------: | ---------------------: | -----------------: | ----------------: |
| Chromium, 8 KiB  |           42,608 rows/s |          39,620 rows/s |       1,337 rows/s |      1,324 rows/s |
| Chromium, 64 KiB |           62,073 rows/s |          54,201 rows/s |       1,351 rows/s |      1,216 rows/s |
| Firefox, 8 KiB   |           23,364 rows/s |          23,256 rows/s |         774 rows/s |        779 rows/s |
| Firefox, 64 KiB  |           21,322 rows/s |          22,989 rows/s |         768 rows/s |        767 rows/s |

The random-write workload performs 200 indexed single-row updates, a five-column update across
1,000 wide rows, a 10,000-row delete, and a 10,000-row reinsert. Its targets are at least 500
indexed updates/s with p95 at most 5 ms, at least 10,000 wide-row updates/s, at least 100,000
deletes/s, and at least 10,000 reinserts/s. Every engine, extent, and durability trial passed:

| Engine/profile   | Mode    | Indexed updates/s (p95) | Wide updates/s | Deletes/s | Reinserts/s |
| ---------------- | ------- | ----------------------: | -------------: | --------: | ----------: |
| Chromium, 8 KiB  | relaxed |            603 (2.8 ms) |         17,730 |   281,690 |      33,322 |
| Chromium, 8 KiB  | strict  |            732 (1.6 ms) |         19,569 |   337,838 |      34,518 |
| Chromium, 64 KiB | relaxed |            689 (2.4 ms) |         21,834 |   636,943 |      47,214 |
| Chromium, 64 KiB | strict  |            673 (2.0 ms) |         25,253 |   420,168 |      37,821 |
| Firefox, 8 KiB   | relaxed |            573 (3.0 ms) |         12,821 |   156,250 |      15,408 |
| Firefox, 8 KiB   | strict  |            595 (3.0 ms) |         13,333 |   172,414 |      15,949 |
| Firefox, 64 KiB  | relaxed |            531 (3.0 ms) |         11,364 |   166,667 |      14,793 |
| Firefox, 64 KiB  | strict  |            588 (3.0 ms) |         14,085 |   172,414 |      15,106 |

The 5,000-query awaited-host diagnostic measured 0.1899 ms/query awaited versus 0.1514 ms/query for
the unsupported detached comparator: 0.0386 ms/query, or 25.47%. The acceptance budget is <= 0.1
ms/query added overhead. Detached host sync remains an optional future optimization only; correctness
does not depend on it.

## Commands

```sh
bun test tests/performance/pglite-opfs-repacked-core.perf.test.ts --timeout 180000
bun test tests/performance/pglite-opfs-repacked-await.perf.test.ts --timeout 120000
cd apps/perf-lab
bun run bench:storage --batteries=flush-matrix --backends=opfs-repacked --repacked-extent-size=8192
bun run bench:storage --batteries=bulk-write --backends=opfs-repacked --repacked-extent-size=65536 --strict
bun run bench:storage --batteries=update-delete --backends=opfs-repacked --repacked-extent-size=8192
```

These recorded trials predate the later performance pass. That pass added a 4 MiB runtime
amortization threshold, activity-gated replacement scheduling, coalesced resize tails, and dirty-flush
gating; it did not change extent selection, allocator policy, persistent format, or correctness
invariants. Both extent profiles met the recorded gates, and allocator and recovery scaling remained
bounded.
