# `opfs-repacked` — a packed, recreate-only OPFS VFS for PGlite

Status: accepted (2026-07-20) — amended by [ADR-0049](0049-capability-driven-engine-placement.md)
(2026-07-21): "hosting topology is a consumer decision outside this package" is superseded — the
toolkit now owns engine placement (capability-probed SharedWorker-direct on WebKit, Web-Locks-elected
tab worker on Chromium/Firefox) and `opfs-repacked` becomes the primary browser store on all three
platforms. The still-open full-engine-in-real-Safari-SharedWorker question below is closed: the
2026-07-21 real-device runs returned `granted-and-persisted` with SharedWorker-direct timings within
noise of the dedicated-worker column.

Browsers meter OPFS synchronous access handles, and a PostgreSQL data directory is far wider than
the tightest meter: a PGlite datadir is 971 files (measured), so upstream `opfs-ahp`'s
one-open-handle-per-file design plus its handle pool holds on the order of 1070 handles — while
WebKit is reported to cap live sync-access handles near 252 per origin (real-device verification
outstanding; see [Engine capability rationale](#engine-capability-rationale) for the measured
status of every claim). A one-handle-per-file OPFS VFS therefore cannot host PostgreSQL on every
target engine.

`opfs-repacked` removes the ceiling by construction: every virtual file of the datadir is packed into
a **constant four** OPFS files. This ADR is the normative contract for that VFS — its on-disk
protocol, crash model, durability guarantees, allocation policy, lifecycle, and version policy. It is
a greenfield design; nothing preceding it shipped, and no compatibility with any prior experiment
exists or may be added.

Vocabulary is governed by the package's bounded context
([`packages/pglite-opfs-repacked/CONTEXT.md`](../../packages/pglite-opfs-repacked/CONTEXT.md)):
the metadata-rebuild operation is a **repack**, the append-only frame sequence is the **log**, and
PostgreSQL's own storage/recovery terms (checkpoint, WAL, page) are banned inside this context.

## Decision

### 1. Package and shape

`@pgxsinkit/pglite-opfs-repacked` in `packages/pglite-opfs-repacked/`. One deep operational seam
(`RepackedVfs`) behind a PGlite `Filesystem` adapter (`OpfsRepackedFS`); a pure state
machine (planners + one reducer); a narrow persistent port (`RepackedPort`) implemented by the real
OPFS adapter and by a deterministic in-memory fault-injection adapter. The core never imports browser
OPFS types. Public exports are exactly: the adapter, its validated creation options, stable typed
errors, and the required PGlite factory helper. The factory is the sole supported construction seam
and derives the host and VFS configuration from one validated options object; direct adapter
construction is unsupported. `createOpfsRepackedPGlite({ directory, extentSize?, durability?,
pglite? })` is that seam: it owns the host filesystem fields, defaults to 64 KiB extents and relaxed
VFS durability, and completes one strict sync before returning. Its typed instance
(`OpfsRepackedPGlite`) additionally exposes the reserved `strictSync()` operation for the sync
layer. No mutable state, apply methods, counters, or repack internals are exported; test hooks live
on the memory port only.

### 2. Owned files and whole-directory ownership

The store owns an entire dedicated directory containing exactly four files:

```text
arena.bin        8 KiB fixed header, then all extent payload bytes, written in place
metadata-a.bin   metadata generation: base + its own append-only log
metadata-b.bin   the alternate metadata generation
activation.bin   two alternating activation slots — the sole authority
```

Every owned file carries the format identity: `arena.bin` begins with a fixed 8 KiB header (magic,
format version, extent size, limits-profile version, header checksum); extent `k` occupies
`[8 KiB + k·extentSize, 8 KiB + (k+1)·extentSize)`, keeping extents 8 KiB-aligned. The open
sync-access-handle count is a constant four.

Bootstrap and open follow one fixed acquisition protocol: (1) enumerate the whole directory without
mutation — any entry that is not one of the four owned filenames, or an owned name with the wrong
entry kind, is `UnexpectedStoreEntryError`; (2) create/get and exclusively acquire `activation.bin`
first — its exclusive sync-access handle is the store ownership lock, and losing the race is
`StoreOwnedError`; (3) re-enumerate under the lock and re-reject unknown entries; (4) acquire or
create the remaining three handles in a fixed order (`arena.bin`, `metadata-a.bin`,
`metadata-b.bin`), recording every acquisition immediately for failed-init cleanup. Two racing
initializers can therefore never each hold a subset of the four handles.

Acquisition may materialize an absent owned filename as an empty file. Classification treats empty
and absent owned files identically, so this cannot turn a corrupt or unsupported layout into a
bootstrap layout: an activated store with a missing file remains corrupt. Requirements for no
mutation on a rejected open mean no owned-file **content** mutation; creating an empty owned file
during fixed acquisition is permitted.

### 3. Permanent recreate-only version policy

The on-disk version is an exact identity check, never a negotiation. An implementation reads and
writes exactly one format version; any package-owned file identifying a different version stops the
open before owned-file content mutation with `StoreRecreationRequiredError`. The only transition to a
different format is: close all handles, delete the complete store directory, create it empty,
initialize fresh. The lifecycle owner performs that destruction explicitly; `open()` never
auto-deletes.

A version mismatch is recognized only from an integrity-valid store-identity envelope: the arena
header, a complete metadata base, or a complete activation slot. Version-looking bytes in an
integrity-invalid activation slot or incomplete metadata candidate do not identify a format; they
remain subject to the existing bootstrap and activation-slot rules. A transaction frame's version is
not a store identity and is always governed by the log prefix rule. This is classification
precedence, not a second identity preamble or format layer.

No codebase revision may contain an earlier decoder, upgrade chain, converter, read-through fallback,
import of prior bytes, dual write, or any other preservation mechanism. **This applies to every
future format version without exception.** When the format changes, the sole implementation changes
wholesale.

### 4. Crash model A (normative)

The correctness contract covers process, worker, tab, and whole-browser termination, occurring
between any two persistent-port effects.

- A successfully completed `flush()` is stable for all later terminations.
- Writes not covered by a completed flush may be absent, partially present, or independently present
  across the owned files.
- A write or flush that *reports failure* may nevertheless have persisted everything it was asked to;
  such ambiguity follows the poison/reopen rules.
- Power loss, device-cache behavior after a completed flush, and media failure are outside the
  contract.
- Checksums are integrity **detectors** only: damage to an activated base or an activation record
  fails closed absolutely. The unactivated log suffix is instead governed by the log prefix rule
  (below) — under this crash model an unflushed suffix can persist in any partial combination, so an
  invalid suffix is never distinguishable from a lost relaxed tail. Checksums never repair bytes,
  never select an alternate activated generation, and never expand the crash model.

The memory port and every crash-fault test implement exactly this model; no test may assume a
stronger one.

### 5. Metadata authority: two generations plus an activation manifest

Each metadata file holds a fixed version-1 header, one deterministic binary base payload, an
integrity checksum, an exact base-end offset, and zero or more append-only transaction frames (magic,
version, generation, monotonic transaction sequence, record type, exact payload length, payload,
CRC). Replay is streaming and governed by the **log prefix rule**: the recovered log is the longest
prefix of valid frames; the first invalid frame — bad envelope, magic, CRC, sequence, generation,
type, or semantics — terminates the prefix, and it plus all following bytes are discarded regardless
of whether its declared envelope fits within EOF. This is forced by crash model A: an unflushed
append may persist a full-length frame with partial contents, or lose a frame while a later append's
bytes persisted, so no unactivated log suffix is ever grounds for fail-closed corruption. External
or media corruption of an unactivated suffix is explicitly indistinguishable from a lost relaxed
tail and is outside the crash model. Within crash model A the prefix rule never discards a frame
covered by a completed flush, so the strict guarantee is unaffected; fail-closed remains absolute
for the activated base and the activation manifest. The discarded suffix may be physically truncated
only after full semantic validation. The codec is canonical binary: exact integers, real maps, no
permissive coercion, and the same codec functions serve live persist, recovery, and tests.

`activation.bin` holds two alternating slots (magic/version, activation sequence, selected file A|B,
selected generation, base digest, exact base-end offset, record checksum). Repack writes the inactive
slot only after the new metadata file is durable. Recovery uses this exact procedure:

1. Decode and checksum both slots independently.
2. Both valid → require distinct **consecutive** activation sequences referencing **opposite**
   metadata files; select the higher, then require its referenced base to match identity,
   generation, base-end offset, and digest exactly. Same-sequence, non-consecutive, or same-file
   pairs are `CorruptStoreError`.
3. Exactly one valid → the invalid slot is the interrupted overwrite permitted by crash model A;
   select the valid slot only after the same exact base match.
4. Neither valid → only the canonical fresh/interrupted-bootstrap layout is acceptable; anything
   else is `CorruptStoreError`.
5. A selected slot whose referenced base is invalid fails closed (the log is governed by the prefix
   rule, never fail-closed). Recovery never falls back to the other slot and never selects a
   metadata file by apparent generation.

Fresh initialization is legal only when all four owned files are empty or absent. A pre-activation
layout is restartable bootstrap residue only when there is no valid activation, `arena.bin` contains
no extent payload and is at most a partial or complete version-1 header, neither metadata file
contains a complete non-bootstrap base, and neither file extends beyond the fixed empty-root
generation-1 candidate envelope, and `activation.bin` does not extend beyond its fixed two-slot
envelope. Any integrity-valid identity in this layout must be version 1; arbitrary bytes outside
these bounds fail closed. Nothing is authoritative before the first valid activation, so this
narrowly classified residue may be reset under the ownership lock.

Bootstrap uses this exact durable sequence:

1. Classify the layout as fresh or restartable bootstrap residue under the ownership lock.
2. Reset `arena.bin`, write the canonical 8 KiB version-1 header, and flush it.
3. Reset `metadata-a.bin`, write the fixed empty-root generation-1 base, and flush it.
4. Reset `metadata-b.bin` to empty.
5. Reset `activation.bin`, write the fixed initial activation record selecting `metadata-a.bin`, then
   flush `activation.bin`.
6. Install the decoded empty-root state and enter `OPEN`.

Termination before step 5 completes leaves either restartable pre-activation residue or a fully
persisted valid initial activation. Once a valid initial activation exists, ordinary activated-store
recovery applies and bootstrap never resets the store.

### 6. One metadata transaction engine

Every metadata-changing operation follows one path: parse/validate → **plan purely** (deterministic
`TxnRecord` with all IDs, timestamps, extents resolved; a prevalidated delta; a list of permitted
pre-commit data actions) → perform safe pre-commit data work (touching only available extents or
bytes beyond the visible EOF, dirty-flag set first) → **append one complete frame** (the commit
point) → apply the single reducer. Live commit and replay run the same reducer; there are no
parallel apply/fixup implementations. Any metadata append error is terminal: the instance poisons
rather than pretending to know whether the append persisted; reopen resolves the final frame. A
reducer failure after append also poisons and preserves the append.

Timestamps and IDs are generated in the planner and encoded in the frame; replay never consults
time, randomness, or the environment.

**Live coalescing exception.** As a live-commit optimization, consecutive growing `resizeFile`
records for one inode may be held as a single in-memory pending frame whose allocation runs merge on
replacement; the reducer still applies each admitted transition immediately. The pending frame is
appended — always with its originally reserved sequence number, ahead of any other record — before
any commit of a different record or inode, before every flush of the active metadata file, before
every repack projection, and at every awaited sync boundary. For a deferred record the commit point
is that materialization; the append-error poison rule applies there unchanged. Recovery semantics
are unaffected: an unmaterialized pending tail recovers to the last materialized size, which crash
model A already permits for any lost relaxed tail, and log accounting (bytes, frames, sequence)
counts the pending frame as written throughout.

**Encoding closure.** A transaction is exactly one frame, permanently — multi-frame transactions
are forbidden. To keep every valid operation inside that format: records encode only live
**choices** (allocated extents as compact runs, new inode IDs, timestamps, modes) and never
state-derivable sets — the extents freed by an unlink, truncate, or rename-replacement are derived
by the reducer from staged state, so releases encode in constant size and can never be rejected for
encoded size. Planners preflight the exact encoded frame size *and* the projected metadata-base
size before any data mutation; per-operation allocation is capped so that POSIX short-write
semantics absorb oversized writes, and the residual otherwise-valid operation that cannot fit is
rejected with `StoreLimitError` before anything changes. The same closure holds for bases: no
planner-admitted state may exceed the base writer soft limit, so every reachable state remains
repackable. Quarantine tags use the same fixed-width field whether untagged or generation-tagged, so
aging cannot increase an entry's encoded size. The planner maintains a simple running projected-base
size using the canonical codec's size rules; property tests require that count to equal the actual
canonical encoding length.

### 7. Allocation: partition, two-repack quarantine, grow-first

Every extent below `totalExtents` is in exactly one of `owned`, `available`, or `quarantine`
(validated as a full partition). Freed extents (unlink, whole-extent truncation, replacement,
orphaning) enter quarantine untagged; the repack projecting generation `G+1` tags untagged entries
`G+1`, and promotes entries tagged `≤ G` to `available` — because that repack overwrites the other
metadata file, both retained generations then exclude the old owner. An extent therefore survives
**two repacks** before reuse, and recovery can never resurrect an owner whose bytes were handed to
someone else. Reused extents receive one durable zero barrier before any frame may name them — even
when the incoming payload would cover the extent — so a lost relaxed frame exposes zeros, never a
previous owner's bytes.

Allocation is grow-first: consume `available`, else grow the arena; it never waits for quarantine to
age. Quarantine/reusable-space pressure queues a **deferred** repack — deferred describes scheduling,
not concurrency: the VFS and its synchronous OPFS handles live on one worker, and a running repack
blocks all filesystem calls until it completes. The only inline pressure path is quota exhaustion on
arena growth: exactly two inline repacks, then exactly one allocation retry, then the quota error.

Unlinking an open file removes its directory entry and inode in one transaction and quarantines its
extents; the descriptor keeps a runtime orphan record. Rename over an open destination is the second
orphan source and follows the identical rule. Growing an orphan first logs a `reserveQuarantine`
frame; closing an orphan needs no persistent mutation; a repack never serializes a crash-dead
orphan.

The closed `TxnRecord` union is defined only after a complete inventory of the pinned host's
`BaseFilesystem` operations (a Phase 1 gate in the plan), classifying each operation as
metadata-only/data-only/mixed, extent-creating/retiring, orphan-capable, partial-success or not,
and record-bearing or not.

Shrink never zeroes (it releases whole trailing extents to quarantine and changes only metadata
size); every later extension zeroes the complete newly visible gap, and for any newly visible range
inside **pre-existing** arena storage — which may hold pre-shrink bytes — the zeroing must be
written *and arena-flushed* before the size-committing frame is appended, exactly like the
reused-extent barrier; fresh tail growth beyond the arena's end needs no flush, since unwritten
regions read as zeros. Extending writes commit only the size and extents covered by the
successfully written prefix.

### 8. Repack

Repack is a forced-strict state transition on a projection — it never mutates live state before
durable activation: project `G+1` (with quarantine aging), validate, encode the candidate base, flush
dirty arena bytes, truncate/write/flush the inactive metadata file, write/flush the next activation
slot, then install the projected state and switch the log cursor. Failure before the activation write
leaves the store usable and the repack retryable; an error while writing or flushing activation is
ambiguous and poisons. Post-activation tail trim of available arena tail is best-effort physical
reclamation only — its failure is a space leak, never state divergence. Triggers: elapsed time,
active-log bytes, active-log frames, quarantine/reusable-space pressure (deferred), and approach to
any writer soft limit.

### 9. Durability construction contract

`durability: "relaxed" | "strict"`, chosen once at construction, **default `"relaxed"`**; never a
per-call flag. Relaxed does not *require* a flush for ordinary log/arena writes; its recovery
guarantee is a valid transaction prefix with no cross-owner byte exposure. The implementation may
flush the arena opportunistically (amortized batching of accumulated dirty bytes) to bound
repack-time flush latency — extra flushes never weaken or reorder the contract. Strict flushes
arena before metadata at the sync boundary and propagates every error. Regardless of mode: repack activation and close-from-OPEN
always run the strict sequence, and one explicit `strictSync()` — reserved for the sync layer above
the VFS — is the sole public strict operation. The strict-success guarantee: after a strict sync
returns, all preceding data and metadata are recoverable together.

**One durability authority.** The VFS construction option is the sole physical-durability
authority; PGlite's `relaxedDurability` flag carries no durability meaning in this design. The
package's required factory helper always constructs the host with `relaxedDurability: false`, so the
host awaits `fs.syncToFs()` after every query, and the awaited call either performs the constructed
mode's work (strict flush, or relaxed health-assert with no flush) or rejects into the calling
query. This separates the two concerns the host boolean conflates — whether the host awaits
synchronization and whether synchronization physically flushes. The host's per-call
`syncToFs(relaxedDurability)` argument becomes a defense-in-depth assertion that the host is
actually awaiting: an observed `true` means a mis-wired construction and is a terminal
`DurabilityModeMismatchError` that poisons the instance, never a silent override.

### 10. Lifecycle, poison delivery, and host requirements

Lifecycle: `NEW → INITIALIZING → OPEN → CLOSING → CLOSED`, with `FAILED` reachable from
initialization and operation; `FAILED` latches the first terminal cause, and every public operation
except close/failed-init cleanup checks lifecycle state first. Cleanup is idempotent and closes every
handle acquired at any point of host/WASM/initdb startup.

Close is state-dependent: from `OPEN`, close performs the forced strict sync and then exhaustive
cleanup; from `FAILED`, close attempts **no** persistence — no sync, no metadata commit, no repack —
performing exhaustive cleanup only and preserving the original terminal cause. Any queued deferred
repack is cancelled (or reduced to a lifecycle-checked no-op) before handles close, in every path.

The package requires **no fork-only host behavior**; poison delivery and failed-init cleanup are
met from package-owned code against plain upstream PGlite semantics, and the one host *bugfix* the
package relies on (transaction-end synchronization, below) is upstream-pending and fork-carried in
the interim. Poison delivery: because the factory
constructs the host with `relaxedDurability: false`, the host awaits `fs.syncToFs()` after every
top-level query — including queries PostgreSQL could serve from its buffer cache — so a durability
failure rejects the query that caused it, latches `FAILED` in the VFS, and fails every later public
query/sync at the VFS health assertion. Buffer-cache-only queries cannot continue after durability
is lost, with no host-side latch. The host must also end every `transaction()` — resolved or
rejected — with that same awaited synchronization rather than running its terminal
`COMMIT`/`ROLLBACK` under the in-transaction sync suppression; this is a plain host correctness
requirement, not fork-only behavior. The required fix is fork-carried in the pinned host while its
upstream PR is open, and the package deliberately ships **no** local workaround for it — dependence
on pending-upstream bugfixes carried by the pinned fork is the one permitted reliance class,
distinct from the forbidden fork-only machinery. Statements *within* an open transaction reach
poison through the VFS's own health assertion on their filesystem operations rather than through an
awaited sync. Failed-initialization cleanup: the factory constructs and retains
the adapter itself and, on any `PGlite.create()` failure (synchronous throw or rejection), invokes
the adapter's idempotent `cleanupFailedInit()` directly — the adapter owns all four handles, so no
host hook is involved. The fork's non-exclusive rejection latch is offered upstream as a generic
swallowed-rejection bugfix; if it ships, detached relaxed host sync becomes an optional performance
mode, but correctness never depends on it and no fork-only host machinery may be referenced.

### 11. Limits profile 1 and integer rules

One shared limits module feeds constructor validation, planners, codecs, replay, and repack. The
version-1 profile (recorded in the metadata header; **changing any reader hard limit is a format
change** and therefore a recreate):

- extent size: 8192-byte multiple in [8 KiB, 16 MiB]; creation default **64 KiB**; header
  authoritative on reopen (`ExtentSizeMismatchError` on a conflicting valid option, argument
  `TypeError` on a malformed one).
- arena header: fixed 8192 bytes with an integrity checksum; extent offsets are always relative to it.
- generation, activation sequence, transaction sequence, inode ID, extent ID: unsigned 64-bit,
  internally `bigint`. The transaction sequence is generation-local and restarts at each repack;
  generation, activation sequence, and `nextInodeId` are monotonic for the life of the store, and
  approaching any of their hard limits is a typed `StoreLimitError` whose only remedy is recreation
  — repack cannot repair them. Extent IDs are bounded by `totalExtents`, not by a separately
  exhaustible persistent counter.
- path component ≤ 255 UTF-8 bytes; full path ≤ 1024 bytes; depth ≤ 32; names reject empty, `/`,
  NUL, `.`, `..`, invalid UTF-8.
- metadata base payload: reader hard 64 MiB (writer soft 32 MiB); frame payload hard 1 MiB;
  active-log bytes hard 16 MiB (soft 8 MiB); active-log frames hard 32768 (soft 16384).
- inodes ≤ 65536; extents per inode ≤ 2^20; total extents ≤ 2^22.
- every add/multiply/offset is computed exactly (bigint where needed) and bounds-checked before any
  conversion to a JavaScript `number` or handle call; no decoder allocates from an unvalidated
  length.

Writer soft limits trigger repack; reaching a hard limit without a successful repack is a typed
`StoreLimitError`, never an oversized record. Reopen never resets a persisted exhausted counter.

### 12. Error taxonomy

`FsError` (normal filesystem rejection, non-terminal), `StoreLimitError`,
`StoreRecreationRequiredError` (version mismatch; complete drop is the only remedy),
`CorruptStoreError` (activated bytes fail integrity/semantics; fail closed), `StoreOwnedError`
(exclusive handles unavailable), `UnexpectedStoreEntryError`, `ExtentSizeMismatchError`,
`DurabilityModeMismatchError` (terminal mis-wired host construction: a non-awaited host sync was
observed), `StoreFailedError`
(poisoned; carries first cause), `StoreClosedError`. An integrity-valid identity envelope carrying an
unsupported version is `StoreRecreationRequiredError`; a missing, short, or integrity-invalid arena
header in an activated store is `CorruptStoreError`; disagreement among integrity-valid same-version
store headers is `CorruptStoreError`; and a caller option conflicting with an internally consistent
store is `ExtentSizeMismatchError`. Corruption and terminal durability errors are never flattened
into a plain `EIO`; messages name the real remedy.

## Engine capability rationale

The four-handle design rests on these engine facts. **Measured 2026-07-20** with the committed
probe suite (`bun run probe:engines`, source in `scripts/probes/engine-capabilities/`; raw output
is host-specific and goes untracked to `tmp/results/`): Linux 7.0.0, Playwright 1.61.1 — Chromium
149.0.7827.55, Firefox 151.0, WebKitGTK 26.5.

**Confirmed by probe:**

- A PGlite datadir is **971 files** after initdb (measured against the pinned fork); upstream
  `opfs-ahp` holds one open sync-access handle per file plus an approximately 100-handle pool by
  construction, so a live store needs on the order of 1070 handles.
- Every OPFS-capable engine probed grants `createSyncAccessHandle` in dedicated workers (Chromium,
  Firefox).
- Chromium and Firefox deny it in SharedWorkers — the method is absent from
  `FileSystemFileHandle.prototype` in that context.
- Only Firefox permits a SharedWorker to spawn a nested worker.
- Held-handle contention throws `NoModificationAllowedError` on Chromium and Firefox.
- Firefox holds at least 1200 concurrent sync-access handles without a cap.

**Confirmed on real devices — 2026-07-18 probe campaign (Safari 26.5/macOS, Safari 18.7.6/iOS).**
Playwright's WebKitGTK 26.5 exposes no OPFS at all, so no WebKit claim is testable on this Linux
host. The WebKit facts below are NOT third-party reports: they were JSON-confirmed on real devices
during the predecessor packed-VFS campaign, whose probe page was served to the devices (record
preserved in the pre-squash ADR-0048 on branch `saved_develop_before_squash`):

- **WebKit grants `createSyncAccessHandle` inside SharedWorker scope** on both the macOS and iOS
  lines — probed by actually opening a sync-access handle in a SharedWorker, not by method
  presence. The mechanism is WebKit's `FileSystemFileHandle.idl` declaring the method
  `Exposed=Worker` (every worker scope), where Chromium and Firefox restrict it to dedicated
  workers.
- The **~252 per-origin sync-access-handle ceiling** — the fact that disqualifies `opfs-ahp` on
  WebKit regardless of worker topology.
- Held-handle contention throws **`InvalidStateError`** on WebKit (vs `NoModificationAllowedError`
  on Chromium/Firefox): ownership fencing must treat both names as the store-already-owned signal.
- The predecessor packed VFS booted a persistent PGlite on all four probed engines
  (dedicated-worker context; warm opens ≈ 0.3–0.5 s desktop, ≈ 3 s iPhone).

**Still open — a full engine inside a real-Safari SharedWorker.** The handle grant is confirmed,
but a complete PGlite-on-packed-VFS boot in SharedWorker scope has never had a green automated run:
the predecessor's single macOS GitHub-Actions attempt (2026-07-20, Playwright's WebKit port — not
Safari proper) failed the VFS boot with a transient `UnknownError`. The check vehicle is the
storage bench's phase-0 **SharedWorker-direct proof** (`apps/perf-lab`, published at `/bench/`):
every run stages `probe → boot → write → close → reopen → verify → cleanup` inside a SharedWorker
and records the outcome in the results envelope (`sharedWorkerProof`, with a per-stage error
attribution and a one-line verdict) — opening `/bench/` on a real macOS/iOS Safari and running the
suite answers this question; on Chromium/Firefox the same phase re-verifies the denial. None of
this constrains the format: the four-handle design does not depend on the exact WebKit cap (any
plausible cap far exceeds four), and hosting topology is a consumer decision outside this package.

**Established — reproducible only in a real desktop Chrome session.** On default Linux installs
(e.g. Ubuntu 26.04), Chrome launches under the desktop session's 1024 `nofile` soft limit, the
zygote is forked under that restriction, and Chrome refuses to raise it dynamically; the
profile-wide storage service then *queues* sync-access-handle creation forever near ~950 open
handles instead of rejecting — a catch-proof, profile-wide wedge. This was proven by instrumented
bisection on deployed Chrome (2026; limit 1024 → stall near 950, limit raised → the full ~1070-handle
`opfs-ahp` flow runs clean). Automation-launched Chromium **cannot** reproduce it — our probe's
Playwright launches (including an `RLIMIT_NOFILE`-hard-clamped child) held 1200 handles cleanly
because the launch path bypasses the session-limited zygote environment. Do not re-litigate this
claim with harness-launched browsers; the probe's negative result measures the launch path, not the
wedge.

## Alternatives rejected

1. **Copy-on-write / log-structuring every database write** — a simpler atomic story, but every
   routine 8 KiB PostgreSQL write would allocate a fresh extent and defer reclamation work,
   damaging write amplification, quota use, and repack latency. In-place arena writes with explicit
   metadata authority keep the hot path cheap; the two-repack quarantine plus zero barrier removes
   the aliasing/data-destruction class that in-place reuse would otherwise invite.
2. **Two bases plus one separate resettable log** — safe log reset requires cross-file generation
   inference. Housing each log with its base and activating through a manifest makes authority
   explicit and recovery decidable.

## Consequences

- **Costs.** A freed extent waits two repacks before reuse (bounded space amplification, reclaimed by
  deferred pressure repacks and post-activation tail trim); each physical ownership change pays one
  durable zero barrier; a running repack blocks the worker for its duration; relaxed mode can lose
  the most recent unflushed transactions (never consistency, never cross-owner bytes).
- **Benefits.** Constant four handles on every engine; in-place database writes; metadata-only
  repacks; streaming bounded recovery; a decidable single-authority recovery procedure; a version
  policy under which compatibility debt is structurally impossible.
- The normative test obligation (property suites, the crash-fault matrix, browser termination lanes,
  host poison delivery) is defined by the implementation plan's fault matrix; every row is mandatory
  named coverage.

## Implementation

[Plan 0048](../plans/0048-opfs-repacked-vfs.md) is the implementation plan for this ADR: phases 0–9
from contract freeze through final conformance, the normative fault matrix, and the definition of
done.
