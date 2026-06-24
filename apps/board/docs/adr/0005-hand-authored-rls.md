# Board RLS is hand-authored: any-member writes, Admin global bypass, cross-team-move trigger

The board does **not** use the generic `buildSupabaseMembershipNativePolicies`.
That builder gates `UPDATE`/`DELETE` to **owner-or-manager**, but the board is
collaborative: _any_ Member may edit _any_ Issue in a Team they belong to, there
is no owner or per-team manager concept, and a single global **Admin** bypasses
everything. So `packages/board-schema` hand-authors its policies from the exported
primitives (`escapeSqlLiteral`, `pgPolicy`, `sql.raw`) on three composable
predicates:

- **admin** — `app_metadata.roles` contains `'admin'` (a `board_is_admin()` SQL
  helper, reused by policies and the trigger below).
- **member-of-team** — `team_id IN (SELECT team_id FROM team_member WHERE user_id = sub)`.
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
- **team`/`channel`/`profile** — `readonly`; no write policies. Read filtering is
  the proxy `customWhere` (Electric bypasses RLS on reads), mirroring the same
  three predicates so read and write authorization derive from one source.

## Cross-team move is enforced by a trigger, not a policy

"Only an Admin may move an Issue to a different Team" cannot be expressed in a
single RLS `UPDATE` policy: a policy's `WITH CHECK` sees only the **new** row and
`USING` only the **old** one — neither can compare `OLD.team_id` to `NEW.team_id`.
WITH CHECK alone is insufficient (it blocks moving an Issue to a Team you're not
in, but a Member of _two_ Teams could still move between them). So a **`BEFORE
UPDATE` trigger** on `issue` raises when `team_id` changes and `board_is_admin()`
is false. This makes the rule structural rather than dependent on the seed keeping
Members single-Team.

## Considered Options

- **Extend `buildSupabaseMembershipNativePolicies`** with any-member-writes /
  immutable-container / global-admin-bypass options — rejected: the board's needs
  (collaborative writes, a two-hop `channel → team` container with a global escape
  hatch, conditional column immutability) are specific enough that generalising the
  builder would worsen it for its owner/manager consumers. Keep the toolkit builder
  focused; hand-author the demo. (Revisit only if a second consumer needs the same
  shape — then it earns a toolkit ADR.)

## Consequences

- The board ships a small board-local policies module plus one migration carrying
  `board_is_admin()` + the `issue` cross-team trigger — server authority, never
  local, exactly what the Parity boundary anticipates.
- A non-Admin cross-team move (only reachable by bypassing the Admin-only UI
  affordance) surfaces as a failed mutation, not a clean conflict — acceptable as
  defense-in-depth.
