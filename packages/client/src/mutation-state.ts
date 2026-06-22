/**
 * The mutation-journal state machine (ADR-0005).
 *
 * The runtime is large; previously the legal status transitions were implicit,
 * scattered across SQL writes. This is the one named place that defines them, so the
 * rules are testable and a future change extends a single table. ADR-0006 will split
 * `failed` into transient (retryable) and permanent/quarantined here.
 */

export type MutationStatus = "pending" | "sending" | "acked" | "failed";

/**
 * Legal transitions. `acked` is terminal at the journal level — it is cleared by
 * reconciliation once the synced echo reaches the acknowledged server timestamp, not
 * by another status transition.
 *
 * - `pending  -> sending`  a flush claims the row and posts it.
 * - `sending  -> acked`    the server acknowledged the mutation.
 * - `sending  -> failed`   transport/server error or a non-ack response.
 * - `sending  -> pending`  recoverSending re-queues an in-flight row on startup.
 * - `failed   -> pending`  retryFailed re-queues a failed row.
 */
export const MUTATION_TRANSITIONS = {
  pending: ["sending"],
  sending: ["acked", "failed", "pending"],
  failed: ["pending"],
  acked: [],
} as const satisfies Record<MutationStatus, readonly MutationStatus[]>;

export function isValidMutationTransition(from: MutationStatus, to: MutationStatus): boolean {
  return (MUTATION_TRANSITIONS[from] as readonly MutationStatus[]).includes(to);
}

export function assertValidMutationTransition(from: MutationStatus, to: MutationStatus): void {
  if (!isValidMutationTransition(from, to)) {
    throw new Error(`Illegal mutation-journal transition: ${from} -> ${to}`);
  }
}
