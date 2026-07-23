import { expect, test } from "@playwright/test";

import { harnessCall, uniqueStore } from "./support";

// ADR-0049 step 12 lane (f) — FRESH COMMIT ON THE CHROMIUM/FIREFOX ELECTED PATH (fault-matrix "Offline first boot,
// fresh store → commits on local init"; invariant 3 — commitment precedes exposure). Attach with factories on a
// virgin store → the elected engine boots `opfs-repacked`; reload → the second boot OPENS the committed store (no
// re-bootstrap), provable via the meta phase `opfs-committed`.
//
// ACTIVE (both ADR-0049 bugs fixed): (1) the elected-worker attach no longer deadlocks — `attachSyncClient` posts
// the placement query FIRST and gates the attach on the elected engine's PIPE handshake (a router-only SharedWorker
// drops the SW-port attach); (2) the elected dedicated engine now PROBES its own scope for the OPFS grant
// (`bootstrapWorkerScope`'s dedicated arm → `probeOpfsSyncAccess`), so the boot opens `opfs-repacked` rather than
// `idbfs`. The commitment barrier + `resolveFreshBoot` record-before-directory machinery is proved off-browser in
// `tests/unit/fresh-commitment.test.ts`; the composed attach path in `tests/unit/attach-placement-composed.test.ts`.
//
// Chromium + Firefox grant OPFS sync-access in a dedicated Worker (that is why the SharedWorker-denied home elects
// one). WebKitGTK (Playwright) denies it even in a dedicated Worker, so the elected engine there boots `idbfs` —
// this lane asserts `opfs-repacked`, so it is scoped to chromium/firefox and skipped on webkit.

test("a virgin elected boot commits opfs-repacked, and the second boot opens the committed store", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name === "webkit",
    "WebKitGTK denies OPFS sync-access even in a dedicated Worker; the elected engine boots idbfs there (real WebKit evidence is the device storage bench).",
  );
  await page.goto("/");
  const store = uniqueStore("fresh-commit");

  // First boot: virgin store → the elected engine commits an opfs-repacked store.
  expect((await harnessCall(page, "attach", { storePath: store, factories: true })).ok).toBe(true);
  const first = (await harnessCall(page, "bootReport", store)) as { report?: { storageBackend?: string } };
  expect(first.report?.storageBackend).toBe("opfs-repacked");
  await expect.poll(() => harnessCall(page, "metaPhase", store)).toBe("opfs-committed");

  // Reload → the second boot OPENS the committed store (no re-bootstrap).
  await harnessCall(page, "stop", store);
  await page.reload();
  expect((await harnessCall(page, "attach", { storePath: store, factories: true })).ok).toBe(true);
  expect(await harnessCall(page, "metaPhase", store)).toBe("opfs-committed");
  const second = (await harnessCall(page, "bootReport", store)) as { report?: { storageBackend?: string } };
  expect(second.report?.storageBackend).toBe("opfs-repacked");

  await harnessCall(page, "cleanup", store);
});
