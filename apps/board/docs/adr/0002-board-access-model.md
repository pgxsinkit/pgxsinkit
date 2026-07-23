# Board access model — membership-gated writes, Admin-only cross-team

A Member reads and writes Issues and Messages only within Teams they belong to
(membership-subquery row-filter on the read path; membership RLS on the write
path). Within a Team, any Member may freely change an Issue's Status and reassign
it to any teammate. The sole elevation is the global **Admin** role: an Admin
alone reads across all Teams and may move an Issue to a _different_ Team /
reassign across Team boundaries. In-Team reassignment is deliberately **not**
Admin-gated.

This exercises both RLS axes — membership and role — with one vivid, visible gate
(the cross-team move) rather than many.

## Considered Options

- **All reassignment Admin-only** (closer to a literal "Admins move the tickets"
  reading): a sharper role gate, but un-Linear (Linear lets any team member
  reassign) and it makes a Member's board feel read-mostly. Rejected — the
  membership gate plus the cross-team move already prove role-based write-gating.

## Consequences

- There is no per-Team manager role; elevation is global, as in Linear.
- The Admin cross-team move doubles as the most striking read-path demo: changing
  an Issue's `team_id` makes the row leave one Member's Electric shape and enter
  another's (fan-out remove/add) live.
