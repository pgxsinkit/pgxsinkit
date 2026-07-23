# Boot observability: a structured, versioned BootReport for every client boot

Status: accepted (2026-07-08)

Boot performance is a product capability, not a nicety — a far-from-database learner waits on it every
cold session, and the ADR-0031/0032 lane exists precisely because it was slow. Yet the last three boot
bottlenecks were each **mis-attributed before anyone measured them**. Electric shape mints were suspected
of gating first paint; measurement cleared them (they were innocent — the catch-up watermark alignment of
ADR-0031 was the real fix). Auth verification was assumed incompressible; it turned out to be a per-request
GoTrue round trip that the ADR-0032 token cache removed. And an opaque ~4.5s window still sits *after* the
worker attach that no rail line explains today, because the front half of boot happens before any
debug-enabled tab exists to see it. Optimisation that runs on guesses regresses as often as it helps. The
engine must therefore **produce numbers**, for us (the boot lane) and for consumers (dashboards, CI budget
gates), and it must produce them on every boot whether or not the debug rail is switched on.

The boot phases are already *timed* — `timeAsync` wraps `boot pglite.create`, `boot local schema`, `boot
journal recovery`, `boot store-version reconcile`, `boot sync start`, and `boot client ready` closes the
rail. But those numbers only exist when `__pgxsinkitDebug` is on, they are console lines rather than a
value, and the per-shape catch-up cost (where the opaque window lives) is not decomposed at all.

## Decision

1. **Every boot produces a structured, versioned `BootReport`.** A plain, allocation-light object
   (`reportVersion: 1`), built as the boot runs and finalized exactly once at `onInitialSync` — the same
   moment the `boot client ready` rail line fires and `ready` resolves. It carries the boot `mode`
   (`in-process` / `worker`), the `freshStore` / `overlapPrefetch` flags, the registry fingerprint, one
   epoch `startedAt` anchor with monotonic offsets/durations for everything else, the decomposed local
   `phases` (pglite create, schema exec, journal recovery, store-version reconcile, sync start, catch-up),
   an optional `provision` block (the spare's initdb cost + how long it sat ready), and a per-group
   `groups` array (rows, requests, fetch wall, apply wall, start/ready offsets) covering the eager +
   promoted boot groups only.

2. **It is surfaced by pull, plus an optional push.** `client.bootReport(): Promise<BootReport | null>`
   returns the engine's most recent *completed* boot report — `null` until the first boot finalizes, and a
   `stop()`/`destroy()` before initial sync leaves it `null`. Pull is the primitive because a late-attaching
   tab must be able to read a boot that predates it: over the worker bridge the RPC returns the engine's
   stored report regardless of when the tab attached. The optional `onBootReport?: (report) => void` client
   option fires once at finalize for push consumers (dashboards, CI gates); in worker mode the worker
   broadcasts a one-shot `boot-report` bridge event to the currently-attached ports, and later tabs read the
   same report through the pull method (there is no replay event — the method covers late tabs).

3. **The debug rail buffers pre-attach lines and replays them on first attach.** The SharedWorker boots the
   engine on the first attach, but the front half of boot (provision, schema exec) can emit rail lines
   before any debug-enabled tab is listening — so they vanished. `defineSyncWorker` now installs the rail
   sink at construction into a bounded ring buffer (last 500 lines, worker-clock stamped) and replays that
   buffer, `[replay]`-marked, to the first attaching tab. The back half already streams live over the
   bridge; together the whole boot is now visible.

Companion mechanics: the phase durations are *captured* into the report builder as they are timed (the log
line text is unchanged — tools/tests match it); `mode` and the provision stamp are threaded through internal
options, not new public knobs; the per-group `fetchMs`/`applyMs`/`rows`/`requests` are stamped inside the
engine's group stream chain (fetch wall + request count from the delivery seam, apply wall + row count from
the commit transaction) and frozen at the group's ready edge so later live traffic never mutates a
finalized report. The per-group segments are concurrent wall times (groups run in parallel), documented as
such on the type.

## Alternatives considered

- **Embed the report in `status`.** `SyncRuntimeStatus` is diffed and re-emitted on every live status
  change; hanging a fat, immutable boot artifact off it taxes every steady-state diff forever to carry a
  value that never changes after boot. Rejected — boot data does not belong on the live status channel.
- **Resolve the report from `client.ready`.** Attractive (one await, already the boot gate) but the
  semantics fork in worker mode: a late-attaching tab's `ready` resolves on *attach*, not on the boot it
  never witnessed (ADR-0032 FIX 3). A pull method that returns the engine's stored report keeps one meaning
  for every tab. Rejected.
- **Only fix the rail (no structured report).** Recovers visibility for a human reading a console, but
  leaves consumers and CI without a value to assert or chart, and keeps every measurement a manual grep.
  The rail fix is necessary but not sufficient — hence both halves of this ADR.

## Consequences

- Boot is measurable on real numbers, unconditionally (the report is built whether or not the debug rail is
  on), so the next boot-lane optimisation starts from evidence rather than a suspicion.
- `bootReport()` and `onBootReport` are new public surface on both client modes; the report is a plain
  structured-clone-safe object, so it crosses the worker bridge unchanged.
- The report is `reportVersion: 1` — a versioned contract. Additive fields keep the version; a breaking
  reshape bumps it, so a consumer can branch on the number.
- A new one-shot `boot-report` bridge event and a `bootReport` RPC op join the ADR-0032 protocol, plus the
  ring buffer for rail replay — all one-shot or bounded, adding no steady-state cost.
