// The engine lifecycle slot (ADR-0035 decision 4). A store holds ONE in-flight lifecycle operation at a
// time — the three exports plus the destructive ops `destroy()`/`discardEphemeral()`/`dropReadCache()` — so
// two blackout-class operations can never overlap and corrupt each other's view of the store. The slot does
// NOT queue: a
// second entrant while one is running is rejected immediately with a typed {@link LifecycleBusyError}
// (the ADR's deliberate choice — a fresh artefact is better served by the caller retrying than by
// stacking back-to-back operations the second could get fresher after the first settles).

/**
 * Thrown when a lifecycle operation is attempted while another already holds the slot (ADR-0035). Carries
 * the running operation's `label` so a caller (or a retry policy) can report exactly what it collided with.
 * A distinct error type — not a bare `Error` — so callers can `instanceof`-branch a busy collision from a
 * genuine operation failure.
 */
export class LifecycleBusyError extends Error {
  /** The label of the lifecycle operation currently holding the slot. */
  readonly runningLabel: string;
  /** The label of the operation that was refused. */
  readonly attemptedLabel: string;

  constructor(attemptedLabel: string, runningLabel: string) {
    super(
      `[pgxsinkit] lifecycle busy: "${attemptedLabel}" refused while "${runningLabel}" is running (ADR-0035; retry once it settles).`,
    );
    this.name = "LifecycleBusyError";
    this.attemptedLabel = attemptedLabel;
    this.runningLabel = runningLabel;
  }
}

/** A single-occupancy lifecycle slot. One owner per store (`createSyncClient`); one operation at a time. */
export interface LifecycleSlot {
  /**
   * Run `fn` under the slot's exclusion. Rejects with a {@link LifecycleBusyError} — without invoking `fn`
   * — if the slot is already occupied; otherwise holds the slot for `fn`'s lifetime and releases it in a
   * `finally`, so a throwing operation never leaves the slot stuck. The occupancy check + claim run
   * synchronously on entry (before the first `await`), so two calls issued in the same tick resolve
   * deterministically: the first claims, the second is refused.
   */
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  /** Whether an operation currently holds the slot. */
  isBusy: () => boolean;
  /** The label of the operation currently holding the slot, or `null` when free. */
  runningLabel: () => string | null;
}

/** Create an empty lifecycle slot (ADR-0035 decision 4). */
export function createLifecycleSlot(): LifecycleSlot {
  let running: string | null = null;

  return {
    run: async (label, fn) => {
      // Refuse before touching `fn` — a busy collision must have zero side effects on the running operation.
      if (running !== null) throw new LifecycleBusyError(label, running);
      // Claim synchronously (before the first `await` below) so a same-tick second entrant sees us busy.
      running = label;
      try {
        return await fn();
      } finally {
        running = null;
      }
    },
    isBusy: () => running !== null,
    runningLabel: () => running,
  };
}
