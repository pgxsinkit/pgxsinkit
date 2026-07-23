# Electric Cloud: live long-polls answered blind to fresh commits — cross-client propagation of 40–89s

Upstream report prepared 2026-07-04 for the Electric team (evidence dossier:
[`0001-stale-handle-retry-storm.md`](./0001-stale-handle-retry-storm.md)). Ready to file as a GitHub
issue / support ticket; project identifiers and raw rails available on request.

## Summary

On Electric Cloud, `live=true` long-poll requests are repeatedly answered **`up-to-date` at the
client's unmoved offset for consecutive full-hold (~41s) cycles while a committed change sits at the
origin** — including a poll _started ~35 seconds after the commit_. The receiving client renders the
change only on the second or third live cycle: measured cross-client propagation **40s (manual
repro) and 88.9s (controlled repro)** for a single-row insert/update. A control on the same
deployment shows origin wake-on-commit works (a parked poll returned 86ms after the writer's own
transaction was applied), so the blind responses are coming from a serving layer between the client
and the shape log — our working hypothesis is CDN request-collapsing or caching whose effective key
ignores the live `cursor`.

For a sync engine this is the difference between "live" and "polling at 41s": collaborative UI
built on Electric Cloud shows other users' changes roughly one long-poll hold late, sometimes two.

**Scope update (2026-07-04, post-investigation).** Two effects were entangled in our end-to-end
numbers. (1) The wire-level blindness documented in Evidence A/B — live polls answered `up-to-date`
while a commit sits at the origin — was measured pre-mitigation and stands as reported. (2) On top of
it, our own client's cross-shape atomic commit waited on _quiet_ shapes' parked polls (nothing changed
on those shapes, so their polls legitimately return only at hold expiry — that part is not a bug on
your side, though it is a direct consequence of the ~41s hold length behind the CDN). We have shipped
client-side mitigations for both halves (cache-busting `live=true` upstream requests in our proxy; an
engine-side forced catch-up to refresh quiet shapes' `global_last_seen_lsn` when a commit is gated).
The asks below are unchanged: with wake-on-commit working through Electric Cloud's CDN, both
mitigations become unnecessary.

## Environment

- Electric Cloud (shape API consumed via a same-origin pass-through proxy on Supabase Edge
  Functions; the proxy forwards `offset`, `handle`, `live`, `cursor`, `cache-buster`,
  `expired_handle` verbatim and adds the shape's `where`/`columns`/`params` server-side).
- `@electric-sql/client` 1.5.23 (unmodified fetch loop; instrumentation wraps `fetchClient` and logs
  URL params + `electric-*` response headers).
- Shapes are per-user row-filtered (parameterized `where`), 5–6 shapes per client, HTTP/2 origin.
- Writes go through a separate function to Postgres (same project); write ack ≈1.2s.

## Evidence A — controlled cross-client repro (2026-07-04, instrumented)

Two isolated browser contexts (writer + receiver), fresh stores. The receiver's issue-shape request
log (client-side instrumentation; `c=` is the request `cursor`, `end=` is the response
`electric-offset`, `ms` is wall time of the fetch):

```
[w  4535ms] start  issue@3288340968_0 live h=109325146-… (no cursor yet)
[w  5770ms] done   status 200  ms=1235   → 1 change, end=3305146672_0, cursor 54696440
[w  5770ms] start  issue@3305146672_0 live h=… c=54696440
[w 15708ms] done   status 200  ms=9938   → 1 change, end=3338672376_0, cursor 54696600
[w 15710ms] start  issue@3338672376_0 live h=… c=54696600
            ← the writer's INSERT commits early in this window (write ack ~w16-20s)
[w 56636ms] done   status 200  ms=40927  → up-to-date, end=3338672376_0 (UNMOVED), cursor 54696640
[w 56638ms] start  issue@3338672376_0 live h=… c=54696640      ← ~35s AFTER the commit
[w 97843ms] done   status 200  ms=41205  → up-to-date, end=3338672376_0 (UNMOVED), cursor 54696680
[w 97845ms] start  issue@3338672376_0 live h=… c=54696680
            → the change finally arrives on this (third) cycle; UI renders at +88.9s
```

Key properties:

- The `cursor` **is present and advances** on every cycle → every request URL is unique. Naive
  same-URL response caching cannot explain the blind responses.
- Both blind responses consumed the **full ~41s hold** (`ms=40927`, `ms=41205`) and returned
  `up-to-date` with an unmoved `electric-offset` — i.e. "nothing new", 35–76 seconds after a
  committed change to a row matching the shape.
- The second blind poll **started long after the commit**. This is not a missed wakeup on an
  in-flight request; a fresh long-poll against an origin that has newer log entries beyond the
  request offset should return immediately with data.

## Evidence B — same-deployment control: origin wake-on-commit works

Same day, same project, single client (writer = receiver): a live issue poll had been parked ~20s
when the write function's transaction committed — the poll returned **86ms later** carrying the
change (client write→applied ≈1.7s end-to-end). So the origin does hold-and-wake correctly; the
blind responses in Evidence A were served by something else.

## Evidence C — manual repro matching Evidence A

Two Chrome incognito profiles (writer admin / receiver member). Writer moved an issue; receiver's
rail shows its parked issue poll returning at the full hold with
`status 200 … resp: 'up-to-date end=<request offset>'` ~38s after the commit, with the change
rendering ~40s after the write. Reproduces at will.

## Related, likely the same root: first-visitor staleness after quiet

Catch-up (non-live) responses observed with
`cache-control: public, max-age=604800, s-maxage=3600, stale-while-revalidate=2629746`. Any first
client after >1h of quiet is served hours-stale catch-up bodies (SWR by design), and — combined
with the live-path blindness above — then waits one or two 41s live cycles for the truth. A month
of `stale-while-revalidate` on catch-up bodies guarantees a stale first paint for the first visitor
after any quiet hour; we'd suggest revisiting that window as well.

Previously reported in our dossier (2026-07-03, same project): an origin-side handle rotation
mid-boot put the client's stale-cache retry ladder through three `cache-buster`-unique `offset=-1`
retries that **each returned the same dead handle**, plus the final no-`expired_handle` retry —
five unique URLs served the same stale response. Same signature: unique URLs, stale answers.

## What we ruled out on our side

- Proxy param handling: `cursor`/`cache-buster`/`expired_handle`/`handle`/`offset`/`live` forwarded
  verbatim (allowlist verified by unit tests); response `electric-*` headers exposed and consumed.
- Browser/proxy caching: the proxy forces `cache-control: no-store` on client-facing responses.
- Client engine: the blind responses are visible at the raw `fetch` boundary (status/headers logged
  before any engine processing).

## Questions / asks

1. Is the live long-poll path on Electric Cloud subject to CDN request collapsing or caching, and
   does its cache key include the `cursor` param for **filtered** shapes (`where`+`params`)? Our
   2026-07-03 probes showed the `cache-buster` busting correctly on an _unfiltered_ shape; the
   blind behavior above is on filtered shapes.
2. Under what conditions can a fresh `live=true` request, with an offset strictly behind the shape
   log head, legitimately return `up-to-date` at that offset after a full hold?
3. Is there a recommended way to opt live long-polls out of collapse/caching for latency-sensitive,
   per-user-filtered shapes? (Our stopgap: the proxy appends a unique `cache-buster` to `live=true`
   upstream requests — restores sub-second cross-client propagation but defeats collapse; we'd
   prefer an upstream fix or a sanctioned knob.)

## Repro sketch (self-contained)

1. Create a filtered shape (any `where` with a param) on an Electric Cloud source; sync it from two
   clients A and B until both are in live long-poll.
2. Commit a row matching the shape from outside (or via client A's write path).
3. Observe client B's live requests at the fetch boundary: expected — the parked poll returns with
   the change within ~1 RTT of commit; observed — one to two full-hold `up-to-date` responses at an
   unmoved offset before the change is delivered (40–89s).
