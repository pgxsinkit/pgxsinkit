# Team-scope consistency group: {team, team_member, channel, issue}

These four read tables share one `Consistency group` so they commit atomically at
a shared LSN frontier. The motivating case is the membership fan-out: when an
Admin adds a Member to a Team, that Member's client begins syncing the Team row,
their membership row, the Channel, and all the Team's Issues across separate
shapes at different LSNs. Ungrouped, Issues can land before the Team row and the
board briefly renders cards under an "undefined" Team — exactly the transient
broken join the feature exists to prevent. Grouping makes the fan-out land as one
frame.

`profile` (syncs globally and is present up-front) and `message` (append-only; a
momentarily missing author name in chat is acceptable, and grouping would pace it
to the group's slowest shape) stay per-table singletons.

## Consequences

- The group advances only as fast as its slowest shape — accepted, since the four
  tables fan out together anyway.
- The Sync Inspector surfaces the group's frontier LSN, turning an invisible
  guarantee into a visible demonstration of atomic multi-table commit.
