import { expect, test } from "@playwright/test";

import { harnessCall, uniqueStore } from "./support";

// ADR-0050 lane — `quiesceStoreWorker`: tear down a store's SharedWorker host BY NAME (a fresh connection), so a
// subsequent path-addressed `destroyStoreArtifacts` on the same path succeeds instead of blocking on the
// still-held backend connection (the board wipe / obsolete-cleanup fix). Drives the REAL primitive against a
// real SharedWorker + real engine placement, cross-browser — the serverless-speed diagnostic loop the board
// worker lane's scenario (H) needs.

test.describe.configure({ mode: "serial" });

// The BOARD scenario: the owning tab is GONE (a wipe reload destroyed it), and a fresh page quiesces the
// surviving worker by name before destroying the path. This is the exact shape the board's obsolete-cleanup and
// wipe run in — the store's original client is no longer attached.
test("owner gone: quiesce-by-name from a fresh page then destroy-by-path succeeds", async ({ context }) => {
  const store = uniqueStore("quiesce-owner-gone");
  const owner = await context.newPage();
  await owner.goto("/");
  expect((await harnessCall(owner, "attach", { storePath: store, factories: true })).ok).toBe(true);
  const report = (await harnessCall(owner, "bootReport", store)) as { report?: { engineHome?: string } };
  const engineHome = report.report?.engineHome;
  // The owner leaves (like the wipe reload): its elected engine dies with the document.
  await owner.close();

  const fresh = await context.newPage();
  await fresh.goto("/");
  const q = await harnessCall(fresh, "quiesceByName", store);
  expect(q, `quiesce (engineHome=${engineHome}, got ${JSON.stringify(q)})`).toMatchObject({ ok: true });
  const destroyed = await harnessCall(fresh, "destroyArtifacts", store);
  expect(
    destroyed,
    `destroy after owner-gone quiesce (engineHome=${engineHome}, got ${JSON.stringify(destroyed)})`,
  ).toMatchObject({ ok: true, timedOut: false });
  expect(await harnessCall(fresh, "idbExists", store)).toBe(false);
  await harnessCall(fresh, "cleanup", store);
});

// The EXACT board scenario: the owner RELOADS (not closes), and the SAME reloaded page runs quiesce+destroy at
// boot — precisely what the board's wipe-on-boot does (applyPendingLocalDataWipe runs first thing after a wipe
// reload, against a store whose pre-reload elected engine died with the old document).
test("owner reloads: quiesce+destroy on the reloaded page succeeds", async ({ page }) => {
  const store = uniqueStore("quiesce-reload");
  await page.goto("/");
  expect((await harnessCall(page, "attach", { storePath: store, factories: true })).ok).toBe(true);
  const report = (await harnessCall(page, "bootReport", store)) as { report?: { engineHome?: string } };
  const engineHome = report.report?.engineHome;
  // Reload the SAME page (the wipe-on-boot reload): the pre-reload elected engine dies with the old document.
  await page.reload();
  const q = await harnessCall(page, "quiesceByName", store);
  expect(q, `reload quiesce (engineHome=${engineHome}, got ${JSON.stringify(q)})`).toMatchObject({ ok: true });
  const destroyed = await harnessCall(page, "destroyArtifacts", store);
  expect(
    destroyed,
    `destroy after reload quiesce (engineHome=${engineHome}, got ${JSON.stringify(destroyed)})`,
  ).toMatchObject({ ok: true, timedOut: false });
  expect(await harnessCall(page, "idbExists", store)).toBe(false);
  await harnessCall(page, "cleanup", store);
});

// The board SPARE shape: `provisionSyncWorker` (never attached), then reload, then quiesce+destroy — exactly
// what the board's scenario (D) does (a login-screen spare, wiped on the next boot).
test("provisioned spare, reloaded: quiesce+destroy on the reloaded page succeeds", async ({ page }) => {
  const store = uniqueStore("quiesce-spare");
  await page.goto("/");
  expect((await harnessCall(page, "provision", { storePath: store })).ok).toBe(true);
  await page.reload();
  const q = await harnessCall(page, "quiesceByName", store);
  expect(q, `spare quiesce (got ${JSON.stringify(q)})`).toMatchObject({ ok: true });
  const destroyed = await harnessCall(page, "destroyArtifacts", store);
  expect(destroyed, `destroy after spare quiesce (got ${JSON.stringify(destroyed)})`).toMatchObject({
    ok: true,
    timedOut: false,
  });
  await harnessCall(page, "cleanup", store);
});

// The SCENARIO (H) case — the whole reason ADR-0050 exists: an idbfs (SW-direct) store's engine holds its
// IndexedDB connection for its whole life, and its extendedLifetime SharedWorker SURVIVES a reload still
// holding it. Without quiesce, `destroyStoreArtifacts` blocks forever. Quiesce must tear the SW-direct host
// down (toreDown:true) so the delete succeeds. This is the fast-loop mirror of the board worker lane's (H).
test("idbfs SW-direct: quiesce tears the host down (toreDown), then destroy deletes the idb database", async ({
  page,
}) => {
  await page.goto("/");
  const store = uniqueStore("quiesce-idbfs");
  // Force the SW-direct idbfs engine (ADR-0050 wire declaration) — no probe, engine in the SharedWorker.
  expect((await harnessCall(page, "attach", { storePath: store, factories: true, forceIdbfs: true })).ok).toBe(true);
  const report = (await harnessCall(page, "bootReport", store)) as {
    report?: { engineHome?: string; storageBackend?: string };
  };
  expect(report.report?.storageBackend, `expected idbfs (got ${JSON.stringify(report.report)})`).toBe("idbfs");
  expect(await harnessCall(page, "idbExists", store)).toBe(true);

  // Reload (the wipe-on-boot reload). On Chromium the `extendedLifetime` SW-direct idbfs worker SURVIVES,
  // still holding the idb connection, so quiesce must actively tear it down (`toreDown: true`). Firefox/WebKit
  // ignore `extendedLifetime`, so the worker dies with the document and the connection is already released —
  // quiesce then reaches a fresh worker (`toreDown: false`), which is equally fine: the destroy still succeeds.
  // The invariant that matters on every engine is the OUTCOME: the idb database is gone after quiesce+destroy.
  await page.reload();

  const q = await harnessCall(page, "quiesceByName", store);
  expect(q, `idbfs quiesce (got ${JSON.stringify(q)})`).toMatchObject({ ok: true });
  const destroyed = await harnessCall(page, "destroyArtifacts", store);
  expect(destroyed, `destroy after idbfs quiesce (got ${JSON.stringify(destroyed)})`).toMatchObject({
    ok: true,
    timedOut: false,
  });
  expect(await harnessCall(page, "idbExists", store)).toBe(false);
  await harnessCall(page, "cleanup", store);
});

// Characterize the LIVE-owner case: quiesce reports the outcome; the destroy behaviour depends on the engine
// home. This documents that quiesce is the teardown for the SW-direct host, not a way to evict another tab's
// live elected engine (which the board never needs — it quiesces only stores whose owner is gone).
test("live owner: quiesce reports the engine home without hanging", async ({ page }) => {
  await page.goto("/");
  const store = uniqueStore("quiesce-live");
  expect((await harnessCall(page, "attach", { storePath: store, factories: true })).ok).toBe(true);
  const report = (await harnessCall(page, "bootReport", store)) as { report?: { engineHome?: string } };
  const q = await harnessCall(page, "quiesceByName", store);
  expect(q, `live-owner quiesce (engineHome=${report.report?.engineHome}, got ${JSON.stringify(q)})`).toMatchObject({
    ok: true,
  });
  await harnessCall(page, "stop", store);
  await harnessCall(page, "cleanup", store);
});
