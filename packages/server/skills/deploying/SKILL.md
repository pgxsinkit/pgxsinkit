---
name: deploying
description: >-
  Load when deploying the @pgxsinkit/server write API, the read path's control plane, and the stream
  edge onto Bun, Deno, Supabase Edge Functions, or Cloudflare Workers. Covers the runtime-portable
  fetch handler, the three steps a non-Bun edge runtime needs (bundle for Deno with node: builtins,
  strip the function-name path prefix, resolve claims in resolveAuthClaims), the deny-by-default
  apply-function ACL and --grant-execute-to (ADR-0054), and splitting write, control plane, and edge
  into three functions — the edge on its own origin, because the cache key is the URL (ADR-0055).
  Also covers the Event lane (ADR-0053): the /api/events route, the eventGate hook, the pgmq
  prerequisite and pgxsinkit-generate --events queue DDL, and defineEventConsumer as a long-lived Bun
  process never deployed serverless — plus its bounded drainOnce mode for platforms with no
  long-lived compute (scheduled invocation + onEventsEnqueued nudge).
metadata:
  type: task
  library: "@pgxsinkit/server"
  library_version: "0.2.7"
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

Both read functions need the same strip: the control plane routes on `/sync/v1/*` and the edge on
`/v1/stream/*`, so each needs its own function-name prefix removed before the path is recognized.

## 3. Resolve claims from the platform JWT in `resolveAuthClaims`

`verify_jwt` is a gateway concept; the portable move is to verify the token yourself and return its
claims (or `null` to fail closed — the write route rejects, and the control plane answers **401**). A
GoTrue access token is already `JwtClaims`-shaped (`sub`, top-level `role`, `app_metadata`), so return it
directly after verifying. The applier reads `role` to switch the RLS actor; the control plane reads `sub`

- `app_metadata.roles` to build the row filter and to bind the minted stream token to that subject. Both
  paths share this one adapter, so authorization cannot drift.

**Return `null`, never a claims object with no `sub`.** Unauthenticated is not a denial: a subscriber told
"not entitled" truncates its scope and unsubscribes, so an expired JWT has to present as a retryable 401
and not as a per-subscription refusal. The control plane enforces this — it 401s when `resolveAuthClaims`
yields no `sub` — because a stream token with no subject would name a bearer that no revocation reaches.

## Three functions: write, control plane, edge

- **write** — `createSyncServer({ registry, db, resolveAuthClaims })` **without** `readPath` registers
  only the mutation route; wrap with the path rewrite above.
- **control plane** (`sync`) — `createSyncServer({ registry, resolveAuthClaims, readPath: { engine, key } })`
  serves `/sync/v1/subscribe`, `/sync/v1/refresh`, and `/sync/v1/barrier`. It answers per-subject
  questions and mints stream tokens, so it is **never cacheable**: force `cache-control: no-store`. Its
  upstream is the Circuits engine's control API, which must not be client-reachable.
- **edge** (`stream`) — `createStreamGate({ key, durableStreamsUrl })` mounted at `/v1/stream`. It needs
  **no claims resolver and no database**: the stream token IS the authorization, which is what lets this
  half scale and cache independently.

**Put the edge on its own origin.** The cache key is the URL, so the surface a CDN may share between
subscribers has to be addressable apart from the one that answers per-subject questions. Same-origin
mounting forecloses ever putting a CDN in front of the shared tier without also caching the private one.

The control plane and the edge share the stream-token signing key, and nothing else. Both read functions
import the same registry as the write function and share `resolveAuthClaims`, which keeps the ingress
points honest.

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

## The apply function is deny-by-default: name your server's DB role (ADR-0054)

The apply function takes `p_user_claims` and **trusts them** — it copies them into `request.jwt.claims`
and switches `role` before running RLS-governed DML. That is correct for your server (which passes claims
it VERIFIED) and catastrophic for anyone else, who would simply choose their own. So the artifact is
**deny-by-default**: right after `CREATE`, it `REVOKE`s EXECUTE from `PUBLIC` and (guarded on role
existence) from `anon`/`authenticated`/`service_role`, then `GRANT`s only to roles you name:

```bash
bun run pgxsinkit-generate --registry ./sync-registry.ts --export registry \
  --project-dir ./db --config drizzle.config.ts --name sync_artifact \
  --grant-execute-to app_writer          # repeatable, or comma-separated
```

- **Default is owner-only** (`[]`). If your server connects as the function's **owner** (the role that
  applies the migrations) or as a **superuser**, you do not need the flag — most deployments do not.
- **Name only SERVER roles.** A granted role can forge any claims it likes; that is by design (the server
  is the component trusted to verify them), which makes the grant list **the write path's entire trust
  boundary**. Never grant `anon`, `authenticated`, `service_role`, or any other client-facing role.
- **It is part of the artifact fingerprint**, so pass the SAME roles three places or every write fails
  `PXS01`: the generate command, the CI `--check` command, and
  `createSyncServer({ applyFunctionGrantExecuteTo: ["app_writer"] })`.
- **The revokes are re-emitted on every install** — the artifact begins with `DROP FUNCTION`, so a fresh
  creation re-inherits Postgres's PUBLIC default and Supabase's `ALTER DEFAULT PRIVILEGES … TO anon,
authenticated, service_role`. A hand-hardened function would silently un-harden itself; this converges.
- **Grantees the toolkit cannot name are revoked too.** After the named revokes, the artifact enumerates
  the installed function's real grantees (`aclexplode(pg_proc.proacl)`) and revokes `EXECUTE` from every
  one that is neither the owner nor on the grant list. Your OWN `ALTER DEFAULT PRIVILEGES … GRANT ALL ON
FUNCTIONS TO <role>` re-grants at the `CREATE` inside every install exactly like Supabase's does, so
  without the enumeration such a role would survive every regenerate. End state: owner + your list.
- **Everyone regenerates once.** The ACL moved the fingerprint, so upgrading `@pgxsinkit/server` means
  re-running the generate command (and `--utilities`, which hardens `pgxsinkit_clock_us()` the same way,
  keeping its grants to the Supabase trio — a column DEFAULT calling the clock runs as the writing role).

**PostgREST is not required, and omitting it is good deployment guidance.** pgxsinkit needs no PostgREST;
the board stack deliberately omits it, which removes the `/rest/v1/rpc/*` surface that would otherwise
expose every `public` function over HTTP. But do not treat that as the control: the ACL is, and it holds
under every topology (lateral movement from a role membership needs no HTTP surface at all, and Studio's
table editor wants PostgREST back). Ship the grant list right; treat "no PostgREST" as defence in depth.

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

## The Event lane: an auto-mounted route, deploy-time queues, and a runner you host (ADR-0053)

If your registry declares `streams` (see the `registry-authoring` skill, `@pgxsinkit/contracts`), the server
gains a **second lane** beside the sync rail. Three deployment obligations, and one of them is a process.

**1. The route mounts itself.** `createSyncServer` registers `POST /api/events` **only** when the registry
registers at least one Event stream (no streams → the path stays a 404). Nothing is probed or provisioned at
startup, so the zero-startup-query posture is intact and the edge deployment story is unchanged — the same
function-name prefix strip that serves `/api/mutations` serves `/api/events`, because they are siblings under
`/api/`. Two options are yours:

```ts
createSyncServer({
  registry,
  db,
  resolveAuthClaims,
  // Consent/entitlement refusal, keyed by Event-stream name. ABSENT = every well-formed event is allowed.
  // Called after the payload validated and identity resolved, BEFORE anything is enqueued; a refusal is a
  // per-event `refused` verdict (terminal — the client deletes it and surfaces it on its report).
  eventGate: ({ stream, identity }) => (stream === "issue_viewed" ? consentedViewers.has(identity["viewerId"]!) : true),
  // Defaults to the shipped pgmq backend over this server's own `db`, which is what makes an enqueue join
  // the endpoint's transaction. Override only for another backend or a test fake.
  eventQueue: createPgmqEventQueue({ db }),
});
```

The gate is called **per event**, not per stream × batch (a consent decision may legitimately depend on the
payload); the claims are constant across a batch, so memoize on them if the hook consults a store. A gate
that **throws** fails the whole batch retryably (500, nothing enqueued) — a gate that cannot decide is never
read as "allow". Any stream your registry declares whose identity comes from claims makes the endpoint
require verified claims: an unauthenticated request is a batch 401.

**Request-shape limits are toolkit constants, enforced server-side independently of any client tuning**:
1000 events per batch, 64 KiB serialized payload per event, 4 MiB request body. A batch-count/body violation
is a 413 and a framing failure is a 400 — both reachable only from a non-library caller or under skew, since
the library validates at append and builds the envelopes. A single oversized payload is a per-event
`rejected` instead, so one bad row cannot wedge a whole Outbox. When the queue is unavailable the endpoint
returns **503 + `Retry-After` and enqueues NOTHING** — a batch is atomic, and the server never buffers on the
queue's behalf.

**2. pgmq is a prerequisite, and the queues are deploy-time DDL.** One queue per Event stream
(`pgxsinkit_events_<stream>`), so a poison event in one stream cannot head-of-line-block another. Generate
the migration and apply it through your normal flow — never at runtime, because the endpoint may enqueue long
before any runner first starts:

```bash
bun run pgxsinkit-generate --events --registry ./sync-registry.ts --export registry \
  --project-dir ./db --config drizzle.config.ts --name event_lane_artifact
```

It gets its own migration folder (queues are provisioned independently of the apply function) and carries a
fingerprint of the registry's stream set. **Add `--events --check` to CI beside the apply-function
`--check`**: adding or removing a stream without regenerating then fails before deploy, instead of at the
first enqueue onto a queue that does not exist. (A registry with no streams passes `--check` trivially —
nothing to provision is not drift.)

**3. The consumer runner is a LONG-LIVED process — do not deploy it serverless.** `defineEventConsumer`
returns a `start()`/`stop()` handle; your app runs it in its own Bun process, deliberately apart from
`createSyncServer`'s serverless posture. There is no CLI entrypoint, no supervisor and no signal handling
inside it — the app owns its lifecycle:

```ts
const consumer = defineEventConsumer({
  registry,
  queue: createPgmqEventQueue({ db }), // required — the runner is backend-agnostic by construction
  streams: ["issue_viewed"], // optional: the knob that splits streams across processes (unknown name → throws)
  callback: async ({ stream, events }) => {
    await db.transaction(async (tx) => {
      await tx.insert(viewArchive).values(events.map(toRow)).onConflictDoNothing({ target: viewArchive.eventId });
    });
  },
  onDeadLetter: (report) => alert(report), // the runner ALSO warn-logs every one, unconditionally
});
consumer.start();
process.on("SIGTERM", () => void consumer.stop()); // graceful: no new reads, in-flight callbacks awaited
```

- **The callback MUST be idempotent.** Delivery is at-least-once; the blessed pattern is deduping on
  `eventId` against your own durable store (`ON CONFLICT (event_id) DO NOTHING`), which composes to
  effectively-exactly-once. Returning acks the sub-batch; **throwing retries it**.
- **Order is batch-internal only.** Events arrive in append order within one delivered sub-batch; across
  sub-batches there is no promise (a retried one is redelivered after its successors, and `concurrency > 1`
  runs them in parallel). Re-sort from your own archive on `occurredAtUs` if you need temporal order.
- **Pacing is internal** — adaptive interval polling (immediate re-read after a non-empty read; consecutive
  empty reads grow the wait from ~250 ms toward a ~5 s idle ceiling). Floor/ceiling/factor are tuning, not
  contract; there is no LISTEN/NOTIFY, deliberately (Bun's `SQL` has none, and a held listening connection is
  exactly what a transaction pooler will not give you).
- **Leases ARE renewed internally; a thrown sub-batch's is deliberately left to lapse.** One read makes the
  whole batch invisible, so while the runner works through it it extends every unsettled receipt (the one in
  flight plus the ones queued behind it) every `visibilityTimeoutSeconds / 2` — ten slow callbacks can no
  longer let message 10 resurface while message 1 is still running. So the timeout is NOT a batch budget: it
  is the **redelivery delay** of a sub-batch whose callback threw (which stops being renewed at once — that
  lapse IS the retry pacing) and the crash-recovery bound. Size it above ONE callback's worst case. Renewal
  is best-effort: a failed renewal warns and the loop continues, because redelivery is the fallback anyway.
- After `maxAttempts` (default 5) a sub-batch **dead-letters into pgmq's own per-queue archive** — there is
  no library-owned DLQ table. Requeue is a deliberate act (`requeueDeadLetter`), never automatic.
- One runner hosts many streams (independent loops each), so a small deployment runs one process and a large
  one splits `streams` across processes. Construction is query-free: the first statement is the first poll.

**3b. No long-lived compute at all? `drainOnce()` on a schedule.** On a platform whose only server-side unit
is a per-request function (managed Supabase, say), there is nowhere to put `start()` — and the queue would
never drain. The SAME handle answers a bounded pass instead; everything else (delivery path, renewal, retry,
dead-lettering) is identical code, which is possible because pacing was never contract:

```ts
// In the scheduled function. Query-free construction ⇒ building one per invocation costs nothing.
const consumer = defineEventConsumer({ registry, queue: createPgmqEventQueue({ db }), callback });
const { delivered, deadLettered, empty } = await consumer.drainOnce({ budgetMs: 20_000 });
```

- **`budgetMs` goes UNDER the platform's invocation cap, with head-room for one callback** — it is checked
  between sub-batches, never inside one, so a running callback is always awaited and acked first.
- **`empty: false` = "there is more"** (budget cut it short, or a read faulted): invoke again rather than
  waiting out the period. A sub-batch whose callback threw near the edge redelivers next pass — at-least-once.
- **Overlapping invocations are safe** (visibility timeouts arbitrate, as with two runners). Two passes on
  ONE handle are not: `drainOnce` beside a live `start()`, beside another pass, or after `stop()`, throws.
- **Pair it with the ingest nudge for latency, never for delivery:**
  `createSyncServer({ onEventsEnqueued: ({ streams }) => void fetch(drainUrl, …) })` fires after a
  successful enqueue with the request's deduplicated stream names, fire-and-forget (a throw is caught and
  warn-logged). **The schedule is the guarantee**; a lost nudge costs only time. Keep the long-lived runner
  wherever you can run one — it is still the primary mode.

## Measure before tuning: `logTimings`

`createSyncServer({ logTimings: true })` (default off) emits ONE compact `[pgxsinkit-timing]` JSON line
per request: the mutation route reports `preTxMs` (parse/validation), `txOpenMs` (the driver's LAZY
connection establishment + BEGIN — invisible to every other timer, and where a serverless worker's
connect cost lands), `authMs` (resolveAuthClaims), `applyMs` (the apply call), `totalMs`, and `status`;
the event route reports its own ingest phases. The read path emits no timing line — the control plane is
a short per-subscribe call and the edge is a byte proxy, so their cost is visible as routing latency
rather than as phases. Pair it with the client's `__pgxsinkitDebug` rail (`operating` skill,
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
DB-bound and wins from it. The read halves are NOT: the control plane's upstream is the engine and the
edge's is durable-streams, neither of which is the database, and the edge in particular wants to sit near
the CALLER so catch-up bytes take the short hop. So put the region header in `writeRequestHeaders`, never
the shared `requestHeaders`, and leave the read functions following the caller. (The Electric-era numbers
that used to sit here measured a CDN-fronted shape proxy and do not transfer — measure this topology
before tuning it.)

A browser also opens **one live connection per synced stream**, so over HTTP/1.1 the ~6-per-origin
cap starves writes — serve the gateway over **HTTP/2**. The JWKS/warming recipe and the connection-budget
detail live in the `operating` skill.

## Common mistakes

- Adding an app-specific encoder for a Drizzle `{ mode: "bigint" }` mutation field. The client transports
  bigint values as exact decimal strings across JSON and the server's registry-derived validator accepts
  that wire representation; keep the typed application value as `bigint` and never round-trip it through
  JavaScript `number`.
- Deploying a registry change or a `@pgxsinkit/server` upgrade without regenerating + applying the sync
  function migration. The apply function verifies itself and **refuses to serve writes** (SQLSTATE
  `PXS01`) on a mismatch — enforcement is always-on, there is no override; run `pgxsinkit-generate --check`
  in CI to catch it before deploy.
- Passing `--grant-execute-to` to the generate command but not to CI's `--check` and
  `createSyncServer({ applyFunctionGrantExecuteTo })` — the ACL is inside the fingerprinted body, so the
  three lists must agree or every write fails `PXS01`. (The list is order-insensitive: the renderer sorts
  it, so the same roles in any order are one artifact.)
- The same mistake with `--function-schema`: generating into a schema without
  `createSyncServer({ applyFunctionSchema: "<schema>" })`. That option is BOTH halves — the fingerprint
  input and the qualification of the call the server makes — so without it the server calls
  `pgxsinkit_apply_mutations` unqualified and either finds nothing (`42883`) or finds a `search_path`
  namesake and fails `PXS01`. Set the flag and the option to the same schema, or neither.
- Granting EXECUTE on the apply function to `authenticated` (or any client-facing role) to "make writes
  work". That re-creates the forged-claims impersonation the deny-by-default ACL exists to close: name the
  role your SERVER connects as, or connect as the owner and grant nobody.
- Ordering the utilities migration after the schema/apply-function migration, or omitting it — the apply
  function and column DEFAULTs call `public.pgxsinkit_clock_us()`, so migrate fails with an
  undefined-function error. Generate it first (`--utilities`).
- Deploying the event **consumer runner** as a serverless function or a route on the sync server. It is a
  long-lived polling process by design; a per-request worker would poll once and die. If the platform has no
  long-lived compute, use `drainOnce()` on a schedule — never `start()` in a request handler.
- Treating the `onEventsEnqueued` nudge as the delivery mechanism. It is fire-and-forget latency relief; the
  scheduled sweep is what guarantees the queue drains.
- Registering an Event stream without generating + applying the `--events` migration (the endpoint then
  enqueues onto a queue that does not exist), or leaving `--events --check` out of CI.
- A consumer callback that is not idempotent. Delivery is at-least-once; dedupe on `eventId`.
- A `visibilityTimeoutSeconds` below a SINGLE callback's worst-case duration — renewal runs at half of it, so
  a callback slower than that window can still be redelivered while the first invocation is running.
- Shipping toolkit source to Deno without bundling, or leaving builtins un-prefixed (not `node:*`).
- Forgetting to strip the function-name prefix, so `/write/api/mutations` 404s.
- Verifying the JWT only at the gateway instead of in `resolveAuthClaims` (non-portable).
- Mounting the edge on the control plane's origin, so the cacheable and uncacheable surfaces share a
  cache key.
- Omitting `cache-control: no-store` on the control plane.
- Returning a claims object with no `sub` instead of `null`, turning an expired JWT into a scope
  truncation instead of a retryable 401.

Full prose: <https://pgxsinkit.github.io/start/deploying-the-server/>.
