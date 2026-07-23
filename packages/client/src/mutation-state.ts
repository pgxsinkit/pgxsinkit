/**
 * The mutation-journal state machine (ADR-0005, extended by ADR-0006).
 *
 * The runtime is large; previously the legal status transitions were implicit,
 * scattered across SQL writes. This is the one named place that defines them, so the
 * rules are testable and a future change extends a single table. ADR-0006 splits the
 * old single `failed` into transient (retryable `failed`) and permanent (`quarantined`).
 */

export type MutationStatus = "pending" | "sending" | "acked" | "failed" | "quarantined" | "conflicted" | "rejected";

/**
 * Legal transitions. `acked` is terminal at the journal level — it is cleared by
 * reconciliation once the synced echo reaches the acknowledged server timestamp, not
 * by another status transition. `quarantined` is terminal too: the server will never
 * accept the mutation as-is, so it is surfaced (callback + diagnostics), never retried.
 * `conflicted` (ADR-0015) is likewise terminal but a *different* outcome: the write was
 * well-formed but **stale** (an external write interleaved) and the table's `reject-if-stale`
 * policy declined it. The optimistic Overlay is KEPT (the user's edit is not lost) and the
 * conflict is surfaced via `onConflict`; resolution is an ordinary NEW mutation, and `discard`
 * clears the overlay + this entry. It is never retried as-is (the base would still be stale).
 * `rejected` (ADR-0022) is terminal as well, and the inverse of `conflicted` on disposition: the
 * authoritative endpoint declined the whole pessimistic write-**unit** for a business reason (a
 * capacity/quota/uniqueness rule the client could not evaluate locally), so the optimistic Overlay
 * is **auto-discarded** for every member of the unit and the typed reason is surfaced via `onReject`.
 * Never retried (the server's answer is authoritative).
 *
 * - `pending     -> sending`      a flush claims the row and posts it.
 * - `sending     -> acked`        the server acknowledged the mutation.
 * - `sending     -> failed`       transient transport/server error (network, 5xx, …).
 * - `sending     -> quarantined`  structural 4xx rejection the server will never accept.
 * - `sending     -> conflicted`   a stale write the reject-if-stale policy declined (ADR-0015).
 * - `sending     -> rejected`     a business rejection from the authoritative endpoint (ADR-0022).
 * - `sending     -> pending`      recoverSending re-queues an in-flight row on startup.
 * - `pending     -> quarantined`  a RESTORE boot quarantines every non-terminal row recovered from a
 *   backup (ADR-0035 decision 6). A `pending` row is normally only ever claimed (`-> sending`), but a
 *   store restored from a backup must NOT auto-flush anything it recovered — the write path has no
 *   `mutationId` dedupe ledger, so replaying a recovered `pending`/`sending`/`failed` mutation is unsafe
 *   (silent last-write-wins reverts, create PK collisions). Restore is therefore the ONE producer of this
 *   edge; ordinary boots never move a `pending` row straight to `quarantined`.
 * - `failed      -> pending`      retryFailed re-queues a failed row.
 * - `failed      -> quarantined`  the hard max-attempts cap is reached; stop retrying (also the restore
 *   quarantine of a recovered `failed` row, ADR-0035 decision 6 — the edge already existed).
 */
export const MUTATION_TRANSITIONS = {
  // `pending -> quarantined` exists ONLY for the restore-boot quarantine (ADR-0035 decision 6); the normal
  // flush path only ever claims a pending row (`-> sending`).
  pending: ["sending", "quarantined"],
  sending: ["acked", "failed", "quarantined", "conflicted", "rejected", "pending"],
  failed: ["pending", "quarantined"],
  quarantined: [],
  conflicted: [],
  rejected: [],
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

/**
 * The hard cap on send attempts (ADR-0005 congestion policy). A mutation that has
 * failed this many times — even with transient-looking errors — is given up on and
 * quarantined, so a permanently-unreachable server never produces an unbounded retry
 * loop. The consumer can raise/lower it via `createSyncClient({ maxMutationAttempts })`.
 */
export const DEFAULT_MAX_MUTATION_ATTEMPTS = 10;

/**
 * 4xx statuses that are nonetheless transient: auth (the runtime refreshes the token and
 * retries), request-timeout, too-early, and rate-limit. Everything else in the 4xx range
 * is treated as a structural rejection the server will never accept as-is.
 */
const TRANSIENT_CLIENT_ERROR_STATUSES: ReadonlySet<number> = new Set([401, 403, 408, 425, 429]);

/**
 * Classify a flush failure into its durable journal state (ADR-0006 decision 4):
 * - `quarantined` (terminal): a structural 4xx rejection — retrying is pointless, so it
 *   is surfaced rather than retry-looped (the silent-data-loss case the runtime *can*
 *   catch at send time).
 * - `failed` (retryable): network/transport (no status), any 5xx, or a transient 4xx.
 */
export function classifyFailureStatus(httpStatus: number | null | undefined): "failed" | "quarantined" {
  if (httpStatus == null) {
    return "failed";
  }

  if (httpStatus >= 400 && httpStatus < 500 && !TRANSIENT_CLIENT_ERROR_STATUSES.has(httpStatus)) {
    return "quarantined";
  }

  return "failed";
}
