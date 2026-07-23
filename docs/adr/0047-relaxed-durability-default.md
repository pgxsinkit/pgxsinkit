# Relaxed durability is the default for the local store, declared on the registry

Status: accepted (2026-07-18)

PGlite's idb backend flushes the whole datadir to IndexedDB **synchronously at the end of every
query**, and the client cannot query again until that flush returns. On the read path (batched sync
commits) the flush amortises, but on the write path each optimistic mutation is its own small
transaction, so the flush — not the SQL — sets the latency floor: a consumer measured a **~50ms+
floor per statement** on idb, dominated entirely by the synchronous IndexedDB write. Every optimistic
`create`/`update`/`delete` pays it before its overlay row is even visible, so the local-first "instant"
write is anything but.

PGlite already exposes the lever: `PGlite.create(dataDir, { relaxedDurability: true })` returns a query
**before** the datadir flush and schedules the flush asynchronously, so query latency reflects the
query itself. The only cost is a narrower flush-timing window (below). pgxsinkit is a local-first sync
toolkit whose whole value proposition is that the local write is instant and the server catches up in
the background — so the synchronous flush is exactly the wrong default for it. This ADR makes relaxed
durability the toolkit's default on every backend and puts the one opt-out where the data contract
lives: the registry.

## Decision

1. **Durability is declared on the registry, once.** `SyncRegistryDefinition.storage` carries
   `durability?: "relaxed" | "strict"`, default `"relaxed"`, applying to every backend the store
   may boot on (`idbfs`, `opfs-repacked`, `filesystem`; a no-op on `memory`). No minting surface,
   worker entry, or attach site takes a durability option: whether losing the last
   not-yet-flushed action is acceptable is decided by what the data IS, so the declaration
   belongs to the data contract, and one declaration binds every open of every store minted from
   that registry — no tab can ever disagree with another about a store's durability, because no
   open site sets durability at all. A capability fallback from opfs to idbfs (ADR-0049
   decision 1) keeps the declared durability. The declaration binds browser stores; Node mints
   and throwaway clones keep their environment's resolution (ADR-0049 decision 14).

2. **The declaration is resolved at exactly one point.** `createSyncClient` resolves
   `storage?.durability ?? "relaxed"` from its registry and passes the result into every store
   mint it performs (its own boot and the provision/spare path), all of which funnel through
   `createClientPGlite`; no surface re-defaults. A caller-supplied `pgliteInstance`/
   `precreatedPglite` remains caller-owned construction, as today: the engine never re-opens or
   re-configures an instance it did not mint — which is precisely what lets a server-side
   artifact builder construct its throwaway filesystem store with whatever settings suit a build
   pipeline.

3. **The resolved mode is stamped on the boot rail.** The `boot pglite.create` `timeAsync`
   metadata carries the resolved durability alongside the storage scheme, so every
   BootReport-adjacent rail capture shows the durability mode the store was created under — no
   guessing which mode a slow (or fast) boot ran in.

4. **The export throwaway clone sets relaxed unconditionally.** The export machinery's read-only,
   memory-backed clone (`PGlite.create({ loadDataDir })`) passes `relaxedDurability: true`. It is a
   no-op on the memory backend (no flush to relax), set only to state intent and stay correct if
   that clone's backend ever changes.

## Loss-window analysis

Relaxed durability weakens **when** data reaches durable storage, not **whether** it is recoverable.
The at-risk case is a crash before BOTH:

- the mutation's journal row reaches the **write API** — which happens within ~hundreds of ms of
  enqueue on a healthy connection; and
- the **scheduled flush** lands.

Only the writes not yet covered by a completed flush — typically the last one or two under
human-rate input — can sit inside both windows at once. And the tables that matter divide cleanly:

- **Synced tables are recoverable from the server by construction.** Their rows arrive over the read
  path and are re-derivable; relaxing their flush *timing* costs nothing durable, because the server
  is the source of truth and a lost local flush is refilled on the next sync.
- **The Mutation journal** is the correctness backstop (ADR-0036), but its rows flush to the write
  API on a ~hundreds-of-ms loop, so the crash window where a journal row is neither server-side nor
  locally flushed is small and bounded to one recent action.
- **Consumer local-only tables** carry whatever risk the consumer accepts — there is no server copy,
  so a crash inside the flush window can lose the most recent local-only write. A consumer for whom
  that is unacceptable declares `storage: { durability: "strict" }` on the registry.

On `opfs-repacked`, strict's per-commit flush is cheap (ADR-0049 driver 3), so a strict
declaration costs little there; on `idbfs` it reinstates the ~50ms+ per-statement floor — the
declaration is per-registry precisely so that price is a conscious, data-driven choice.

## Relationship to ADR-0036

ADR-0036 states "pgxsinkit's durability semantics assume a persisted store": `retention: "persistent"`
means "survives a restart", and the optimistic journal is what makes a background flush safe. Relaxed
durability does **not** violate that. The store is still persistent — every write still lands in
durable storage — relaxed durability only changes the **timing** of the flush (asynchronous, shortly
after the query, rather than synchronously inside it). ADR-0036 is about *persistence*; this ADR is
about *flush latency*. The memory-store prohibition, the retention guarantee, and the journal
backstop are all unchanged (and relaxed durability is a no-op on a memory store).

## Alternatives considered

- **Keep strict durability the default; make relaxed opt-in.** Rejected: it makes the toolkit's
  headline promise (instant local writes) an opt-in tuning step every consumer must discover, and the
  ~50ms+ floor is present on the default path — the worst place for it. The loss window is narrow and
  bounded to one recent action, and synced data is server-recoverable, so relaxed is the right default
  for a sync toolkit. The opt-out remains one declaration. Tracked as backlog-0006 (revisit if the
  flush cost profile changes).
- **A per-open durability option on the minting surfaces.** Rejected: durability follows the data,
  not the open site — two knobs over one behavior demand precedence rules, let one tab's open
  disagree with another's, and make the durability of a capability fallback ambiguous. One
  registry declaration has none of those problems.
- **Batch/debounce the synchronous flush ourselves above PGlite.** Rejected: it reimplements, less
  well, exactly what PGlite's `relaxedDurability` already does, and couples us to PGlite flush
  internals — the same reason ADR-0028 keeps us off private upstream constants.
- **Per-table durability.** Rejected as premature: the flush is a whole-datadir operation, so there is
  no cheap per-table lever today. Revisit if PGlite gains incremental/partitioned flush (also a
  backlog-0006 reopen signal).

## Consequences

- Local optimistic writes shed the per-query flush floor by default; the write path's latency
  reflects the SQL, and the flush rides asynchronously behind it.
- Consumers with local-only tables they cannot re-derive from the server, and for whom a one-action
  crash window is unacceptable, declare `storage: { durability: "strict" }` on the registry.
- [backlog-0006](../backlog/0006-restore-strict-durability-default.md) stays parked as the marker
  for revisiting the default; the OPFS storage model it anticipated
  ([backlog-0007](../backlog/0007-opfs-storage-model.md)) landed as ADR-0048/0049, and ADR-0049
  decision 9 keeps relaxed the default there too.
