import { expect, test } from "@playwright/test";

import { harnessCall, PLACEMENT_SERVER_URL, serverControl, serverCount, uniqueStore } from "./support";

// ADR-0049 step 12 — the remaining plan lanes. Provision-then-attach is now ACTIVE (Gap C — elected-mode
// provision); the rest need machinery BEYOND this harness (a real sync/write server, CDP-level worker
// termination, or an execution-limit-configured elected boot). Each remaining stub is a precise `fixme` so the
// coverage map is explicit; none is a fake pass.

// ADR-0049 step 8 (fault row "provision then attach, same tab → attach adopts the provision grant; never
// self-queued"). Elected provision drives the coordinator's PROVISION CLAIM and pre-spawns the store over the
// elected engine's pipe (Gap C); a later attach on the SAME tab ADOPTS that grant — the router pipes the attach
// connection to the SAME engine and the boot adopts the provisioned store, so the BootReport carries a `provision`
// stamp (initdb ran once, at provision time, NOT re-run at attach — no double initdb, no second engine).
//
// The proof of adoption is the BootReport's `provision` stamp — initdb ran ONCE, at provision time — with a NULL
// `phases.pgliteCreateMs` (the boot ran NO create of its own): the store the boot uses IS the pre-spawned one (no
// double initdb, no second engine). This holds on every engine (chromium/firefox pre-spawn opfs-repacked, WebKit
// idbfs); the adopted-opfs BootReport omits `storageBackend` (the opfs-repacked VFS reports no dataDir), so this
// lane keys on the provision stamp, not the backend field.
test("provision-then-attach on one tab adopts the provision grant (no second engine, no double initdb)", async ({
  page,
}) => {
  await page.goto("/");
  const store = uniqueStore("provision-adopt");

  // Provision pre-spawns the store (initdb only) via the elected PROVISION CLAIM.
  expect((await harnessCall(page, "provision", { storePath: store })).ok).toBe(true);

  // Attach on the SAME tab ADOPTS the grant — no second engine, no second lock, boot adopts the provisioned store.
  expect((await harnessCall(page, "attach", { storePath: store, factories: true })).ok).toBe(true);

  const report = (await harnessCall(page, "bootReport", store)) as {
    ok: boolean;
    report?: { provision?: { initdbMs?: number } | null; phases?: { pgliteCreateMs?: number | null } };
  };
  expect(report.ok).toBe(true);
  // Adopted: the boot carries the provision stamp (initdb ran at provision time) …
  expect(
    report.report?.provision,
    `boot should carry a provision stamp (adopted), got ${JSON.stringify(report.report?.provision)}`,
  ).not.toBeNull();
  // … and ran NO create of its own — the single initdb, never doubled.
  expect(report.report?.phases?.pgliteCreateMs).toBeNull();

  await harnessCall(page, "cleanup", store);
});

test.describe("plan lanes needing machinery beyond the placement harness", () => {
  // Fault-matrix: "SharedWorker dies; leader + engine alive → Leader keepalive threshold → HOLDER reconstructs via
  // factory, re-attaches, re-announces. Without factory: leader-op-or-reload (risk 3)"; and "SW dies after a call
  // was forwarded; engine alive → Pipes are direct — in-flight traffic survives". ACTIVE (chromium only).
  //
  // Machinery: a CDP `Target.closeTarget` on the store's `shared_worker` target forcibly kills the SharedWorker
  // mid-session (no page platform API can). CDP is chromium-only — firefox/webkit skip with that reason.
  test("SharedWorker kill → keepalive recovery (with factory) + leader-op recovery (without) + in-flight survival", async ({
    page,
    browser,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "CDP Target.closeTarget (forced shared-worker kill) is chromium-only; the keepalive reconstruction is proved off-browser in election-coordinator.test.ts.",
    );
    test.setTimeout(90_000);
    await page.goto("/");
    const cdp = await browser.newBrowserCDPSession();
    const swTargetIds = async (store: string): Promise<string[]> => {
      const { targetInfos } = (await cdp.send("Target.getTargets")) as {
        targetInfos: Array<{ targetId: string; type: string; title?: string }>;
      };
      return targetInfos
        .filter((t) => t.type === "shared_worker" && (t.title ?? "").includes(store))
        .map((t) => t.targetId);
    };
    const killSw = async (store: string): Promise<number> => {
      const ids = await swTargetIds(store);
      for (const targetId of ids) await cdp.send("Target.closeTarget", { targetId });
      return ids.length;
    };

    // ── Arm 1: WITH the reconstruction factory — in-flight survives + the keepalive reconstructs the SW. ──
    const withStore = uniqueStore("swkill-with");
    expect(
      (
        await harnessCall(page, "attach", {
          storePath: withStore,
          factories: true,
          keepaliveIntervalMs: 800,
          keepaliveMissThreshold: 2,
        })
      ).ok,
    ).toBe(true);
    expect((await harnessCall(page, "read", withStore)).ok).toBe(true);

    // Issue an in-flight read + mutation, then FORCIBLY KILL the SharedWorker. The per-tab pipe is DIRECT
    // (tab↔engine, not routed through the SW), so the engine still answers — the in-flight ops SURVIVE (resolve),
    // never hang (plan row "Pipes are direct — in-flight traffic survives").
    expect((await harnessCall(page, "startInFlight", withStore)).started).toBe(true);
    expect(await killSw(withStore)).toBeGreaterThan(0);
    const settled = await harnessCall(page, "settleInFlight", withStore);
    expect(settled.read.settled, `in-flight read must survive the SW kill (got ${JSON.stringify(settled.read)})`).toBe(
      "resolved",
    );
    expect(
      settled.mutation.settled,
      `in-flight mutation must survive the SW kill (got ${JSON.stringify(settled.mutation)})`,
    ).toBe("resolved");

    // The leader keepalive detects the SW silence (unanswered pings) and RECONSTRUCTS the SW via the factory (a
    // fresh `shared_worker` target reappears), re-announcing the still-live engine; a post-kill RPC succeeds and
    // the leader lock never dropped.
    await expect.poll(async () => (await swTargetIds(withStore)).length, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await harnessCall(page, "read", withStore)).ok, { timeout: 15_000 }).toBe(true);
    expect((await harnessCall(page, "leaderLocks")).held.length).toBeGreaterThanOrEqual(1);
    await harnessCall(page, "cleanup", withStore);

    // ── Arm 2: WITHOUT the reconstruction factory — leader-op recovery over the direct pipe, no reconstruction. ──
    const woStore = uniqueStore("swkill-without");
    expect(
      (
        await harnessCall(page, "attach", {
          storePath: woStore,
          factories: true,
          omitCreateWorker: true,
          keepaliveIntervalMs: 800,
          keepaliveMissThreshold: 2,
        })
      ).ok,
    ).toBe(true);
    expect((await harnessCall(page, "read", woStore)).ok).toBe(true);
    expect(await killSw(woStore)).toBeGreaterThan(0);

    // No factory → the keepalive threshold CANNOT reconstruct (accepted-risk 3: leader-op-or-reload). Past the
    // threshold, NO fresh SharedWorker target appears — yet the leader op still works over the surviving direct
    // pipe, and the lock is untouched.
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await swTargetIds(woStore)).toHaveLength(0);
    expect((await harnessCall(page, "read", woStore)).ok).toBe(true);
    expect((await harnessCall(page, "leaderLocks")).held.length).toBeGreaterThanOrEqual(1);
    await harnessCall(page, "cleanup", woStore);
  });

  // Fault-matrix: "Engine hangs silently, execution limit ENABLED, elected placement → Overdue report → probes →
  // threshold → engine-retiring → deliberate terminate (idempotent) → ownership release → respawn". ACTIVE.
  //
  // Machinery: the elected engine boots with the router's `executionLimit` present (baked into `sync.worker.ts`),
  // this tab carries `executionLimit` (1 s) so it ARMS the overdue-dispatch report, and the hang is a genuine
  // CPU-bound cross join via `rawExec` (`startHang`) — real work, no product test seam, no `pg_sleep`. The
  // single-threaded WASM engine cannot answer the router's control-channel probe pings while it runs, so the
  // router (past its miss threshold) fans `engine-retiring`; the leader terminates + respawns under the SAME grant.
  // Bridge-silence is DISABLED so the execution-limit path (not the non-leader silence reconnect) handles the hang.
  //
  // Chromium + Firefox only. On WebKitGTK the elected engine is idbfs (OPFS denied), and the execution-limit
  // verdict never engages there: the CPU-bound blocking op does NOT starve the idbfs engine's control-plane event
  // loop the way it starves the synchronous-OPFS engine, so the router's probe pings keep being answered → the
  // miss threshold is never reached → no termination fires (verified: no termination over 110 s). This is a
  // WebKitGTK/idbfs behaviour, not the pgxsinkit contract; the verdict flow is proved off-browser
  // (`engine-router.test.ts` + `engine-control.test.ts`) and end-to-end here on the elected-OPFS engines.
  test("silent engine kill with the execution limit enabled → termination + respawn", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name === "webkit",
      "WebKitGTK idbfs elected engine: the execution-limit verdict does not engage (probes stay answered); the flow is proved on chromium/firefox + off-browser.",
    );
    test.setTimeout(90_000);
    await page.goto("/");
    const store = uniqueStore("exec-limit");
    expect(
      (
        await harnessCall(page, "attach", {
          storePath: store,
          factories: true,
          executionLimitMs: 1000,
          disableBridgeSilence: true,
        })
      ).ok,
    ).toBe(true);

    // Inject a multi-second engine-blocking op. The tab reports the overdue dispatch; the router probes the busy
    // engine (unanswered) → verdict → the leader terminates + respawns it (slow is NEVER death evidence below the
    // probe threshold — a long op under the limit would run to completion; here it exceeds it).
    expect((await harnessCall(page, "startHang", store)).started).toBe(true);

    // The respawned engine answers — poll the idempotent read across the verdict + terminate + respawn + the
    // successor's contention-retried OPFS open (the dying WASM engine holds its exclusive handle until its op ends).
    await expect.poll(async () => (await harnessCall(page, "read", store)).ok, { timeout: 60_000 }).toBe(true);

    // Terminated + respawned UNDER THE SAME grant — the leader lock never dropped.
    expect((await harnessCall(page, "leaderLocks")).held.length).toBe(1);

    // The hung WRITE-CAPABLE op settled with the documented outcome (a dispatched mutation whose response was lost
    // when the engine relocated → `unknown`; inspect/reconcile, never auto-retry).
    const settled = await harnessCall(page, "settleHang", store, 5_000);
    expect(settled.settled).toBe("rejected");
    expect(settled.error?.code).toBe("engine-relocated");
    expect(settled.error?.outcome).toBe("unknown");

    await harnessCall(page, "cleanup", store);
  });

  // Fault-matrix: "Leader enters BFCache (persisted: true) → release authority + retire; pageshow → re-queue +
  // re-attach". Reliable BFCache entry/exit needs a real cross-document navigation with a cacheable response and
  // BFCache eligibility, which the static preview harness cannot guarantee headless. Off-browser: the BFCache
  // release/reclaim hooks are proved in `tests/unit/election-coordinator.test.ts`.
  test.fixme("BFCache navigation of the leader releases + reclaims authority — needs a BFCache-eligible navigation", async () => {});

  // Fault-matrix: "Offline first boot, fresh store → commits on local init … writes journal safely". ACTIVE under
  // the container launcher (`test:integration:placement` / `test:browser:placement:server`); SKIPPED in the serverless suite. The fixture server
  // REFUSES every write (503), so nothing can reach Postgres — proving the fresh store commits + journals a write
  // with ZERO server contact (the provenance-gate invariant "fresh = local init, no server"). Then the leader tab
  // closes, the survivor succeeds and recovers the SHARED committed store's journal, writes are un-refused, and the
  // row arrives server-side EXACTLY ONCE (mutation-id dedup). Chromium+firefox commit `opfs-committed`; WebKitGTK
  // (idbfs) commits `idb-authoritative` — asserted per engine.
  test("offline-first-boot fresh commit + journal survival across succession", async ({ context }, testInfo) => {
    test.skip(
      !PLACEMENT_SERVER_URL,
      "PLACEMENT_SERVER_URL absent (serverless suite) — run via test:integration:placement or test:browser:placement:server",
    );
    test.skip(
      testInfo.project.name === "webkit",
      "WebKitGTK (idbfs elected engine): the store-meta record written by the dedicated engine is not observable from the page (same as the recordless-idb lane), so the commit phase cannot be asserted here; proven on chromium/firefox (OPFS).",
    );
    test.setTimeout(90_000);
    const store = uniqueStore("offline-first");
    await serverControl({ refuseWrites: true });
    try {
      const before = await serverCount();
      const leader = await context.newPage();
      const survivor = await context.newPage();
      await leader.goto("/");
      await survivor.goto("/");
      expect((await harnessCall(leader, "attachServer", { storePath: store })).ok).toBe(true);
      expect((await harnessCall(survivor, "attachServer", { storePath: store })).ok).toBe(true);

      // Offline-first COMMIT: the virgin store committed locally despite the write API refusing every write.
      const expectedPhase = testInfo.project.name === "webkit" ? "idb-authoritative" : "opfs-committed";
      await expect.poll(() => harnessCall(leader, "serverMetaPhase", store)).toBe(expectedPhase);

      // A local write is optimistically acked while the server refuses — it sits in the journal (owed > 0), and
      // NOTHING reaches the server (zero server contact for the write).
      expect((await harnessCall(leader, "serverCreate", store, crypto.randomUUID(), "offline-row")).ok).toBe(true);
      await expect
        .poll(() => harnessCall(leader, "serverOwedCount", store), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(1);
      expect(await serverCount()).toBe(before);

      // Close the leader → the survivor succeeds (opens the committed store + recovers its journal).
      await leader.close();
      await expect.poll(async () => (await harnessCall(survivor, "leaderLocks")).held.length).toBe(1);

      // Un-refuse → the survivor drains the recovered journal → the row arrives server-side EXACTLY ONCE.
      await serverControl({ refuseWrites: false });
      await expect.poll(() => serverCount(), { timeout: 50_000 }).toBe(before + 1);

      await harnessCall(survivor, "serverStop", store);
    } finally {
      await serverControl({ refuseWrites: false });
    }
  });

  // Fault-matrix (strict/relaxed split): "Leader tab dies mid-commit … successor boots from journal; pendings
  // classified per invariant 5". ACTIVE under the launcher; SKIPPED serverless. The write is DELAYED at the server
  // (writeDelayMs) so it is genuinely in-flight/journalled when the leader tab is abruptly KILLED (page.close);
  // the survivor's engine recovers the shared journal and, once the delay is lifted, drains it — the row lands
  // EXACTLY ONCE (mutation-id dedup), proving journal survival across a leader kill.
  //
  // BOUNDARY SEMANTICS (what this proves vs not): the worker runs `durability: "relaxed"` (ADR-0048 crash model =
  // longest valid stable prefix). This lane proves the RELAXED guarantee — a journalled write survives the kill
  // and converges exactly once. The STRICT pre/post-boundary (a strict write is durable BEFORE its ack) is a
  // separate durability mode; it is NOT asserted here (it needs a strict-durability worker + a crash injected
  // between journal-fsync and ack, which page.close cannot time deterministically) and is proved off-browser in
  // the durability unit suites. Documented, not faked.
  test("leader-kill journal survival — the survivor drains the recovered journal exactly once (relaxed)", async ({
    context,
  }, testInfo) => {
    test.skip(
      !PLACEMENT_SERVER_URL,
      "PLACEMENT_SERVER_URL absent (serverless suite) — run via test:integration:placement or test:browser:placement:server",
    );
    test.skip(
      testInfo.project.name === "webkit",
      "WebKitGTK (idbfs, relaxed durability): an abrupt leader close before the ASYNC IndexedDB flush loses the not-yet-flushed journal write (the ADR-0048 relaxed crash model), so the survivor has nothing to drain; the write is durable across the close on chromium/firefox via the OPFS commitment barrier.",
    );
    test.setTimeout(90_000);
    const store = uniqueStore("leader-kill");
    await serverControl({ refuseWrites: true });
    try {
      const before = await serverCount();
      const leader = await context.newPage();
      const survivor = await context.newPage();
      await leader.goto("/");
      await survivor.goto("/");
      expect((await harnessCall(leader, "attachServer", { storePath: store })).ok).toBe(true);
      expect((await harnessCall(survivor, "attachServer", { storePath: store })).ok).toBe(true);

      // The write lands PRE-KILL and is durably journalled (owed > 0) while the server refuses it.
      expect((await harnessCall(leader, "serverCreate", store, crypto.randomUUID(), "prekill-row")).ok).toBe(true);
      await expect
        .poll(() => harnessCall(leader, "serverOwedCount", store), { timeout: 10_000 })
        .toBeGreaterThanOrEqual(1);

      // Abruptly KILL the leader tab (its dedicated engine dies with it) — the journal lives in the shared store.
      await leader.close();
      await expect.poll(async () => (await harnessCall(survivor, "leaderLocks")).held.length).toBe(1);

      // The successor drains the recovered journal once writes are allowed — exactly once.
      await serverControl({ refuseWrites: false });
      await expect.poll(() => serverCount(), { timeout: 50_000 }).toBe(before + 1);

      await harnessCall(survivor, "serverStop", store);
    } finally {
      await serverControl({ refuseWrites: false });
    }
  });
});
