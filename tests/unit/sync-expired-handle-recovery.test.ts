/**
 * REGRESSION REPRO — expired-handle (must-refetch) recovery over a persisted local store loses rows.
 *
 * Field failure (Electric Cloud + board demo, persisted IndexedDB store; tmp/agents/board-409-debug.log):
 * a client resumed with persisted subscription metadata AFTER Electric had rotated/expired the shape
 * handles. Every shape's resume request 409'd (`expired_handle`), the client refetched from offset -1,
 * and — because the multiple shapes were recovering SIMULTANEOUSLY — the experimental `MultiShapeStream`
 * fired `forceDisconnectAndRefresh()` on lagging shapes (the doubled `offset=0_0` catch-up requests seen
 * ~5ms apart in the log). The net effect for an affected shape was that a **bare `up-to-date`** (carrying
 * the server's real, large `global_last_seen_lsn`) reached the engine callback BEFORE that shape's
 * re-snapshot rows did. All shapes reached up-to-date, the engine reported synced — and the local store
 * was left EMPTY for the affected shape ("No teams synced" while the server tables are fully populated).
 *
 * This test drives the REAL engine (real ShapeInbox, real commit queue, real PGlite) through the
 * `MultiShapeStream` mock in the exact pathological message ORDER those two racing fetch loops produce,
 * and asserts the store converges to the full snapshot on every shape. `team` is hit by the reorder;
 * `profile` is a healthy control that recovers normally (matching the field: one table empty, the other
 * populated). Runs in its own `bun test` invocation (ISOLATED set) because `mock.module` is process-global.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { PGlite } from "@electric-sql/pglite";
import { integer, text } from "drizzle-orm/pg-core";

import { defineSyncRegistry, defineSyncTable } from "@pgxsinkit/contracts";

import type { MultiShapeMessages, Row, ShapeStreamOptions } from "../../packages/client/src/sync/types";
import { createTablesFromSchema, drizzleOver } from "../support/drizzle";
import { createFreshTestPGlite } from "../support/pglite";

const registry = defineSyncRegistry({
  team: defineSyncTable({
    tableName: "team",
    makeColumns: () => ({ id: integer("id").primaryKey(), name: text("name") }),
  }),
  profile: defineSyncTable({
    tableName: "profile",
    makeColumns: () => ({ id: integer("id").primaryKey(), handle: text("handle") }),
  }),
});

type MultiShapeMessage = MultiShapeMessages<Record<string, Row<unknown>>>;
type SubscribeCallback = (messages: MultiShapeMessage[]) => Promise<void>;

// Reassigned on every `subscribe` — so it points at the CURRENT sync's callback (phase 1, then the
// resumed phase 2). The mock shapes expose `shapeHandle`/`lastOffset` so the phase-1 commit can persist
// real-looking subscription metadata, which then drives the phase-2 resume.
let capturedCb: SubscribeCallback | null = null;

const makeShape = (handle: string) => ({
  subscribe: mock(),
  unsubscribeAll: mock(),
  shapeHandle: handle,
  lastOffset: "0_inf",
});

const MockMultiShapeStream = mock((_initOpts?: ShapeStreamOptions) => ({
  subscribe: (cb: SubscribeCallback) => {
    capturedCb = cb;
  },
  unsubscribeAll: mock(),
  isUpToDate: true,
  shapes: {
    team: makeShape("team-handle"),
    profile: makeShape("profile-handle"),
  },
}));
await mock.module("@electric-sql/experimental", () => ({ MultiShapeStream: MockMultiShapeStream }));

const { createSyncEngine } = await import("../../packages/client/src/sync/index");

// Attach the sync engine as `.electric` on a freshly-created PGlite (ADR-0032 S1) — a plain module over
// the instance, no longer a create-time extension. Setup-only shim; assertions are unchanged.
type SyncEnginePGlite = PGlite & { electric: Awaited<ReturnType<typeof createSyncEngine>>["namespace"] };
async function attachSyncEngine(
  pg: PGlite,
  options?: Parameters<typeof createSyncEngine>[1],
): Promise<SyncEnginePGlite> {
  const engine = await createSyncEngine(pg, options);
  (pg as unknown as { electric: SyncEnginePGlite["electric"] }).electric = engine.namespace;
  return pg as SyncEnginePGlite;
}

// A replication-stream change with a real LSN (used for the initial, healthy sync). No `last` header:
// several rows share one LSN and the trailing `up-to-date` advances the frontier over all of them (a
// per-row `last` would advance the frontier to this LSN and make the dedup drop its siblings).
const changeMsg = (shape: string, lsn: number, value: Record<string, unknown>): MultiShapeMessage => ({
  headers: { operation: "insert", lsn: String(lsn) },
  key: `${shape}/${String(value["id"])}`,
  value,
  shape,
});
// A SNAPSHOT row (offset -1 refetch): an insert with NO `lsn`/`last` header — the engine floors its
// LSN to 0. This is exactly what a fresh snapshot insert looks like on the wire.
const snapshotRow = (shape: string, value: Record<string, unknown>): MultiShapeMessage => ({
  headers: { operation: "insert" },
  key: `${shape}/${String(value["id"])}`,
  value,
  shape,
});
const upToDate = (shape: string, lsn: number): MultiShapeMessage => ({
  shape,
  headers: { control: "up-to-date", global_last_seen_lsn: String(lsn) },
});
const mustRefetch = (shape: string): MultiShapeMessage => ({
  shape,
  headers: { control: "must-refetch" },
});

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeout = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeout) throw new Error("waitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Persisted metadata carries a large committed LSN — the server had advanced well past 0 by the time the
// handle expired (field: stored offsets like `1577066776_0`). The recovery snapshot's up-to-date carries
// an even larger current LSN.
const INITIAL_LSN = 1_577_066_776;
const RECOVERY_LSN = 1_577_066_900;
// A still-higher current LSN: the second racing loop caught up further, so its (re-delivered) snapshot
// batch advances the group frontier and forces a SECOND commit of the double-delivered rows.
const RECOVERY_LSN_2 = 1_577_067_000;

const SUB_KEY = "board_sync";

describe("sync expired-handle recovery over a persisted store", () => {
  let pg: SyncEnginePGlite;

  beforeEach(async () => {
    capturedCb = null;
    pg = await attachSyncEngine(await createFreshTestPGlite(), { debug: false });
    await createTablesFromSchema(pg, { team: registry.team.table, profile: registry.profile.table });
  });

  async function startSync() {
    const sub = await pg.electric.syncShapesToTables({
      registry,
      key: SUB_KEY,
      commitRetryDelayMs: () => 0,
      shapes: {
        team: { shape: { url: "http://localhost:3000/v1/shape", params: { table: "team" } }, tableKey: "team" },
        profile: {
          shape: { url: "http://localhost:3000/v1/shape", params: { table: "profile" } },
          tableKey: "profile",
        },
      },
    });
    if (!capturedCb) throw new Error("subscribe callback was not captured");
    return sub;
  }

  const teamRows = () => drizzleOver(pg).select().from(registry.team.table).orderBy(registry.team.table.id);
  const profileRows = () => drizzleOver(pg).select().from(registry.profile.table).orderBy(registry.profile.table.id);

  it("converges every shape to the full snapshot after all handles expire simultaneously", async () => {
    // ── Phase 1: initial sync of both shapes to up-to-date, with non-trivial row counts, key persisted.
    const sub1 = await startSync();
    const cb1 = capturedCb!;
    await cb1([
      changeMsg("team", INITIAL_LSN, { id: 1, name: "Alpha" }),
      changeMsg("team", INITIAL_LSN, { id: 2, name: "Bravo" }),
      changeMsg("team", INITIAL_LSN, { id: 3, name: "Charlie" }),
      upToDate("team", INITIAL_LSN),
      changeMsg("profile", INITIAL_LSN, { id: 1, handle: "ann" }),
      changeMsg("profile", INITIAL_LSN, { id: 2, handle: "bob" }),
      changeMsg("profile", INITIAL_LSN, { id: 3, handle: "cara" }),
      upToDate("profile", INITIAL_LSN),
    ]);

    await waitUntil(async () => (await teamRows()).length === 3 && (await profileRows()).length === 3);
    sub1.unsubscribe();

    // ── Phase 2: resume against the SAME store (persisted metadata drives the resume; committedLsn is now
    // the large INITIAL_LSN). All handles have expired → each shape 409s and must-refetch. The two racing
    // fetch loops (MultiShapeStream.forceDisconnectAndRefresh on the lagging shape) reorder `team`'s
    // recovery so a bare up-to-date lands BEFORE its re-snapshot rows; `profile` recovers in-order.
    const sub2 = await startSync();
    const cb2 = capturedCb!;

    // The 409s: both shapes emit must-refetch (Electric's synthetic control message on an expired handle).
    await cb2([mustRefetch("team"), mustRefetch("profile")]);

    // team's racing catch-up loop delivers a BARE up-to-date first (its aborted -1 snapshot body never
    // reached the callback; the retried loop caught up at offset 0_0 and saw only the server frontier).
    await cb2([upToDate("team", RECOVERY_LSN)]);

    // team's re-snapshot rows finally arrive from the other loop — but the frontier is already at
    // RECOVERY_LSN, so the engine's dedup drops these (floored) LSN-0 rows.
    await cb2([
      snapshotRow("team", { id: 1, name: "Alpha" }),
      snapshotRow("team", { id: 2, name: "Bravo" }),
      snapshotRow("team", { id: 3, name: "Charlie" }),
    ]);

    // profile recovers healthily: its re-snapshot rows arrive BEFORE its up-to-date, in one batch.
    await cb2([
      snapshotRow("profile", { id: 1, handle: "ann" }),
      snapshotRow("profile", { id: 2, handle: "bob" }),
      snapshotRow("profile", { id: 3, handle: "cara" }),
      upToDate("profile", RECOVERY_LSN),
    ]);

    // The group commit truncates both shapes (must-refetch) and re-applies. profile converges; team is
    // truncated-empty because its snapshot rows were dropped by the reordered frontier advance — yet the
    // engine reports up-to-date. THIS is the field data-loss.
    await waitUntil(async () => (await profileRows()).length === 3);
    expect(sub2.isUpToDate).toBe(true);

    const teams = await teamRows();
    const profiles = await profileRows();
    expect(profiles).toHaveLength(3); // healthy control shape recovered

    // The bug: team lost every row across the expired-handle recovery even though the engine is synced.
    expect(teams).toHaveLength(3);
    expect(teams.map((r) => r.name)).toEqual(["Alpha", "Bravo", "Charlie"]);

    sub2.unsubscribe();
  });

  it("converges when the racing loops DOUBLE-DELIVER a shape's re-snapshot across separate commits", async () => {
    // ── Phase 1: initial healthy sync, key persisted (as above).
    const sub1 = await startSync();
    const cb1 = capturedCb!;
    await cb1([
      changeMsg("team", INITIAL_LSN, { id: 1, name: "Alpha" }),
      changeMsg("team", INITIAL_LSN, { id: 2, name: "Bravo" }),
      changeMsg("team", INITIAL_LSN, { id: 3, name: "Charlie" }),
      upToDate("team", INITIAL_LSN),
      changeMsg("profile", INITIAL_LSN, { id: 1, handle: "ann" }),
      upToDate("profile", INITIAL_LSN),
    ]);
    await waitUntil(async () => (await teamRows()).length === 3 && (await profileRows()).length === 1);
    sub1.unsubscribe();

    // ── Phase 2: resume; team's handle expires and both racing recovery loops deliver its FULL
    // re-snapshot. The first delivery lands (with team's up-to-date) and COMMITS; the second delivery of
    // the same snapshot rows then arrives — while snapshot acceptance is still open, so it is buffered
    // again and committed separately. A plain INSERT would collide on the (already re-inserted) PKs and
    // fail the commit into retry/degraded; the snapshot-acceptance upsert path must let it converge.
    const sub2 = await startSync();
    const cb2 = capturedCb!;

    // profile has to reach up-to-date too so the group can commit (the commit target is the lowest
    // frontier across shapes); it recovers healthily in-order.
    await cb2([mustRefetch("team"), mustRefetch("profile")]);

    // First delivery of team's re-snapshot + its up-to-date, and profile's, in one batch → commit #1.
    await cb2([
      snapshotRow("team", { id: 1, name: "Alpha" }),
      snapshotRow("team", { id: 2, name: "Bravo" }),
      snapshotRow("team", { id: 3, name: "Charlie" }),
      upToDate("team", RECOVERY_LSN),
      snapshotRow("profile", { id: 1, handle: "ann" }),
      upToDate("profile", RECOVERY_LSN),
    ]);
    await waitUntil(async () => (await teamRows()).length === 3 && (await profileRows()).length === 1);

    // SECOND delivery of the very same team snapshot rows from the other loop (no truncate now — the
    // must-refetch flag was consumed by commit #1). It carries a HIGHER up-to-date (the loop caught up
    // further), advancing the group frontier so these rebuffered LSN-0 rows commit AGAIN — commit #2. A
    // plain INSERT would collide on the already-present PKs and fail; the snapshot-acceptance upsert
    // converges. profile advances its frontier too so the group's lowest-frontier target moves.
    await cb2([
      snapshotRow("team", { id: 1, name: "Alpha" }),
      snapshotRow("team", { id: 2, name: "Bravo" }),
      snapshotRow("team", { id: 3, name: "Charlie" }),
      upToDate("team", RECOVERY_LSN_2),
      upToDate("profile", RECOVERY_LSN_2),
    ]);

    await waitUntil(() => sub2.isUpToDate === true);
    const teams = await teamRows();
    expect(teams).toHaveLength(3);
    expect(teams.map((r) => r.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(await profileRows()).toHaveLength(1);

    sub2.unsubscribe();
  });
});
