// Live-tail sibling nudge (ADR-0031 live-tail completion). The engine commits a consistency group
// atomically at the group's lowest effective frontier (the MIN over per-shape `max(rawFrontier,
// commitFloor)`; see shape-inbox.ts). On the LIVE tail, when a change batch arrives on a busy shape at
// LSN L, a quiet sibling shape's frontier only advances when its parked long-poll returns — up to ~41s on
// Electric Cloud — so the busy shape's batch stays buffered, unapplied, for that whole hold. The nudge
// aborts those parked polls and forces an immediate NON-live catch-up on each lagging sibling, which
// returns a fresh `global_last_seen_lsn` in ~sub-second; the group frontier then reaches L and the batch
// commits. Commit atomicity is untouched — commits still fire only at the group min frontier — this only
// shortens how long a gated batch waits for its siblings' watermarks.
//
// This module holds the two pieces that are pure and side-effect-free (so a plain unit test can exercise
// them without dragging PGlite/Electric in through the engine module): the bounded-round constants and the
// one-shot cache-buster fetch wrapper. The stateful, per-group watchdog itself lives in the engine's
// per-group scope (index.ts), where it can read the inbox frontiers and reach the live shape streams.

/**
 * How long a hold must PERSIST before the first nudge round fires. A cross-shape transaction's halves
 * arrive milliseconds apart even on a healthy stack, so every grouped commit passes through a
 * transient "held" instant — nudging on it immediately ABORTS the sibling's long-poll that was about
 * to deliver the other half, turning a millisecond hold into an abort/refetch disruption loop
 * (regression caught by the sync-e2e integration lane on local Electric). A hold that outlives this
 * grace is the real thing: a quiet sibling parked in a multi-second poll. On Electric Cloud this adds
 * ~1s to a path that saves ~40s; on local stacks it means the nudge simply never fires.
 */
export const NUDGE_HOLD_GRACE_MS = 1_000;

/**
 * Max nudge rounds before a dead / genuinely-still-polling sibling degrades back to the old behavior
 * (wait out its live long-poll) instead of being nudged forever — so a stuck sibling never becomes a
 * refresh storm.
 */
export const NUDGE_MAX_ROUNDS = 3;

/**
 * Polling step while waiting for a nudge round's forced catch-ups to advance the group frontier. The
 * `forceDisconnectAndRefresh()` promise settles BEFORE the refreshed catch-up response lands (field
 * measurement: round 2 fired ~750ms into round 1's still-in-flight requests when the wait keyed off that
 * promise alone), so the watchdog instead polls the frontier at this step, up to
 * {@link NUDGE_ROUND_WAIT_MS} per round, breaking out the moment the target is reached.
 */
export const NUDGE_ROUND_GRACE_MS = 100;

/**
 * Max wait per nudge round for the forced catch-ups to return and advance the frontier. A nudged
 * catch-up measures ~0.9–1.4s through a warm deployed edge proxy but >3.5s against a cold one — and
 * a next round's refresh ABORTS a still-in-flight round (the abort-and-reconnect is the mechanism),
 * so an early re-nudge throws away an almost-done response. The wait therefore covers the cold-edge
 * tail; worst case to exhaustion stays NUDGE_MAX_ROUNDS × this ≈ 12s, still far under a ~41s hold.
 */
export const NUDGE_ROUND_WAIT_MS = 4_000;

/** The request URL of a `fetch` first argument, in any of its accepted forms; undefined if unreadable. */
function requestUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof input === "object" && input !== null && "url" in input) {
    return (input as { url: string }).url;
  }
  return undefined;
}

/**
 * Wrap a `fetchClient` so a pending one-shot nudge token defeats the CDN on the nudged sibling's catch-up.
 *
 * A nudge's `forceDisconnectAndRefresh` issues a NON-live catch-up (Electric sets `canLongPoll: false`),
 * which is CDN-cacheable — a HIT would return the SAME stale watermark that made the sibling lag, defeating
 * the nudge. So the watchdog drops a per-shape token into `nudgeBusters` just before it nudges; this wrapper
 * consumes that token on the sibling's next NON-live request, appending `cache-buster=<token>` to force a
 * CDN miss. It is one-shot (the token is deleted on use) and skips LIVE (`live=true`) long-polls — the token
 * is meant for the catch-up that follows the aborted poll, not the poll itself, which is left to be retained
 * for that catch-up. An already-present `cache-buster` param is overwritten. When no token is pending this is
 * a straight passthrough, so the off-path pays only this closure.
 *
 * Exported for unit testing; composed in the engine as the OUTER wrapper around `instrumentShapeFetch`, so
 * the buster stamps the URL BEFORE instrumentation logs it (the debug rail then shows `BUSTED`).
 */
export function withNudgeBuster(
  fetchClient: typeof fetch,
  nudgeBusters: Map<string, string>,
  shapeName: string,
): typeof fetch {
  const wrapped = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const token = nudgeBusters.get(shapeName);
    if (token === undefined) {
      return fetchClient(input, init);
    }
    const raw = requestUrl(input);
    if (raw === undefined) {
      return fetchClient(input, init);
    }
    const url = new URL(raw);
    // A live long-poll is the parked request the nudge aborts, not the catch-up that carries the fresh
    // watermark — leave it (and the token) untouched so the token lands on the following catch-up.
    if (url.searchParams.get("live") === "true") {
      return fetchClient(input, init);
    }
    // One-shot: consume the token and stamp this catch-up URL (set overwrites any existing param).
    nudgeBusters.delete(shapeName);
    url.searchParams.set("cache-buster", token);
    const busted = url.toString();
    if (typeof input === "string" || input instanceof URL) {
      return fetchClient(busted, init);
    }
    // A Request carries method/headers/body that must survive the URL swap — rebuild from it.
    return fetchClient(new Request(busted, input), init);
  };
  // `typeof fetch` (Bun's global) carries a `preconnect` member the wrapper neither has nor needs — the
  // ShapeStream only ever invokes fetchClient as a plain fetch — so the shape-compatible cast is safe.
  return wrapped as typeof fetch;
}
