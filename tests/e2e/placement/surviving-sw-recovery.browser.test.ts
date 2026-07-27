import { expect, test } from "@playwright/test";

import { harnessCall, uniqueStore } from "./support";

// ADR-0049 — RECOVERY UNDER A SURVIVING SHAREDWORKER WITH A DEAD ENGINE. The one arrangement no other lane
// reaches, and until now only ever reproduced by hand.
//
// THE ARRANGEMENT. The harness constructs every store's SharedWorker with `extendedLifetime: true`
// (`harness.ts` → `newSharedWorker`), so on chromium the SharedWorker SURVIVES its last client. The elected
// DEDICATED engine does not: it is spawned by the winning tab and dies with it. Close the ONLY tab and the
// pair comes apart — a live router still holding a registration for an engine that no longer exists. This is
// the state `engine-router.ts` names in its own header ("the router state can outlive an engine … a
// registration is never trusted on age"), and it is reachable ONLY with zero clients in between: this lane
// therefore opens page B strictly AFTER page A is closed, and never keeps a third connection alive across the
// gap — a spectator tab would keep the SharedWorker alive on its own and quietly destroy the premise.
//
// WHAT MUST HAPPEN. A new tab attaching must reach its data anyway. Two signals drive that recovery and both
// land on the same outcome: the engine control port's `close` (the DEFAULT-configuration death evidence —
// per ADR-0049 D5 the timing/probe retirement exists only under the opt-in execution limit, which this
// lane does NOT set), which retires the corpse and fans `engine-retiring`; and the new tab's coordinator
// winning the leader lock, whose `leader-granted` opens the router's handoff window. The lane pins the
// OUTCOME both must produce — a FRESH engine generation minted by the SAME SharedWorker, serving the SAME
// store, with page A's committed row still in it.
//
// GATING — chromium only:
//   - firefox: the SharedWorker is torn down with its last client (no `extendedLifetime`), so the premise
//     cannot be set up at all — a new tab there is an ordinary cold boot, which `election-succession` covers.
//   - webkit: placement is SW-direct, so there is no separate dedicated engine to outlive (and WebKitGTK
//     denies the elected worker OPFS sync access anyway).

test("a SURVIVING SharedWorker recovers a new tab from the dead engine of the tab that closed", async ({
  context,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "`extendedLifetime` (a SharedWorker outliving its last client) is chromium-only: firefox kills the SharedWorker with its last client and webkit is SW-direct, so neither can reach the surviving-router/dead-engine state.",
  );
  // Two full cold engine boots (page A's mint + page B's recovery boot) plus a page close in between.
  test.setTimeout(120_000);

  const store = uniqueStore("sw-survives");

  // ── Page A: the tab that mints the store and owns the elected engine. ──────────────────────────────────
  const pageA = await context.newPage();
  await pageA.goto("/");
  expect((await harnessCall(pageA, "attach", { storePath: store, factories: true })).ok).toBe(true);

  // PRECONDITION: this really is the ELECTED path — a dedicated engine worker that dies with its spawning
  // tab. On SW-direct placement the engine lives IN the SharedWorker and would survive the close, which is a
  // different scenario entirely.
  const placementA = await harnessCall(pageA, "probePlacement", store);
  expect(placementA.ok, `placement query must reply (got ${JSON.stringify(placementA)})`).toBe(true);
  if (!placementA.ok) return;
  expect(
    placementA.result.engineHome,
    "this lane needs the ELECTED home — a dedicated engine that dies with its tab while the SharedWorker lives on.",
  ).toBe("elected-worker");
  const swInstanceId = placementA.result.swInstanceId;

  // A real, COMMITTED opfs store — so page B's recovery opens a persisted store, not a fresh mint.
  await expect.poll(() => harnessCall(pageA, "metaPhase", store), { timeout: 30_000 }).toBe("opfs-committed");
  expect((await harnessCall(pageA, "read", store)).ok).toBe(true);

  // One durable row: page B's recovery is only worth anything if it reaches this DATA, not merely a live pipe.
  // The enqueued write lives in the store's JOURNAL (owed) until a server settles it — this lane has no server
  // for `notes`, so the owed count is the page-observable durable-data evidence (the survival lanes' pattern; a
  // bare table count never sees journal rows).
  expect((await harnessCall(pageA, "mutate", store)).ok).toBe(true);
  await expect.poll(() => harnessCall(pageA, "localOwedCount", store), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

  // Tap the router's control plane to learn the identity of page A's engine (`swInstanceId` + generation).
  // A late-joining declared connection is piped immediately by the router, and that `connect-port` carries the
  // CURRENT identity — which is why a passive tap can read it without attaching anything.
  expect((await harnessCall(pageA, "observeEngineIdentity", store)).started).toBe(true);
  await expect
    .poll(async () => (await harnessCall(pageA, "engineIdentityLog", store)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const logA = await harnessCall(pageA, "engineIdentityLog", store);
  const identityA = logA.at(-1);
  expect(identityA, `page A's engine identity must be observable (log: ${JSON.stringify(logA)})`).toBeDefined();
  if (!identityA) return;
  expect(
    identityA.swInstanceId,
    "the router's minted identity must be scoped to the SharedWorker instance the placement reply named.",
  ).toBe(swInstanceId);

  // ── Close the ONLY tab. Its dedicated engine dies with it; the SharedWorker does not. ──────────────────
  // Everything after this point runs with the store's SharedWorker holding ZERO connections until page B
  // opens one. Page B is opened IMMEDIATELY — promptness is load-bearing, so this lane never sleeps here.
  await pageA.close();

  // ── Page B: a new tab attaching into the surviving router. ─────────────────────────────────────────────
  const pageB = await context.newPage();
  await pageB.goto("/");

  // THE PRECONDITION THIS LANE IS WORTHLESS WITHOUT. The placement reply carries the SharedWorker instance id,
  // minted ONCE per SharedWorker scope. A DIFFERENT id here means chromium tore the SharedWorker down with its
  // last client and this connection booted a brand-new one — in which case everything below would pass as an
  // ordinary cold boot while proving nothing. Fail loudly instead.
  const placementB = await harnessCall(pageB, "probePlacement", store);
  expect(placementB.ok, `placement query must reply (got ${JSON.stringify(placementB)})`).toBe(true);
  if (!placementB.ok) return;
  expect(
    placementB.result.swInstanceId,
    "THE SHAREDWORKER DID NOT SURVIVE THE TAB CLOSE — a new swInstanceId means `extendedLifetime` was not " +
      "honoured (the SharedWorker went down with its last client), so this lane's precondition is gone and " +
      "what follows would be an ordinary cold boot, not recovery from a dead engine under a surviving router.",
  ).toBe(swInstanceId);

  // Tap the control plane BEFORE attaching, so the observation spans the whole recovery: whatever the router
  // still holds for the corpse, and then the fresh engine's identity.
  expect((await harnessCall(pageB, "observeEngineIdentity", store)).started).toBe(true);

  // THE RECOVERY. Bounded but generous: this attach spans the corpse's retirement, a fresh election, a
  // dedicated-engine spawn, and a warm open of the committed OPFS store (whose exclusive handle the dying
  // engine may still be releasing). A genuine attach FAILURE rejects fast and surfaces as `ok:false` with an
  // error, so the budget cannot hide one — it only stops a slow success being misreported as a timeout.
  const recovered = await harnessCall(pageB, "attach", { storePath: store, factories: true, timeoutMs: 45_000 });
  expect(recovered.ok, `the new tab must recover and attach (got ${JSON.stringify(recovered)})`).toBe(true);
  await expect.poll(async () => (await harnessCall(pageB, "read", store)).ok, { timeout: 30_000 }).toBe(true);

  // FRESH GENERATION UNDER THE SAME SHAREDWORKER — the positive proof of re-election rather than survival of
  // the old engine. `mintEngineIdentity` increments within one `swInstanceId` and RESTARTS at 0 under a new
  // one, so "same id, higher generation" is exactly "this SharedWorker outlived its engine and elected another".
  await expect
    .poll(async () => (await harnessCall(pageB, "engineIdentityLog", store)).at(-1)?.generation ?? -1, {
      timeout: 15_000,
    })
    .toBeGreaterThan(identityA.generation);
  const logB = await harnessCall(pageB, "engineIdentityLog", store);
  expect(
    logB.every((observation) => observation.swInstanceId === swInstanceId),
    `every identity page B saw must be minted by the SURVIVING SharedWorker ${swInstanceId} (log: ${JSON.stringify(logB)})`,
  ).toBe(true);

  // The recovery is a genuinely NEW elected engine, not the SharedWorker quietly hosting one itself.
  const report = (await harnessCall(pageB, "bootReport", store)) as {
    ok: boolean;
    report?: { engineHome?: string };
  };
  expect(report.ok, `the recovered engine must report its boot (got ${JSON.stringify(report)})`).toBe(true);
  expect(report.report?.engineHome).toBe("elected-worker");

  // COHERENCE: the SAME store, opened in place. Page A's committed row is there, the committed OPFS artefacts
  // are the ones page A minted, and no idb sibling was created at the path by the recovery boot.
  // The recovery boot's journal pass recovers page A's owed write (sending → pending), so a non-zero owed count
  // here proves the recovered engine opened page A's committed store — a fresh mint would owe nothing.
  await expect
    .poll(() => harnessCall(pageB, "localOwedCount", store), {
      message:
        "the recovered engine must open page A's committed store — the journalled write from before the close is the proof.",
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(1);
  expect(await harnessCall(pageB, "metaPhase", store)).toBe("opfs-committed");
  expect(await harnessCall(pageB, "opfsArtefacts", store)).toEqual({
    sentinelPresent: true,
    storeDirectoryPresent: true,
  });
  expect(await harnessCall(pageB, "idbExists", store)).toBe(false);

  await harnessCall(pageB, "cleanup", store);
});
