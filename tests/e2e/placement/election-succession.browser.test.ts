import { expect, test } from "@playwright/test";

import { harnessCall, uniqueStore } from "./support";

// ADR-0049 step 12 lane (b) — ELECTION + SUCCESSION (fault-matrix "Leader tab dies … successor boots from
// journal", "SharedWorker dies; leader keepalive"). Two tabs attach, one is elected leader (its `pgx-leader-*`
// Web Lock is HELD), the leader page closes, the survivor becomes leader, its engine respawns, and an RPC from
// the survivor succeeds.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// ACTIVE — the two ADR-0049 product bugs these lanes caught are FIXED:
//
// BUG 1 (elected-mode attach deadlock). `attachSyncClient` used to await the FIRST `attach-ack`
// (`runAttachHandshake(currentDataPort(), true)`) BEFORE posting the placement query. In `elected-worker`
// placement the SharedWorker is ROUTER-ONLY and the router DROPS the bridge `attach` envelope, so the ack never
// came, the placement query never posted, and election never started — deadlock. FIX: post the placement query
// FIRST (answered in BOTH SW modes by the bootstrap meta listener), and gate the attach on `firstAttachReady`,
// which settles off the FIRST ack from EITHER home — the elected engine acks over the per-tab PIPE
// (`onConnectPort`), never the (dropped) SW-port send. Composed off-browser proof:
// `tests/unit/attach-placement-composed.test.ts`.
//
// BUG 2 (elected engine never learned OPFS access). The dedicated engine's `defineSyncWorker` scope delegated
// straight to `bindGlobalScope` and never probed, so `placementOpfsAccess` stayed false and it booted `idbfs`.
// FIX: `bootstrapWorkerScope`'s dedicated arm now runs `probeOpfsSyncAccess` in ITS OWN scope and threads the
// grant into the boot (invariant 8). Off-browser proof: `tests/unit/sw-placement-bootstrap.test.ts`.
//
// The harness hooks (`attach`, `bootReport`, `read`, `mutate`, `leaderLocks`, `startInFlight`/`settleInFlight`)
// drive the full flow. Succession works on every Playwright engine: the survivor takes the lock and respawns.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════

test("leader is elected, dies, and the survivor succeeds it with a working engine", async ({ context }) => {
  const store = uniqueStore("succession");
  const leader = await context.newPage();
  const survivor = await context.newPage();
  await leader.goto("/");
  await survivor.goto("/");

  expect((await harnessCall(leader, "attach", { storePath: store, factories: true })).ok).toBe(true);
  expect((await harnessCall(survivor, "attach", { storePath: store, factories: true })).ok).toBe(true);

  // Exactly one leader lock is held across the two tabs.
  const held = (await harnessCall(leader, "leaderLocks")).held;
  expect(held.length).toBe(1);

  // Close the leader → the survivor takes the lock, respawns the engine, and an RPC succeeds. Poll the (idempotent)
  // read until the respawned engine answers — succession spans a fresh engine boot (a cold open of the committed
  // store), so a single-shot read can race the boot under load; retrying a `SELECT 1` is safe and is the correct
  // way to await succession completing.
  await leader.close();
  await expect.poll(async () => (await harnessCall(survivor, "leaderLocks")).held.length).toBe(1);
  await expect.poll(async () => (await harnessCall(survivor, "read", store)).ok, { timeout: 15_000 }).toBe(true);
});
