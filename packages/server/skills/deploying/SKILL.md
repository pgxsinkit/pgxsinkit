---
name: deploying
description: >-
  Load when deploying the @pgxsinkit/server write API and Electric shape proxy onto Bun, Deno, Supabase
  Edge Functions, or Cloudflare Workers. Covers the runtime-portable fetch handler, the three concrete
  steps a non-Bun edge runtime needs (bundle the function so Deno can load the toolkit's bare specifiers
  with node: builtins, strip the function-name path prefix before server.fetch, resolve claims from the
  platform JWT in resolveAuthClaims), splitting write and sync into two functions, setting the worker
  timeout above Electric's ~25s long-poll, and forcing cache-control:no-store on a same-origin shape
  proxy. Load before deploying the server or wiring it into an edge platform.
metadata:
  type: task
  library: "@pgxsinkit/server"
  library_version: "0.2.0"
  source: https://pgxsinkit.github.io/start/deploying-the-server/
---

# Deploying the pgxsinkit server

The server is a web-standard `fetch` handler, so it runs unmodified anywhere that speaks
`Request -> Response`. "Unmodified" is true at the API level; the steps below are about the runtime
around it, not the toolkit. On **Bun**, `export default { fetch: server.fetch }` (or `server.start()`,
the only Bun-specific helper) and you are done. The rest applies to Deno / Edge.

## 1. Bundle the function (Deno will not load the toolkit source directly)

The packages import dependencies with bare, extensionless specifiers (the Node/bundler convention),
which Deno's strict resolver rejects, and your registry package is usually unpublished. Bundle each
function into one self-contained ESM file ahead of time (`bun build` / esbuild, `target: "node"`,
`format: "esm"`). **The easy miss:** with `target: "node"`, Bun leaves builtins external but **bare**
(`import net from "net"`); Deno only resolves them under the `node:` scheme, so add an `onResolve` plugin
that rewrites every builtin to `node:*`. Everything else (drizzle, zod, the toolkit, your registry, plus
any framework you chose) inlines.

## 2. Strip the function-name path prefix before `server.fetch`

Edge Functions route by the first path segment, so a POST to `/functions/v1/write/api/mutations`
arrives as `/write/api/mutations`. Strip only the function-name prefix so the server receives the
canonical `/api/mutations` path:

```ts
Deno.serve((request) => {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/write(?=\/|$)/, "") || "/";
  return server.fetch(new Request(url, request));
});
```

The **read** path needs no rewrite: `proxyElectricShapeRequest` keys off the query string, not the path.

## 3. Resolve claims from the platform JWT in `resolveAuthClaims`

`verify_jwt` is a gateway concept; the portable move is to verify the token yourself and return its
claims (or `null` to fail closed — the proxy then blocks all rows and the write route rejects). A GoTrue
access token is already `JwtClaims`-shaped (`sub`, top-level `role`, `app_metadata`), so return it
directly after verifying. The applier reads `role` to switch the RLS actor; the read proxy reads `sub` +
`app_metadata.roles` for the row filter. Both paths share this one adapter, so authorization cannot
drift.

## Read vs write as two functions (a deployment choice)

- **write** — `createSyncServer({ registry, db, resolveAuthClaims })` **without** `electricUrl` registers
  only the mutation route; wrap with the path rewrite above.
- **sync** — call `proxyElectricShapeRequest(request, claims, { registry, electricUrl })` directly. No
  rewrite. **Set the function's idle/wall-clock timeout above Electric's bounded long-poll (~25s)** so a
  live subscription is not recycled mid-cycle. If it is a **same-origin proxy with no CDN**, force
  `cache-control: no-store` on the response, or a rotated shape handle serves stale and the client loops
  on 409s.

Both import the same registry and share `resolveAuthClaims`, which keeps the two ingress points honest.

## The apply function verifies itself; the `deployment` profile tunes startup (ADR-0030)

The generated `pgxsinkit_apply_mutations` is **self-verifying**. The migration stamps it with a
fingerprint of its own DDL (a `COMMENT ON FUNCTION`); on every call the server passes the fingerprint it
expects for its registry + codegen, and the function compares that to its own stamped comment **before it
touches any table**, raising SQLSTATE `PXS01` (and applying nothing) on a mismatch. There is **no startup
drift check and no `applyFunctionDriftCheck` option** — enforcement is always-on and rides the existing
call (no extra round trip, no read-then-call race). A **stale** function is refused; a **hand-installed /
unfingerprinted** function (no comment) is also refused; an **old-signature** function fails at call
resolution (undefined function). Regenerate + apply the sync-function migration to fix it, and run
`pgxsinkit-generate --check` in CI to catch the drift before deploy.

**Order the utilities migration first.** The generated apply function and the `clockMicrosecondsSql`
column DEFAULTs both **call** `public.pgxsinkit_clock_us()` — the canonical microsecond clock installed by
the **utilities migration** (`renderPgxsinkitUtilitiesMigration()`, or the generate CLI's `--utilities`
mode). It must be the **first folder** in a consumer's migration chain: a chain that omits it or orders it
after the schema/apply-function migrations fails at **migrate** time with an undefined-function error,
before the server ever starts.

The `deployment` profile on `createSyncServer` owns the remaining **startup query** posture (its defaults
preserve long-lived-host behavior, so you only set it for serverless):

```ts
createSyncServer({
  deployment: {
    startupVerification: "in-process" | "deploy-time", // default "in-process": governs ONLY the RLS auth-helper verify
    operationsLog: "probe" | "enabled" | "disabled", // default "probe": ensure-then-warn-disable
  },
});
```

- `startupVerification: "deploy-time"` skips the boot-time RLS auth-helper verify (the migration pipeline
  owns that guarantee).
- `operationsLog: "enabled"` assumes the table exists (no query; an actual absence then fails writes
  loudly); `"disabled"` turns logging off with no query.
- The **serverless posture** is `{ startupVerification: "deploy-time", operationsLog: "enabled" | "disabled" }`
  — a fresh per-request worker sends **zero queries before the mutation transaction itself**, which
  matters where the platform serves one worker per request (each write otherwise replays the whole startup
  gate). Pair it with warming the JWT/JWKS verify at module scope so the first verify does not pay a cold
  key fetch.

## Measure before tuning: `logTimings`

`createSyncServer({ logTimings: true })` (default off) emits ONE compact `[pgxsinkit-timing]` JSON line
per request: the mutation route reports `preTxMs` (parse/validation), `txOpenMs` (the driver's LAZY
connection establishment + BEGIN — invisible to every other timer, and where a serverless worker's
connect cost lands), `authMs` (resolveAuthClaims), `applyMs` (the apply call), `totalMs`, and `status`;
the shape proxy reports `table`/`live`/`offset`, `upstreamMs` (the Electric fetch — for live long-polls,
the hold), and `totalMs`. Pair it with the client's `__pgxsinkitDebug` rail (`operating` skill,
`@pgxsinkit/client`): client-observed minus server `totalMs` is routing + network, and the phase fields
attribute the rest. Read the split BEFORE changing anything — every latency class below was found this way.

## Serverless geometry: compute follows the caller, data does not

On platforms like Supabase Edge Functions, workers execute **near the CALLER** while the database lives
in ONE region — and worker boots are cheap (~80ms), but each per-request worker opens its own DB
connection and the wire protocol is **one round trip per statement**. If the caller is far from the
database, every statement pays the cross-region RTT (measured: 162ms/statement Singapore↔`eu-central-1`
⇒ ~1.9s connect + ~3s per write, with `applyMs` itself only tens of ms). Fix the geometry, not the code:
**pin only the DB-bound functions to the DATABASE's region** (Supabase: send the `x-region: <db-region>`
header — the toolkit client's `writeRequestHeaders` option carries it on the write path; CORS is
unaffected because the preflight responses echo requested headers). The long hop is then paid once,
client→function, instead of per statement — measured: function `totalMs` 3,050 → 191.

The pin is **per-function, and only right for DB-bound ones.** The mutation ingress (`board-write`) is
DB-bound and wins from it. A **read proxy** (`board-sync`) is NOT: its upstream is Electric Cloud's
globally-distributed CDN, so pinning it to the database's region drags every catch-up hop away from a
distant caller — ~2 intercontinental round trips (~1.2s) versus ~300ms unpinned near the caller, while
the function itself is lean (`totalMs − upstreamMs` ≈ 2–3ms). So keep read proxies **unpinned** (follow
the caller) and put the region header in `writeRequestHeaders`, never the shared `requestHeaders`.

A browser also opens **one long-poll connection per synced shape**, so over HTTP/1.1 the ~6-per-origin
cap starves writes — serve the gateway over **HTTP/2**. The JWKS/warming recipe and the connection-budget
detail live in the `operating` skill.

## Common mistakes

- Deploying a registry change or a `@pgxsinkit/server` upgrade without regenerating + applying the sync
  function migration. The apply function verifies itself and **refuses to serve writes** (SQLSTATE
  `PXS01`) on a mismatch — enforcement is always-on, there is no override; run `pgxsinkit-generate --check`
  in CI to catch it before deploy.
- Ordering the utilities migration after the schema/apply-function migration, or omitting it — the apply
  function and column DEFAULTs call `public.pgxsinkit_clock_us()`, so migrate fails with an
  undefined-function error. Generate it first (`--utilities`).
- Shipping toolkit source to Deno without bundling, or leaving builtins un-prefixed (not `node:*`).
- Forgetting to strip the function-name prefix, so `/write/api/mutations` 404s.
- Verifying the JWT only at the gateway instead of in `resolveAuthClaims` (non-portable).
- A sync function timeout below Electric's ~25s long-poll (constant read-path reconnects).
- Omitting `cache-control: no-store` on a same-origin shape proxy.

Full prose: <https://pgxsinkit.github.io/start/deploying-the-server/>.
