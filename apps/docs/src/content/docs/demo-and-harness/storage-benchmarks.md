---
title: Storage benchmarks
description: A wa-sqlite-style, in-browser benchmark suite comparing pgwasm storage backends across timed SQL batteries.
sidebar:
  label: Storage benchmarks
---

pgxsinkit's local store runs on [pgwasm](/packages/pgwasm/). The benchmark suite compares three storage
backend columns:

- **`idb`** — IndexedDB, via pgwasm's IndexedDB filesystem (the universal fallback; works in every browser
  and context). Capability-enabled worker mode prefers `opfs-repacked`; fixed worker mode and the
  no-SharedWorker main-thread fallback remain on IndexedDB.
- **`opfs-repacked`** — the OPFS-repacked store (`@pgxsinkit/pgwasm/opfs`), which packs the data
  directory into a constant four OPFS handles, in a dedicated worker. It is default-ticked and supports both
  8 KiB and 64 KiB extent profiles.
- **`opfs-repacked-sw`** — the same store hosted directly in a SharedWorker, the topology worker mode uses
  on Safari. Default-ticked on WebKit; elsewhere it stays selectable behind a warning, because Chromium and
  Firefox grant sync access handles in dedicated workers only, and the column reports `unavailable`.

Earlier published runs also carry an **`opfs-ahp`** column: PGlite's one-sync-access-handle-per-file OPFS
filesystem, which needed ~1070 handles or file descriptors for a live store (against WebKit's ~252-handle cap
and Chrome/Linux's 1024 FD soft limit) — the reason `opfs-repacked` exists. pgwasm does not support that
filesystem, so the column is retired; its numbers below are kept as history.

The timed backend cells run in dedicated workers so each cell is isolated. Separately, phase 0 runs a
full OPFS-repacked boot, persist, and reopen inside a SharedWorker and records `sharedWorkerProof` in the
downloaded results envelope. That proof returned `granted-and-persisted` on real macOS and iOS Safari on
2026-07-21. Playwright WebKitGTK denies synchronous handles in both worker kinds; it is useful fallback
coverage, not a substitute for the real-Safari proof.

To make the storage choice evidence-based, the perf lab ships a **live, in-browser benchmark suite**, modelled
on [rhashimoto/wa-sqlite's benchmarks page](https://rhashimoto.github.io/wa-sqlite/demo/benchmarks.html): a
grid of timed SQL batteries (rows) across the storage backends (columns), with nothing but inline code — no
network, no framework.

Each **cell** (one battery × one backend) runs isolated in its **own short-lived dedicated worker**, spawned
fresh and terminated when the cell finishes, behind an **inactivity watchdog**: if a worker emits no progress
for 90 seconds it is assumed wedged, terminated, recorded in the grid as `hung`, and the suite moves on to the
next cell. Column order in the grid is fixed: `idb`, `opfs-repacked`, `opfs-repacked-sw`.

## Run it

**[Open the live storage benchmarks →](/bench/)**

Tick the batteries and backends you want and press **Run selected**. `idb` and `opfs-repacked` are
default-ticked everywhere; `opfs-repacked-sw` is default-ticked on WebKit and warned elsewhere.
Durability is _relaxed_ by default; the strict toggle measures the per-commit fsync/flush cost. The
OPFS-repacked backend lets you select either extent profile. The page is deliberately dependency-free so it
boots on a phone, including iPhone/Safari, where WebKit's OPFS behavior can differ from desktop engines.

Results **survive a page reload**: after every cell the current envelope is mirrored to `sessionStorage`, and
on the next load — unless the page is auto-running — it is restored into the grid behind a labelled notice.
This matters on iOS Safari, which can hard-reload the page under memory pressure once the suite has churned
enough stores, wiping the DOM before you read the numbers; a fresh **Run selected** overwrites the saved
envelope so stale results never masquerade as current. Add `?debug=1` to pass pgwasm's `debug: 1` option to every
store a cell opens, for tracing in the browser console, viewable via devtools or the Safari remote inspector.

### The batteries

| Battery                                      | What it times                                                                                                                                                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flush cost — per-op inserts × durability** | 200 sequential single-row INSERTs, once relaxed and once strict, per backend. Isolates flush cost with a mean / p50 / p95 / max envelope.                                                                                               |
| **Bulk writes**                              | The classic wa-sqlite pair on a ~6-column table: N rows in ONE transaction vs N rows each in its own autocommit statement.                                                                                                              |
| **Big-table reads**                          | Builds a ~50k-row indexed table, a ~30-column wide table and a ~100KB-text TOAST table once per backend, then times indexed point lookups, an index range scan, a full-table aggregate, an unindexed scan, a join and ORDER BY + LIMIT. |
| **Updates & deletes**                        | An indexed batch update, a wide-row update, and a bulk delete + reinsert.                                                                                                                                                               |

## Desktop findings

These are the numbers this machine produces under headless Chromium and Firefox. **They are a baseline, not
the target device** — the numbers that decide the storage choice come from a real iPhone/Safari run of the
live page.

**Flush cost (the headline).** `idb` under _strict_ durability is **~100–160× slower** than `idb` _relaxed_
(≈ 86.8 ms vs 0.80 ms per insert on Chromium; ≈ 158 ms vs 0.95 ms on Firefox), because every autocommit pays an
IndexedDB round trip. Both OPFS backends sit near 1–2 ms regardless of durability on desktop.

| Backend                  |    relaxed |     strict |
| ------------------------ | ---------: | ---------: |
| `idb`                    |   ~0.40 ms |   ~84.7 ms |
| `opfs-ahp` (retired)     |   ~0.91 ms |   ~1.06 ms |
| `opfs-repacked` (8 KiB)  | 1.4 ms p95 | 1.0 ms p95 |
| `opfs-repacked` (64 KiB) | 1.1 ms p95 | 0.8 ms p95 |

_(Chromium; strict `idb` is the ~100× cliff. Firefox shows the same shape, larger absolute strict cost.)_

**Bulk writes** show the same lesson at scale: batching 10k rows into one transaction runs at tens-to-hundreds
of thousands of rows/sec on every backend, while the per-statement autocommit path drops one to two orders of
magnitude — the single strongest argument for staging writes in a transaction.

**Big-table reads** are comfortably fast on all backends once the data is resident: indexed point lookups sit
around 0.4–2 ms each, and full 50k-row aggregates, unindexed scans, joins and ORDER BY + LIMIT all complete in
tens of milliseconds. On desktop the backends differ mainly in **fixture build time** (writing the 50k + wide +
TOAST rows) — a write-path difference, not a read-path one.
