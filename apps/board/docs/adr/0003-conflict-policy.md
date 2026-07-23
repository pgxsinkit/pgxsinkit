# Issue writes are reject-if-stale; Message writes are last-write-wins

pgxsinkit requires a named `Conflict policy` per writable table (ADR-0015, no
silent default). **Issue → `reject-if-stale`**: a losing concurrent edit (two
windows dragging the same card, or an offline drag racing an Admin reassign) is
held back and surfaced inline ("moved by someone else → now _In Progress_", with
the server's value) rather than silently overwritten. This is the demo's headline
conflict story and the only choice consistent with "conflicts surface inline,
never silently." **Message → `last-write-wins`**: chat is append-only, each
Message is a fresh insert with its own PK so inserts never collide, and a rare
self-edit just applies.

## Consequences

- `Server version` is **per-row** (`updated_at_us`), so two concurrent edits to
  _different fields_ of one Issue still conflict — field-merge is reserved in
  ADR-0015. The Sync Inspector frames this as a teaching point ("field-merge is
  future work"), not a bug to hide.
- A single user's own rapid successive edits never self-conflict: per-entity
  flush serialization chains each write onto its predecessor's resolved version,
  so the per-row gate only bites on genuine cross-user / offline races.
- Representing both policies in one demo is incidental but useful — an engineer
  sees the two halves of ADR-0015 side by side.
