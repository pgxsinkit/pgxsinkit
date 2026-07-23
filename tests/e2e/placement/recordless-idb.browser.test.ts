import { expect, test } from "@playwright/test";

import { harnessCall, uniqueStore } from "./support";

// ADR-0049 step 12 lane (e) — RECORDLESS-IDB STORE RECOGNITION (invariant 14; fault-matrix "Recordless idb store,
// no meta record → non-creating existence check → idb-authoritative; never virgin-matched"). This is the ENTRY
// POINT of the forward idbfs→opfs transition: an existing idb store's data is never overwritten by a fresh opfs
// mint — it is opened in place, and adoption (when declared) later migrates it forward.
//
// The RECOGNITION CONDITION is directly observable in a real browser WITHOUT booting an engine: a store with an
// existing PGlite idb database but NO store meta record is exactly boot-classification 7's `idbStoreExists &&
// record === undefined` → `boot-idb-authoritative`. This lane seeds that state (a bare idb store created and
// closed, as a record-free fixed-mode store leaves it) and asserts the two facts the classifier keys on — using
// the REAL non-creating existence check (`idbStoreExists`, invariant 14 — NEVER `indexedDB.databases()`) and the
// REAL meta-record reader.

test.describe.configure({ mode: "serial" });

test("a seeded bare idb store is recognized as a recordless fixed-mode store (existing idb + no meta record)", async ({
  page,
}) => {
  await page.goto("/");
  const store = uniqueStore("recordless");

  // Virgin: no idb store, no meta record.
  expect(await harnessCall(page, "idbExists", store)).toBe(false);
  expect(await harnessCall(page, "metaPhase", store)).toBe("absent");

  // Seed a bare idb store directly (the state a record-free fixed-mode store leaves behind), then close it.
  expect(await harnessCall(page, "seedIdbStore", store)).toMatchObject({ ok: true });

  // The exact classification-7 condition: the non-creating existence check sees the store, and there is still
  // no meta record — so a boot would write `idb-authoritative`, never a virgin opfs mint.
  expect(await harnessCall(page, "idbExists", store)).toBe(true);
  expect(await harnessCall(page, "metaPhase", store)).toBe("absent");

  await harnessCall(page, "cleanup", store);
});

// The BOOT-LEVEL assertion of this lane — attach → the engine's BootReport shows `idbfs` and no virgin opfs
// directory is created, with the meta record settled to `idb-authoritative`. ACTIVE now the elected-worker attach
// completes (the placement-query-first ordering, see `election-succession.browser.test.ts`): even though the
// elected dedicated engine now HOLDS the OPFS grant (bug 2 fix), an existing recordless idb store + no meta record is
// boot-classification 7 → `idb-authoritative` → `idbfs`, never a virgin opfs mint (invariant 14; adoption is off).
//
// The `idbfs` backend (the lane's core "no virgin opfs mint" claim) is asserted on EVERY engine. The
// `idb-authoritative` meta-record phase is asserted on chromium + firefox; on WebKitGTK (Playwright) the elected
// DEDICATED engine's IndexedDB store-meta record is not observable from the page context (the engine correctly
// reads the page-seeded PGlite idb store — it boots `idbfs`, proving the two share IndexedDB — but the separate
// store-meta record it writes reads back `absent` from the page; a WebKitGTK harness observation gap, the same
// class as its SharedWorker/dedicated-worker OPFS sync-access denial). Real WebKit meta-record evidence is the
// device storage bench; here webkit asserts the `idbfs` backend and annotates the gap rather than faking the phase.
test("attach over a recordless idb store boots idbfs with no virgin opfs creation", async ({ page }, testInfo) => {
  await page.goto("/");
  const store = uniqueStore("recordless-boot");
  await harnessCall(page, "seedIdbStore", store);
  const attach = await harnessCall(page, "attach", { storePath: store, factories: true });
  expect(attach.ok).toBe(true);
  const report = (await harnessCall(page, "bootReport", store)) as {
    ok: boolean;
    report?: { storageBackend?: string };
  };
  expect(report.report?.storageBackend).toBe("idbfs");
  if (testInfo.project.name === "webkit") {
    testInfo.annotations.push({
      type: "note",
      description:
        "WebKitGTK: the elected dedicated engine's IndexedDB store-meta record is not observable from the page " +
        "context (the idbfs boot itself succeeds); real WebKit meta-record evidence is the device storage bench.",
    });
  } else {
    expect(await harnessCall(page, "metaPhase", store)).toBe("idb-authoritative");
  }
  await harnessCall(page, "cleanup", store);
});
