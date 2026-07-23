# Per-table `applyMode` for locally-derived rows

Status: accepted (2026-07-17).

A synced cache table is server-authoritative, and ADR-0014 made the CDC `insert` path a plain INSERT on
purpose: a genuine primary-key collision must SURFACE (degrade the engine loudly) rather than be silently
absorbed, because in a server-authoritative table a duplicate insert is a real bug. But some apps
maintain locally-DERIVED provisional rows inside a synced table via local triggers — e.g. a `card`
trigger inserts a provisional `userword` row so the derived data is available offline-instant. When the
server independently creates that same row, its CDC insert collides (23505) against the provisional local
row and degrades the engine, even though nothing is actually wrong. The engine already owns the
idempotent applier this needs (`applyUpsertsToTable`, used for ADR-0024 move-ins and snapshot-acceptance
mode); the gap is a sanctioned, per-table way to opt a table's CDC inserts into it.

## Decision

1. **Per-table opt-in `applyMode: "insert" | "upsert"` on the registry entry.** Default `"insert"`
   preserves ADR-0014 exactly — a CDC insert is a plain INSERT and a real PK collision surfaces.
   `"upsert"` declares that this table legitimately receives locally-derived provisional rows, so its
   server CDC inserts are applied idempotently as `INSERT … ON CONFLICT (pk) DO UPDATE` (or a pk-targeted
   `DO NOTHING` for a pk-only table); the authoritative server row overwrites the provisional local row.
   `defineSyncTable` resolves the field (default `"insert"`), mirroring the `primaryKey` resolution, and
   it is carried onto the resolved `ApplyTarget` the appliers read.

2. **All three CDC-insert paths route on `applyMode`.** The steady-state folded-insert branch already
   chose the idempotent applier for snapshot-acceptance mode; its condition becomes
   `snapshotModeAtPeek || applyMode === "upsert"`. The initial bulk-insert fast path (json/copy/insert —
   all plain-INSERT appliers with no conflict clause) routes through a `json_to_recordset` **upsert**
   applier (`applyUpsertsToTableWithJson`) when `applyMode === "upsert"`, because a local trigger can
   already have created rows before the snapshot applies — even on a fresh store, since another table's
   apply in the same catch-up can fire the trigger. The initial path uses the set-based json tier (one
   statement, one bound param per 10k-row batch) rather than the param-bound `applyUpsertsToTable`, whose
   ~31k bound params/statement would eat the ADR-0014 bulk-performance gain on a large snapshot; a
   COPY-eligible upsert table is downgraded to json here because COPY has no ON CONFLICT clause, so json is
   the bulk ceiling for upsert-mode tables. A table whose build-time classification is `insert` is so
   BECAUSE a column is not json-safe — it takes the batched-VALUES `applyUpsertsToTable` instead, never the
   json cast. The per-message `applyMessageToTable` insert case and the
   steady-state fold apply the same ON CONFLICT semantics via `applyUpsertsToTable` (incremental volumes).
   The conflict-target / conflict-set construction is factored into shared helpers (`upsertConflictSpec`
   for the builder paths, `jsonConflictClause` for the json tier), so the paths can never drift.

3. **The exception is declared where it lives.** Opting in is a property of the specific table that
   receives locally-derived rows, authored in that table's registry entry — not a client-wide flag and
   not a change to the engine's default posture.

## Alternatives considered

- **Stop the app writing locally into synced tables.** The app would drop its local trigger and wait for
  the server row to sync. This loses the offline-instant derived data the trigger exists to provide (the
  whole point of deriving `userword` from `card` locally), and pushes latency onto the exact interaction
  the local write optimises. Rejected — it solves the collision by removing a wanted feature.

- **Make ALL CDC inserts upserts repo-wide.** A single switch to idempotent inserts everywhere would end
  the collisions, but it destroys the ADR-0014 collision-surfacing invariant for every table: a genuine
  duplicate insert on a server-authoritative table — a real bug — would be silently absorbed instead of
  degrading the engine loudly. Rejected — it trades a loud, correct failure signal on every table for the
  convenience of a few.

## Consequences

- The strict ADR-0014 invariant remains the **default** for every table; the relaxation is opt-in and
  scoped to the single table that declares it, so the collision-surfacing signal is intact everywhere it
  was not deliberately waived.
- The declared exception lives in the registry entry — a reviewer reading the entry sees the table
  accepts locally-derived provisional rows, next to its primary key and conflict policy.
- Coverage: `tests/unit/registry-apply-mode.test.ts` pins the contracts resolution (default `"insert"`,
  explicit `"upsert"` carried onto the entry); `tests/unit/bulk-apply.test.ts` pins the applier behaviour
  (an `"upsert"` target overwrites a pre-existing provisional row through the per-message path, the bulk
  `applyUpsertsToTable` path, and the initial-load `applyUpsertsToTableWithJson` tier — the last with a
  mixed colliding/new batch and a pk-only `DO NOTHING` case — while the default `"insert"` path rejects
  the same pre-existing-row scenario). Full-engine routing is not stood up in a unit test.
