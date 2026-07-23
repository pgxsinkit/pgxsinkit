# OPFS Repacked VFS

The packed-storage OPFS VFS for PGlite: every virtual file of a Postgres datadir lives inside a
constant set of four OPFS files. A greenfield, recreate-only store — exactly one on-disk format
version exists at any time, and a format change is a total destructive break.

## Language

### Storage

**Arena**:
The single data file holding all extent payload bytes, written in place.
_Avoid_: data file, data.bin (as a concept), heap

**Extent**:
The fixed-size allocation unit of the arena, identified by a stable extent ID.
_Avoid_: block, chunk, page (reserved for Postgres 8 KiB pages)

**Metadata generation**:
One complete base state plus its own append-only transaction log, stored in one of the two
alternating metadata files.
_Avoid_: snapshot slot, version (reserved for the on-disk format version)

**Activation**:
The manifest record that makes exactly one metadata generation authoritative. Recovery follows
the last valid activation, never apparent generation numbers.
_Avoid_: promotion, commit (reserved for transaction commit)

**Log**:
The append-only sequence of transaction frames following a metadata base. The frame append is the
commit point.
_Avoid_: WAL (banned — Postgres owns that word), journal (the sync toolkit owns that word)

### Operations

**Repack**:
The operation that projects a new metadata generation, writes it to the inactive metadata file,
and activates it. Never mutates live state before durable activation.
_Avoid_: checkpoint (banned — Postgres owns that word), compaction, snapshot(ting)

**Pressure repack**:
A repack triggered by low reusable space or quarantine buildup rather than time or log size.

**Strict sync**:
The durability mode/operation whose successful return guarantees all preceding data and metadata
are recoverable together.

**Relaxed sync**:
The mode where recovery guarantees only a valid transaction-prefix of metadata with no
cross-owner byte exposure, not durability of every acknowledged operation.

### Allocation

**Quarantine**:
The holding state for freed extents until two repacks have excluded the former owner from both
retained metadata generations. Quarantined extents are never reusable.
_Avoid_: pending free, grace list

**Orphan**:
An open file whose directory entry and persistent inode were removed while its descriptor stays
usable; its extents are quarantined and only a runtime record keeps them readable.

### Failure

**Poison**:
The latched terminal failure of a live instance after a durability-ambiguous error; every later
public operation rejects until close/reopen.
_Avoid_: fatal flag, broken state

**Fail closed**:
Rejecting an activated-but-invalid store as corrupt rather than falling back, resetting, or
guessing.

**Recreate-only**:
The permanent version policy: one exact on-disk format version per build; any mismatch requires
explicit complete deletion and fresh creation. No migration, conversion, or preservation path
exists, ever.
_Avoid_: migration, upgrade, backwards compatibility (all banned as concepts, not just words)
