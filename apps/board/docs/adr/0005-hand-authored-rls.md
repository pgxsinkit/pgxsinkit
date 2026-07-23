# Board RLS is hand-authored: any-member writes, Admin global bypass, cross-team-move trigger

The board does **not** use the generic `buildSupabaseMembershipNativePolicies`.
That builder gates `UPDATE`/`DELETE` to **owner-or-manager**, but the board is
collaborative: _any_ Member may edit _any_ Issue in a Team they belong to, there
is no owner or per-team manager concept, and a single global **Admin** bypasses
everything. So `packages/board-schema` hand-authors its policies from the exported
primitives (`escapeSqlLiteral`, `pgPolicy`, `sql.raw`) on three composable
predicates:

- **admin** — `app_metadata.roles` contains `'admin'`, **inlined** as an `EXISTS`
  over `current_setting('request.jwt.claims')` and reused verbatim by the trigger.
  It reads no table, so it has no recursion risk; inlining (rather than a
  `board_is_admin()` function) also keeps it clear of the ordering trap where a
  `CREATE POLICY` references a function that must already exist.
- **member-of-team** — `<col> IN (SELECT board_member_team_ids())`, where the
  helper is a `SECURITY DEFINER` function that reads `team_member` with RLS
  bypassed. It must **not** be inlined as `... IN (SELECT team_id FROM team_member
WHERE user_id = sub)`: that read re-enters `team_member`'s own RLS while the
  policy is being evaluated and Postgres aborts with `42P17 infinite recursion`
  (see below).
- **channel-visibility** — the Channel is `global`, or its Team is one of mine.

Per-table:

- **issue** — `select`/`update`/`delete` USING `member-of-team(team_id) OR admin`;
  `insert`/`update` WITH CHECK `member-of-team(team_id) OR admin`. `created_by` is
  a managed `authUid` field, not a gate.
- **team_member** — `select` USING `member-of-team(team_id) OR admin`; all writes
  `admin` only (the add/remove-member fan-out is an Admin action).
- **message** — `select`/`insert` gated by `channel-visibility OR admin`;
  `update`/`delete` gated to `author_id = sub OR admin` (edit/delete your own;
  Admin moderates).
- **team** / **channel** / **profile** — `readonly`: RLS **enabled** with a
  SELECT-only policy (team → member-of-team; channel → channel-visibility;
  profile → any authenticated identity) and **no** write policy, so writes are
  denied at the DB layer. Read filtering for the sync stream is still the proxy
  `customWhere` (Electric bypasses RLS on reads), mirroring the same predicates so
  read and write authorization derive from one source.

## Cross-team move is enforced by a trigger, not a policy

"Only an Admin may move an Issue to a different Team" cannot be expressed in a
single RLS `UPDATE` policy: a policy's `WITH CHECK` sees only the **new** row and
`USING` only the **old** one — neither can compare `OLD.team_id` to `NEW.team_id`.
WITH CHECK alone is insufficient (it blocks moving an Issue to a Team you're not
in, but a Member of _two_ Teams could still move between them). So a **`BEFORE
UPDATE` trigger** on `issue` raises when `team_id` changes and the caller is not an
Admin (the same inline predicate the policies use). This makes the rule structural
rather than dependent on the seed keeping Members single-Team.

## Membership reads via a `SECURITY DEFINER` helper (recursion)

`board_member_team_ids()` (`SECURITY DEFINER`, `STABLE`, pinned `search_path`)
returns the caller's Team ids by reading `team_member` as its owner — a `BYPASSRLS`
superuser — so the read does **not** re-trigger `team_member`'s RLS. Every
membership predicate (the `team_member` SELECT policy itself, plus the
`issue`/`message`/`team` policies that need "my Teams") routes through it. This was
not a precaution chosen up front: the first time the booted stack evaluated these
policies as `authenticated`, the inlined `SELECT … FROM team_member` recursed and
`42P17` broke the whole write path (the read path never hit it — Electric reads as
a superuser, so RLS is not evaluated there). Because the policies reference the
helper, it must exist first: it ships in its own migration
(`…_board_member_helper`) that the policy migration follows.

## Every table has RLS; PostgREST is not exposed

Grants alone are not a gate here. Supabase's default privileges grant
`authenticated` full DML on every `public` table, so a "SELECT-only grant" does not
exist by default; and the self-hosted stack ships a PostgREST data API. As first
built, an authenticated user could `POST`/`PATCH`/`DELETE` the readonly tables
directly via `/rest/v1`, bypassing `board-write` entirely. The board closes this
two ways: **every** table has RLS, with a write policy only where a write is
intended (so the DB is the gate regardless of grants), and the board's Kong config
**does not route `/rest/v1`** — the board never uses the auto-CRUD API (reads via
Electric/`board-sync`, writes via `board-write`), so dropping it removes the
surface entirely. Both were verified live: a member write to its own Team succeeds,
a cross-Team write and any write to a readonly table are denied by RLS, and
`/rest/v1` returns `no Route matched`.

## Considered Options

- **Extend `buildSupabaseMembershipNativePolicies`** with any-member-writes /
  immutable-container / global-admin-bypass options — rejected: the board's needs
  (collaborative writes, a two-hop `channel → team` container with a global escape
  hatch, conditional column immutability) are specific enough that generalising the
  builder would worsen it for its owner/manager consumers. Keep the toolkit builder
  focused; hand-author the demo. (Revisit only if a second consumer needs the same
  shape — then it earns a toolkit ADR.)

## Consequences

- The board ships a small board-local policies module; the table + RLS migration and
  the `issue` cross-team trigger live in the board's own drizzle history
  (`infra/board-drizzle`) — server authority, never local, exactly what the Parity
  boundary anticipates.
- A non-Admin cross-team move (only reachable by bypassing the Admin-only UI
  affordance) surfaces as a failed mutation, not a clean conflict — acceptable as
  defense-in-depth.
