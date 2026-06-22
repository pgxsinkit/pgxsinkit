# Mutation convergence: mechanism primitives plus an opt-in driver

Status: accepted (2026-06-22); partially implemented

The product promise is reliable offline operation and eventual convergence. The
mutation journal (`packages/client/src/mutation.ts`, 1,835 lines) is deep in raw
behaviour: local staging, overlay construction, journal sequencing, HTTP
transport, acknowledgements, retry metadata, and echo reconciliation.

The public `SyncClient` exposes `flush`, `reconcile`, `retryFailed`,
`recoverSending`, `readMutationDetails`, and `diagnostics`
(`client/index.ts:66-70`). `recoverSending` is **already** called automatically at
construction (`:164`), so the "caller must drive recovery" framing is only partly
true. But two consumers (`apps/web`, `apps/perf-lab`) each hand-roll the same
flush → poll → reconcile → retry loop — duplicated orchestration glue, the exact
"complexity spread across callers" the deletion test flags as a missing module.

Separately, `stop()` and `destroy()` are byte-identical (`index.ts:196-207`): both
only close PGlite. `destroy()` leaves the IndexedDB store — and the journal of
un-erased mutations — intact, a footgun for logout and erasure.

Maintainer decision (2026-06-22): unbundle "the lifecycle" — different operations
have different rightful owners — and adopt the mechanism-primitives + opt-in-driver
split.

## Decision

1. **Unbundle ownership.**
   - *recoverSending* (reclaim in-flight on startup): **library**, already
     automatic. Unchanged.
   - *Congestion policy* (jittered exponential backoff, retry caps, a global
     concurrency cap): **library**. The thundering-herd failure after an outage is
     a library-level responsibility no single app can coordinate.
   - *Scheduling policy* (when to flush — online? not on cellular? not
     backgrounded?): **app**. Only the app knows network/power/foreground state.
   - *Reconciliation* (clear acked overlay once the echo lands): **library**,
     driven off sync events.

2. **The explicit mechanism primitives (`flush`, `reconcile`, `retryFailed`) stay
   public.** Removing them pushes scheduling policy into per-app workarounds (fails
   the deletion test); they are deterministic and trivially testable.

3. **Add an opt-in convergence driver.** `createSyncClient` accepts an optional
   driver that owns the convergence loop using the primitives, taking an
   app-supplied scheduling predicate (`shouldFlush` / network + power conditions)
   plus online/visibility hooks. Pass nothing → fully manual (today's behaviour).
   The driver is a real seam: browser (`visibilitychange`/`online`) versus React
   Native (`AppState`/`NetInfo`) are two genuine adapters, which is what earns the
   seam its place.

4. **Make the internal mutation state machine explicit.** The states
   `pending`/`sending`/`acked`/`failed` already exist as data (`mutation.ts:45`);
   the *transitions* become a named machine. Orthogonal to the public interface;
   directly improves the 1,835-line module's testability. Do this regardless.

5. **`destroy()` becomes a true teardown.** It wipes the local store (synced cache
   + overlay + journal), distinct from `stop()` (which only halts sync and closes
   the handle). This reuses the drop primitive from
   [ADR-0006](0006-local-schema-evolution.md). A guard surfaces pending un-flushed
   mutations before the wipe (or requires an explicit `force`), so "destroy" never
   silently drops owed writes.

## Consequences

- The common case ("just converge") stops being copy-pasted; offline/metered apps
  keep full control.
- Congestion safety is centralised; servers stop being hammered on recovery.
- `destroy()` finally means destroy; logout and erasure become correct.

## Implementation status

- **Decision 4 (explicit state machine) — done.** `packages/client/src/mutation-state.ts`
  is the one named definition of the journal transitions
  (`pending`/`sending`/`acked`/`failed`), with `isValidMutationTransition` /
  `assertValidMutationTransition`; the runtime sources `MutationStatus` from it and
  guards the manual `retryFailed`/`recoverSending` transitions. Pinned by
  `tests/unit/mutation-state.test.ts`. ADR-0006 extends this with the
  transient/permanent split.
- **Decision 1 (congestion policy) — partially done.** Backoff now applies equal
  jitter around the existing capped-exponential ceiling
  (`computeRetryDelayMs`, injectable RNG), so a fleet does not retry in lockstep
  after an outage. Flushes are already serialised through the runtime's `flushQueue`
  (effective concurrency cap of 1). A hard max-attempts cap is folded into ADR-0006's
  quarantine state (a terminal "give up" needs that state).
- **Decision 3 (opt-in convergence driver) — deferred.** The driver's retry cadence
  interacts with the runtime's per-mutation `next_retry_at_us` backoff in ways that
  must be verified against real sync (the Podman integration lane), not just unit
  fakes. To be built as its own focused change with that lane, including the demo
  rewire.
- **Decision 5 (`destroy()` teardown) — deferred** to land with ADR-0006's
  `dropReadCache`/full-wipe drop primitive, which it reuses.

References: [ADR-0006](0006-local-schema-evolution.md) (drop primitive, quarantine
state); `CONTEXT.md` (Mutation journal, Overlay);
[docs/plans/0005-mutation-convergence.md](../plans/0005-mutation-convergence.md).
