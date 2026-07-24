import type { StoreWorkerQuiesceOutcome } from "@pgxsinkit/client";

// The DOM-FREE core of "quiesce the store's SharedWorker, THEN destroy its artifacts" (ADR-0050). The real
// browser wiring — the `new SharedWorker(name)` teardown port and `destroyStoreArtifacts` — is INJECTED via
// {@link QuiesceThenDestroyDeps}, so the orchestration (does it quiesce first, does it swallow or diagnose a
// failure, which step's stall does the thrown message name) is unit-testable in bun with plain fakes and no
// DOM. store-registry-default.ts binds the real deps as the exported `quiesceThenDestroyStore`; this split
// mirrors store-registry.ts vs store-registry-default.ts.

/** Options for {@link quiesceThenDestroyStoreWith}. */
export interface QuiesceThenDestroyOptions {
  /** The WIPE path passes `true`: on failure, THROW a diagnostic error naming WHICH step stalled — the worker
   * teardown (quiesce) vs. the subsequent artifact delete — so a real-device failure is self-diagnosing (the
   * board's `destroyKnownStores` surfaces the thrown message to the user). The background obsolete-drain omits
   * it (or passes `false`): the quiesce stays best-effort/swallowed and the destroy's own error propagates
   * unchanged — it must NOT start throwing a synthesized message and break the obsolete-list retry drain. */
  diagnostic?: boolean;
}

/** The injected effects {@link quiesceThenDestroyStoreWith} drives. */
export interface QuiesceThenDestroyDeps {
  /** Whether a per-store SharedWorker exists to tear down. `false` in the in-process fallback (no worker) →
   * the quiesce step is skipped entirely and only {@link destroy} runs. */
  workerMode: boolean;
  /** Tear down the store's SharedWorker host so its backend connection releases before the delete. REJECTS on
   * a handshake timeout, a declaration refusal, or a teardown-ack error — a rejection is NOT proof of teardown. */
  quiesce: (storePath: string) => Promise<StoreWorkerQuiesceOutcome>;
  /** Destroy every artifact for the path (OPFS directory + sentinel + meta + idb). MAY reject (still held). */
  destroy: (storePath: string) => Promise<void>;
}

/**
 * Release a store's backend connection (tear down its SharedWorker host) and THEN destroy its artifacts
 * (ADR-0050). An `extendedLifetime` idbfs worker surviving a reload keeps holding its IndexedDB connection, so
 * without the teardown the delete blocks forever; quiescing first frees it so the destroy converges on the same
 * boot. The quiesce is captured (never blindly swallowed) so a diagnostic caller can report which step stalled:
 *
 *   - quiesce REJECTED (e.g. "timed out after 6000ms") and the destroy then failed → the WORKER teardown did
 *     not complete (its background sync worker did not shut down);
 *   - quiesce SUCCEEDED (`toreDown: true`) but the destroy still failed → teardown succeeded, the delete was
 *     still blocked (something other than this store's own worker holds it);
 *   - nothing to tear down (in-process fallback, or an `elected-worker` home) and the destroy failed → no live
 *     shared-worker engine needed teardown.
 *
 * Best-effort by default: without `diagnostic`, a quiesce failure is swallowed and the destroy's own error (or
 * success) propagates unchanged — the behaviour the background obsolete-list drain depends on.
 */
export async function quiesceThenDestroyStoreWith(
  deps: QuiesceThenDestroyDeps,
  storePath: string,
  opts?: QuiesceThenDestroyOptions,
): Promise<void> {
  let quiesceError: unknown;
  let toreDown = false;
  if (deps.workerMode) {
    try {
      toreDown = (await deps.quiesce(storePath)).toreDown;
    } catch (cause) {
      // Best-effort: a quiesce failure (timeout, refusal, or the worker already gone) never aborts the destroy,
      // whose own ownership-lag handling reports honestly and leaves the path re-runnable. Captured (not
      // swallowed) so the diagnostic caller can name it if the destroy then also fails.
      quiesceError = cause;
    }
  }
  try {
    await deps.destroy(storePath);
  } catch (destroyCause) {
    if (opts?.diagnostic === true) {
      throw quiesceThenDestroyDiagnostic({ quiesceError, toreDown, destroyCause });
    }
    throw destroyCause;
  }
}

/** Build the diagnostic error for a failed quiesce-then-destroy (the message the wipe surfaces to the user):
 * it names whether the WORKER teardown or the subsequent artifact delete is what stalled. */
export function quiesceThenDestroyDiagnostic(input: {
  quiesceError: unknown;
  toreDown: boolean;
  destroyCause: unknown;
}): Error {
  const destroyMsg = messageOf(input.destroyCause);
  if (input.quiesceError != null) {
    const quiesceMsg = messageOf(input.quiesceError);
    const timedOut = /timed out after (\d+)ms/.exec(quiesceMsg);
    const teardown =
      timedOut != null
        ? `worker teardown timed out after ${timedOut[1]}ms — the store's background sync worker did not shut down`
        : `worker teardown failed (${quiesceMsg}) — the store's background sync worker did not shut down`;
    return new Error(`${teardown}; the artifact delete then failed: ${destroyMsg}`);
  }
  if (input.toreDown) {
    return new Error(`worker teardown succeeded but the artifact delete was still blocked: ${destroyMsg}`);
  }
  return new Error(`${destroyMsg} — no live shared-worker engine needed teardown`);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
