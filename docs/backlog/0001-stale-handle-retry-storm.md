# 0001 — Stale-handle retry storm through the CDN chain

Status: FIX SHIPPED 2026-07-04 (root cause found — engine live-tail gating × Electric Cloud's 41s
holds; sibling nudge shipped as ADR-0033, see the RESOLVED section at the bottom; awaiting owner
verification on the cloud board)
Opened: 2026-07-03 · Area: client-sync (upstream-suspect: `@electric-sql/client` / Electric Cloud)
Reopen trigger: the symptom recurs on the hosted `/demo` (the `[Electric] Received stale cached
response with expired shape handle` console warning, or a fresh load stalling ~5–6s on one shape),
or Electric ships a change to the 1.5.x stale-cache retry ladder worth re-testing against.

## Recurrence 2026-07-04 (reopens this item — and worsens the impact assessment)

Fresh-incognito cold load of the board against the cloud backend (dev tab on :5173, worker mode,
post-ADR-0032). The rail shows the ADR-0031 watermark path healthy — `catch-up watermark aligned`
fired for both consistency groups (w4496/w4702), `boot client ready` w4830, and the one live batch
at w5865 applied immediately — yet **first paint was stale** (the familiar 3/4 vs 4/3
Backlog/In-Progress fixture split) because the CDN served stale catch-up **bodies**: rows missing
outright, which no client-side watermark alignment can conjure. The live tail then took **~48s** to
heal it:

- six live long-polls went quiet by w6.7s; the first returned only at **w45.8s** — a ~39–41s hang,
  the same ~41s Electric Cloud constant from the original dossier, where a normal cycle is ≤25s;
- w51.4–52.2s: a rapid `shape request start/done` ladder burst with **no data batches** — the
  stale-cache ladder signature — then the healing re-render lands at ~w52.8s (tab 52781ms).

Delta to the original impact assessment: this recurrence was NOT "bounded by the ladder (~5.6s)" —
the user-visible stale window was ~48s on an idle board, i.e. the same UX class ADR-0031 was built
to kill, arriving through the stale-BODY + dead-handle door instead of the stale-watermark one. No
recent demo-reset coincided (last nightly ran ~18h prior), so the origin-side handle
eviction/rotation window is evidently wider than the reset-coincidence the dossier assumed.

Ruled out for this recurrence: every pgxsinkit commit between the last clean measurement and the
recurrence (convergence scheduling, bridge attach/ready fixes, CI/docs/seed — none touch
`sync/`/`shape-sync.ts`), and the same-day deps update (no Electric package changed).

## Problem / evidence

During a cold-boot measurement of the board demo (Supabase Cloud + Electric Cloud,
`@electric-sql/client` 1.5.23 behind the `board-sync` proxy, reads unpinned), one shape hit a
stale-handle retry storm that delayed `boot client ready` by ~5.6s. It self-healed; the UI already
had the other shapes' data.

Timeline (2026-07-03, boot starting ~13:24:07 UTC; monotonic rail stamps from the run):

- The `channel` shape's `offset=-1` catch-up was served a CDN-cached response carrying handle
  `54872999-1783068492731458` (minted ~08:48:12 UTC — hours earlier).
- The follow-up `offset=0_0&handle=54872999…` was rejected — the origin had evicted/rotated the
  shape **mid-boot**: the replacement handle `56214760-1783085058024393` decodes to a creation time
  of ~13:24:18 UTC, inside the boot window.
- The client marked the handle expired and ran its stale-cache ladder: three `offset=-1` retries,
  each with a random `cache-buster`, **each returned the same dead handle** (`attempt 1..3/3`
  warnings), then "retries exhausted → self-healing retry without the `expired_handle` param",
  which _also_ returned the dead handle; the client proceeded with the stale data and the next
  cycle succeeded (`0_0` → up-to-date). Rail: `-1` dones at 18.4s/19.8s/21.3s (~1.3–1.4s each — vs
  ~0.5s for a typical `-1` that run), recovery complete 22.3s, ready 22.5s.

Every individually-testable layer checked out clean:

1. **Client**: the retry sets `CACHE_BUSTER_QUERY_PARAM = "cache-buster"` (verified in the 1.5.23
   dist).
2. **Proxy**: `ELECTRIC_CONTROL_QUERY_PARAMS` in `packages/server/src/electric-proxy.ts` forwards
   `cache-buster` and `expired_handle` upstream.
3. **Electric Cloud CDN keying**: direct curls — `-1` → MISS then HIT (age 0); `-1&cache-buster=r…`
   → MISS, twice. The buster demonstrably busts. _Caveat_: the direct probe exercises the
   **unfiltered** `table=channel` shape; the app's shape carries the registry row-filter
   `where`/`columns`, i.e. a different shape whose CDN behavior was not directly observable (the
   proxy replaces cache headers, and the visible `cf-cache-status: DYNAMIC` belongs to the Supabase
   Cloudflare hop).
4. **Browser/Supabase-CF caching excluded**: `board-sync` forces `cache-control: no-store` on
   responses (observed).

Electric Cloud's catch-up cache policy at the time: `public, max-age=604800, s-maxage=3600,
stale-while-revalidate=2629746` (a month of serve-stale).

**The open question**: with unique busted URLs end-to-end, _something_ still served the dead handle
five times. Remaining hypotheses: Electric Cloud CDN cache-key normalization behaving differently
for filtered shapes (where/columns/params in the key); the origin briefly serving a stale `-1`
while re-creating the shape; or request coalescing at Electric Cloud. The ~1.3–1.4s per retry
(longer than a normal `-1`) hints the retries did travel past the nearest cache.

Impact assessment: fresh-load only; requires an origin-side handle eviction to coincide with the
load; bounded by the ladder (~5.6s) and self-healing; after self-heal the client knowingly runs on
stale data for that shape until the cache refreshes. Same CDN-staleness _family_ as ADR-0031 (stale
watermark) and the must-refetch recovery fix (expired-handle 409), but this one lives
**inside** `@electric-sql/client`'s stale-cache ladder — upstream of anything pgxsinkit's engine
sees.

## 2026-07-04 instrumented session (local vite → cloud services; post-recurrence forensics)

What was PROVEN with the new handle-chain rail (fresh-profile cold loads + a live write probe):

- **Write→echo is healthy: ~1.7s.** A parked issue live long-poll woke the moment board-write acked
  (ack w284815 → batch received w284901 → applied w284903). Live wakeups work when the client's
  offset is current — the engine, ADR-0031 alignment, and the write path are all exonerated.
- **The idle live-poll hold on Electric Cloud is ~41.3s** (repeatedly measured, status 200, all
  shapes; self-hosted is ~20s). Harmless in itself, but it is the RE-CHECK cadence — i.e. the heal
  clock — whenever the catch-up was served stale.
- **The staleness gate is cache AGE, which explains "absolutely reproduces" vs. not-today:**
  catch-up responses carry `s-maxage=3600, stale-while-revalidate=2629746`. Within ~1h of the last
  cache-fill a cold load gets fresh bodies (every probe load today — each load itself re-primes the
  POP). After >1h of quiet — the owner's every-morning case — the CDN by design serves the
  hours-old body instantly (SWR) and revalidates in background: **stale first paint is then
  guaranteed**, and the client waits out the live cycle to heal. The 2026-07-04 recurrence and the
  original 2026-07-03 storm both sit in that window.
- **Still open — needs a capture INSIDE the SWR window** (>1h quiet; the compacted rail now records
  handle/offset/status on every line, so the owner's next morning cold load is the capture): why the
  first live long-poll from an SWR-stale offset parks ~41s instead of returning the backlog
  immediately from origin (a behind-offset long-poll should answer at once — the echo probe proves
  origin does this for current offsets). CDN request-collapsing onto a held revalidation is the
  prime suspect.
- Side observation (not chased): committing a write's echo triggered `live:false` refetches of the
  OTHER group shapes (team/team_member/channel, same handles), and the re-render burst around them
  included a transient `rows: 0` frame — worth checking for the same expired-handle recovery flash.

Mitigation candidates (decision pending): a time-bucketed cache-busting param appended upstream by
the read proxy (e.g. floor(now/300s) — bounds first-paint staleness to bucket+live-cycle while
keeping cold-fanout CDN sharing inside the bucket), and/or an upstream report to Electric that a
month of `stale-while-revalidate` on catch-up bodies guarantees a stale first paint for the first
visitor after any quiet hour.

## 2026-07-04 cross-client experiment — the LIVE path itself is blind (this is the core defect)

Owner repro (two Chrome incognito profiles, local vite → cloud): admin moved an issue, ack fast on
admin, **~40s to appear for alice** — and alice's rail shows her parked issue live poll returning at
its full 41.3s hold with `up-to-date end=<request offset>`: a response claiming "nothing new" ~38s
after a committed change. Controlled replication (two isolated Playwright contexts, admin creates
an issue on Growth; alice's full worker rail captured with the cursor-instrumented lines):

- Alice's live polls carry an **advancing cursor** (`c=54696440 → …600 → …640 → …680`) — unique
  URLs every cycle, and the proxy forwards `cursor` (`ELECTRIC_CONTROL_QUERY_PARAMS`). Same-URL CDN
  caching and param-stripping are both RULED OUT on our side.
- The write landed early in alice's in-flight poll window. That poll ran its full **40.9s** and
  returned `up-to-date`, offset unmoved. The NEXT poll — started **~35s AFTER the commit** — parked
  **41.2s** and ALSO returned blind. The change rendered on the third cycle: **propagation 88.9s**.
- Contrast the same-day same-client control: a parked poll woke ~86ms after board-write's ack
  (write→applied 1.7s). So origin CAN wake parked polls; whatever answered alice's two blind polls
  could not see origin commits.

Conclusion: on Electric Cloud, a live long-poll can be answered by a layer that is blind to fresh
commits for consecutive cycles despite distinct cursors — consistent with CDN request-collapsing /
caching whose key ignores `cursor` (or an origin-side stale follower). Cross-client propagation is
then bounded below by ~1×–2× the 41s hold instead of sub-second. This, not the catch-up SWR
staleness alone, is the "utterly unacceptable" UX: it breaks LIVE reactivity between users, not
just first paint.

Remaining attribution step (for the upstream exchange, or a follow-up session): replay the EXACT
filtered-shape live URL (same where/columns/handle/offset/cursor) directly against Electric Cloud
with the source credentials and read `cf-cache-status`/`age` — the 2026-07-03 probe only exercised
the unfiltered shape.

**2026-07-04 disposition (owner-directed):**

- **Upstream report WRITTEN** —
  [`0001-upstream-report-electric-cloud-live-poll-blindness.md`](./0001-upstream-report-electric-cloud-live-poll-blindness.md)
  (ready to file; project identifiers withheld from the repo copy).
- **Local stopgap SHIPPED** — the proxy appends a unique Electric-recognized `cache-buster` to every
  `live=true` upstream request (`ElectricProxyOptions.bustLiveUpstreamCache`, default ON, opt-out).
  Live long-polls in this per-user-filtered geometry gain ~nothing from CDN collapse, while catch-up
  keeps its cold-fanout sharing. Reaches the hosted/cloud demo when the board-sync function is next
  deployed (`board:cloud:functions`). REMOVE (or default OFF) when Electric fixes the live path —
  that removal is this item's close-out condition.

## 2026-07-04 isolation probes (after the stopgap deploy) — current state

The owner reported ~40s cross-client propagation persisting after deploying the busted proxy. A
probe ladder (scripts in `tmp/agents/origin-probe*.ts`, session artifacts) isolated each layer with
the REAL `@electric-sql/client` ShapeStream and SQL inserts into the cloud DB:

| Path                                                                                                   | Result                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Direct to Electric Cloud — unfiltered / simple filter / the REAL registry subquery filter              | wake in 1.2–2.7s                                                                                          |
| Direct — idle live-poll hold                                                                           | ~41s, `cf=MISS` (Electric Cloud's own cycle; normal)                                                      |
| Direct — catch-up requests                                                                             | served from Cloudflare `HIT`/`UPDATING`, observed `age` up to 2100s                                       |
| Through the DEPLOYED busted proxy, authenticated as seeded alice, racing a direct stream on one insert | **1.87s vs 1.87s — identical, healthy**                                                                   |
| Full stack, two headless browser contexts (admin writes, alice receives)                               | **rendered in 1.3s**; rail shows the parked issue poll waking mid-hold with the change, applied instantly |
| PRE-deploy (owner manual + controlled runs, same day)                                                  | blind 40–89s                                                                                              |

So post-deploy the wire and the full stack measure HEALTHY in controlled runs, and the engine's
live-tail group gating did NOT hold the commit in the healthy run. The owner's post-deploy ~40s
reports are so far unreproduced — candidate explanations: the failing tests raced the function
rollout; or the blindness needs CDN entries AGED by real quiet (probing every few minutes keeps
re-priming fresh entries — the same trap as the SWR first-visitor analysis, where staleness only
manifests after >1h of quiet). The client rail now prints `req`/`resp` with offset/handle/cursor/
status per request, so the NEXT failing run's console names the layer directly; a failing-run rail
is the missing artifact.

1. Deterministic repro attempt: dispatch the demo-reset workflow (rotates every shape handle at the
   origin) and immediately cold-load the board — the eviction/boot coincidence is then forced.
2. Instrument the repro at request level: capture per-attempt response bodies + handles in the
   browser, and pull `board-sync`'s `[pgxsinkit-timing]` lines (per-request `upstreamStatus`) for
   the same window from the Supabase dashboard.
3. With bodies + upstream statuses in hand, this either becomes a pgxsinkit proxy fix (if a header
   or param is mangled after all) or — more likely — an upstream report to Electric with this
   dossier attached (per the fix-upstream-first rule).

## 2026-07-04 RESOLVED — the failing rail arrived; root cause was the ENGINE's live-tail gating

The owner instantly reproduced with the instrumented rail (two fresh incognito profiles, admin move
on Growth, alice watching; rail timestamps 10:44:14–10:45:38). The rail decoded:

- Alice's parked **issue** poll woke **mid-hold ~2s after the write** and delivered the change —
  the wire (with the busted proxy) is healthy, exactly as the probe ladder measured.
- The rows then sat **buffered for 41.7s**: the group commits at the MIN effective frontier, and the
  three quiet sibling shapes (`team_member`, `channel`, `team`) only advance their watermarks when
  their parked long-polls return — which on Electric Cloud is the full ~41s hold. The re-render fired
  at the exact moment those three polls returned their `up-to-date`s.
- The old `sync applied change batch to local store` line printed at +2s anyway (it logged after
  `enqueueCommit()` regardless of whether the commit loop could commit), which is what misdirected
  the investigation toward the wire.

Why the controlled runs measured healthy: constant probing kept the quiet shapes' CDN entries young,
so their polls returned in ~1–5s and the group frontier never lagged — survivorship bias, not health.

**Fix shipped (ADR-0033, `docs/adr/0033-live-tail-sibling-nudge.md`):** when a live batch is gated
behind quiet siblings, the engine nudges them — `forceDisconnectAndRefresh()` per lagging up-to-date
sibling (immediate non-live catch-up, one-shot `cache-buster` so a CDN HIT can't echo the stale
watermark), bounded rounds, single-flight, commit still only at the group min frontier. Plus the
truthful rail: "applied" only on real commit; a gated batch logs
`sync change batch held by group frontier` → `live-tail sibling nudge {shape}` lines.

The upstream report (`0001-upstream-report-electric-cloud-live-poll-blindness.md`) still stands for
what remains Electric Cloud's: the ~41s blind hold itself (pre-deploy Evidence A/B) and the SWR
staleness policy. The proxy live-bust stopgap remains needed for the BUSY shape's own delivery; the
nudge covers the quiet siblings. Close-out condition unchanged: drop `bustLiveUpstreamCache` when
Electric fixes live wake-on-commit behind their CDN; the nudge stays (correct against any hold
length, including self-hosted ~20s).

### Open observation (2026-07-04, post-fix verification): first nudge round's requests stall

In the headless cloud verification runs, the FIRST nudge round's busted catch-ups consistently
stalled (>4s, no response) while the SECOND round's byte-identical requests completed in ~1.1–1.3s.
Ruled out: the HTTP/1.1 per-origin cap (the functions origin negotiates HTTP/2). Working suspicion:
the Supabase edge isolate still holds the just-aborted parked long-polls when round 1's catch-ups
arrive, and frees capacity only after noticing the client disconnects. The engine's bounded rounds
absorb this correctly (commit lands on round 2; measured cross-client render 5.3–8.4s vs 41.7s
pre-fix), and the pre-alignment nudge guard removed the boot-time burst that worsened the
contention. Follow-up if it matters later: measure round-1 stalls against a non-edge (long-lived
Bun) proxy to confirm the isolate theory; if confirmed upstream of us, nothing to fix in the engine.
