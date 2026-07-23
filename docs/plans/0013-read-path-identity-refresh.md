# Plan — ADR-0013: Read-path identity — refresh the token, never freeze it at boot

Implements [ADR-0013](../adr/0013-read-path-identity-refresh.md). Goal: the read path consults
the consumer's `getAuthToken` **per request** (no boot-time freeze), recovers from auth errors
at the **per-shape** `ShapeStreamOptions.onError`, surfaces a persistent auth failure through
the status channel (never `void`/stop), and documents the refresh-deduping provider contract —
so a long-lived offline-first session survives JWT expiry on the read path exactly as it
already does on the write path.

**Independent of the convergence work — buildable at any point** (a low-risk early win). It
unblocks nothing else and nothing else blocks it.

Depends on / coordinates with: [ADR-0003](../adr/0003-secured-sync-ingress.md) (the server-side
one-identity decision; this is its client mirror — read and write share one token lifecycle),
[ADR-0009](../adr/0009-internalize-read-path-sync.md) (`onSyncError`/`degraded`, kept
**distinct** — different UX: "re-login" vs "sync error"). Pins from Electric's types:
`ExternalHeadersRecord` header values may be async functions invoked per request; per-shape
`ShapeStreamOptions.onError` returns `void | RetryOpts` (`void` **stops permanently**);
`MultiShapeStream.subscribe`'s `onError` is notification-only.

Each phase ends `validate`-green; the expiry-then-recover proof runs in the Podman integration
lane against real Electric.

## Phase 1 — Per-request token, no boot-time freeze

- Replace the boot-time `syncAuthToken = await getAuthToken()`
  (`packages/client/src/index.ts:227`) and the static `shapeHeaders` with an **async header
  function** per shape: `Authorization: async () => \`Bearer ${await getAuthToken()}\``, which
  Electric invokes on every request and every retry.
- Reuse the consumer's existing `getAuthToken` as the seam — **no `SyncIdentity` interface**
  (rejected as a shallow wrapper; deleting it and plumbing `getAuthToken` loses nothing). Read
  and write now share one token provider, one lifecycle.
- No behaviour change beyond freshness; unit-assert the header function is invoked per request,
  not captured once.

## Phase 2 — Auth-error recovery at the per-shape `onError`

- Wire the per-shape `ShapeStreamOptions.onError` (currently plumbed through the sync types but
  never wired — `shape-sync.ts`): on **401/403** return retry (`{}`), which re-invokes the
  header function for a fresh token. Electric auto-retries network/5xx/429 already, but **not**
  401/403 — this is the gap being closed.
- It **must never return `void`** for a transient/auth error — that kills the stream
  permanently. The `MultiShapeStream.subscribe` `onError` stays a **pure notification** (it
  cannot return `RetryOpts`) and feeds surfacing (Phase 3). Recording the per-shape-vs-subscribe
  distinction in the plan because the two `onError`s look identical and wiring recovery at the
  wrong one silently does nothing.
- Test: an expiring token → the stream 401s, then succeeds after `getAuthToken` refreshes —
  sync resumes **without a manual restart**.

## Phase 3 — Surface a persistent auth failure (retry forever, never stop)

- A truly dead token (refresh token expired) 401s every retry. Keep returning retry — Electric's
  jittered backoff bounds the cost and settles to low-frequency background retries — so sync
  **auto-resumes the instant re-authentication makes `getAuthToken` valid again**. Permanent
  stop is wrong for offline-first; **no hard attempt cap**.
- Surface the condition through the existing `status`/`onStatusChange` channel with a **distinct
  auth-needed indication** so the app can prompt re-login. Keep it distinct from `onSyncError`
  (commit-retry exhaustion, ADR-0009 decision 5).
- Test: a persistent 401 surfaces the auth-needed status and **never** returns `void`/stops.

## Phase 4 — Provider contract: `getAuthToken` must be refresh-deduping

- `getAuthToken` is now called per request by **both** paths; document the provider contract: it
  returns the cached valid token and refreshes **single-flight**, so an N-shape group does not
  trigger N refreshes. The consumer owns this; the toolkit documents it (getting-started /
  `architecture.md` read-path section).
- Test (or harness note): N concurrent shape requests against a momentarily-expired token
  trigger exactly one refresh.

## Acceptance

- The read path consults `getAuthToken` per request; no value is frozen at boot; no new
  identity interface is introduced.
- An expiring token recovers automatically at the per-shape `onError`; recovery is never wired
  at the subscribe `onError`.
- A persistent auth failure retries forever with backoff, surfaces a distinct auth-needed
  status, and resumes on re-auth — it never silently wedges or permanently stops.
- The refresh-deduping provider contract is documented.
- `validate` green; the expiry-then-recover proof green in the integration lane.

## Build notes (BUILT — all four phases, order P1 → P2 → P3 → P4 + integration proof)

Built in order, each phase its own `validate:full`-green commit on `develop`.

- **P1 — per-request token.** New `packages/client/src/sync-auth.ts` `buildAuthShapeHeaders` returns
  `Authorization` as an async function (`async () => Bearer ${await getAuthToken()}`); an absent
  token resolves to `""` (unauthenticated), never `Bearer undefined`. `createSyncClient` drops the
  boot-time `syncAuthToken = await getAuthToken()` freeze and installs this when `getAuthToken` is
  set. The shape-sync wrapper header types widen from `Record<string,string>` to Electric's
  `ExternalHeadersRecord` (string | async-function values).
- **P2 — recovery at the per-shape onError.** `createShapeAuthErrorHandler` returns retry (`{}`) on a
  401/403 and `undefined` otherwise; `startGroupSync` attaches it to **every** shape's
  `ShapeStreamOptions.onError`. `{}` re-issues the request, re-resolving the async header for a fresh
  token (verified end-to-end — see below). Auth detection reads the `FetchError` **`status`** field
  by duck-typing, not `instanceof FetchError`: the client and experimental packages can resolve to
  different `@electric-sql/client` copies (1.5.16 + 1.5.21 both installed), so an `instanceof` can
  miss a `FetchError` from the other copy; and the root test lane cannot import `@electric-sql/client`
  directly (it is a nested dep of `packages/client`), so duck-typing is also what makes the handler
  unit-testable.
- **P3 — surface auth-needed.** New `SyncRuntimePhase` member `"auth-needed"` (distinct from
  `degraded`). `startGroupSync` threads `onAuthError` into the handler and an `onSyncActivity` hook
  into the engine — the latter fires at the top of the `MultiShapeStream.subscribe` callback (a
  delivered batch = a fetch succeeded). `createSyncClient` flips to `auth-needed` on the first auth
  error and clears it back to the steady-state phase (`ready` if initial sync completed, else
  `syncing`) on the next activity — only when a `getAuthToken` provider exists.
- **P4 — provider contract.** `docs/architecture.md` gains a "Read-path identity" section; a unit
  test pins the refresh-deduping contract with a reference single-flight provider (five concurrent
  header resolutions → one refresh).
- **Integration proof** (`client-contract.integration.test.ts`, Podman + real Electric): full
  `createSyncClient` behind an auth-gating proxy; a dead token surfaces `auth-needed` and keeps
  retrying, then on re-auth the fresh token forwards and sync resumes to `ready` with no restart.

### Electric-internals caveats found during build

- **`MultiShapeStream` forwards per-shape `onError`.** It constructs each child
  `new ShapeStream({ ...shape })`, so the per-shape `onError` (the only `onError` that can request a
  retry) reaches the child stream. The `MultiShapeStream.subscribe` `onError` stays notification-only
  (decision 2 holds).
- **"Retry forever" is bounded at 50 by Electric.** `ShapeStream` has a
  `maxConsecutiveErrorRetries = 50` guard: after 50 **consecutive** `onError`-handled retries that
  never succeed, it tears the stream down regardless of the handler returning `{}`. A single success
  resets the counter, so in practice this is "retry until re-auth, provided re-auth happens within 50
  consecutive failures" — with the default backoff (1s→32s) that is many minutes. Decision 3's "no
  hard attempt cap, retries forever" is therefore the toolkit's intent but is ultimately capped by
  Electric; faithful and almost always sufficient, but recorded here as a real bound.
- **`{}` re-resolves the async header.** Confirmed against real Electric: after re-auth, the proxy saw
  repeated forwards all carrying the freshly-resolved `Bearer <valid>` token (not the stale one), so
  returning `{}` does re-invoke the header function — no need to return `{ headers }`.
- **The integration auth proxy must return the web `Response` natively.** A handler served by
  `Bun.serve` — directly, or via Hono (`Bun.serve({ fetch: app.fetch })`, which the
  membership/asymmetric read proofs use) — relays `proxyElectricShapeRequest`'s streaming body +
  headers faithfully. The node:http `startFetchServer` helper instead buffers via `arrayBuffer()` and
  re-emits headers via `setHeader`, which mangles Electric's streaming shape response (forwards
  returned but delivered no batch; `setHeader` can also choke on the `electric-schema` JSON header).
  A node-`http`/`ServerResponse`-based server (raw node, Express) hits the same wall **unless** it
  carefully streams the body and copies headers rather than buffering. So it is not "Bun.serve
  specifically" — it is "a server that natively returns the web `Response`."
