import { expect, test } from "@playwright/test";

import { harnessCall, PLACEMENT_SERVER_URL, serverControl, uniqueStore } from "./support";

// ADR-0049 step 12 lane (c) — RELOCATION OUTCOMES (fault-matrix "Dispatched mutation, response lost → outcome:
// unknown, never auto-retried"; invariant 5 / D10). ACTIVE under the container launcher
// (`test:browser:placement:server`); SKIPPED serverless.
//
// The MUTATION half is proven end-to-end here: the server is made SLOW (`writeDelayMs`), the survivor issues a
// `flush()` that rides the delayed write path (a genuine in-flight MUTATION-class RPC waiting on the server), and
// the leader is closed mid-flight — the flush's response is lost when the engine relocates, so it settles the
// exported `EngineRelocatedError` with `code: "engine-relocated"` and `outcome: "unknown"` (inspect/reconcile,
// never auto-retry).
//
// The READ / never-dispatched half ("not-dispatched") is NOT asserted in the browser: a LOCAL read never touches
// the server, so it cannot be held in flight across a relocation (a `SELECT 1` resolves in ~1 ms against the alive
// engine, established in task 1), and a queued-op deadline is not deterministically timeable from a Playwright
// vantage. That classification (dispatched read → `not-dispatched`; queued op on cap/deadline → `not-dispatched`)
// is proved deterministically off-browser in `tests/unit/attach-placement.test.ts`. Documented, not faked.

test("in-flight synced mutation settles `unknown` across a relocation (real delayed-server write path)", async ({
  context,
}) => {
  test.skip(
    !PLACEMENT_SERVER_URL,
    "PLACEMENT_SERVER_URL absent (serverless suite) — run via test:integration:placement or test:browser:placement:server",
  );
  test.setTimeout(90_000);
  const store = uniqueStore("relocation");
  const baselineWrites = (await serverControl({ writeDelayMs: 8_000 })).writesStarted;
  try {
    const leader = await context.newPage();
    const survivor = await context.newPage();
    await leader.goto("/");
    await survivor.goto("/");
    expect((await harnessCall(leader, "attachServer", { storePath: store })).ok).toBe(true);
    expect((await harnessCall(survivor, "attachServer", { storePath: store })).ok).toBe(true);

    // A write on the survivor, then a `flush()` that rides the SLOW server path — in-flight for ~8 s.
    expect((await harnessCall(survivor, "serverCreate", store, crypto.randomUUID(), "reloc-row")).ok).toBe(true);
    expect((await harnessCall(survivor, "serverStartFlush", store)).started).toBe(true);
    // Observe the fixture accepting the delayed request before relocating; no timing guess.
    await expect
      .poll(async () => (await serverControl({})).writesStarted, { timeout: 8_000 })
      .toBeGreaterThan(baselineWrites);

    // Relocate by closing the leader — the survivor's engine (the leader's) dies mid-flush.
    await leader.close();

    const settled = await harnessCall(survivor, "serverSettleFlush", store);
    // The dispatched MUTATION's response was lost when the engine relocated → `unknown`, never auto-retried.
    expect(settled.settled, `flush settlement: ${JSON.stringify(settled)}`).toBe("rejected");
    expect(settled.error?.code).toBe("engine-relocated");
    expect(settled.error?.outcome).toBe("unknown");

    await harnessCall(survivor, "serverStop", store);
  } finally {
    await serverControl({ writeDelayMs: 0 });
  }
});
