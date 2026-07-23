# Catch-up commit-floor alignment for CDN-cached shape watermarks

Status: accepted (2026-07-03). Decision 4 amended by ADR-0033 (live-tail sibling nudge): the live
tail keeps the min-watermark gate, but a gated batch now actively refreshes lagging siblings'
watermarks instead of waiting out their long-polls.

The client sync engine syncs the N Electric shapes of a consistency group as one atomic unit. Each
shape's change messages are buffered by LSN in the `ShapeInbox`, and the group commits at the MINIMUM
complete-LSN frontier across its shapes — the slowest shape gates the group, so a cross-shape
transaction never renders half-applied. A shape's frontier advances on its `up-to-date` control message,
whose `global_last_seen_lsn` header is the global replication head the shape has caught up to.

Field measurement on the board demo (Electric Cloud) surfaced a load-time stall the min-frontier gate
turns into a visible defect. Electric's **catch-up** (non-live) shape responses are **CDN-cacheable** —
observed policy `max-age=604800, s-maxage=3600, stale-while-revalidate=2629746` — and the `up-to-date`
message, watermark and all, is served **inside the cached body**. So on a fresh client load a quiet
shape's catch-up chain can deliver a **stale** watermark (cached before the latest writes), while a busy
shape's fresh chain delivers real changes at higher LSNs. The group min-floor then sits below those
changes and holds them in the buffer — until the quiet shapes' first **live** long-poll returns a fresh
`up-to-date` (~41s on Electric Cloud; live requests carry a cache-busting cursor and complete on every
global-LSN advance). Users see a stale board for ~41s, then it "rearranges itself".

The min-watermark gate is correct in the **live tail**: live responses are fresh, and Electric completes
every held long-poll on each global-LSN advance, so no shape's frontier lags for a cacheable reason.
Only the **catch-up phase** has cacheable-therefore-lying watermark inputs.

## Decision

1. **One-time commit-floor alignment at catch-up completion.** The `ShapeInbox` gains a per-shape
   **commit floor**, laid down exactly once per registration/reset generation: when EVERY shape in the
   group has reported `up-to-date` at least once, each shape's floor is raised to the **freshest asserted
   global head** — the `max` over the shapes' most-recently **reported** watermarks. The group's commit
   target becomes the minimum over each shape's **effective** frontier, `max(rawFrontier, commitFloor)`,
   so a busy shape's delivered changes commit at catch-up completion instead of waiting for the quiet
   shapes' first live poll.

2. **The commit floor is separate from the dedup frontier — the load-bearing safety property.** The raw
   per-shape `completeLsns` frontier remains the **sole** dedup threshold: `ingestChange` still drops
   only what is at or below the raw frontier. The floor only ever RAISES the commit watermark; it never
   narrows ingestion. So a change **below an aligned floor** that arrives late — precisely the change a
   shape's cached catch-up omitted — is still ingested and buffered, then committed on the next
   `up-to-date` via a buffered-changes commit trigger (`hasBufferedChangesAtOrBelow(target)`), rather
   than being silently dropped as already-seen.

3. **Align to reported watermarks, never to frontiers.** The group max is taken over the shapes'
   reported `up-to-date` watermarks, NOT over their `completeLsns` frontiers. A frontier can sit ahead of
   every reported watermark when a live change batch is in flight and its sibling shapes' halves have not
   yet arrived; aligning floors to such a frontier would commit one shape's half of a cross-shape
   transaction ahead of the other's — a torn write. The freshest asserted global head is a watermark
   every shape has been told is complete, so aligning to it cannot tear a transaction still assembling
   above it.

4. **The live tail keeps full min-watermark gating.** Alignment is one-time and monotonic; once the
   floors are laid the live frontiers climb above them and the floor becomes inert, so the slowest-shape
   min-watermark gate governs the steady state unchanged. A `must-refetch` reset re-arms the alignment
   (the reset shape re-streams a fresh, possibly cached, catch-up) but RETAINS the shape's floor (floors
   are monotonic; the reset shape's buffer is empty until it rebuilds).

The transition where a control message completes the group and aligns the floors emits one diagnostic
line on the debug rail — `catch-up watermark aligned {floor}` — so the "stale board that rearranges
itself" symptom is one grep away.

## Alternatives considered

- **Cache-busting the catch-up requests** (a per-load cursor, as live requests use). This defeats the
  exact property Electric's CDN scaling relies on — catch-up responses are cacheable so a cold fanout of
  clients shares one origin fetch. Rejected: it trades a bounded, self-healing torn window for a
  permanent origin-load and cold-start regression.
- **Holding until live watermarks** (the status quo). Correct and never torn, but a **guaranteed** stale
  window on every fresh load, bounded only by the long-poll hold (~41s measured). The defect this ADR
  fixes.
- **Per-shape independent commit** (drop the group min entirely). Removes the stall but abandons
  cross-shape atomicity in the **live tail** too, where it is both correct and cheap — a far larger
  regression than the narrow catch-up torn window.

## Consequences

- **A narrow, self-healing torn window at catch-up/re-snapshot boundaries.** A multi-table transaction
  straddling two shapes' CDN cache generations can render torn — one shape committed to the aligned
  floor, its sibling's half not yet delivered — for roughly **one shape-request round trip**. It
  self-heals immediately: a live request from the lagging shape's stale offset returns without waiting
  (the data exists past that offset), and its sub-floor changes commit via the buffered-changes trigger.
  This is the deliberate trade — a sub-second torn view at load over a consistent-but-up-to-41s-stale
  one.
- **Steady-state atomicity is unchanged.** The floor is inert once live frontiers pass it; the live tail
  is governed by the same min-watermark gate as before.
- **`resetShape` retains the floor** and re-arms the group alignment, so a must-refetch re-catch-up
  realigns once every shape has completed again — the same cacheable-watermark exposure a fresh load has.
- The alignment is pure `ShapeInbox` state (no DB I/O), so it stays property-testable against the ordered
  per-row apply oracle alongside the rest of the inbox.
