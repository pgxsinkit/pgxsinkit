# Plan — ADR-0048: `opfs-repacked` correctness-first implementation

Implements [ADR-0048](../adr/0048-opfs-repacked-vfs.md), which is the normative contract; this plan
is its phased implementation sequence, normative fault matrix, and definition of done.

> **NON-NEGOTIABLE VERSION POLICY — ZERO MIGRATION AND ZERO BACKWARDS COMPATIBILITY**
>
> `opfs-repacked` must never contain a reader, upgrader, converter, fallback, shim, dual-format path,
> data copier, or any other mechanism intended to preserve a store across an on-disk format change.
> Every format change is an unconditional destructive lifecycle break: the entire store is dropped and
> a completely empty store is created. This policy applies to every future version without exception.

> **GREENFIELD ONLY — NO DEPLOYMENT OR TRANSITION WORK**
>
> No earlier packed-store format is part of the supported `0.2.0` baseline. The discarded prototype is not
> an upgrade source. This plan contains no rollout,
> coexistence, interim-default, transition, or adoption mechanics.

Date: 2026-07-20  
Planning inputs: the correctness mistakes and invariant failures distilled into this document.  
Scope: design and implement a new packed OPFS VFS from first principles.

Package: `@pgxsinkit/pglite-opfs-repacked` in
`packages/pglite-opfs-repacked/`, with a greenfield source tree.

This is an implementation plan, not a review patch list. No source code was changed and no tests were
run while preparing it.

## Executive decision

Build `opfs-repacked` around an architecture consisting of:

1. one in-place arena;
2. two alternating metadata files, each containing a complete metadata base followed by its own
   append-only transaction log; and
3. one small activation manifest that identifies exactly which metadata file is authoritative.

The VFS will keep in-place arena writes for PostgreSQL performance, but all metadata changes will go
through one deterministic transaction planner/reducer. Freed extents will pass through a two-repack
quarantine before reuse. A repack will construct a new metadata generation without mutating live state
and will activate it only after the arena and new metadata are durable.

The selected design is intended to be a deep module: the public interface stays small while format
handling, recovery, allocation, fault handling, and repack ordering remain private. Tests
exercise the same core interface as the production OPFS adapter rather than reaching around it through
mutable internals.

## Permanent recreate-only version policy

The on-disk version is an exact identity check, not a compatibility or negotiation mechanism. An
implementation reads and writes exactly one format version. If any package-owned file identifies a
different version, opening stops before owned-file content mutation with
`StoreRecreationRequiredError`. A version is identified only by an integrity-valid store-identity
envelope: an arena header, complete metadata base, or complete activation slot. Version-looking bytes
in an incomplete or integrity-invalid identity envelope remain crash residue under its bootstrap or
activation-slot rule. A transaction frame's version is not a store identity and remains governed by
the log-prefix rule.

The only permitted transition to a different on-disk format is:

1. close all handles;
2. explicitly delete the complete `opfs-repacked` store directory;
3. create a new empty store directory; and
4. initialize the new version as a completely fresh VFS.

The lifecycle owner performs that destructive action explicitly. `open()` must never automatically
delete a mismatched store. No codebase revision may contain an earlier decoder, an upgrade chain, incremental or
in-place conversion, read-through fallback, import of prior bytes, dual writes, or preservation of
database contents. When the format changes, the sole implementation changes wholesale and the prior
format implementation is absent.

## Normative crash model A

The correctness contract covers process, worker, tab, and whole-browser termination. Termination may
occur between any two persistent-port effects, including after a write has changed bytes but before a
flush has completed.

- A successfully completed `flush()` is stable for all later process/browser terminations.
- Writes not covered by a completed flush may be absent, partially present, or independently present
  in different package-owned files.
- A write or flush that reports failure may nevertheless have persisted all requested bytes. Any
  resulting ambiguity follows the poison/reopen rules.
- Power loss, storage-device cache behavior after a completed flush, and media failure are outside the
  contract.
- Checksums are integrity detectors only. Damage to an activated base or an activation record fails
  closed absolutely; the unactivated log suffix is instead governed by the log prefix rule, because
  an unflushed suffix can persist in any partial combination and an invalid suffix is never
  distinguishable from a lost relaxed tail. Checksums never repair bytes, select an alternate
  activated generation, or expand the crash model.

The memory port and every crash-fault test must implement this exact model. A stronger storage model
must not be assumed implicitly by test ordering.

## Bounded-context vocabulary

`packages/pglite-opfs-repacked/CONTEXT.md` is the authoritative glossary, and `CONTEXT-MAP.md`
registers this package as the repository's third bounded context. Package source, tests, ADRs, and
this plan use **repack** for metadata rebuilding and **log** for transaction frames. PostgreSQL's
terms for its own recovery and storage concepts must not be borrowed by this package.

## Additional critical design driver found during planning

A reused-extent barrier is not sufficient when the operation that freed the extent is still relaxed
and non-durable:

1. A durable metadata generation maps extent `e` to `/a`.
2. A relaxed `unlink("/a")` appends metadata that has not been flushed and makes `e` reusable live.
3. Creating `/b` reuses `e`; the reuse barrier zeros `e` and flushes the arena before logging
   `/b`.
4. A crash loses the relaxed metadata log but retains the durable zeros.
5. Recovery revives `/a` from that metadata generation with its contents destroyed.

A scenario-local regression that checks only whether `/b` is absent is insufficient; the composed
regression must also assert that the revived `/a` still contains its original bytes.

This is not fixable merely by moving the zero again. A physical extent must not be destructively
prepared for a new owner while either retained metadata generation may still recover an old owner.
The allocator therefore quarantines freed extents until two metadata activations have excluded the
old owner. Only then may the extent enter the reusable pool and be zeroed for a new owner.

## Goals and explicit non-goals

### Goals

- Correct recovery after termination at every persistent I/O boundary covered by crash model A.
- A strict-success guarantee: after a strict sync returns, all preceding data and metadata are
  recoverable together.
- A precise relaxed guarantee: recovery is a valid metadata-transaction prefix, and no prefix can
  expose bytes belonging to a different owner.
- Replay equivalence or a latched terminal failure after every error.
- Bounded recovery memory, metadata size, frame size, and allocator work.
- Deterministic replay with no calls to time, random generators, or environment-dependent coercions.
- Constant OPFS handle count and in-place database data writes.
- Fast normal writes, metadata-only repacks, and bounded space amplification.
- Reliable cleanup and poison delivery through the PGlite host.

### Non-goals

- Any form of store migration, backwards compatibility, data preservation, or multi-version support.
- Exposing state internals or test-only production methods.
- Recovering through arbitrary external edits while silently guessing user intent.
- Byzantine or malicious tamper resistance. Checksums detect damage only: activated bases and the
  activation manifest fail closed, while an unactivated log suffix follows the log prefix rule.
- Power-loss recovery.
- Copy-on-write of every PostgreSQL database write.

## Required invariants

These are design constraints, not aspirations. Each should become both a documented contract and a
property checked by the reference model/fault suite.

| Invariant                              | Enforcement                                                                                                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replay equivalence                     | One pure reducer is used by live commit and replay. Any failure with ambiguous durable metadata poisons the live instance.                                                                                      |
| Allocator partition                    | Every extent is in exactly one of `owned`, `available`, or `quarantine`; runtime orphan descriptors may reference quarantined extents but do not make them persistently owned.                                  |
| Retired-generation isolation           | An extent cannot move from `quarantine` to `available` until both retained metadata generations exclude its former owner.                                                                                       |
| Arena before metadata                  | Strict sync flushes arena bytes before metadata. Reused extents are durably zeroed before a transaction can name them. Repack flushes the arena before activation.                                              |
| No destructive pre-commit side effects | Planning and validation occur first. Pre-commit data work may touch only bytes beyond the current EOF or extents already proven available across both generations.                                              |
| Side-effect-free rejection             | Decode, bounds checks, and transition validation precede persistent truncation, growth, or unbounded allocation.                                                                                                |
| Writer/reader closure                  | Encoders and decoders use one limits/constants module and one typed codec. No writer path can emit a value the same version rejects.                                                                            |
| Deterministic replay                   | Transaction records encode allocated extent runs, inode IDs, timestamps, modes, and every other live choice — and never state-derivable release sets, which the reducer derives.                                |
| Encoding closure                       | One frame per transaction, permanently. Planners preflight encoded frame size and projected base size; fixed-width quarantine tags cannot grow during aging.                                                    |
| Fail closed                            | A selected, activated metadata generation whose base fails integrity or semantics is terminal corruption. Fresh initialization has a narrowly specified bootstrap state only.                                   |
| Log prefix recovery                    | The recovered log is the longest valid frame prefix; the first invalid frame and all following bytes are discarded regardless of envelope completeness (crash model A forces this).                             |
| Universal health contract              | Every public operation other than close/failed-init cleanup first checks lifecycle state. No mutable state or unguarded apply API is exported.                                                                  |
| Ownership cleanup                      | Initialization cleanup is idempotent and closes every handle acquired at any point in host/WASM/initdb startup.                                                                                                 |
| Poison delivery                        | A durability failure is latched in the VFS; the host awaits every top-level sync and one at every transaction end, so later entry points reject at the VFS health assertion even if no repack is currently due. |
| Bounded recovery                       | Frame length, log bytes, frame count, string lengths, inode count, extent count, and all arithmetic are bounded before allocation or data I/O.                                                                  |
| Extension hygiene                      | Shrink does not destroy bytes. Every extension zeros the newly visible gap — with a completed arena flush for pre-existing storage — before the size-committing frame appends.                                  |
| Exact activation                       | Recovery follows the last valid activation record; it never guesses between metadata files by generation alone.                                                                                                 |
| Recreate-only versioning               | The implementation accepts exactly one on-disk version. Every mismatch requires explicit complete deletion and fresh creation; no preservation path exists.                                                     |
| Crash-model fidelity                   | Correctness claims and fault tests use crash model A exactly; completed flushes are stable and power loss is out of scope.                                                                                      |
| Whole-directory ownership              | Every directory entry is one of the four owned files; any extra file, directory, or unknown entry fails closed before owned-file content mutation.                                                              |

## Architecture

### Persistent files and ownership

`opfs-repacked` owns exactly four persistent files in its store directory:

```text
arena.bin        8 KiB fixed header, then extent payload bytes in place
metadata-a.bin   metadata generation: base + its own append-only log
metadata-b.bin   the alternate metadata generation
activation.bin   two alternating activation slots — the sole authority
```

Every owned file carries the format identity. `arena.bin` begins with a fixed 8192-byte header
(magic, format version, extent size, limits-profile version, header checksum); extent `k` occupies
`[8192 + k * extentSize, 8192 + (k + 1) * extentSize)`, keeping every extent 8 KiB-aligned. The
handle count is a constant four, staying far below the Chromium `ulimit -n=1024` failure region.

```text
                         public Filesystem adapter
                                  |
                                  v
                         +------------------+
                         |   RepackedVfs    |  <- one deep operational interface
                         +------------------+
                           |       |       |
                 pure state| metadata      |data
                           v       v       v
                    StateMachine  Metadata  DataArena
                           \       |       /
                            \      v      /
                             +-----------+
                             |RepackedPort|  <- OPFS or fault-injection adapter
                             +-----------+
```

The production adapter translates PGlite's filesystem calls into `RepackedVfs`. It should not contain
recovery, allocation, or transaction policy.

### Greenfield source layout

These four names are normative for format version 1.

```text
packages/pglite-opfs-repacked/
  CONTEXT.md                  authoritative bounded-context glossary
  src/
    index.ts                  PGlite Filesystem adapter and public exports
    core/
      repacked-vfs.ts         lifecycle and operation orchestration
      state-machine.ts        pure plans, reducer, state invariants
      metadata-store.ts       metadata files, manifest, repack, recovery
      metadata-codec.ts       format-version-1 binary codec and shared limits
      data-arena.ts           exact reads/writes, zeroing, growth, safe tail trim
      path.ts                 canonical path parsing and name validation
      errors.ts               stable typed errors and terminal-cause wrapping
    port.ts                   narrow persistent-handle interface
  test/
    support/
      memory-port.ts          crash-model-A fault-injection adapter
      reference-fs.ts         independent behavior/reference model
```

Avoid turning this into a collection of shallow pass-through classes. `RepackedVfs`, the pure state
machine, and the persistent port are the important seams. Codec/repack helpers remain private to the
metadata module unless a second real caller appears.

### Public interface

Export only:

- `OpfsRepackedFS`;
- its validated creation options type;
- stable typed error classes/codes needed by callers; and
- the required PGlite factory helper.

The factory is the sole supported construction seam. It creates and wires PGlite and the adapter from
one validated options object; direct construction of the exported adapter is unsupported.

The creation options include:

```ts
type RepackedOptions = {
  extentSize?: number; // creation default: 64 KiB
  durability?: "relaxed" | "strict"; // default: relaxed
};
```

`extentSize` is a creation-time choice. A value outside the permitted range/alignment is a plain
argument `TypeError`. On an existing same-version store, the header is authoritative; if the caller
also supplies a different valid value, open returns a typed, non-terminal
`ExtentSizeMismatchError` without mutating or poisoning the store.
Durability is fixed for the lifetime of the constructed instance. No filesystem call accepts a
per-call durability override.

The deep interface exposes one explicit `strictSync()` operation reserved for the sync layer above the
VFS. Repack activation and close from `OPEN` always execute the strict durability sequence regardless
of the constructed durability mode; close from `FAILED` performs no persistence.

Do not export mutable state, direct apply methods, counter setters, or a public repack implementation.
Test hooks belong on the in-memory port, not on production objects.

### Persistent port

Define the smallest interface that can support both real OPFS and deterministic crash simulation:

- open/acquire a named synchronous handle;
- exact positioned read and best-effort positioned write returning a byte count;
- get size, truncate, flush, and close;
- enumerate every entry and entry kind in the complete store directory before bootstrap; and
- optionally report operation labels to fault tests.

The core must not import browser OPFS types. The OPFS adapter owns DOM exception translation and
exclusive handle acquisition. The memory adapter owns volatile versus durable byte images and
crash-model-A termination materialization.

## On-disk protocol

### Exact-version gate

Every package-owned file carries the single expected format version inside an integrity-protected
store-identity envelope: the arena header, a complete metadata base, or a complete activation slot.
Decoding begins with a fixed, bounded read sufficient to validate that envelope; only then may its
version field identify the store format. An integrity-valid mismatch raises
`StoreRecreationRequiredError` before replaying records, allocating from stored lengths, or mutating
file content. An incomplete or integrity-invalid identity envelope does not make a version claim and
remains governed by its bootstrap or activation-slot classification. A transaction frame's version
is not a store identity and is always governed by the log prefix rule. This rule adds no separate
identity preamble.

There is deliberately no registry of historical decoders and no dispatch by version. A format-version
change replaces the constants, codecs, fixtures, and implementation together. The version field exists
only to prevent the wrong implementation from touching a store. Recovery logic is exclusively
same-version crash recovery.

### Shared numeric and size policy

Put every limit in one module used by constructor validation, planners, encoders, decoders, replay,
and repacking. At minimum:

- extent size: a creation-time option that is an 8192-byte multiple in the closed range 8 KiB to
  16 MiB, defaulting to 64 KiB;
- arena header size: a fixed 8192 bytes including an integrity checksum; every extent offset is
  relative to it;
- unsigned 64-bit generation, activation sequence, transaction sequence, inode ID, and extent ID,
  represented internally as `bigint` where exactness matters;
- bounded UTF-8 component and path lengths;
- bounded metadata base size, transaction payload size, active-log bytes, and frame count;
- bounded inode count, extents per inode, and total extents; and
- checked add/multiply/offset conversion before every JavaScript `number` or handle call.

Use a writer soft limit below the reader hard limit. Reaching the soft log limit triggers repack;
failure to repack before the hard limit produces a typed `StoreLimitError`, never an oversized record.
Counter remedies are per-counter: the transaction sequence is generation-local and restarts at each
repack; generation, activation sequence, and `nextInodeId` are monotonic for the life of the store,
and approaching any of their hard limits is a typed `StoreLimitError` whose only remedy is recreation
— repack cannot repair them. Extent IDs are bounded by `totalExtents`, not a separately exhaustible
persistent counter. No counter remedy may claim that reopen resets a persisted exhausted value.

### Metadata file

Each metadata file contains:

1. a fixed format-version-1 base header;
2. one deterministic binary metadata-base payload;
3. an integrity checksum over the full header and exact payload;
4. an exact base-end offset; and
5. zero or more append-only transaction frames.

The header records magic, format version, generation, extent size, root inode, payload length, and
the limits/profile version. The decoder rejects trailing bytes inside the declared base envelope,
unknown versions, invalid flags, unsafe arithmetic, and non-canonical values.

Each transaction frame records:

- fixed magic and version;
- generation and monotonically increasing transaction sequence;
- record type;
- exact payload length;
- payload; and
- CRC covering the frame header and payload.

Replay is streaming and governed by the **log prefix rule**: the recovered log is the longest prefix
of valid frames, and the first invalid frame — bad envelope, magic, CRC, sequence, generation, type,
or semantics — terminates the prefix; it and all following bytes are discarded regardless of whether
its declared envelope fits within EOF. Crash model A forces this: an unflushed append may persist a
full-length frame with only partial contents, or lose a frame entirely while a later append's bytes
persisted, so no unactivated log suffix is ever grounds for fail-closed corruption. External or media
corruption of an unactivated suffix is explicitly indistinguishable from a lost relaxed tail and is
outside the crash model. Within crash model A the prefix rule never discards a frame covered by a
completed flush, so the strict guarantee is unaffected; fail-closed remains absolute for the
activated base and the activation manifest. The discarded suffix may be physically truncated only
after full semantic validation. Replay never first builds an array of all frames.

Use a canonical binary codec rather than permissive JSON coercion. Decode booleans as booleans,
integers as exact integers, maps as maps, and reject unknown required fields. The same codec functions
used to persist a live transaction decode it in tests/recovery.

### Activation manifest

The manifest contains two fixed, alternating activation slots. Each slot contains:

- manifest magic/version;
- activation sequence;
- selected metadata file (`A` or `B`);
- selected metadata generation;
- selected base header/payload checksum or digest;
- exact selected base-end offset; and
- a checksum over the complete activation record and canonical padding.

Repack writes the inactive manifest slot only after the new metadata file has been flushed. Recovery
uses this exact two-slot decision procedure:

1. Decode and checksum both slots independently; interpret a version only for an integrity-valid
   slot.
2. If both slots are valid, require distinct consecutive activation sequences referencing opposite
   metadata files, select the higher sequence, and require its referenced metadata base to match its
   identity, generation, base-end offset, and digest exactly. A same-sequence pair, a
   non-consecutive pair, a pair referencing the same metadata file, or a selected-base
   identity/generation/offset/digest mismatch is `CorruptStoreError`.
3. If exactly one slot is valid, treat the other as an interrupted overwrite under crash model A and
   select the valid slot only after its referenced metadata base matches exactly.
4. If neither slot is valid, accept only the canonical fresh/interrupted-bootstrap layout; every other
   layout is `CorruptStoreError`.
5. If the selected slot is valid but its referenced metadata base is invalid, fail closed; the log is
   governed by the prefix rule and is never grounds for fail-closed. Never try the other slot or
   select a metadata file by apparent generation.

Because the manifest has only two alternating slots, recovery classifies each slot only as valid or
invalid; it does not infer an ordering position for an invalid slot. Under crash model A, one invalid
slot is always consistent with the current in-progress overwrite; the other independently valid,
digest-matched slot is the authority. The memory port must model
write-completed-but-flush-failed and flush-completed-then-termination separately.

### Fresh bootstrap and acquisition protocol

Bootstrap and open follow one fixed acquisition protocol:

1. Enumerate the whole store directory without mutation. Every entry must be one of `arena.bin`,
   `metadata-a.bin`, `metadata-b.bin`, or `activation.bin`, and each must be a file. Any other
   filename, subdirectory, or unknown entry kind raises `UnexpectedStoreEntryError`.
2. Create/get and exclusively acquire `activation.bin` first; its exclusive sync-access handle is
   the store ownership lock, and losing the acquisition race is `StoreOwnedError`.
3. Re-enumerate under the lock and re-reject unknown entries.
4. Acquire or create the remaining handles in a fixed order — `arena.bin`, `metadata-a.bin`,
   `metadata-b.bin` — recording every acquisition immediately for failed-init cleanup.

Two racing initializers can therefore never each hold a subset of the four handles.

Acquisition may create an absent owned filename as an empty file. Empty and absent are equivalent for
layout classification, so this does not change any classification result: for example, an activated
store missing its arena remains corrupt after an empty `arena.bin` is materialized. References below
to rejection without mutation mean without owned-file **content** mutation; fixed acquisition may
create empty owned files.

After whole-directory ownership is established, fresh initialization is legal when all four
package-owned files are empty or absent (which are equivalent here). A pre-activation layout is
restartable bootstrap residue only when:

- no valid activation exists;
- `arena.bin` contains no extent payload and is at most a partial or complete version-1 header;
- no transaction log exists;
- neither metadata file contains a complete non-bootstrap base or extends beyond the fixed empty-root
  generation-1 candidate envelope; and
- `activation.bin` does not extend beyond its fixed two-slot envelope.

Any integrity-valid identity in that layout must be version 1. Before the first valid activation no
state is authoritative, so this exact residue may be reset under the ownership lock. Arbitrary bytes
outside those bounds and every other non-empty, unactivated, internally contradictory layout fail
with `CorruptStoreError`; an arena with any extent payload is never treated as fresh.

Bootstrap performs this exact sequence:

1. Classify the locked layout as fresh or restartable bootstrap residue.
2. Reset `arena.bin`, write its canonical 8 KiB version-1 header, and flush it.
3. Reset `metadata-a.bin`, write the fixed empty-root generation-1 base, and flush it.
4. Reset `metadata-b.bin` to empty.
5. Reset `activation.bin`, write the fixed initial activation record selecting `metadata-a.bin`, then
   flush `activation.bin`.
6. Install the decoded empty-root state and enter `OPEN`.

Termination before step 5 completes leaves either restartable pre-activation residue or a fully
persisted valid initial activation. A complete initial activation switches recovery permanently to
the activated-store procedure; bootstrap never resets an activated store.

## In-memory state model

### Stable inode graph

Use stable inode IDs rather than recursively embedded JavaScript objects:

```text
VfsState
  generation: bigint
  nextInodeId: bigint
  rootInodeId: bigint
  inodes: Map<InodeId, DirectoryInode | FileInode>
  allocator: AllocatorState

DirectoryInode
  children: Map<string, InodeId>

FileInode
  size: bigint
  extents: ExtentId[]
```

`Map` removes the `__proto__` class of bugs. The validator still rejects empty components, `/`, NUL,
`.` and `..`, invalid UTF-8, and over-limit names. A central path parser handles root explicitly so no
operation can derive an `undefined` child. Modes use `??`, not truthiness, so mode `0` remains exact.

Generate timestamps and inode IDs in the planner before commit and encode them in the transaction.
Replay never calls `Date.now()`.

### Allocator states

Maintain O(1) membership/index structures for:

- `ownedBy: Map<ExtentId, InodeId>`;
- `available: indexed set/stack of safely reusable extents`; and
- `quarantine: Map<ExtentId, firstExcludedGeneration | null>`.

The full validation equation is:

```text
[0, totalExtents) = owned XOR available XOR quarantine
```

Runtime orphan descriptors may read/write extents in `quarantine`, but the persistent allocator still
classifies them as quarantined. No linear `includes`, `indexOf`, or repeated `splice` should appear in
allocation paths.

### Two-generation quarantine

On unlink, truncation of whole extents, replacement, or orphaning, removed extents enter quarantine
with `firstExcludedGeneration = null`. They are not available for reuse.

During repack projection to generation `G + 1`:

1. entries with `null` become tagged `G + 1`; the new metadata base is the first retained generation that
   excludes their former owner;
2. entries already tagged with a generation at or before `G` become `available` in the projected
   state, because the repack overwrites the other metadata file and both retained generations now
   exclude the old owner; and
3. live state is unchanged until activation succeeds.

This rule must be derived from which physical metadata file is being overwritten, not merely elapsed
time. Recovery validates quarantine generations against the selected and retained manifest records.

Normal allocation consumes already-available extents first. If none are available, it grows the arena;
it never waits for quarantine to age. Low reusable space or quarantine buildup marks a pressure repack
pending and queues it for a later worker turn without delaying the allocation that triggered it.

“Deferred” describes scheduling, not concurrency. Synchronous OPFS handle operations and the VFS run
on one worker. When the queued pressure repack starts at the next host sync/idle opportunity, it runs
to completion on that worker and all filesystem calls wait. The implementation must not claim that a
repack overlaps filesystem work.

Only an arena-growth failure specifically classified as quota exhaustion may enter the synchronous
last-resort path: perform exactly two inline repacks, then retry the allocation once. The first repack
ages newly quarantined extents and the second can release them. If the one retry still cannot allocate,
return the quota error. No other allocation or error path performs inline double repack.

### Orphans

Unlinking an open file removes its directory entry and persistent inode in one transaction and moves
its extents to quarantine. The open descriptor retains a runtime orphan record containing its size and
extent list. Rename over an open destination is the second orphan source and follows the identical
rule: the replaced inode's extents quarantine, its open descriptors keep a runtime orphan record.

- Closing the orphan requires no persistent allocator mutation.
- Growing an orphan writes a `reserveQuarantine` transaction before the new extent can be relied on;
  after crash the orphan disappears but the extent remains quarantined.
- Shrinking an orphan can leave released extents quarantined; reclamation proceeds through normal
  repacks.
- A repack never serializes a crash-dead orphan as an owned inode.

This removes deferred-free state entirely and therefore removes the orphan-retirement replay-order
ambiguity.

## One metadata transaction engine

### Plan, perform safe data work, append, reduce

Every metadata-changing operation follows one path:

1. **Parse and validate inputs.** Reject normal filesystem errors and size/limit violations without
   changing persistent data.
2. **Plan purely.** Produce a deterministic `TxnRecord`, a prevalidated state delta, and a list of
   permitted pre-commit data actions. Resolve inode IDs, exact extent IDs, timestamps, and resulting
   sizes here.
3. **Perform safe pre-commit data actions.** These may touch only available extents or bytes beyond a
   file's current visible EOF. Mark data dirty before the first write/truncate.
4. **Append one complete transaction frame.** The active log is the commit record.
5. **Apply the already validated reducer.** This should be non-failing except for process-level faults.

Live commit and replay call the same reducer with the same preconditions and resulting state checks.
There must not be separate live-apply, guarded-log, replay-apply, and recovery-fixup implementations.

**Live coalescing exception (ADR §6).** Consecutive growing `resizeFile` records for one inode may be
held as a single in-memory pending frame whose allocation runs merge on replacement; the reducer still
applies each admitted transition immediately, and log accounting counts the pending frame as written.
The pending frame is appended — with its originally reserved sequence, ahead of any other record —
before any commit of a different record or inode, before every flush of the active metadata file,
before every repack projection, and at every awaited sync boundary; the commit point of a deferred
record is that materialization, where the append-error poison rule applies unchanged. An
unmaterialized pending tail recovers to the last materialized size, which crash model A already
permits for any lost relaxed tail.

If metadata append reports any error, the instance becomes terminally failed. It may attempt a
best-effort truncate for hygiene, but it must not continue on the assumption that the append did not
persist. Reopen resolves the log tail through the prefix rule. This eliminates duplicated log rollback
paths and the impossible task of proving a write-error rollback durable enough for continued commits.

If reduction unexpectedly fails after append, poison immediately and preserve the append. Do not
roll back a committed frame; reopen will replay it through the deterministic reducer.

### Encoding closure

A transaction is exactly one frame, permanently; multi-frame transactions are forbidden and must not
be introduced later. To keep every valid operation inside that format:

- Records encode only live **choices** — allocated extents as compact runs, new inode IDs,
  timestamps, modes — and never state-derivable sets. The extents freed by an unlink, truncate, or
  rename-replacement are derived by the reducer from staged state, so releases encode in constant
  size and can never be rejected for encoded size.
- Planners preflight the exact encoded frame size and the projected metadata-base size before any
  data mutation.
- Per-operation allocation is capped so that POSIX short-write semantics absorb oversized writes; the
  adapter loops.
- The residual otherwise-valid operation that cannot fit is rejected with `StoreLimitError` before
  anything changes.
- The same closure holds for bases: no planner-admitted state may exceed the base writer soft limit,
  so every reachable state remains repackable below the reader hard limit.
- A quarantine tag has the same fixed-width encoding whether it is null or contains a generation, so
  repack aging cannot increase an entry's encoded size.
- Planners maintain a simple running projected-base size using the canonical codec's size rules. A
  property test requires that count to equal the actual canonical encoding length; no secondary
  projection algebra is introduced.

### Write and extension semantics

Set the data-dirty flag before any call that can alter `arena.bin`, including writes, zeroing,
truncate/grow, and short-write loops.

Do not zero on shrink. Shrink changes metadata size only and releases whole trailing extents to
quarantine. Bytes beyond the new EOF may remain physically present but are invisible.

Before any later extension, zero the complete newly visible gap `[oldSize, newVisibleSize)` before
committing the larger size. These bytes are beyond the old EOF, so a zeroing failure cannot damage the
old live file and a retry repeats the hygiene safely. For any part of that gap inside **pre-existing**
arena storage — which may hold pre-shrink bytes — the zeroing must be written _and arena-flushed_
before the size-committing frame is appended, exactly like the reused-extent barrier: otherwise a
persisted frame with lost zeros would expose discarded bytes on recovery. Fresh tail growth beyond
the arena's end needs no flush; unwritten regions read as zeros.

For a write that extends a file:

1. reserve exact fresh/available extents in the pure plan;
2. grow the arena for fresh tail extents as needed;
3. durably zero every reused available extent before it can be named by metadata;
4. zero any intra-file gap beyond the old EOF, with a completed arena flush for every gap byte in
   pre-existing storage;
5. write payload bytes while counting the exact completed prefix; and
6. commit only the size and extents required by the successfully written prefix.

If zero payload bytes were written, return/throw the underlying I/O error with metadata unchanged. If
a positive prefix was written, commit and return that partial byte count according to the filesystem
contract. If the metadata commit fails, poison; the bytes remain beyond the old EOF or in available
extents and cannot become cross-owned.

For reused extents, the durable full-zero barrier remains necessary even if the immediate payload
would cover the whole extent: relaxed payload data may be lost independently, but recovery must still
see zeros rather than a previous owner's bytes. Because quarantine proves no retained generation owns
the extent, losing the subsequent allocation frame after the zero is harmless.

Fresh data-arena growth may leave an unreferenced tail after a crash. Recovery first validates all
metadata, then treats data strictly beyond `totalExtents` as protocol-created residue and may truncate
it. It must never grow/truncate data in response to unvalidated metadata.

## Recovery algorithm

Recovery should be a staged computation with a single publication point:

1. Run the fixed acquisition protocol: enumerate without mutation, exclusively acquire
   `activation.bin` as the ownership lock, re-enumerate under the lock, then acquire the remaining
   handles in fixed order — recording each acquisition immediately for failed-init cleanup.
2. Read owned-file sizes (validating the arena header when present) and classify
   fresh/bootstrap/activated/unsupported layouts without writing.
3. Decode both manifest slots with fixed bounded reads and apply the exact two-slot decision procedure
   above.
4. Select its resulting authoritative activation record; do not infer authority from metadata
   generation numbers.
5. Read and validate the referenced metadata base exactly, including activation identity, generation,
   base-end offset, and digest match. Failure is terminal; do not try the other slot.
6. Build a staged state with bounded allocations and validate the complete allocator partition.
7. Stream transaction frames from base end:
   - check length, sequence, generation, checksum, and numeric bounds;
   - decode one record;
   - plan/validate its transition against staged state;
   - update a staged `requiredArenaEnd` for fresh tail allocations without performing data I/O;
   - apply the shared reducer; and
   - discard the decoded record before reading the next.
8. Validate final state, retained-generation quarantine facts, data coverage, and all configured hard
   limits, including the final `requiredArenaEnd`.
9. Only after complete semantic validation, grow `arena.bin` once to `requiredArenaEnd` if needed and
   normalize a harmless unreferenced data tail if desired.
10. Install the staged state at the single publication point and mark lifecycle `OPEN`.

Important direction rules:

- an activated generation mismatch is corruption, not a reason to reset metadata;
- an invalid selected **base** never falls back to an older generation;
- an inactive, unreferenced partial repack candidate is ignored;
- the log follows the prefix rule: the first invalid frame terminates the recovered prefix and its
  suffix is discarded, regardless of envelope completeness;
- the discarded suffix may be physically truncated only after full semantic validation; and
- no corruption path mutates owned-file content, truncates data, allocates huge arrays, or resets
  files. Fixed acquisition may only materialize absent owned filenames as empty files, which are
  classification-equivalent to absent files.

## Repack algorithm

Repack is a forced-strict state transition, not an in-place cleanup routine:

1. Assert `OPEN`, enter a reentrancy guard, and reject if limits already prevent encoding.
2. Clone/project only the metadata structures needed for generation `G + 1`; do not mutate live
   allocator state.
3. Apply quarantine aging/promotion to the projection and validate the full projected state.
4. Encode the complete candidate base in memory or bounded chunks and verify encoder size limits.
5. Flush dirty arena bytes. On failure, leave live state and activation unchanged; the repack is
   retryable.
6. Truncate and write the inactive metadata file, then flush it. Failure remains retryable because the
   manifest still selects the old active file.
7. Re-read/verify the candidate's fixed header/checksum if useful for defense in depth.
8. Write and flush the next manifest activation slot.
9. After activation flush succeeds, install the projected state, switch the active log cursor, and
   clear the repack counters.
10. Trim only a contiguous tail that the newly activated state classifies as available. This is
    best-effort physical reclamation after commit; failure causes a space leak, not allocator/state
    divergence.

An error while writing/flushing activation is ambiguous and therefore poisons the live instance.
Failure before activation does not poison unless the underlying port reports loss of ownership. An
unexpected failure installing live state after successful activation also poisons; reopen selects the
new generation.

Repack triggers should include:

- elapsed time;
- active-log byte count;
- active-log frame count;
- quarantine pressure/reusable-space pressure, queued for a later worker turn; and
- approach to any writer soft limit.

Tail trimming never changes the logical allocator. `totalExtents` in the new metadata base is projected
before activation; the physical truncate merely catches the arena up to that already committed
logical boundary.

Every repack executes all three durability barriers even when the instance was constructed in relaxed
mode. A pressure repack is normally deferred, then runs synchronously to completion and blocks the
worker when its queued turn starts. The only pressure path executed inline with an allocation is the quota-exhaustion
double repack described above.

## Lifecycle, ownership, and host integration

Use an explicit lifecycle state machine:

```text
NEW -> INITIALIZING -> OPEN -> CLOSING -> CLOSED
                  \-> FAILED -----------^
```

`FAILED` stores the first terminal cause. Every public operation, including `syncToFs()`, checks
`OPEN` before examining repack intervals or dirty flags. Only `closeFs()` and
`cleanupFailedInit()` are allowed from `FAILED`; both are idempotent and attempt all cleanup steps.

Close is state-dependent:

- `OPEN` → close: forced strict sync, then exhaustive cleanup; a sync failure is returned after all
  cleanup attempts.
- `FAILED` → close: **no persistence attempt** — no sync, no metadata commit, no repack; exhaustive
  cleanup only, preserving the original terminal cause.
- Any queued deferred repack is cancelled or reduced to a lifecycle-checked no-op before handles
  close, in every path.

Implement `cleanupFailedInit()` entirely package-side. It closes every acquired handle without
assuming that `RepackedVfs`, the Emscripten FS, PostgreSQL, or `FS.quit()` completed initialization.
The factory constructs and retains the adapter itself and, on any `PGlite.create()` failure
(synchronous throw or rejection), invokes `cleanupFailedInit()` directly on the retained adapter —
the adapter owns all four handles, so no host hook is required or referenced.

Poison delivery requires no host-side latch. The factory always constructs the host with
`relaxedDurability: false`, so the host awaits `fs.syncToFs()` after every top-level query, and the
package asserts VFS health on every `syncToFs()` call. The host must also end every `transaction()`
— resolved or rejected — with that same awaited synchronization rather than running its terminal
`COMMIT`/`ROLLBACK` under the in-transaction sync suppression; this host correctness fix is
fork-carried in the pinned host while its upstream PR is open, and the package deliberately ships
no local workaround (host-conformance suite:
`tests/unit/pglite-opfs-repacked-factory-transaction.test.ts` — if it fails, fix the pin, never the
factory). The contract is:

1. A VFS durability failure sets `FAILED` and rejects the awaited sync, which rejects the query that
   caused it.
2. The host awaits `syncToFs()` after every top-level query — including queries PostgreSQL could
   serve from its buffer cache — and at every transaction end, so every later query, transaction, or
   sync re-enters the VFS health assertion and rejects. Statements within an open transaction reach
   poison through the VFS health assertion on their filesystem operations.
3. Closing still attempts all cleanup.

There must be an integration test proving that buffer-cache-only queries cannot continue indefinitely
after durability is poisoned. The test must hold under plain upstream `syncToFs()` semantics — it may
not depend on fork-only host machinery (`#fsSyncFailure`, `#pendingFsSync`,
`syncRequiresExclusiveExecution`).

### Durability construction contract

`durability: "relaxed" | "strict"` is selected once at construction and defaults to `"relaxed"`.
It is never a per-operation argument.

- In relaxed mode, ordinary transaction-log and arena writes are not flushed per call; recovery after
  termination follows the valid transaction-prefix/no-cross-owner contract. The implementation may
  flush the arena opportunistically (amortized batching of accumulated dirty bytes) to bound
  repack-time flush latency; extra flushes never weaken or reorder the contract.
- In strict mode, the configured sync boundary flushes arena bytes before metadata and propagates every
  error.
- `strictSync()` is the only explicit public strict operation and is reserved for the sync layer above
  this module.
- `syncToFs()` consults the construction option rather than accepting an override: strict instances
  delegate to `strictSync()`; relaxed instances assert health, queue any due deferred repack, and
  return without a per-call flush.
- Repack activation always uses strict ordering regardless of construction mode.
- Close from `OPEN` always performs strict sync before handle closure regardless of construction
  mode; a failure is returned after all cleanup attempts. Close from `FAILED` attempts no
  persistence.
- A terminal failure from a deferred repack is latched in the VFS and delivered through the same
  awaited poison-delivery path as every other durability failure.

**One durability authority.** The VFS construction option is the sole physical-durability authority;
PGlite's `relaxedDurability` flag carries no durability meaning in this design. The package's
required factory helper — the sole supported construction seam — always constructs the host with
`relaxedDurability: false`, so the host awaits `fs.syncToFs()` after every top-level query and at
every transaction end, and the awaited call either performs the constructed mode's work (strict
flush, or relaxed health-assert with no flush) or rejects into the calling query. This separates the two concerns the host boolean
conflates: whether the host awaits synchronization, and whether synchronization physically flushes
storage. The host's per-call `syncToFs(relaxedDurability)` argument becomes a defense-in-depth
assertion that the host is actually awaiting: an observed `true` raises terminal
`DurabilityModeMismatchError`, poisons the VFS, and is never a silent override.

## Error taxonomy

Use stable error codes/classes and retain the original cause:

- `FsError`: normal path, type, permissions, or descriptor errors; non-terminal.
- `StoreLimitError`: a validated configured/hard limit was reached; non-terminal unless it prevents
  required recovery.
- `StoreRecreationRequiredError`: the package-owned files do not have the one exact format version
  implemented by this build; no owned-file content mutation, and the only action is complete drop and
  fresh creation.
- `CorruptStoreError`: activated bytes violate integrity or semantics; open fails closed.
- `StoreOwnedError`: exclusive OPFS handles cannot be acquired.
- `UnexpectedStoreEntryError`: the owned store directory contains an entry outside the exact four-file
  set or an owned name has the wrong entry kind; no owned-file content mutation.
- `ExtentSizeMismatchError`: a well-formed supplied extent-size option disagrees with the
  authoritative same-version store header; non-terminal and no owned-file content mutation.
- `DurabilityModeMismatchError`: the host's per-call sync argument shows it is not awaiting every
  sync (mis-wired construction); terminal, and the VFS poisons on detection.
- `StoreFailedError`: this live instance is poisoned; includes the first terminal cause.
- `StoreClosedError`: use after close.

Do not convert corruption or terminal durability errors into ordinary `EIO` without preserving the
distinction. User-facing messages must name the real recovery action: close/reopen for ambiguous live
state, complete drop and fresh creation for a version mismatch, restore or recreate for corruption,
recreation for generation/activation/`nextInodeId` exhaustion, and repack or space recovery for
log/space limits.

## Performance design and gates

### Why this should remain fast

- Database contents stay in one in-place arena; ordinary 8 KiB database writes do not copy the
  database or allocate a new physical extent.
- Normal metadata work appends one small frame.
- Relaxed mode does not flush on every ordinary write.
- Strict mode retains the necessary data-then-metadata two-flush ordering.
- Repack copies metadata only, not `arena.bin`.
- Allocation/free membership is O(1).
- Recovery streams the log rather than retaining every frame.
- The OPFS handle count is a constant four.

The main new cost is that a freed extent waits for two repacks before reuse and every reused extent
receives one durable zero barrier. Normal allocation does not wait: it grows the arena and queues a
deferred pressure repack. That repack later blocks the worker while it runs. Inline double repack is
reserved for quota exhaustion and is
followed by exactly one retry. The zero barrier is paid only at physical ownership change, not for
ordinary writes to an existing file.

### Alternatives rejected

1. **Copy-on-write/log-structure every database write.** This gives a simpler atomic model but adds a
   new data extent and later arena-reclamation work for routine PostgreSQL writes. It is likely to
   damage write amplification, quota use, and repack latency.
2. **Use two metadata bases plus a separate resettable log.** Rejected because safe reset requires
   cross-file generation inference. Putting each log with its base and activating through a manifest
   makes authority explicit.

### Benchmark gates

Define workload targets before tuning and run identical browser, database, extent-size, and
durability-mode trials. Those recorded targets are the pass/fail criteria. Comparisons with the
independent PGlite IDBFS and in-memory configurations are diagnostic context only, not an implicit
predecessor baseline. At minimum track:

- sequential and random database write throughput;
- transaction latency in relaxed and strict modes;
- warm reopen time with small and near-soft-limit logs;
- repack p50/p95 and two-repack pressure reclamation latency;
- peak JS heap during recovery/repack;
- arena space amplification and quarantined bytes;
- metadata bytes and frame count;
- number of arena, metadata, zero-barrier, and manifest flushes; and
- open sync-handle count during success and failed initialization.

Set numerical acceptance thresholds after stable exploratory measurements, before final tuning. Do
not waive a correctness invariant to meet them. Optimize codec allocation, metadata-base chunking,
repack scheduling, or extent selection first.

## Detailed implementation sequence

Each phase lands directly in the greenfield package. No feature flag, alternate construction path, or
parallel implementation is created while the work is incomplete.

### Phase 0 — erase the prior attempt and freeze the new contract

Deliverables:

- **Done (2026-07-20):** the prior packed-VFS prototype — code, tests, package material, and its two
  ADRs — was discarded before the supported `0.2.0` baseline. Nothing from that source tree is copied
  into the new package, and it is not part of the supported repository history.
- **Done:** `packages/pglite-opfs-repacked/CONTEXT.md` and root `CONTEXT-MAP.md` are the normative
  vocabulary inputs.
- **Done (ADR-0048):** the dedicated ADR describing its files, activation, strict/relaxed
  guarantees, quarantine, poison delivery, crash model A, and the deliberate log-prefix rule.
- **Done (2026-07-20):** engine-capability facts restated in ADR-0048 with per-claim measured
  status, backed by newly authored probes (`scripts/probes/engine-capabilities/`,
  `bun run probe:engines`; host-specific raw output untracked in `tmp/results/`). Measured on
  Chromium 149 / Firefox 151 / WebKitGTK 26.5 under Playwright 1.61.1: dedicated-worker grants,
  SharedWorker denial (method absent), Firefox-only nested workers, `NoModificationAllowedError`
  contention, Firefox uncapped at ≥1200 handles, and a 971-file PGlite datadir are **confirmed**;
  WebKit claims are untestable under WebKitGTK (no OPFS), but the SharedWorker
  `createSyncAccessHandle` grant (macOS + iOS), the ~252 handle ceiling, and the
  `InvalidStateError` contention name are **confirmed on real devices** — 2026-07-18
  predecessor-campaign probes on Safari 26.5/macOS and Safari 18.7.6/iOS, provenance restored in
  ADR-0048's capability section. The Chromium/Linux FD wedge is **established** from prior deployed-Chrome
  instrumentation and is reproducible only in a real desktop Chrome session (session-limited
  zygote); harness-launched browsers structurally cannot reproduce it and must not be used to
  question it.
- **Open:** a full PGlite-on-packed-VFS boot inside a real-Safari SharedWorker has never had a
  green automated run (the predecessor's one macOS Playwright-WebKit nightly attempt failed the
  VFS boot with a transient `UnknownError`, and Playwright WebKit is not Safari proper). The check
  vehicle is the storage bench's phase-0 **SharedWorker-direct proof** (`apps/perf-lab`, published
  at `/bench/`): every run stages the full boot/persist/reopen sequence inside a SharedWorker and
  records `sharedWorkerProof` (staged errors + verdict) in the results envelope — open `/bench/`
  on a real macOS/iOS Safari and run the suite. Optionally, also re-run the probe suite
  (`scripts/probes/engine-capabilities/`) on real Safari for continuity with the 2026-07-18
  predecessor-campaign results. Does not block anything; the design uses a constant four handles
  regardless.
- Make the permanent zero-migration, zero-backwards-compatibility, complete-drop-and-recreate policy
  normative and explicitly applicable to every future format version.
- Specify the construction contract: extent size is an 8192-byte multiple from 8 KiB through 16 MiB,
  default 64 KiB; relaxed durability is the default; durability is instance-wide; repack activation
  and close from `OPEN` are forced-strict; close from `FAILED` performs no persistence;
  `strictSync()` is reserved for the upper sync layer.
- Specify grow-first allocation, deferred pressure repack, and the quota-only inline double-repack
  plus one-retry rule.
- Specify whole-directory ownership and fail-closed rejection of every unowned entry.
- Specify exact shared limits and integer conversion rules.
- Specify host minimum version and the failed-init/async-sync hooks required.
- Turn the invariant table above into normative language.

Acceptance:

- Every persistent write in initialization, normal commit, strict sync, repack, recovery cleanup,
  and close has a documented before/after-crash outcome.
- There is no statement that depends on “likely” write ordering between separate files.
- The strict and relaxed contracts distinguish API success, flush success, and ambiguous thrown I/O.
- The contract contains no data-preserving transition between format versions.
- Every engine-capability number and worker claim in the ADR is either backed by the recorded probe
  measurements or explicitly labeled unverified/not-reproduced; no unlabeled claim survives.

### Phase 1 — pure reference state machine

Deliverables:

- **Gate — operation inventory first.** Derive a complete inventory of the pinned host's
  `BaseFilesystem` operations (including rename with replacement-by-rename, rmdir, utimes,
  writeFile, descriptor flags/offsets) and classify each as: metadata-only / data-only / mixed;
  extent-creating or -retiring; orphan-capable; carrying partial-success semantics; requiring a
  transaction record. `TxnRecord` may not be defined before this table exists.
- Implement stable inode graph, canonical path parser, allocator partition, orphan runtime records,
  and two-generation quarantine as pure code.
- Define closed `TxnRecord` variants covering exactly the inventoried record-bearing operations,
  encoding only live choices (extent runs, IDs, timestamps, modes) with reducer-derived releases.
- Implement pure planners — including encoded-frame-size and projected-base-size preflight — and a
  single reducer with deterministic timestamps/IDs. Projected-base preflight uses one running size
  counter derived from canonical codec size rules; quarantine tags are fixed-width whether null or
  generation-tagged.
- Implement full state validation and checked arithmetic.
- Build an independent small reference filesystem for behavioral comparison.

Acceptance:

- Random operation sequences preserve allocator partition after every successful transaction.
- Serializing and replaying records produces exactly equal state.
- Invalid record transitions are rejected before the input state is mutated.
- The inventory table covers every operation the pinned host can issue; every `TxnRecord` variant
  maps to an inventory row and vice versa.
- An operation whose encoded frame or projected base would exceed limits is rejected with
  `StoreLimitError` (or absorbed by short-write capping) before any state mutation.
- `__proto__`, root paths, mode `0`, invalid numeric values, recursive mkdir timestamps, and all path
  exactness cases have direct coverage.

### Phase 2 — persistent port and format-version-1 codecs

Deliverables:

- Define `RepackedPort` and production-handle abstractions.
- Implement canonical arena-header, metadata base, frame, and activation codecs with one limits
  module.
- Implement exact bounded read/write helpers and overflow-safe offsets.
- Implement the memory port with separate volatile/durable images, short operations, injected errors,
  and crash-model-A process/browser termination materialization.

Acceptance:

- Every encoder output round-trips through the same decoder.
- Boundary-value tests prove writer/reader closure.
- Property tests prove the running projected-base size equals the actual canonical encoding length,
  including quarantine aging from null to a generation.
- An integrity-valid identity envelope carrying a non-current format version is rejected immediately
  with `StoreRecreationRequiredError`; version-looking bytes in an integrity-invalid envelope follow
  that envelope's crash-recovery rule. No historical decoder is callable or present.
- Codec/fault suites run with 8 KiB and 64 KiB extents; the header is authoritative on reopen and a
  conflicting valid supplied option returns `ExtentSizeMismatchError`.
- Trailing bytes, unknown versions, invalid flags/types, same-sequence, non-consecutive, or
  same-file valid activation slot pairs, malformed padding, checksum errors, and oversized
  declarations fail as specified.
- No decoder allocates from an unvalidated length.

### Phase 3 — metadata activation and bounded recovery

Deliverables:

- Implement bootstrap, manifest selection, base verification, streaming frame replay, and final staged
  state installation. Replay computes `requiredArenaEnd` without data I/O, validates the complete
  staged state, grows the arena at most once, then publishes.
- Implement explicit handling of inactive partial repack candidates.
- Enforce total log byte/frame limits during both writing and recovery.
- Verify selected metadata against activation digest and generation.

Acceptance:

- Termination at every byte/flush boundary of bootstrap and repack either opens the old generation,
  opens the fully activated new generation, or returns the specified typed terminal error.
- Termination during pre-activation bootstrap leaves either fresh/restartable residue or a complete
  initial activation; bootstrap never resets a store after a valid activation exists.
- Exactly one invalid activation slot selects the other only after exact metadata identity/generation/
  offset/digest verification.
- Two invalid activation slots outside canonical bootstrap fail with `CorruptStoreError`.
- A selected activation whose metadata base is invalid fails closed without trying the other slot or
  selecting by generation.
- A full-length CRC-invalid final frame, and an invalid frame followed by later persisted valid
  bytes, both recover the valid prefix and open the store.
- Replay never produces persistent data side effects from a discarded suffix.
- Huge declared growth/truncate values and many-small-frame logs remain within fixed work/memory bounds.

### Phase 4 — transaction executor and file operations

Deliverables:

- Implement the single plan/data/append/reduce executor.
- Port the complete inventoried operation surface — directory, file, descriptor, stat, chmod,
  utimes, truncate, read, write, unlink, rmdir, writeFile, and rename including replacement of an
  open destination — through planners/reducer.
- Implement dirty-before-mutation, partial-write accounting, gap zeroing on extension, and no-zero
  shrink.
- Implement fresh tail growth and available-extent durable-zero preparation.
- Implement runtime orphan behavior and `reserveQuarantine` records.

Acceptance:

- No normal filesystem rejection appends metadata or changes persistent data.
- No pre-commit failure can alter bytes visible through the old metadata state, except an ordinary
  partial write to an already-visible file range.
- Every append error poisons, every post-append reducer failure poisons, and reopen yields a valid
  transaction prefix.
- The new destructive-zero scenario recovers `/a` intact when its unlink was not activated/durable.
- Shrink → zero failure/extension retry cannot expose discarded bytes.

### Phase 5 — repack, quarantine promotion, and reclamation

Deliverables:

- Implement projected-state repack and manifest activation.
- Implement two-generation quarantine promotion based on physical metadata-file replacement.
- Implement time/log triggers and deferred quarantine-pressure repack scheduling.
- Implement the synchronous double-repack path only for quota exhaustion, followed by one allocation
  retry.
- Implement best-effort post-activation tail trimming.
- Add metrics/hooks for quarantine bytes, repack reason, and flush counts.

Acceptance:

- Failure before activation leaves the exact live state usable and replay-equivalent.
- Failure during activation poisons and reopen chooses one valid authority.
- Tail-trim failure changes only physical space use.
- Repacked orphan → close → reuse → termination is valid.
- Free → first repack → second repack → reuse → termination never aliases or destroys an older
  generation's owner.

### Phase 6 — production OPFS adapter and host integration

Deliverables:

- **No fork-only prerequisite.** The package targets plain upstream `@electric-sql/pglite` host
  semantics and must not require or reference fork-only host behavior (`#fsSyncFailure`,
  `#pendingFsSync`, `syncRequiresExclusiveExecution`, host cleanup hooks). `peerDependencies` names
  a plain upstream version range; the workspace-level fork override is a temporary carrier for
  upstream-pending host _bugfixes_ the packages may rely on — the initdb-fs-leak fix and the
  transaction-end sync fix (see `docs/runbooks/pglite-fork-override.md`). The fork's non-exclusive
  rejection latch is offered upstream as a generic swallowed-rejection bugfix; if accepted it
  enables detached relaxed host sync as an optional future performance mode, but correctness must
  never depend on it.
- Connect the deep core through `OpfsRepackedFS`.
- Implement lifecycle guards, idempotent close (state-dependent: strict sync from `OPEN` only, never
  from `FAILED`), and idempotent `cleanupFailedInit()`; the factory retains the adapter and invokes
  `cleanupFailedInit()` directly on any `PGlite.create()` failure.
- Make `syncToFs()` assert health before interval/dirty decisions.
- Wire the single durability authority: the factory always constructs the host with
  `relaxedDurability: false` (the host awaits every sync); the VFS construction option alone decides
  physical flushing. The per-call `syncToFs(relaxedDurability)` value is an assertion that the host
  is awaiting — an observed `true` raises terminal `DurabilityModeMismatchError` and poisons. No
  filesystem call accepts a per-call durability flag.
- After successful database initialization, the factory performs one explicit strict sync before
  returning the instance.

Acceptance:

- Failure after any acquired handle, including `super.init`, WASM startup, initial sync, and initdb,
  releases every handle.
- A durability failure rejects the query that caused it, and every later public query/sync fails the
  VFS health assertion even if PostgreSQL could otherwise serve it from memory — proven under plain
  upstream host sync semantics, with no fork-only machinery.
- A non-awaited host sync (per-call `relaxedDurability: true`) poisons on the first observed sync and
  is never silently accepted.
- Upstream's strict-mode early return when a sync is already scheduled is shown unreachable in
  factory-owned usage (all syncs originate from the serialized query path and close), by test or
  assertion.
- Close attempts all handle/FS cleanup and preserves the first cause.
- Handle count never grows with files, transactions, repacks, or failed retries.

### Phase 7 — systematic correctness campaign

Deliverables:

- Property-based command sequences compared with the independent reference filesystem.
- A crash/fault matrix generated from labeled port operations.
- A named composed regression for every row of the normative fault matrix.
- Real-browser worker/tab/browser-termination tests and PGlite workload stress.
- Documentation that maps each invariant to property, fault, browser, and integration coverage.

Acceptance:

- The suite checks state, recovered bytes, allocator ownership, and poison delivery—not only whether
  open succeeds.
- Faults include short writes, partial-then-error, fully-persisted-then-error, truncate failure, flush
  failure, cross-file durability skew, and process/browser termination after every labeled effect.
- Relaxed recovery always satisfies the prefix/no-cross-owner oracle.
- Strict acknowledged state always survives.
- Tests do not claim or simulate power-loss durability after a completed flush. Checksums never repair
  or select alternate activated state; an invalid activated base or activation record fails closed,
  while the log prefix rule alone classifies the unactivated log suffix and the activation protocol
  alone classifies an unactivated repack candidate.

### Phase 8 — performance validation and tuning

Deliverables:

- Record workload targets and `opfs-repacked` results.
- Measure the awaited host-sync boundary overhead in relaxed VFS mode (one awaited promise/mutex
  round-trip per query, no physical flush) against a detached-sync baseline, so the "detached relaxed
  host sync is only an optional optimization" claim has a number behind it.
- Profile codec allocations, recovery, allocator hot paths, zero barriers, and repack scheduling.
- Tune extent selection, metadata-base chunking, soft limits, and pressure repacks without changing
  invariants.

Acceptance:

- No unbounded or O(n²) allocator/replay behavior appears in profiles.
- Four-handle ownership remains constant.
- The implementation meets every recorded workload target; any miss is corrected or the target is
  explicitly re-decided with measured evidence before final conformance.
- Space amplification is bounded by documented quarantine/repack policy.

### Phase 9 — final conformance

Deliverables:

- Complete the greenfield `@pgxsinkit/pglite-opfs-repacked` package implementation.
- Keep the public interface limited to the adapter, validated options, and stable errors described
  in this plan.
- Update its ADR, README, testing strategy, package skill/source docs, comments, and errors to the exact
  implemented contract.

Acceptance:

- Public documentation makes no broader guarantee than the executable invariants.
- Source and generated package artifacts contain exactly one format codec and no migration, upgrade,
  compatibility, fallback, dual-format, or data-preservation mechanics.
- Tests cross the production `RepackedVfs` seam except focused codec/state-machine unit tests.
- The final conformance record includes browser fault, host poison-delivery, failed-init cleanup, and
  performance results.

## Normative fault matrix

Every row below is mandatory normative coverage. Additional tests may refine these rows but cannot
replace or weaken them.

| Scenario                                                                         | Required result                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Orphan repack → close → allocation → strict sync → termination                   | New owner recovers; no quarantined/owned alias.                                                                                                                          |
| Relaxed unlink → reuse attempt → zero barrier → crash                            | Reuse is forbidden; old owner's bytes remain intact if unlink is lost.                                                                                                   |
| Free → one repack → termination                                                  | Extent remains quarantined.                                                                                                                                              |
| Free → two repacks → reuse → termination before allocation frame                 | No retained generation owns extent; zero residue is harmless.                                                                                                            |
| Repack projected tail trim → arena flush failure                                 | Old live/activated allocator remains exact and usable.                                                                                                                   |
| Inactive metadata partial write/flush failure                                    | Old activation remains authoritative.                                                                                                                                    |
| One invalid activation slot and one valid, digest-matched slot                   | Treat invalid slot as interrupted overwrite and select the valid slot.                                                                                                   |
| Two invalid activation slots outside canonical bootstrap                         | `CorruptStoreError`; no owned-file content mutation.                                                                                                                     |
| Two valid slots with equal or non-consecutive sequences                          | `CorruptStoreError`; no guessed authority.                                                                                                                               |
| Two valid slots referencing the same metadata file                               | `CorruptStoreError`; no guessed authority.                                                                                                                               |
| Selected activation references a mismatched/corrupt metadata base                | Fail closed; never try the other slot or select by generation.                                                                                                           |
| Full-length CRC-invalid final frame (relaxed termination)                        | Prefix rule: frame discarded; store opens with the valid prefix.                                                                                                         |
| Invalid frame followed by later persisted valid bytes                            | Prefix rule: prefix ends at first invalid frame; entire suffix discarded; store opens.                                                                                   |
| Activation write/flush reports ambiguous failure                                 | Live instance poisons; reopen applies the exact two-slot procedure.                                                                                                      |
| Huge CRC-valid transition                                                        | Rejected before allocation, loop, or data truncate.                                                                                                                      |
| Many valid small frames at hard limit                                            | Bounded streaming work or typed limit error.                                                                                                                             |
| Metadata append partial/persisted-then-error                                     | Poison; reopen yields old or committed record, never continued divergent live state.                                                                                     |
| Data write partial-then-error                                                    | Dirty remains set; exact partial result/old size semantics hold.                                                                                                         |
| Shrink → reopen → extend                                                         | Newly visible range is zero.                                                                                                                                             |
| Shrink → extension zero partial failure → retry                                  | Old visible bytes intact; full gap zero before size commit.                                                                                                              |
| Shrink → extend → termination with unflushed gap zeros                           | The size frame cannot commit before the gap-zero arena flush; recovery never exposes pre-shrink bytes.                                                                   |
| Valid operation whose encoded frame or projected base exceeds limits             | `StoreLimitError` (or short-write capping) before any state or data mutation.                                                                                            |
| `mkdir` strict reopen                                                            | Exact stored timestamps/mode/recursive structure reproduce.                                                                                                              |
| `__proto__`, root, mode `0`, invalid numbers                                     | Exact FsError/validation result; state remains unchanged.                                                                                                                |
| Pre-activation termination during arena-header or empty-base write               | Classify as restartable bootstrap residue; reset and retry under the ownership lock.                                                                                     |
| All package metadata empty but arena contains extent payload                     | Fail closed, not fresh initialization.                                                                                                                                   |
| Store directory contains an extra file, subdirectory, or wrong-kind owned entry  | `UnexpectedStoreEntryError` before any owned-file content mutation.                                                                                                      |
| Integrity-valid package identity declares another format version                 | Reject without content mutation using `StoreRecreationRequiredError`; only complete external drop and fresh creation permits use.                                        |
| Integrity-invalid envelope contains version-looking bytes                        | Do not classify a version; apply that envelope's bootstrap, activation-slot, or log-prefix rule.                                                                         |
| Create at 8 KiB and 64 KiB extent sizes                                          | Both execute the full codec, fault, termination, and reopen suite.                                                                                                       |
| Create with a non-aligned or out-of-range extent size                            | Plain argument `TypeError`; no store mutation.                                                                                                                           |
| Open with omitted extent size                                                    | Persisted header value is authoritative.                                                                                                                                 |
| Open with a conflicting valid supplied extent size                               | `ExtentSizeMismatchError`; store remains healthy and unchanged.                                                                                                          |
| No available extents, quarantine non-empty, arena growth succeeds                | Allocation grows immediately and only queues a deferred pressure repack.                                                                                                 |
| Arena growth reports quota exhaustion                                            | Exactly two inline repacks, then exactly one allocation retry.                                                                                                           |
| Quota retry also fails                                                           | Return quota error without another repack/retry loop.                                                                                                                    |
| Relaxed instance ordinary write                                                  | No per-call strict flush; termination recovers a valid prefix with no cross-owner exposure.                                                                              |
| Strict instance sync boundary                                                    | Arena flush precedes metadata flush and every error propagates.                                                                                                          |
| Repack activation or close from `OPEN` on a relaxed instance                     | Forced-strict ordering still occurs.                                                                                                                                     |
| Durability interface surface                                                     | `strictSync()` exists and no other operation accepts a per-call durability override.                                                                                     |
| Failure after each init acquisition/WASM/initdb stage                            | All acquired handles close.                                                                                                                                              |
| Relaxed deferred-repack poison followed by cache-only query                      | Query rejects at the VFS health assertion on the next awaited host sync.                                                                                                 |
| Close from `FAILED`                                                              | No sync/commit/repack attempted; exhaustive cleanup; original terminal cause preserved.                                                                                  |
| Host `syncToFs(relaxedDurability)` call observed with `true` (host not awaiting) | Terminal `DurabilityModeMismatchError`; VFS poisons; no silent override.                                                                                                 |
| Integrity-valid arena identity declares an unsupported version                   | `StoreRecreationRequiredError`; no owned-file content mutation.                                                                                                          |
| Arena header missing, short, or integrity-invalid on an activated store          | `CorruptStoreError`; no owned-file content mutation.                                                                                                                     |
| Same-version arena and metadata disagree on extent size/profile                  | `CorruptStoreError`; no owned-file content mutation.                                                                                                                     |
| Close with multiple flush/close failures                                         | Every cleanup attempted; first cause returned.                                                                                                                           |
| `transaction()` resolution on the factory instance                               | An awaited sync boundary covers the terminal `COMMIT`/`ROLLBACK` before resolution (host obligation; the pinned host carries the fix); a strict instance has flushed it. |
| Termination with an unmaterialized coalesced resize tail                         | Recovery yields the last materialized size; replay equality holds; no cross-owner exposure.                                                                              |

Property tests should deliberately compose two or three state transitions before each injected failure.
Separate tests for orphan repack, orphan reuse, and termination are insufficient without their
composition.

## Definition of done

The implementation is complete only when all of the following are true:

- The `opfs-repacked` ADR defines the crash model and every invariant above.
- The discarded packed-VFS prototype is not part of the supported source or documentation baseline.
- `@pgxsinkit/pglite-opfs-repacked` exists only in its greenfield package tree.
- Package source, tests, and docs conform to `packages/pglite-opfs-repacked/CONTEXT.md`; the
  forbidden PostgreSQL storage/recovery terms do not occur in this bounded context as operational
  vocabulary or identifiers (the glossary's own ban entries and meta-policy text are exempt).
- The ADR and top-level package documentation state that every future format change requires complete
  destructive drop and fresh creation, with zero exceptions.
- One reducer governs live metadata commit and replay.
- A freed extent cannot be reused until both retained metadata generations exclude its old owner.
- Repack never mutates live allocator state before durable activation.
- Recovery makes no persistent content change until selected metadata is bounded and semantically
  valid; fixed acquisition may materialize absent owned files as empty because empty and absent are
  classification-equivalent.
- Every durability-ambiguous metadata error poisons and is delivered by the host.
- Every acquired handle is released after any initialization or close failure.
- Every normative fault-matrix row has a named regression and passes at its declared test layer.
- Random state-machine and crash-fault tests satisfy the strict and relaxed recovery oracles.
- Crash-fault claims use crash model A only: process/worker/tab/browser termination, completed flushes
  stable, power loss excluded, checksums never repair/select alternate activated state, an invalid
  activated base or activation record fails closed, and the unactivated log suffix follows the
  prefix rule.
- Close from `FAILED` never attempts persistence; close from `OPEN` always runs the forced strict
  sequence.
- The full fault suite passes at 8 KiB and 64 KiB extent sizes; 64 KiB is the creation default and the
  persisted header governs reopen.
- Durability is construction-scoped with relaxed default; repack and close from `OPEN` force strict
  ordering, close from `FAILED` performs no persistence, and `strictSync()` is the sole explicit
  strict operation reserved for the upper sync layer.
- Normal allocation never waits on quarantine; quota exhaustion is the only inline double-repack path
  and allocation is retried exactly once.
- Whole-directory enumeration rejects every entry outside the four owned files before owned-file
  content mutation.
- Browser/PGlite integration demonstrates hard-termination recovery and poison delivery.
- Benchmarks meet the recorded workload targets.
- The public interface exposes no mutable state-store surface or alternate persistence path.
- Production and test artifacts contain exactly one on-disk codec and zero code for migration,
  backwards compatibility, multi-version reads, conversion, fallback, or preservation of an earlier
  store.

The key architectural trade is intentional: retain in-place data writes for throughput, but make
metadata authority explicit and delay physical reuse until recovery can no longer resurrect an old
owner. That removes the aliasing/data-destruction class rather than continuing to repair individual
interleavings.
