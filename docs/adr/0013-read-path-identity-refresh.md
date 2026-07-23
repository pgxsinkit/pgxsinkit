# Read-path identity: refresh the token, never freeze it at boot

Status: accepted (2026-06-23)

The two ingress points disagree on identity lifecycle. The write path calls the consumer's
`getAuthToken()` fresh on every flush and retries on 401/403 (`packages/client/src/mutation.ts`). The
read path captures `syncAuthToken = await getAuthToken()` **once** at boot
(`packages/client/src/index.ts:227`) and freezes it into static `shapeHeaders`. So a long-lived
offline-first session — exactly the case the toolkit exists to serve — has its read sync wedge when
the JWT expires, while the write path sails on. `onError` is plumbed through the sync types but never
wired (`shape-sync.ts`), so the failure is also invisible.

[ADR-0003](0003-secured-sync-ingress.md) unified the *server-side* claim resolution ("one verified-
claims adapter, read and write cannot diverge"). This is the client-side mirror of the same
principle: read and write should share **one token lifecycle**.

Three facts from Electric's types pin the mechanism:

- A header value may be an **async function** Electric invokes per request:
  `ExternalHeadersRecord = { [k]: string | (() => string | Promise<string>) }`
  (`@electric-sql/client/dist/index.d.ts:451`).
- Per-shape `ShapeStreamOptions.onError` returns `void | RetryOpts`: `{}` retries, `{ headers }`
  retries with refreshed headers, **`void` stops the stream permanently** (`:457-657`). Electric
  auto-retries network/5xx/429 with jittered backoff but **not** 401/403 (`:609`); `onError`-requested
  retries also use that backoff (`:627`).
- **`MultiShapeStream.subscribe(cb, onError)`'s `onError` is `(error) => void`** — notification only,
  it cannot return `RetryOpts` (`@electric-sql/experimental/dist/index.d.ts:88`).

## Decision

1. **The read path consults `getAuthToken` per request — no boot-time freeze, no new interface.** Each
   shape's `Authorization` header becomes an async function `async () => Bearer ${await getAuthToken()}`
   that Electric calls on every request (and every retry). The consumer's existing `getAuthToken` is
   the seam — a dedicated `SyncIdentity` interface was rejected as a shallow wrapper (deleting it and
   plumbing `getAuthToken` loses nothing). Read and write now share one token provider, one lifecycle.

2. **Auth-error recovery is wired at the per-shape `ShapeStreamOptions.onError`, not the subscribe
   `onError`.** On 401/403 the per-shape handler returns retry (`{}`), which re-invokes the header
   function for a fresh token. It **must never return `void`** for a transient/auth error — that kills
   the stream permanently. The `MultiShapeStream.subscribe` `onError` stays a pure notification
   (feeding surfacing, decision 3). Recording this because the two `onError`s look identical and wiring
   recovery at the wrong one silently does nothing.

3. **A persistent auth failure retries forever with backoff and is surfaced — never stopped.** A truly
   dead token (refresh token expired) would 401 every retry. We keep returning retry (Electric's
   jittered backoff bounds the cost, settling to low-frequency background retries) so sync **auto-
   resumes the instant re-authentication makes `getAuthToken` valid again** — permanent stop is wrong
   for offline-first. The condition is surfaced through the existing `status`/`onStatusChange` channel
   with a distinct auth-needed indication so the app can prompt re-login. No hard attempt cap. This is
   kept distinct from `onSyncError` (commit-retry exhaustion, [ADR-0009](0009-internalize-read-path-sync.md)
   decision 5) — different UX ("re-login" vs "sync error").

4. **`getAuthToken` is now called per request by both paths and must be refresh-deduping.** It should
   return the cached valid token and refresh single-flight, so an N-shape group does not trigger N
   refreshes. The consumer owns this; the toolkit documents it as the provider contract.

## Consequences

- Long-lived sessions survive JWT expiry on the read path; the read/write token lifecycle is unified
  on one provider (the ADR-0003 principle, client side).
- The per-shape-vs-subscribe `onError` gotcha is recorded, so recovery is wired where it works.
- A dead session degrades visibly (re-login prompt) and resumes automatically on re-auth, instead of
  silently wedging or permanently dying.

## Proving it

- A test where `getAuthToken` yields an expiring token: the read stream 401s, then succeeds after the
  provider refreshes — asserting sync resumes without a manual restart.
- A test asserting a persistent 401 surfaces the auth-needed status and never returns `void`/stops.

References: [ADR-0003](0003-secured-sync-ingress.md) (one identity — server side; this is the client
mirror); [ADR-0009](0009-internalize-read-path-sync.md) (`onSyncError`/degraded, kept distinct);
`@electric-sql/client` + `@electric-sql/experimental` types (header function, `onError` RetryOpts,
the void subscribe `onError`); `tmp/agents/sync-system-improvement-worklog.md` (ISS-05).
