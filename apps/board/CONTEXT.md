# Board demo

`apps/board` — a Linear-style issue board with realtime chat. It exists to drive
the `@pgxsinkit/*` toolkit end-to-end in a real-ish product so an engineer can see
offline-first sync, membership fan-out, optimistic writes, and conflict
convergence working in context. It is an exerciser, not the product.

The vocabulary mirrors Linear wherever Linear has a word; it deviates only where
Linear has none (chat) or where a word collides with the Toolkit context (group).

## Language — people and access

**User**:
An authenticated person, backed by a Supabase Auth `auth.users` row. The unit a
JWT `sub` names.
_Avoid_: account, person.

**Member**:
A User in the context of a Team they belong to. Membership is the `team_member`
join row.
_Avoid_: participant, collaborator.

**Admin**:
A User holding the workspace-wide Admin role (a JWT `app_metadata.roles` claim).
An Admin sees every Team's Issues and Channels and may reassign Issues across
Members and Teams. There is no per-Team manager role — elevation is global, as in
Linear.
_Avoid_: manager, moderator, superuser, owner.

## Language — work

**Team**:
A named container that owns a set of Issues and exactly one team Channel, and has
a set of Members. The demo's unit of isolation: a Member sees the Issues and
Channel of their Teams and no others. This is the user's "group", renamed because
the Toolkit reserves that word.
_Avoid_: group, workspace, project, squad, org.

**Issue**:
A unit of work that belongs to one Team, is assigned to at most one Member, and
sits in exactly one Status. The thing that moves across the board. UI chrome may
say "ticket"; the model says Issue.
_Avoid_: ticket (in code/schema), task, card, work item.

**Status**:
The workflow state of an Issue and the kanban column it occupies. The primary
drag axis. Values: `backlog`, `todo`, `in_progress`, `done`.
_Avoid_: column, stage, state (bare).

**Assignee**:
The single Member an Issue is currently assigned to; nullable (an Issue can be
unassigned). Reassignment _within_ a Team is free to any Member; moving an Issue
_across_ Teams is Admin-only — the second, role-gated axis of movement.
_Avoid_: owner (collides with the Toolkit's managed `owner_id` convention).

**Priority**:
An Issue's importance on Linear's scale (`none`, `urgent`, `high`, `medium`,
`low`). A second editable Issue field, present so the per-row-version conflict
story (editing Priority races a Status drag) is concrete.
_Avoid_: severity, importance.

**Issue view**:
A Member opening an Issue's details (the card's actions menu on a pointer device, the bottom sheet on
touch — the board has no separate detail route). A fire-and-forget fact, not a write: it is appended
to the toolkit's event lane (ADR-0053) and lands in the board's `board_issue_view_event` archive,
keyed on the event id so an at-least-once redelivery archives it once. Nothing about it syncs back
down, nothing on the board reads it — it exists so the lane has an exerciser a human can watch
end-to-end, and so "who looked at what, when" is a query the demo can answer.
_Avoid_: "read receipt" (implies the Issue's author is told), "impression"/"pageview" (analytics
vocabulary the board does not otherwise use), "audit" (the Toolkit's `operations_log` owns that word).

## Language — chat

**Channel**:
A realtime chat surface. Exactly one global Channel (every User) plus one Channel
per Team (its Members, and every Admin). The second fan-out scenario, parallel to
Issue visibility. Linear has no chat; the term is borrowed from Slack.
_Avoid_: chatroom, room, thread.

**Message**:
A single post in a Channel, ordered by creation time. Authored optimistically and
converged like any other write.
_Avoid_: chat, comment (a comment would belong to an Issue, not a Channel).

**Obsolete stores**:
The board-registry list of exact store paths a storage-preference "Apply & reload"
dropped (ADR-0050): a store's declaration is immutable, so Apply obsoletes the
current bindings and the next boot mints fresh stores. Each boot retries a
best-effort background destruction of every listed path; a path a live worker
still holds stays listed — the list is the retry state. Board vocabulary only:
the toolkit sees a bare path handed to `destroyStoreArtifacts`, never a list.
_Avoid_: "orphans" (orphan GC is the separate idb sweep for unbound store ids);
"retired workers" (nothing talks to the old worker at all — that machinery is
gone).

**Offline return**:
A signed-in User closing the board and reopening it without connectivity, and
landing on a usable board (ADR-0010): the app shell replays from the
service-worker cache, and the data is whatever each table's declared retention
kept locally — every eager table, plus the Admin's chat once activated; never the
Member's chat, whose ephemeral lifecycle leaves no durable trace by design. The
precondition is one full online session in that browser profile.
_Avoid_: "offline mode" (ambiguous with the Offline toggle, which pauses the
outbound half of a running session); "PWA" / "installable" (installability is an
ADR-0010 non-goal).
