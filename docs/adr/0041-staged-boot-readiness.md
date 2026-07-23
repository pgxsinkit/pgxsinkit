# Staged boot readiness: local-read before write and network

Status: accepted (2026-07-14) — delivery Option B (maintainer ruling)

> The maintainer has ruled on the delivery API shape: **Option B — change the default** (see
> §Delivery). Implementation remains deliberately sequenced **last** in the warm persisted store
> lane — after the recovery-marker and schema-fingerprint slices land and the warm-boot benchmark
> is re-run — because the latency case for this change collapses once those slices remove the
> per-table recovery and schema-replay costs (see Context). This ADR fixes the semantics and the
> invariants; the ruling authorises the Option B contract change when that point in the lane is
> reached.

## Context

pgxsinkit exposes exactly one boot gate to a consumer: the client object's existence. In worker
mode the worker posts `attach-ack` only inside the boot promise's `.then` — after
`createSyncClient()` has fully returned (`packages/client/src/worker/define-sync-worker.ts:745-762`)
— so `attachSyncClient()` does not resolve until the whole boot has run. The returned facade's data
methods are then **entirely ungated**: safety today is "the object is not handed back until boot
finished", not per-method gating. The only method that awaits an internal readiness signal is
`exportStore`, which awaits `ready` (`packages/client/src/index.ts:1987`; the lifecycle siblings at
:2008/:2027 do the same).

That single gate covers a long, strictly ordered boot
(`packages/client/src/index.ts:1293-1418`, client-owned PGlite path):

1. `prepareLocalDbBeforeSchema` hook (`:1294-1297`);
2. durable local-schema exec — `generateLocalSchemaSql(registry)` then `pglite.exec` (`:1299-1300`);
3. `prepareLocalDbAfterSchema` hook (`:1302-1305`);
4. mutation-runtime construction (`:1321-1332`);
5. `recoverSending()` — one journal update per writable table (`:1337`);
6. restore-boot `quarantineRecovered()`, restore only (`:1346-1348`);
7. store-version reconcile against the registry fingerprint (`:1360-1367`);
8. `openDbGate()` — the overlap commit gate (`:1382`);
9. sync **start** (not catch-up), `startConfiguredSync` (`:1390` overlap / `:1412` sequential).

On a cold-worker warm-store boot the GenreTV trace attributed ~1,712 ms to step 5 and ~438 ms to
step 2 — both scaling with writable-table count, both about to be removed by the recovery-marker and
schema-fingerprint slices of the warm-store lane. After those slices, the window between a
hypothetical local-read-ready point (PGlite open + compatible schema + reconcile done) and today's
`attach-ack` is roughly hooks + reconcile + sync-start — on the order of **125–200 ms**, not seconds
(trace: reconcile 66 ms, sync start 125 ms). **This ADR is therefore justified on semantics, not on
seconds saved.** The invariant that matters is: *a cached local read must not depend on sync startup
or the network.* Today a consumer that only wants to paint rows already sitting in IndexedDB still
waits for the write runtime and the sync engine to start, offline or not.

pgxsinkit already has four readiness surfaces, none of which expresses "cached reads are safe":

- `ready` — whole-client initial-sync completion (resolves at `onInitialSync`; in worker mode a late
  tab resolves it off the engine-ready ack, ADR-0032 FIX 3 / ADR-0034).
- per-group `groupReady(group)` — Electric catch-up for one consistency group (ADR-0021/0031).
- subscription `hydrated` — a single live query's rows-before-signal edge (ADR-0040 decision 3).
- ADR-0039 write activation — a lazy group activating when a write references it.

`localReadReady` is the missing fifth surface, and it is the one the warm-store paint depends on.

## Decision

1. **Introduce two new monotonic boot stages, below the existing two.** In staging order:

   - `localReadReady` — PGlite is open, the durable schema is compatible (fingerprint match or
     completed evolution, per the schema-fingerprint slice), any required read-cache rebuild has
     finished, and cached rows are queryable. Resolving this stage does **not** require the write
     runtime, sync start, or any network I/O.
   - `writeReady` — `recoverSending()` (or its marker fast path) and write-runtime initialisation
     have completed; enqueue is safe.
   - `groupReady(group)` — unchanged (per-group Electric catch-up).
   - `ready` — unchanged (whole-client initial sync).

   The stages are monotonic and never regress. Each is exposed as an idempotent promise on the
   client facade (`localReadReady: Promise<void>`, `writeReady: Promise<void>`), alongside the
   existing `ready`/`groupReady`.

2. **Stages are milestone events on the worker bridge, folded for late attachments.** The worker
   emits a one-shot milestone message per stage as the engine crosses it (new protocol messages
   alongside `attach-ack`, in the ADR-0032/0034 one-shot/bounded family — no steady-state cost). A
   tab attaching after a stage has already fired receives the current milestone set immediately,
   mirroring the existing engine-ready/group snapshot fold on attach
   (`packages/client/src/worker/attach-sync-client.ts:193-273`: the status snapshot's `status.groups`
   merge that lets a late tab resolve `groupReady` off the snapshot, and the `engineReady` ack path
   that resolves a late `ready`). One engine crosses each stage once; every port — early or late —
   observes the same monotonic sequence.

3. **The `createSyncClient()` monolith splits into a local-read core and a write/sync activation
   tail.** Steps 1–3 and 7 above (hooks, durable schema, reconcile) plus the drizzle read facade
   (`:1370`) form the local-read core and resolve `localReadReady`. Steps 4–6 (mutation runtime,
   `recoverSending`, restore quarantine) resolve `writeReady`. Step 9 (sync start) continues to feed
   `ready` as today. The split is the invasive part and the reason this ADR sequences last: the
   recovery/reconcile interleave at `index.ts:1337-1367` (recover → quarantine → reconcile) must be
   untangled so that read exposure never precedes schema compatibility, and quarantine never lets an
   unquarantined recovered write become visible (see Invariants).

## Delivery

The stages above are internal and additive regardless of how the facade is delivered. What needs a
maintainer ruling is **when `attachSyncClient()` (and the in-process constructor) resolves**, given
the hard hazard the proposal itself names: *there must be no app-visible object whose methods
silently fail depending on timing.* If the facade is delivered before `writeReady`, its write
methods must **explicitly await `writeReady`, or reject with a clear, typed error** — never
no-op or throw an opaque failure.

- **Option A — progressive attach, opt-in.** A new option/entry point —
  `attachSyncClient({ progressive: true })` (or a distinct `attachSyncClientProgressive()`) — resolves
  the facade at `localReadReady`; write methods on that facade await `writeReady` internally. The
  bare `attachSyncClient()` resolves at full boot. Cost: two attach
  shapes to document and keep behaving identically, and the "object exists but writes are still
  gated" state exists only on the opt-in path (a smaller, self-selected blast radius).

- **Option B — change the default.** `attachSyncClient()` always resolves at `localReadReady`; every
  write method awaits `writeReady` internally (or rejects clearly if called against a not-yet-writable
  engine and the consumer opts out of awaiting). One meaning for every consumer, and the semantic
  contract becomes the default that CI/prod exercise. Cost: it is a behavioural change to a published
  contract — any consumer that today assumes "attach resolved ⇒ a write will flush immediately" now
  has a facade whose first write may await write-runtime init. The window is ~125–200 ms after the
  warm-store slices, so the practical exposure is small, but it is still a contract change and must
  be called out in release notes.

**Recommendation: Option A.** It delivers the semantic surface (`localReadReady` as a
first-class, network-independent gate) on an explicit opt-in path, keeping the "object exists but
writes are still gated" state to a self-selected blast radius. Option B's single-meaning tidiness is
real but concentrates that gated-write state on every caller for a measured latency delta of a couple
of hundred milliseconds. **The pick is the maintainer's** — both are specified so the choice is a
ruling, not a redesign.

**Maintainer ruling (2026-07-14): Option B.** The contract changes: `attachSyncClient()` (and the
in-process constructor) resolves at `localReadReady`, and every write method awaits `writeReady`
internally with the typed pre-`writeReady` rejection path for consumers that opt out of awaiting.
Consumers are fixed, not preserved: the board app, the e2e/worker lanes, and every docs example are
updated to the new meaning in the same change, and the release notes call out the behavioural
change explicitly. Option A's opt-in shape is recorded above as the considered alternative only —
no `progressive` flag ships.

## Required invariants

These hold under either delivery option and constrain the core/tail split (decision 3):

- **Registry mismatch reconciled before cached reads are exposed.** `localReadReady` must not resolve
  until store-version reconcile (`index.ts:1360-1367`) has run; a stale-fingerprint boot that *defers*
  the read-cache rebuild must not expose the pre-rebuild rows as compatible.
- **Restore boot never exposes unquarantined recovered writes.** On a restore boot,
  `quarantineRecovered()` (`index.ts:1346-1348`) must complete before any read facade is handed out,
  and before `writeReady`. The quarantine-vs-read-exposure ordering is the sharpest reason the
  recovery/reconcile interleave must be untangled rather than merely reordered.
- **Offline boot resolves `localReadReady` with no network.** No Electric request, no write-API
  request, and no token fetch may sit on the `localReadReady` path. `groupReady`/`hydrated` retain
  their catch-up meaning and may remain unresolved offline — that is correct and unchanged.
- **Multi-tab: one engine initialises once; later attaches get current stages; no attach writes
  before `writeReady`.** A tab that attaches after `localReadReady` but before `writeReady` receives
  both the resolved local-read milestone and the still-pending write milestone (decision 2); its write
  methods gate exactly as the first tab's do.
- **ADR-0039 write activation is orthogonal.** Activation fires at enqueue (the `onOrdinaryEnqueue`
  seam, `index.ts:1325`), not at boot. Enqueue simply moves to post-`writeReady`; activation
  semantics are untouched — a write still activates its lazy target group when it is enqueued.

## Consequences

- **BootReport gains `localReadReadyMs` and `writeReadyMs`** (additive; `reportVersion` stays `1`,
  per ADR-0034's additive-fields rule). They sit alongside the existing decomposed `phases` and make
  the local-read/write split measurable on every boot, so the post-slice re-measurement this ADR
  waits on is captured on the same rail. These join the warm-store lane's other additive fields
  (`storeKind`, the schema/recovery flags).
- **New public surface:** the `localReadReady`/`writeReady` promises on both client modes, the new
  bridge milestone messages, and (per the Option B ruling) the changed `attachSyncClient()`/
  constructor resolution point plus the typed pre-`writeReady` rejection error. All
  structured-clone-safe or one-shot; no steady-state channel cost.
- **`createSyncClient()` is decomposed** into a local-read core and a write/sync activation tail
  (decision 3), and the recovery/reconcile interleave at `index.ts:1337-1367` is untangled. This is
  the highest-risk edit in the warm-store lane and the reason for sequencing it last, behind a
  green benchmark.
- **A method-gating surface appears where there was none.** Write methods acquire an explicit
  `await writeReady` (or a typed pre-`writeReady` rejection). This is a genuine new discipline — the
  facade's methods are ungated today — and must be uniform across the worker bridge and in-process
  client so both modes reject/await identically.
- **Testing plan** (the proposal's readiness section, verbatim intent): a cached read succeeds
  offline at `localReadReady`; a write awaits or fails explicitly before `writeReady`; restore data
  is not exposed before its quarantine/schema handling; `hydrating` stays true until group catch-up
  and row delivery, independent of the local cached paint. Plus the multi-tab fold: a late attach
  observes the correct current stage set, and no attach writes before `writeReady`. These ride the
  warm-boot Playwright scenario (online + offline runs) and the registry-width lane established
  earlier in the warm-store lane.

## Alternatives considered

- **Keep the single gate, document "attach ≠ paint-ready".** Cheapest, but it leaves cached reads
  hostage to write-runtime and sync-start init and gives offline boot no first-class contract — the
  exact semantic gap this ADR exists to close. Rejected.
- **Resolve reads off `ready`, as `exportStore` does.** `ready` means whole-client initial sync;
  binding cached reads to it re-couples them to the network and forks in worker mode for late tabs
  (ADR-0034's own rejected alternative). `localReadReady` is deliberately network-independent.
  Rejected.
- **Land staged readiness first, before the recovery/schema slices.** Tempting for the seconds it
  appears to save, but before those slices the "local-read-ready" point still sits behind ~2 s of
  per-table recovery and schema replay — the split would ship complexity while the real cost stays,
  and would then need re-tuning once the slices move the boundary. Sequenced last, on purpose.

## Out of scope

Any PGlite startup **scheduling policy** — prioritising local live-query registration over draining
prefetched Electric catch-up applies (the proposal's §7). It is rejected pending evidence: the
decomposition measurements attribute the startup contention to registration fan-out, which the
mutation-summary and recovery slices remove, and there is no existing prioritisation primitive beyond
the `dbReady` gate. Building a scheduler for a problem the data says is gone is pure risk; it stays
out until a post-slice re-measurement shows registration losing to catch-up applies.
