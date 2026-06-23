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
