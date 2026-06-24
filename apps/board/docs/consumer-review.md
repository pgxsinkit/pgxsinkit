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
> compat** are verified by bringing the stack up (`bun run infra:board:up`) — the
> static layer (bundles build to valid ESM, migrations generate, types/lint/format/tests
> green) is all confirmed. Findings from the live run append here.
