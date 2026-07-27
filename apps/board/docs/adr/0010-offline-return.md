# Offline return: a runtime-capture service worker over the declared retention

The board's **data plane** has been offline-capable from the start — reads serve from the local
store, writes stage in the journal and converge on reconnect, and the Offline toggle showcases
exactly that. But the **app shell** never was: with no service worker, a cold navigation with the
network down depends on the browser's best-effort HTTP cache, and the un-hashed HTML document
usually misses — so the hosted [/demo](https://pgxsinkit.github.io/demo/) fails to load offline
before pgxsinkit ever runs.

This ADR adds **offline return**: a signed-in User who closes the board and reopens it without
connectivity boots to a usable board. The shell replays from a service-worker cache; the data is
whatever the registry's declared retention kept locally. It is deliberately _return_, not
first-visit offline: the capability's precondition is one full online session, and that is also
what makes the implementation nearly free.

## Decision

- **The offline data breadth is a consequence of the registry, not a new promise.** Every eager
  table serves offline for both roles. The one lazy table, `message` (chat), follows its per-client
  retention (ADR to the lifecycle split: board schema, pgxsinkit ADR-0021 × ADR-0025): the Admin's
  `lazy + persistent` chat, once activated, is durably promoted and serves history offline like any
  eager shape; the Member's `lazy + ephemeral` chat is a `TEMP` cluster that leaves no durable trace
  **by design**, so on an offline return it cannot exist — it gets the connection-needed state, not
  a workaround. No registry change; the offline story demonstrates the declared lifecycles rather
  than flattening them.
- **A hand-rolled, runtime-capture service worker — no precache, no dependency.** `apps/board/public/`
  ships an un-hashed worker at the scope root, registered only from built output (`import.meta.env.PROD`)
  against `import.meta.env.BASE_URL`, so the same file serves `/` in local preview and `/demo/` on
  GitHub Pages. Fetch policy, two branches: **navigations** are network-first with cache fallback
  (fresh deploys win whenever the network is up; the cached document answers offline); **same-origin
  hashed assets** are cache-first with background fill, captured _as the app fetches them anyway_ —
  plus a one-shot **first-session backfill**. Runtime capture has a structural blind spot: the entry
  assets (the document's own script/style graph) are requested during parse, before the worker
  exists, so on the capability's canonical timeline — ONE online session, close, return offline —
  they would never be cached and the return would die loading `index-*.js`. Once the worker is
  ready, the page hands it the same-origin URLs the session has already fetched (its own
  performance entries — still no manifest, still nothing a drive-by visitor didn't download anyway)
  and it caches the ones it missed, while the session is online and mostly straight from the HTTP
  cache. A visitor who booted once has, by definition, already
  pulled every byte an offline boot needs (~17 MB of PGlite engine assets plus the app bundle). The
  SharedWorker engine is a controlled client of the same service worker, so the wasm/data fetches it
  makes are captured identically in worker mode and in the in-process fallback.
- **Silent lifecycle: `skipWaiting` + `clients.claim`, no update prompt.** Navigations being
  network-first means an online visit after a deploy always gets fresh HTML and freshly hashed
  assets regardless of which worker version is installed — there is nothing for an update prompt to
  protect.
- **Cache garbage is accepted and documented.** Content-hashed entries from superseded deploys and
  PGlite bumps are dead weight, never wrong answers. Without a build manifest the worker cannot
  soundly know the current asset set, and every nuke-on-update scheme breaks offline return until
  the next full online boot — the capability itself. Growth cadence is per-deploy, not per-visit;
  browser storage eviction is the backstop.
- **One connection-needed pattern for unreachable data.** Wherever data cannot exist offline —
  Member chat, an Admin chat never yet activated, and sign-in for a signed-out visitor — the surface
  says so explicitly instead of presenting an indefinite skeleton or a dead button. Detection
  combines the existing `settled` convention with the sync runtime status the SyncBadge already
  renders; `navigator.onLine` is not consulted (it lies in both directions). The state recovers to
  ordinary loading the moment connectivity returns.
- **Non-goals.** PWA installability (manifest, icons, add-to-home-screen) is orthogonal to offline
  capability and out of scope. First-visit offline and any offline affordance for a signed-out
  visitor are out of scope by definition of the capability.
- **Proof: a chromium e2e lane in the existing worker harness.** Sign in online, boot fully, write;
  close the page; flip the _same_ browser context offline (same profile = same store, session, and
  caches); open a new page. Assert the navigation is service-worker-served, the board reaches
  interactive, eager tables render local rows, and the role-split chat behaviour holds. Then post a
  write offline, assert it journals, flip online, assert convergence. Firefox (worker mode on a
  different SW stack) and WebKit (in-process fallback) are named extensions, not requirements. A
  separate **cold-return** scenario removes every crutch — one online session with no reload, a wait
  past the SharedWorker's `extendedLifetime` grace so the engine is genuinely dead, then an offline
  reopen that must cold-boot the engine from the worker cache alone. The fast-reopen scenarios can be
  answered by a surviving worker; only the cold one proves the first-session backfill and the dead-
  engine boot path, which is exactly where the capability first failed in manual use.

## Considered Options

- **Eager precache (workbox-style build manifest)** — rejected. Guarantees offline-readiness at
  first visit, which the requirement does not ask for, at the price of ~17 MB+ forced onto every
  visitor of a public demo page — including those who bounce before signing in.
- **`vite-plugin-pwa`** — rejected. Its value is precisely the machinery rejected above (precache
  manifests, install plumbing, workbox update flows). Adopting a dependency and its lifecycle
  abstractions for a ~100-line, fully-inspectable concern inverts the demo's purpose of showing its
  own mechanics.
- **Flipping the Member's chat to `persistent` so "already-loaded lazy tables work" holds verbatim
  for both roles** — rejected. It would gut the ephemeral half of the per-client retention showcase
  (the board's reason for that projection to exist) and change the registry fingerprint, to rescue a
  table the demo deliberately declares session-scoped.
- **An update-available prompt** — rejected; see the lifecycle decision. Prompts defend against
  serving a stale shell, and network-first navigations never do that while online.
- **`navigator.onLine` for offline detection** — rejected. False positives (LAN without internet)
  and false negatives (browser heuristics) both produce the wrong UI state; the sync runtime status
  is the signal the app already trusts.
