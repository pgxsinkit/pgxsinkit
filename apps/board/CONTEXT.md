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
