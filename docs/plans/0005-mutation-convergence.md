# Plan — ADR-0005: Mutation convergence

Implements [ADR-0005](../adr/0005-mutation-convergence.md). Goal: keep the explicit
primitives, add an opt-in convergence driver, centralise congestion policy, make the
state machine explicit, and fix `destroy()`.

Depends on: [ADR-0006](../adr/0006-local-schema-evolution.md) drop primitive (for
`destroy()` wipe). Phases 1–3 are independent of it.

## Phase 1 — Explicit internal state machine

- In `packages/client/src/mutation.ts`, name the transition machine over the
  existing `pending`/`sending`/`acked`/`failed` data: one place that defines legal
  transitions and the guards (e.g. `sending → acked` only on matching echo;
  `sending → pending` on `recoverSending`). No public-interface change.
- Tests: drive each transition explicitly; this is also the seam to later add the
  transient/permanent `failed` split (ADR-0006).

## Phase 2 — Congestion policy in the library

- Centralise retry backoff: jittered exponential backoff, a max-attempts cap, and a
  global in-flight concurrency cap, all inside the runtime (not per-app).
- Surface the knobs as config with safe defaults; `retryFailed` continues to work
  manually.
- Tests: backoff schedule is jittered + bounded; concurrency cap holds under a burst.

## Phase 3 — Opt-in convergence driver

- `createSyncClient` accepts an optional `autoSync` driver:
  - app supplies a `shouldFlush()` predicate (network/power/foreground) and the
    driver wires `online`/`visibilitychange` (browser) — the RN adapter
    (`AppState`/`NetInfo`) is the proving second adapter.
  - the driver calls `flush`/`reconcile`/`retryFailed` under the congestion policy.
  - omit it → today's fully-manual behaviour, unchanged.
- Replace the hand-rolled loops in `apps/web` and `apps/perf-lab` with the driver
  (proving the duplicated glue is gone).
- Tests: driver flushes only when the predicate allows; pauses offline/backgrounded;
  manual mode untouched.

## Phase 4 — `destroy()` is a true teardown

- Split `stop()` (halt sync, close handle) from `destroy()` (wipe local store:
  synced cache + overlay + journal), reusing the ADR-0006 drop primitive.
- Guard: `destroy()` surfaces un-flushed/pending mutations (or requires `force`) so
  it never silently drops owed writes.
- Tests: `stop()` leaves data; `destroy()` clears it; the guard fires on pending
  writes.

## Acceptance

- State machine explicit and tested (`mutation-state.ts`,
  `tests/unit/mutation-state.test.ts`); backoff jittered + bounded, flushes already
  serialised. **(Phase 1 + the jitter half of Phase 2 done)**
- Driver opt-in; both demo apps use it; manual mode preserved. **(Phase 3 — deferred
  to its own change verified on the Podman integration lane; retry cadence must be
  checked against real `next_retry_at_us` backoff, not unit fakes)**
- `destroy()` wipes; `stop()` does not; pending-write guard tested. **(Phase 4 —
  deferred to land with ADR-0006's drop primitive)**
- Max-attempts cap **(deferred to ADR-0006's quarantine terminal state)**.
