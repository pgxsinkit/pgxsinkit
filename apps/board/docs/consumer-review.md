# Consumer review log (docs dogfooding)

Running log of every moment building `apps/board` required reading `@pgxsinkit/*`
**source** because the docs/`llms.txt` did not answer the question — i.e. a
documentation gap a real external consumer would also hit. See
[ADR-0006](./adr/0006-docs-dogfooding-gate.md) for the process. Fixes land in the
toolkit docs (Starlight content + source JSDoc); `llms.txt` regenerates from them.

Status: `open` → `resolved` (doc/JSDoc updated) · `n/a-internal` (consumer never
needs it) · `ergonomics` (a real API gap, fixed upstream).

## Phase 1 — board-schema (registry, RLS, conflict policy, consistency groups)

Gate resolved in the toolkit docs; verified by `bun run --cwd apps/docs build` (the
new material appears in the regenerated `llms-full.txt`).

1. **RLS read/write two-subject split** — write-path policies key on `auth.uid()`
   (Postgres-with-JWT) but the read-path `customWhere` must key on the literal
   `claims.sub` because **Electric** runs the `where`, not Postgres. Getting this
   wrong silently breaks security. → **resolved**: new "Two execution contexts
   enforce the same authorization" note in `start/getting-started`.
2. **Local schema emits no FK** → a child grouped with its parent needs no
   `deferrableConstraints` (that setting is a write-path/server concern only). →
   **resolved**: new practical-implications bullet in
   `concepts/local-schema-ddl-parity`.
3. **`conflictPolicy` is a required hard-error** on writable tables. → **resolved**:
   the `start/getting-started` registry example now declares it, plus a "Writable
   tables have two hard requirements" caution. (The example was previously _invalid_
   — it would have thrown.)
4. **The membership RLS builder gates writes to owner-or-manager**; collaborative
   any-member writes are hand-authored from `pgPolicy` + the predicate builders. →
   **resolved**: RLS-helpers + hand-author pointer added to the security note in
   `start/getting-started`.
5. **The server is a runtime-portable `fetch` handler** (Deno / Supabase Edge
   Functions / Workers, not only Bun). → **resolved**: prerequisite softened + an
   inline deploy note on `server.fetch` in `start/getting-started`.
6. **Managed fields + Server version** — every writable table needs a
   `nowMicroseconds`-on-update managed field (the Server version); `authUid` stamps
   are server-assigned and rejected in client payloads. → **resolved**: the
   `start/getting-started` registry example now shows the managed-field block + the
   two-hard-requirements caution.

## Phase 1b — board migrations (drizzle generate + cross-team trigger)

7. **Custom-function-in-RLS ordering trap** — a `CREATE POLICY` (or trigger) that
   references a custom SQL function requires that function to exist _before_ the
   migration runs; with drizzle generating the table+policy migration first, a
   `board_is_admin()` helper would have to be installed out-of-band. → **n/a-internal**
   (not a pgxsinkit doc gap): the toolkit's own RLS builders **inline** the admin/owner
   predicate over `current_setting('request.jwt.claims')` precisely to stay
   self-contained, so a consumer using the builders never hits this. The board followed
   suit and inlined its admin predicate (board ADR-0005). The "hand-author beyond the
   builders" pointer added in Phase 1 finding 4 is the right home if this ever needs a
   sentence.

## Phase 2 — partial Supabase stack + the two edge functions

Phase 2 is the first time the toolkit is consumed from a **non-Bun runtime** (Deno, in
Supabase Edge Functions). That boundary surfaced the densest batch of findings — three
genuine ones plus a toolkit code fix.

8. **`pgxsinkit-generate` could not find a non-default migration `out` dir.** The CLI
   probed only `drizzle` / `infra/drizzle`; the board's drizzle history lives in
   `infra/board-drizzle` (declared via `out` in its drizzle config). A real consumer
   with any non-standard layout hits a hard "could not find drizzle output directory".
   → **ergonomics** (fixed upstream, `packages/server/src/cli/generate.ts`): the CLI now
   derives `out` from the `--config` drizzle config (and accepts an explicit `--out`),
   falling back to the probe. New `resolveDrizzleOutDir` + 3 tests. The board's
   `db:board:sync-fn` script proves it end-to-end.
9. **Deploying the server to Deno/Edge needs a bundle step — the docs implied source
   would "just run".** The "runtime-portable `fetch` handler" claim is true at the API
   level, but Deno will not load the toolkit's **source** directly: it imports its deps
   with bare, extensionless specifiers (a bundler/Node convention Deno's resolver
   rejects), and a demo's own registry package is unpublished (no `npm:` form). The
   working recipe is to **bundle each function self-contained** (`bun build`, target
   `node`, ESM), with one wrinkle: Bun leaves builtins as **bare** (`"net"`) but Deno
   only resolves them under the `node:` scheme — so the bundle plugin must normalize
   builtins to `node:*` and keep them external. → **resolved**: new
   `start/deploying-the-server` guide documents the bundle recipe + the `node:`
   normalization; the "portable handler" note in `getting-started` now links to it
   instead of implying source-deploys.
10. **Edge Functions prepend the function name to the request path; the mutation route
    does not expect it.** A POST to `/functions/v1/board-write` arrives at the worker as
    `/board-write`, but `registerMutationRoute` serves `/mutations` (+ `/api/mutations`),
    deployment-name-agnostic by design. Without a rewrite the route 404s. → **resolved**:
    the new deploy guide shows the one-line "strip the function prefix before
    `server.fetch`" adapter (what any reverse proxy in front of the server already does).
11. **`verify_jwt` is a platform concept; on raw edge-runtime you verify in-function.**
    The portable path is to resolve identity from the GoTrue access token yourself —
    HS256-verify with the shared `JWT_SECRET`, then hand the decoded claims (already
    `JwtClaims`-shaped: `sub` + top-level `role` + `app_metadata.roles`) to the single
    `resolveAuthClaims` adapter both paths share. → **resolved**: the deploy guide shows
    the GoTrue-JWT `resolveAuthClaims` recipe and the read/write split.

> Live shake-out (tracked, requires the container stack up): the exact edge-runtime
> image tags, GoTrue/PostgREST env names, and **postgres.js running under Deno's node
> compat** are verified by bringing the stack up (`bun run infra:up`) — the
> static layer (bundles build to valid ESM, migrations generate, types/lint/format/tests
> green) is all confirmed. Findings from the live run append here.

## Phase 3 — seed + one-click login + client boot

No new pgxsinkit **doc** gaps: the read-path client API (`createSyncClient` +
`createSyncClientHooks`) consumed cleanly straight from `getting-started`. The findings
here were board-internal infra, not toolkit gaps — recorded for completeness:

- Seeding uses `drizzle-seed` at the same unified `1.0.0-rc.2` tag as the rest of the
  drizzle stack (`drizzle-orm`/`drizzle-kit`/`drizzle-seed` move together); structural
  fixtures are deterministic inserts, bulk Issues/Messages are `drizzle-seed`.
- One-click identities are provisioned through the **GoTrue admin API** with
  `app_metadata.roles` carrying `admin` — the same claim the read filters and RLS read.
- A signed-out store must not be torn down in place (a live query still subscribed to the
  PGlite handle deadlocks the WASM thread); sign-out hard-navigates to `/login` instead.

## Phase 4 — read path (board / chat / admin all-teams)

Two genuine **toolkit code** findings, both fixed upstream with a regression test (the
read path is otherwise faithful to the docs):

12. **`useLiveDrizzleRows` returned rows keyed by the underlying snake_case column
    names, not the select's field keys.** The hook runs a Drizzle select's `.toSQL()`
    through PGlite's live query, which yields raw DB-named columns; typed access on the
    builder keys (`row.assigneeId`) then silently read `undefined` (every assignee
    avatar rendered "?"). → **ergonomics** (fixed upstream, `packages/react`): new
    `remapLiveRow` uses the select's `_.selectedFields` metadata to map snake_case rows
    back to the builder keys (Column → `row[column.name]`, aliased SQL by key, nested
    selects recurse). 4 unit tests; the board's `data.ts` is back on typed
    `useLiveDrizzleRows`. (commit 1ccfbb7)
13. **Electric tags shape responses with a long, CDN-oriented `cache-control`** (`max-age`
    - `stale-while-revalidate`) that assumes a CDN keyed on the full URL. Behind a
      same-origin proxy with **no CDN**, the browser HTTP cache serves those responses
      _stale_ once a shape handle rotates server-side (re-seed/re-login/restart) — the
      client then loops on "expired shape handle" 409s before self-healing. → board-side
      mitigation: `board-sync` forces `cache-control: no-store` so the browser never reuses
      a stale shape (Electric's own offset/handle bookkeeping makes resumption cheap). A
      docs note on `deploying-the-server` ("a shape proxy without a CDN should send
      `no-store`") would save the next consumer the same dig. (commit 48b34ea)

## Phase 5 — issue write path (drag status, reassign, admin cross-team move)

The write API consumed cleanly — `client.tables.issue.update({ id }, patch)` with
`autoSync: createBrowserConvergenceTrigger()` is the whole optimistic→converged loop, and
the registry's `reject-if-stale` policy + the cross-team-move trigger enforced exactly as
designed (verified live: member writes in their teams; the Admin-only "Move to team" moved
an Issue out of one member's shape and into another's, live). One real **toolkit code**
finding:

14. **A missing _optional_ `operations_log` table 500'd every write instead of degrading
    to "logging disabled".** Operation logging is opt-out (`operationsLog.enabled`
    defaults to `true`) and `ensureOperationsLogSchema` documents/warns "logging will be
    disabled until the table exists" — returning `false` when the table is absent. But
    `createSyncServer` called it as `…​.then(() => {})`, **discarding that boolean**, so
    `config.enabled` stayed `true`: the success-path `logOperation` then `INSERT`ed into
    the missing table _inside the write transaction_, and the `42P01` rolled the user's
    mutation back (board-write returned 500, every Issue edit silently failed). The board
    legitimately ships **without** the table — so a consumer that never opts into logging
    is exactly the configuration that broke. → **ergonomics** (fixed upstream,
    `packages/server/src/index.ts`): the probe's boolean is now threaded into the effective
    config (`enabled = enabled && tablePresent`); the route awaits the readiness gate
    before any `logOperation`, so a missing optional table degrades to "no logging" and
    writes succeed. New integration regression (`write-api.integration.test.ts`: drop the
    table, assert a default-enabled write still applies and the table stays absent). A docs
    note on the operations-log feature ("either create the table or it auto-disables; it is
    never auto-created") is the matching content gap.

## Phase 6 — conflict surfacing (reject-if-stale, inline)

The conflict primitives consumed cleanly — `issue_sync_state.conflict_state` (ADR-0011)
is a live, per-row signal; the synced base table holds the server value to show against the
kept optimistic overlay; `discardConflict` and a re-applied `issue.update` are the two
resolutions. Verified live by staging a real stale write (block `board-sync`, advance the
row server-side, write against the now-old base): the loser surfaces inline ("the server
now has this in _In progress_"), never snaps back, and **both** resolutions work — "Use
server's" reverts to the synced value, "Keep mine" re-applies and converges. But staging it
exposed a real **toolkit convergence bug**:

15. **A resolved conflict's banner never cleared — the conflicted journal row orphaned.**
    Two sites retire a `conflicted` row once a later write resolves it: `reconcileTable`
    (the post-flush bulk pass) and the `<table>_reconcile_on_sync` **trigger** (real-time,
    fires when the resolver's echo lands). Only `reconcileTable` did the retire; the trigger
    just cleared the acked resolver. So when the resolution's echo beat the post-flush
    `reconcileTable` pass (the common case — local Electric is fast), the trigger deleted the
    acked resolver _before_ `reconcileTable` could see it, and the `conflicted` row orphaned:
    its `conflict_state` surfaced a long-resolved conflict forever (a stuck "edited by
    someone else" banner after a successful "Keep mine"). The two cleanup sites are meant to
    be in parity (they already share the resolution-barrier predicate), but the
    conflicted-retire was missing from the trigger. → **ergonomics** (fixed upstream,
    `packages/client/src/schema.ts`): the reconcile-on-sync trigger now does the
    supersede-retire too, _before_ its acked-clear (same ordering as `reconcileTable`), so a
    resolution clears the conflict deterministically regardless of which path wins. New unit
    regression (`conflict-handling.test.ts`) crafts `conflicted` + acked-resolver journal
    rows and fires only the trigger; it asserts the conflicted row is retired (it fails
    without the fix — the row orphans). Verified end-to-end on the board: "Keep mine" now
    clears the banner with no manual reconcile.

## Phase 7 — chat write path + admin membership (creates, the second fan-out)

Phase 7 is the demo's **first `create`** (every prior write was `issue.update`): a
`message.create` (compose) and `team_member.create`/`.delete` (admin membership). Two
real toolkit bugs fell out — both specific to a `create` on a table with an `authUid`
managed field (`message.author_id`), a near-universal owner/author/created_by pattern no
prior consumer or test had exercised. The membership add/remove + live subquery fan-out and
the LWW message append consumed cleanly once the create path worked.

16. **The optimistic overlay never stamped an `authUid` create-managed field → NOT NULL
    violation on the very first create.** A `message.create` supplies only `{ id, channelId,
body }` — `authorId` is an `authUid` managed field, so it is stripped from the create
    input type and the server stamps it from `auth.uid()`. But the optimistic overlay row
    (which the local thread renders this frame) is INSERTed with every projected column, and
    `author_id` is `NOT NULL`, so the create threw `null value in column "author_id" of
relation "message_overlay" violates not-null constraint`. The convention/governance fill
    only covered `nowMicroseconds` timestamps, not `authUid`. → **ergonomics** (fixed
    upstream, `packages/client/src/mutation.ts`): the optimistic record now stamps `authUid`
    create-managed fields from the decoded JWT `sub` (the same value the server stamps), so
    the row is attributed to the current user immediately and never flips on convergence; the
    flushed payload still omits it (it is built from the original input, not the overlay), so
    the server's managed-field-violation guard is satisfied. Resolved only when a create
    needs it (a table with such a field), so tokenless registries pay no token lookup. New
    unit regression (`overlay-state.test.ts`): a create omitting the `authUid` field stamps
    the overlay from the subject and keeps it out of the journal payload.

17. **The server's create-validation then required the same `authUid` field the client must
    omit → every such create 400'd.** Even with the overlay filled, `board-write` rejected
    the create: `createInsertSchema(table).parse(payload)` validates the FULL insert model,
    which marks `author_id` (NOT NULL, no SQL DEFAULT) required — but the managed-field
    -violation check (run first) rejects a payload that _includes_ a managed field. Omit it →
    400 (validation); include it → 400 (violation): a `create` on any table with a
    managed-on-create field lacking a column default was impossible. (Managed timestamps
    slipped through only because their SQL DEFAULT already makes them optional in the insert
    schema.) → **ergonomics** (fixed upstream, `packages/server/src/mutations/route.ts`):
    `buildCreateValidationSchema` omits managed-on-create fields from the create schema (the
    server stamps them after validation), so a NOT NULL managed column without a default is no
    longer falsely required. New unit regression (`create-payload-validation.test.ts`):
    accepts a payload omitting the `authUid` field, still rejects one omitting a genuinely
    -required non-managed field. Verified end-to-end against the live stack: Alice's
    `message.create` round-trips (200) and lands with `author_id` = her `sub`.

**Verified through the real edge functions + Postgres + Electric** (the browser was wedged,
so the write paths were exercised server-side): a `message.create` round-trips with the
server-stamped author; a non-member posting into a team Channel is RLS-denied (no row); an
admin `team_member.create`/`.delete` round-trips; and the **live subquery fan-out** holds —
a live `board-sync` long-poll on Bob's `issue` shape received the 12 Growth issues the moment
the admin added Bob to Growth (`snapshot-end → up-to-date`), then they left on removal. Note
the membership change is a change to the _source_ of a subquery row-filter, distinct from
Phase 5's cross-team move (a row's own `team_id`); both fan out, but only a **live-following**
shape receives the subquery delta — a fresh `offset=-1` snapshot on the cached handle does
not, which is worth a docs note on how subquery shapes propagate source-table changes.

Content gaps for the docs (no source bug, but a fresh consumer would hit them): (a) a
`create` only supplies non-managed fields — managed fields (`authUid`, `nowMicroseconds`) are
stamped both optimistically (client) and authoritatively (server); the consumer never sends
them; (b) `authUid` is filled in the optimistic overlay from the session `sub`, so an
owner/author column renders attributed before convergence; (c) subquery row-filters propagate
source-table membership changes to **live** subscribers (the board's add-member fan-out),
which is the mechanism behind the team-scope consistency group's atomic appearance.

## Phase 8 — Sync Inspector + Offline toggle + convergence dots

Phase 8 is pure showcase: it surfaces the convergence machinery the earlier phases relied on. Almost
everything consumed cleanly off existing primitives — no new toolkit bug — and the one real finding is
a capability **gap**, not a defect.

- **Convergence dots** read the per-row derived convergence state (`issue_sync_state`, ADR-0011) the
  board already exposes via `useIssueConvergence`; a card shows a dot only when not converged
  (pending → yellow, conflict → orange, quarantined → red). Clean.
- **The Sync Inspector journal** reads `client.readMutationDetails()` — a snapshot, so the drawer polls
  it on a short interval while open to surface the pending → sending → acked → cleared transitions.
  Clean, though a _live_ journal query (a view the consumer could subscribe to like `issue_sync_state`)
  would be a nicer primitive than polling a snapshot — a small content/ergonomics nicety, noted.

18. **No client-side pause/resume for the read path → an Offline toggle can only pause the outbound
    half.** The Offline toggle pauses the **outbound** convergence driver cleanly with no toolkit
    change: a custom `ConvergenceTrigger` whose `shouldConverge()` is gated behind an app `online`
    flag (writes still stage into the journal; reconnect fires one pass to flush). But there is no
    matching seam to pause the **inbound** Electric subscription without `client.stop()`, which closes
    PGlite (teardown, not pause) — and re-subscribing has no client API. So a faithful "fully offline"
    (also stop _receiving_) isn't expressible; the toggle is honestly "your edits queue locally and
    sync on reconnect". → **capability gap** (no app-layer workaround attempted): the toolkit wants a
    first-class read-path pause/resume (e.g. `client.setSyncEnabled(false)` that halts the shape
    long-polls and resumes from the persisted offset) so an offline mode can suspend both directions
    without tearing down the store. A future ADR.

Deferred to a later increment (no toolkit gap, just scope): the PGlite **REPL tab** (the board carries
no `@electric-sql/pglite-repl` dependency yet) and a **team-scope frontier-LSN** readout (no client API
surfaces the consistency group's frontier today).

## Performance pass — idle CPU + write→converge latency

A profiling pass on two things that _felt_ slow. Both turned out to be **outside the sync rail** — the
toolkit's read/write/converge primitives are fast; the costs were a too-eager convergence cadence and the
self-hosted edge-runtime's worker lifecycle. Measure CPU via a `/proc/<pid>/stat` utime+stime **delta**,
not `ps %cpu` (a lifetime average); measure latency at the **network**, not by polling PGlite in a loop
(every PGlite WASM query is ~50ms and serializes on the one worker thread, so a tight poll loop inflates
the very number it reports — this bit us repeatedly).

- **Idle CPU ~70% of a core → ~2% (no toolkit defect, a cadence fix).** The convergence driver polled
  every 1.5s and each pass ran `reconcileTable` for every writable table unconditionally — a transaction
  - clear/retire CTEs even on an empty journal — and those writes fired PGlite's live-query `NOTIFY`
    triggers, re-running every mounted query. Fixes, all upstream: `reconcileTable` idle-skips behind one
    cheap `EXISTS` probe; convergence is **event-driven** (`requestPass()` on enqueue) so the interval
    drops to a 15s fallback. Convergence latency is unchanged (it is bounded by the echo, not the interval).

- **The "convergence dot lingers ~8s" is an edge-function cold start, not the sync rail.** Measured legs,
  server-side and clean: Electric replication→delivery **~75ms**; `board-write` apply **~20ms warm**; the
  overlay/dot clears **~0.7–0.9s** after the ack + echo both land (the `<table>_reconcile_on_sync` trigger
  works — it does **not** wait on the 15s fallback). The latency the learner feels is entirely the
  `board-write` POST: **~20ms warm**, but **~0.45s** when the edge worker has been suspended for ~15s (a
  Postgres reconnect on resume) and **~5.8s** when its module cache is cold (a fresh isolate re-imports the
  whole bundle). Drag a card after the board sits idle → the first write hits a cold worker → ~6–8s.
  This is a property of the **self-hosted edge-runtime deployment target**, not pgxsinkit: the same
  `board-write`/`board-sync` logic on a long-lived Bun service (`apps/write-api`) or on Cloud Supabase's
  managed warm pool has no cold start. Demo fix (infra only, see `infra/compose/board-compose.yml`): a
  `warmer` sidecar pings both functions every 8s (a no-op empty-`mutations` POST — rejected at validation
  _before_ any DB work, the cheapest request that still reaches the worker — keeps writes ~20ms after
  idle), and `EDGE_WORKER_TIMEOUT_MS` raises the vendored main router's 60s per-worker wall-clock budget
  so the board-sync long-poll is not recycled (and the read path forced to reconnect) once a minute.

  Secondary, logged: reloading the board tab after editing a core client module (HMR full-reload while
  PGlite resumes a rotated shape handle) can spin a shape refetch loop to 100% — dev-only friction.
