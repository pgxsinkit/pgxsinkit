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
