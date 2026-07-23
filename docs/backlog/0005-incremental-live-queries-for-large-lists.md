# 0005 — Opt-in keyed incremental live queries for very large lists

Status: OPEN (investigated 2026-07-13, deliberately not built — no current workload needs it)
Opened: 2026-07-13 · Area: client-react / worker live-query bridge (ADR-0032 S2 §4)
Reopen trigger: a real subscription where profiling shows the per-change full result re-run (or the
WASM→JS copy of unchanged rows in worker mode) materially hurting — i.e. a list of hundreds+ of wide
rows under frequent writes. Not before.

## Context

The live-rows seam runs `live.query` (full re-run per dependent-table change). The worker bridge
already sends only DIFFs to the tab (`computeLiveDiff` / `LiveRowsMaterializer`, with React-friendly
row identity), so the wire is delta-shaped regardless. The bridge protocol supports `pkColumns`
(single key → `live.incrementalQuery` worker-side), but the React hooks never pass it.

Investigated while fixing the board's echo-timed card shuffle (fixed instead with a deterministic
ORDER BY — the correct fix; incremental mode was neither necessary nor sufficient).

## What incremental mode would buy — and cost (from the PGlite live-extension source, 0.5.4)

`live.incrementalQuery` = `live.changes` + JS reconstruction:

- PGlite keeps **two temp state tables holding full copies of the result set** per subscription and
  re-runs a prepared three-way diff (window functions + INSERT/DELETE/UPDATE UNION arms) on every
  dependent-table change; a JS layer then rebuilds the full ordered array per fire by walking an
  `__after__` linked list.
- Only deltas cross the WASM→JS boundary — the sole real saving. The JS-side full array still exists
  every fire, and our worker re-diffs it for the wire anyway. For small/medium lists the two state
  tables + diff SQL cost more than the plain re-run.

Hidden sharp edges (none documented upstream; all confirmed in source):

1. **Key uniqueness is a silent-corruption cliff.** Diff arms join `curr.key = prev.key`; a
   duplicated key value fan-outs the join and corrupts diffs. A hook cannot prove uniqueness for an
   arbitrary Drizzle query (joins/aggregates), so **auto-deriving `pkColumns` is unsafe by
   construction** — this must be an explicit caller opt-in, with the uniqueness contract documented.
   With `fields` aliasing the key must name the ALIASED column (see protocol.ts `pkColumns` note).
2. **Ordering fragility.** `__after__` comes from `LAG(key) OVER ()` — an empty window, so chain
   order rests entirely on the query's own ORDER BY; the JS rebuild walks the chain with
   `if (!row) break`, i.e. a desynced chain **silently truncates the result**. Deterministic ORDER BY
   is a hard prerequisite.
3. **More teardown machinery per subscription** (state tables, prepared statements, triggers) —
   enlarges the surface of the PGlite unsubscribe-vs-close race
   (tmp/agents/upstream-pglite-live-unsubscribe-close-hang.md).
4. Windowed `offset`/`limit` pagination is `live.query`-only; incremental forfeits it.

## Shape of the work, if reopened

An explicit `key` option on the live hooks (`useLiveDrizzleRows(build, deps, { key: "id" })`),
threaded as `pkColumns` — never inferred. Docs must state: unique-in-result required, aliased name
when `fields` is in play, deterministic ORDER BY required. Benchmark against the plain path on the
actual offending list before committing to it; consider `live.query`'s windowed mode as the
alternative for huge lists.
