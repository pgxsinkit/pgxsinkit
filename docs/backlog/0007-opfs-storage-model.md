# 0007 — OPFS storage model (two-tier VFS, Safari open-file ceiling)

Status: retired (2026-07-20 — superseded by [ADR-0048](../adr/0048-opfs-repacked-vfs.md))
Opened: 2026-07-18 · Area: client store path / backend derivation (ADR-0036), PGlite VFS

Both pressures this item recorded — Safari's open-file ceiling on wide datadirs and the
durability/latency profile of OPFS sync-access handles — are now addressed head-on by
[ADR-0048](../adr/0048-opfs-repacked-vfs.md): `opfs-repacked`, a packed OPFS VFS holding the entire
datadir in a constant four files. The two-tier (hot set + packed cold tier) shape sketched here was
not adopted; packing everything proved strictly simpler and removes the handle ceiling entirely
rather than staying under it. Implementation is scheduled via
[Plan 0048](../plans/0048-opfs-repacked-vfs.md).
