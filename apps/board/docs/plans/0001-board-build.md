# Plan — apps/board: build the substantial demo

Builds the Linear-style issue board + realtime chat that **replaces `apps/web`** as
the pgxsinkit demo. Realises the four board ADRs —
[0001 edge functions](../adr/0001-edge-function-deployment.md),
[0002 access model](../adr/0002-board-access-model.md),
[0003 conflict policy](../adr/0003-conflict-policy.md),
[0004 consistency group](../adr/0004-team-scope-consistency-group.md) — and the
glossary in [CONTEXT.md](../../CONTEXT.md). The demo is a **pure consumer**: no
toolkit feature is invented here, only exercised, plus two thin Deno edge adapters
the server already supports.

Build order is dependency-first. Each phase ends `validate`-green; the cross-user
fan-out / conflict / offline-converge proofs run in the Podman integration lane
against real Postgres + Electric + the edge functions.

## Docs review gate (runs at the end of every phase)

Per [ADR-0006](../adr/0006-docs-dogfooding-gate.md), the board build is the
toolkit's documentation dogfooding pass. Every phase's acceptance includes: triage
the phase's entries in [`consumer-review.md`](../consumer-review.md) → update the
Starlight content (`apps/docs/src/content/docs/`) and/or source JSDoc so a fresh
consumer could build that phase from docs alone → `bun run --cwd apps/docs build`
and verify the regenerated `llms.txt`/`llms-full.txt`. Fixes land in the toolkit
docs, not the board.

## Toolkit dependencies (must be landed by the refactor session before the gated phase)

The board's showcase features ride on toolkit capabilities currently in flight on
`develop`. Confirm each is landed before starting the phase that needs it:

- **`conflictPolicy` per writable table ([ADR-0015](../../../../docs/adr/0015-stale-write-conflict-policy.md))** — gates Phase 6 (Issue `reject-if-stale`). Per its plan this is built _last_; if it has not landed, Phase 6 builds against `last-write-wins` and the reject-if-stale surfacing is wired when 0015 lands.
- **`consistencyGroup` ([ADR-0009](../../../../docs/adr/0009-internalize-read-path-sync.md) / [0014](../../../../docs/adr/0014-bulk-apply-ordering-safety.md))** — gates Phase 1's group declaration and Phase 7's atomic add-member frame.
- **Convergence driver + derived convergence state ([ADR-0005](../../../../docs/adr/0005-mutation-convergence.md) / [0011](../../../../docs/adr/0011-convergence-model.md))** — gates Phase 8's inline dots + inspector. Already exercised by `apps/web` today, so this is the safest dependency.

## Structural decisions (settle once, in Phase 0–1)

- **Shared registry location.** The board registry is imported by _both_ the Vite
  client (`apps/board`) and the two Deno edge functions. It must be
  runtime-neutral (no Bun/Node-only imports) so Deno can bundle it. Put it in a
  dedicated workspace package (`packages/board-schema`) rather than reusing
  `packages/schema` (which carries the old todo/membership fixture). The client and
  both functions import from there.
- **`supabase/` directory.** Functions live at `supabase/functions/board-write/`
  and `supabase/functions/board-sync/` (Supabase CLI convention). This is a new
  root entry → add `"supabase"` to `allowedRootEntries` in
  `scripts/check-temp-file-placement.ts` when the directory is created.
- **Retire `apps/web`** at the end of Phase 0 (after the PGlite REPL is carried
  over into the board's Sync Inspector), and drop it from `typecheck`'s project
  list and any root scripts.

## Phase 0 — Scaffold `apps/board`, retire `apps/web`

- New Vite + React 19 app: Mantine v9 (provider + theme), TanStack Router (file or
  code routes for `/login`, `/team/$teamId/board`, `/team/$teamId/chat`, `/all`
  (admin), `/chat/global`), `@hello-pangea/dnd`. Pin `@hello-pangea/dnd` to a major
  that declares `react@19` peer support.
- Carry the `@electric-sql/pglite-repl` panel over from `apps/web` (it becomes the
  Sync Inspector's REPL tab in Phase 8).
- Remove `apps/web`; update `typecheck` and root scripts.
- **Acceptance:** the app boots to a placeholder shell with the router and Mantine
  provider mounted; `validate` green.

## Phase 1 — Board schema + registry (`packages/board-schema`)

- Enums: `issue_status` (`backlog,todo,in_progress,done`), `issue_priority`
  (`none,urgent,high,medium,low`).
- Tables (every writable table carries a `Server version` `updated_at_us` managed
  field):
  - `profile` (`id` = user id, `display_name`, `avatar_color`) — **readonly** synced
    to everyone.
  - `team` (`id`, `name`) — **readonly** synced.
  - `team_member` (`id`, `team_id`, `user_id`) — **readwrite, Admin-only** writes.
  - `channel` (`id`, `team_id` nullable, `kind` = `global|team`) — **readonly** synced.
  - `message` (`id`, `channel_id`, `author_id`, `body`, `created_at_us`) —
    **readwrite**, `conflictPolicy: last-write-wins`.
  - `issue` (`id`, `team_id`, `assignee_id` nullable, `title`, `description`,
    `status`, `priority`, `created_by`) — **readwrite**,
    `conflictPolicy: reject-if-stale`.
- `consistencyGroup: "team-scope"` on `team`, `team_member`, `channel`, `issue`
  (ADR-0004). `profile` and `message` stay singletons.
- Read-path `rowFilter.customWhere` per ADR-0002 (membership-subquery + Admin
  branch); reuse the proven `workspaceVisibilityRowFilter` shape. Enum columns in a
  `where` cast to text.
- Generate migrations + the governance/sync-function artifacts via the existing
  generators (`scripts/generate-*-migration.ts`); `infra:up` applies them.
- **Acceptance:** registry validates (every writable table has a Server version +
  a `conflictPolicy`); local-schema SQL generates; migration history regenerated;
  `validate` green. (RLS write policies land in Phase 5 — see Policy notes.)

## Phase 2 — Partial Supabase stack + the two edge functions

- `infra/compose`: a partial Supabase compose — **db (supabase/postgres), gotrue
  (auth), kong (gateway), edge-runtime (functions), studio + postgres-meta, postgrest**,
  plus **electric** (1.7.2, `allow_subqueries,tagged_subqueries`). Drop realtime,
  storage, imgproxy, analytics, vector, pooler (Storage is v2).
- `supabase/functions/board-write/index.ts` — `Deno.serve` over
  `registerMutationRoute` on a Hono app + `drizzle(postgres(connStr))`;
  `resolveAuthClaims` decodes the Kong-verified JWT (`sub`, `app_metadata.roles`).
- `supabase/functions/board-sync/index.ts` — `Deno.serve` over
  `proxyElectricShapeRequest`; wall-clock set above Electric's ~25s long-poll.
- Both functions import the registry from `packages/board-schema`. `verify_jwt = true`.
- **Acceptance:** `bun run infra:up` brings the stack healthy; an authenticated
  `GET /functions/v1/board-sync` returns a membership-filtered shape; a
  `POST /functions/v1/board-write` round-trips one mutation to Postgres.

## Phase 3 — Auth + seed

- Two-phase seed (`scripts/seed-board.ts`): (1) create the fixture users via the
  **GoTrue admin API** (`createUser`, setting `app_metadata.roles` for the admin),
  resolve email→id; (2) `drizzle-seed` the app tables against those ids. Split: a
  **deterministic structural fixture** (users, teams, memberships, channels — keyed
  by email so scenarios stay reproducible) + `drizzle-seed` **bulk filler** (issues
  across statuses/priorities, chat backlog).
- Fixture scale: ~3 Teams, ~8 Members + 1 Admin, a few dozen Issues, a chat backlog
  per channel.
- `/login` screen: one-click "Sign in as Alice / Bob / … / Admin" buttons backed by
  real `signInWithPassword` (seeded known passwords).
- **Acceptance:** one-click login yields a real session; the client boots PGlite and
  completes initial sync filtered to that identity.

## Phase 4 — Board read path (clean surface)

- TanStack Router views render from local PGlite via the generated hooks
  (`createSyncClientHooks` → `useSyncClient` / `useLiveDrizzleRows`).
- Per-team board: Status columns (`@hello-pangea/dnd` layout, not yet draggable),
  Issue cards with assignee avatar (from `profile`), priority chip. Team switcher
  sidebar. Admin `/all` view across teams.
- Channels list; messages rendered read-only.
- **Acceptance:** switching identity (second window) visibly changes the synced row
  set — fan-out and Admin-sees-all are observable read-only. `validate` green.

## Phase 5 — Issue write path + RLS

- Drag a card across Status columns → `client.tables.issue.update` (optimistic);
  reassign via avatar menu (within team); Admin "Move to team…" action.
- Author the RLS write policies (see Policy notes) and land them with the Phase 1
  migration set: membership-gated writes; cross-team move Admin-only;
  `team_member` Admin-only.
- **Acceptance (integration lane):** a Member writes Issues in their Teams; a
  non-member is denied; a Member cannot move an Issue to a Team they're not in; an
  Admin can. The Admin cross-team move makes the row leave one Member's shape and
  enter another's, live.

## Phase 6 — Conflict surfacing (gated on ADR-0015)

- Wire `reject-if-stale` surfacing for Issue: a stale-rejected drag is held back
  with an inline "moved by someone else → now _In Progress_" state showing the
  server's value, never a silent snap-back.
- Stage the money-shot: two windows drag the same card; an offline drag races an
  Admin reassign.
- **Acceptance (integration lane):** concurrent same-Issue writes resolve per
  policy — loser surfaced, server value shown; a single user's own rapid edits
  never self-conflict.

## Phase 7 — Chat write path + admin membership (the second fan-out)

- Message compose: optimistic append into global + team Channels
  (`last-write-wins`); fan-out across windows.
- Admin membership management: add/remove a `team_member`. Adding a Member makes
  that Team's whole board + Channel appear for them live, committing as one frame
  via the team-scope consistency group (ADR-0004).
- **Acceptance (integration lane):** a posted Message fans out to every Channel
  member within an Electric live cycle; adding a Member triggers an atomic
  multi-table appearance with no broken-join flicker.

## Phase 8 — Sync Inspector + Offline toggle (the showcase)

- Inline convergence dots on cards (optimistic / awaiting-echo / converged /
  conflict) from the derived convergence state.
- Collapsible Sync Inspector drawer: mutation journal, convergence counters, the
  team-scope group's frontier LSN, the PGlite REPL tab.
- Offline toggle: pause the convergence driver / Electric subscription; queue
  writes; flip online → flush + converge.
- **Acceptance:** offline drags + posts queue in the journal and converge on
  reconnect; the inspector shows journal → converged transitions; default view
  stays a clean board with the guts one click away.

## Phase 9 — Integration smoke + docs

- A compose-backed integration test (Podman) proving fan-out + conflict +
  offline-converge end-to-end through the real edge functions, torn down after.
- Update the docs site demo page to point at `apps/board`; refresh README quick-start.
- **Acceptance:** the smoke runs in CI's integration lane; docs reflect the new demo.

## Policy notes / risks (the meatiest implementation work)

The generic `buildSupabaseMembershipNativePolicies` covers membership + the
lock/mute writeGate, but two board policies go beyond it — decide at build time
whether to extend the builder or hand-author the policy in `packages/board-schema`:

1. **Cross-team move is Admin-only.** Issue `UPDATE` needs `USING` = member of the
   _old_ team and `WITH CHECK` = `new team_id = old team_id OR is_admin()`. The
   "container unchanged unless Admin" predicate is not in the generic builder.
2. **Global-Channel exception.** Message write is allowed when the Channel is
   `global` (any authenticated user) OR the user is a member of the Channel's Team
   OR Admin — a two-hop (`message → channel → team`) container with a global escape
   hatch, also beyond the single-column container builder.

Both are small, self-contained SQL predicates; the risk is only that they need
authoring rather than reuse. Capture whichever path is chosen as a follow-up ADR
if the builder is extended (a reusable toolkit change) rather than hand-authored
(demo-local).
