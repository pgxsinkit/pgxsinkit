import { expect, test } from "@playwright/test";

import { harnessCall, uniqueStore } from "./support";

// ADR-0049 step 12 lane (d) — DESTROY (peer refusal + success; fault-matrix "`destroy()` with peers attached →
// refused with a typed error — close peers first").
//
// The PEER-REFUSAL DECISION is the SharedWorker router's `tabCount()` surfaced through the DESTROY peer-count
// query (`StoreDestroyRefusedError` is raised on `peers > 1`). This lane drives that REAL router wire in a real
// browser: open N SharedWorker connections to one per-store router and read the verdict. One connection → the
// single-tab destroy is permitted (`peers === 1`); two connections → destruction is refused (`peers === 2`,
// i.e. one peer besides the destroyer).

test.describe.configure({ mode: "serial" });

test("the router's destroy peer-count verdict reflects the attached-connection count", async ({ page }) => {
  await page.goto("/");

  // One connection: the destroyer alone — `peers === 1` (destroy would be permitted).
  const solo = await harnessCall(page, "peerVerdict", uniqueStore("destroy-solo"), 1);
  expect(solo, `single-connection verdict (got ${JSON.stringify(solo)})`).toMatchObject({ ok: true, peers: 1 });

  // Two connections: a live peer besides the destroyer — `peers === 2`, so `client.destroy()` would raise
  // `StoreDestroyRefusedError` (peers > 1). This is the exact input the peer-refusal gate keys on.
  const withPeer = await harnessCall(page, "peerVerdict", uniqueStore("destroy-peer"), 2);
  expect(withPeer, `two-connection verdict (got ${JSON.stringify(withPeer)})`).toMatchObject({ ok: true, peers: 2 });
});

// The FACADE-LEVEL flow — `client.destroy()` refused with two tabs attached, succeeds with one, and a fresh attach
// after destroy boots a fresh store. ACTIVE now Gaps A+B are fixed:
//   A. Peer-departure detection (D8): a detaching tab posts a `tab-detach` pgx0049 control envelope on the SW port
//      (the `detach` bridge envelope rides the pipe the router never sees), so `router.tabCount()` — the
//      peer-refusal input — falls when the peer closes. (Belt-and-braces: the router also drops a crashed tab via
//      the MessagePort `close` event where supported.)
//   B. Destroy↔retirement ordering (D8): the destroy supervisor RETIRES its own elected engine and AWAITS the
//      teardown ack — the point the exclusive OPFS handle is released — BEFORE `deleteBackendStore`, so the delete
//      no longer races the engine's async handle release (`NoModificationAllowedError`).
// The refusal INPUT is also proved by the `peerVerdict` primitive lane above; the supervised destroy machine
// (effect ordering, resumable boundaries) is proved off-browser in `tests/unit/destroy-supervision.test.ts`; the
// peer-refusal + retirement-barrier wiring in `tests/unit/engine-router.test.ts` + `election-coordinator.test.ts`.
test("client.destroy() refuses with a peer, succeeds alone, then a fresh attach reboots", async ({ context }) => {
  const store = uniqueStore("destroy-facade");
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await tabA.goto("/");
  await tabB.goto("/");
  expect((await harnessCall(tabA, "attach", { storePath: store, factories: true })).ok).toBe(true);
  expect((await harnessCall(tabB, "attach", { storePath: store, factories: true })).ok).toBe(true);

  // Two tabs → refused.
  const refused = await harnessCall(tabA, "destroy", store);
  expect(refused.error?.name).toBe("StoreDestroyRefusedError");

  // "Close peers first": detach the peer CLEANLY (`stop()`), which posts its `tab-detach` on the SW port so the
  // router's `tabCount` drops deterministically across every engine. NOTE — a real page-CLOSE posts `tab-detach`
  // on `pagehide`, which chromium + webkit deliver to the SharedWorker but FIREFOX DROPS (an unload-message
  // platform limitation; the MessagePort `close` event that would cover it is unsupported in all three Playwright
  // engines — `onclose` absent). That page-close pagehide-drop is the documented residual (stale count until SW
  // restart, resolved by `destroy({ force: true })`); it is a platform trait, not the pgxsinkit contract, so this
  // lane exercises the contract via the reliable clean detach. Delivery is async, so poll until the refusal clears
  // (a REFUSED destroy has no side effects — it throws before detach — so retrying is safe).
  await harnessCall(tabB, "stop", store);
  await tabB.close();
  await expect
    .poll(
      async () => {
        const result = await harnessCall(tabA, "destroy", store);
        return result.ok ? "ok" : (result.error?.name ?? "error");
      },
      { timeout: 15_000 },
    )
    .toBe("ok");

  // A fresh attach after destroy boots a fresh store (not stuck in `deleting`).
  expect((await harnessCall(tabA, "attach", { storePath: store, factories: true })).ok).toBe(true);
  expect(await harnessCall(tabA, "metaPhase", store)).not.toBe("deleting");
});

test("destroying an idb-authoritative store deletes its database and permits fresh capability placement", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "webkit", "the fresh capability-placement assertion requires elected OPFS");
  await page.goto("/");
  const store = uniqueStore("destroy-idb");
  expect(await harnessCall(page, "seedIdbStore", store)).toMatchObject({ ok: true });
  expect(await harnessCall(page, "idbExists", store)).toBe(true);

  expect(await harnessCall(page, "destroyIdbStore", store)).toMatchObject({ ok: true });
  expect(await harnessCall(page, "idbExists", store)).toBe(false);
  expect(await harnessCall(page, "metaPhase", store)).toBe("absent");

  expect((await harnessCall(page, "attach", { storePath: store, factories: true })).ok).toBe(true);
  const report = (await harnessCall(page, "bootReport", store)) as { report?: { storageBackend?: string } };
  expect(report.report?.storageBackend).toBe("opfs-repacked");
  await harnessCall(page, "cleanup", store);
});
