import { expect, test } from "@playwright/test";

import { harnessCall, uniqueStore } from "./support";

// ADR-0049 step 12 lane (a) — PLACEMENT DECISION (the engine-home probe verdict that gates every downstream
// placement guarantee; fault-matrix "Probe per boot", invariant 8).
//
//   - Chromium / Firefox: the SharedWorker placement probe is DENIED sync-access handles in SharedWorker scope,
//     so the reply is `electionRequired: true` (router-only, elected-worker home).
//   - WebKit: a GRANTED probe → SW-direct (`electionRequired: false`), election never engages. But Playwright's
//     WebKitGTK build lacks OPFS sync-access in a SharedWorker, so that arm lands `elected` here — the REAL
//     WebKit SW-direct evidence is the on-device storage bench (`docs/testing-strategy.md` § storage bench), NOT
//     this harness; the lane annotates that and asserts the reply is internally consistent whichever way it went.

test.describe.configure({ mode: "serial" });

test("the SharedWorker placement reply reflects the probed engine home", async ({ page }, testInfo) => {
  await page.goto("/");
  const reply = await harnessCall(page, "probePlacement", uniqueStore("decision"));

  console.log(`[lane-a ${testInfo.project.name}] placement reply: ${JSON.stringify(reply)}`);

  expect(reply.ok, `placement query must reply (got ${JSON.stringify(reply)})`).toBe(true);
  if (!reply.ok) return;
  const { engineHome, electionRequired, swInstanceId } = reply.result;
  expect(typeof swInstanceId).toBe("string");
  expect(swInstanceId.length).toBeGreaterThan(0);
  // The two fields are always internally consistent: election is required exactly when the home is elected-worker.
  expect(electionRequired).toBe(engineHome === "elected-worker");

  if (testInfo.project.name === "webkit") {
    if (engineHome === "shared-worker") {
      // A real SW-direct grant (would only happen on a WebKit build with SharedWorker OPFS sync-access).
      expect(electionRequired).toBe(false);
    } else {
      testInfo.annotations.push({
        type: "note",
        description:
          "WebKitGTK denied OPFS sync-access in SharedWorker scope (elected reply). Real WebKit SW-direct is " +
          "proven on-device via the storage bench, not in this Playwright harness.",
      });
      expect(engineHome).toBe("elected-worker");
    }
    return;
  }

  // Chromium + Firefox: the SharedWorker probe is denied → router-only, election required.
  expect(engineHome).toBe("elected-worker");
  expect(electionRequired).toBe(true);
});
