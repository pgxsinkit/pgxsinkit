# 0012 — durable-streams needs a persistent volume before staging

Status: candidate (recorded 2026-08-22)
Opened: 2026-08-22 · Area: `infra/` (no k8s/Helm deployment of `ds` exists yet), `infra/compose/*.yml`
Reopen trigger: the first k8s/Helm deployment of the `ds` service is authored. This must be settled in
that change, not after it — a wrong answer here is invisible until the node that proves it wrong.

## Context

Everything below follows from one fact: **the Circuits engine keeps its durable shape catalog inside
durable-streams**, as the `meta/catalog` stream (`apps/engine/src/engine/catalog.rs`,
`CATALOG_STREAM`). That catalog is the engine's restart contract — `Dropped`-without-`Retired`
retirement intents, dormancy records, the sequencer's `Offset` checkpoints, and the `SlotBound` that
names the replication epoch. It is **not** reconstructible from Postgres.

Both compose lanes run `--durability memory`, which is correct there and stated in their comments:
each lane replays from Postgres on every bring-up, so fsync-per-append would buy durability nothing
reads. That default is right for a lane and wrong for staging.

## What memory mode actually risks

Narrower than it first sounds, and worth stating precisely so this is decided on the real shape:

- A **pod restart, container crash or OOM-kill keeps the data.** Page cache belongs to the kernel;
  upstream even has a test for it (`memory_mode_data_survives_restart_via_sidecar`).
- A **node power loss or hard node failure** loses un-written-back pages. That is the exposure.

Memory mode was designed to pair with a replication layer that delegates durability. That layer
(quorum acks via openraft) was proposed upstream as electric-sql/electric#4686 and never merged, and
upstream is dormant post-acquisition. It is not coming.

## Why a truncated catalog is the case that matters

The engine defends hard against durable-streams being **unavailable** and not at all against it being
**lossy** — reasonably, since the protocol says an acked append is durable.

- **Catalog unreadable** → the engine **refuses to boot** (`apps/engine/src/engine/mod.rs`, the
  `fold_catalog` error context): _"an unreadable catalog is not an empty one — booting on would create
  a slot at the current WAL head and silently orphan every shape already in the log"_. Safe.
- **Catalog entirely lost** → `binding: None` → `Verdict::FirstBoot`, which adopts an existing slot
  rather than recreating it. Nothing is restored, so nothing is resumed over a gap. Cost is a full
  client resync plus permanently orphaned `shape/*` streams (orphan GC is bounded by the catalog, and
  durable-streams has no list operation). Expensive, not corrupting.
- **Catalog loses only its TAIL** → this is the hazard. An older `SlotBound` survives, so shapes _are_
  restored. Lost `Offset` checkpoints are safe (replay is idempotent absolute upserts); a lost
  `Retired` is safe (retirement retries, delete is idempotent). But a lost `Created` leaves
  `max_shape_id` under-counted, and `CatalogFold::max_shape_id`'s own comment spells out the result:
  re-minting `sN` _"would hand a brand-new shape the dead one's stream — the PUT succeeds, the
  backfill appends to a stream holding pre-`TRUNCATE` rows, and the pending retirement then closes and
  deletes the LIVE shape's stream"_.

There is no gap detection to catch it: `fold_catalog` folds whatever it reads, and the catalog writer
uses no idempotent-producer sequencing (no `Producer-*` headers anywhere in `apps/engine/src/ds.rs`),
so the engine cannot distinguish a catalog of 100 events from one that had 120 and lost 20. Losing
un-written-back pages truncates a tail, which is exactly this case.

## What staging needs

1. **`--durability wal`.**
2. **`--data-dir` on a mounted PVC.** Non-negotiable and easy to get wrong: `--data-dir` defaults to a
   temp dir, so wal without it fsyncs every append and discards it on restart while looking perfectly
   healthy. The fork now **refuses to start** on that combination
   (pgxsinkit/durable-streams-rust, `--durability wal` requires an explicit `--data-dir`), so this
   fails loudly at deploy rather than silently at the first node loss — but the volume still has to
   exist.
3. **A storage class with honest fsync — only an open question off local-path.** A local-path PVC is a
   directory on the node's filesystem (the provisioner bind-mounts a hostPath), so there is no storage
   layer between the process and the disk and the fsync semantics are the ones already exercised — see
   Evidence. The question reopens only on **network-attached** storage (NFS, iSCSI, cloud block devices
   with write caching), where a flush can be acknowledged before it is durable, and wal's guarantee is
   then only as good as that acknowledgement.
4. **Disk sizing / retention.** WAL segments plus per-stream files grow; `--wal-checkpoint-wal-bytes`
   bounds retained WAL, and checkpoint cadence (`--wal-checkpoint-interval-ms`, default 3000) is an
   explicit crash-replay budget — it also sets restart time, which matters because there is no HA.
5. **A backup decision.** The catalog is not reconstructible from Postgres. Either back the volume up,
   or accept the "catalog entirely lost" outcome above (full resync + orphaned streams) as the
   recovery path. Accepting it is defensible; leaving it undecided is not.
6. **Network isolation — the server has no authentication.** None: the only credentials anywhere in
   `durable-streams-rust` are the S3 keys for the optional cold tier. Anyone who can reach the port
   can read any stream, append to any stream, and `DELETE` any stream — including `meta/catalog`,
   which would hand the engine the "catalog entirely lost" path on demand. This is by design and
   matches classic Electric: authorization belongs to the edge, which for us is `board-stream`
   verifying a stream token and proxying the bytes. So `ds` must be ClusterIP-only with a
   NetworkPolicy, never an Ingress/Gateway route, and never a `LoadBalancer`.

   Note the trap: both compose files publish it on a host port (`${PGXSINKIT_DS_PORT:-8791}:8791`)
   because the lanes probe readiness from the host. That is correct for a lane and would be a total
   compromise in staging — the same shape as the `--data-dir` default, a lane config that must not
   be carried across. Unlike `--data-dir`, the server cannot guard this one: binding `0.0.0.0` is
   legitimate inside a cluster, so it is a deployment invariant to assert in review, not in code.

Not in scope: HA. durable-streams is single-node by construction, and so was classic Electric — one
walsender per replication slot. Accepted deliberately (2026-08-22).

## Evidence

Verified 2026-08-22 on the implementation lane (which includes `restore-resume.integration.test.ts`):
**56 passed, 0 failed** against `--durability wal` on `ghcr.io/pgxsinkit/durable-streams-rust:sha-4da82ab`,
with the resolved compose config checked rather than assumed. The default (memory) lane passes too, so
adding `--data-dir` did not regress the path every other lane takes.

**Local-disk durability is already covered, and a local-path PVC adds nothing to it.** The server's own
suite (112 tests) runs on local disk and includes a seeded crash/recovery simulation that crashes the
runtime, injects power-loss disk faults, reboots through the real recovery sequence and checks a
no-loss/no-torn oracle across multiple generations per seed — plus named regressions for the torn- and
short-tail cases. The lanes fsync to the container's writable layer, which is overlayfs on the node's
local disk. All of that is the same filesystem path a local-path PVC gives you.

What remains untested is narrower than it first looks:

- **k8s plumbing, not durable-streams behaviour** — that the volume mounts where expected with usable
  permissions, and that a pod restart re-opens the same directory cleanly. The crash simulation covers
  the recovery half; what it cannot cover is the container boundary.
- **Network-attached storage**, if the storage class is ever anything but local-path (see requirement 3).
- **wal under load** at real shape counts — both lanes are functional tests, not throughput ones.
- **The other four lanes** (contract, worker, placement, board), all still memory-only — now a single
  env var each, `PGXSINKIT_DS_DURABILITY=wal`.
