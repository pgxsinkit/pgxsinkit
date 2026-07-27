import { expect, test } from "@playwright/test";

import { harnessCall, PLACEMENT_SERVER_URL, uniqueStore } from "./support";

// ADR-0049 step 12 lane (e) — RECORDLESS-IDB STORE RECOGNITION and its PERMANENCE (invariant 14; fault-matrix
// "Recordless idb store, no meta record → non-creating existence check → idb-authoritative; never
// virgin-matched"). A store's storage backend is fixed at its FIRST MINT, forever: an existing idb store is
// opened IN PLACE by every later boot, whatever that boot's capabilities are. A capability flip (a home that
// now holds OPFS sync-access handles) migrates NOTHING — no candidate, no sentinel, no successor. The only
// route to a different backend is a deliberate `destroyStoreArtifacts()` / `client.destroy()` followed by a
// fresh boot, which `destroy.browser.test.ts` pins.
//
// The RECOGNITION CONDITION is directly observable in a real browser WITHOUT booting an engine: a store with an
// existing PGlite idb database but NO store meta record is exactly boot-classification 6's `idbStoreExists &&
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

  // The exact classification-6 condition: the non-creating existence check sees the store, and there is still
  // no meta record — so a boot would write `idb-authoritative`, never a virgin opfs mint.
  expect(await harnessCall(page, "idbExists", store)).toBe(true);
  expect(await harnessCall(page, "metaPhase", store)).toBe("absent");

  await harnessCall(page, "cleanup", store);
});

// The BOOT-LEVEL assertion of this lane — attach → the engine's BootReport shows `idbfs`, the meta record settles
// to `idb-authoritative`, and NO opfs artefacts are ever created. ACTIVE now the elected-worker attach completes
// (the placement-query-first ordering, see `election-succession.browser.test.ts`): even though the elected
// dedicated engine now HOLDS the OPFS grant (bug 2 fix), an existing recordless idb store + no meta record is
// boot-classification 6 → `idb-authoritative` → `idbfs`, permanently.
//
// The `idbfs` backend + the ABSENCE of opfs artefacts (this lane's core "no virgin opfs mint, no migration"
// claim) are asserted on EVERY engine. The `idb-authoritative` meta-record phase is asserted on chromium +
// firefox; on WebKitGTK (Playwright) the elected DEDICATED engine's IndexedDB store-meta record is not
// observable from the page context (the engine correctly reads the page-seeded PGlite idb store — it boots
// `idbfs`, proving the two share IndexedDB — but the separate store-meta record it writes reads back `absent`
// from the page; a WebKitGTK harness observation gap, the same class as its SharedWorker/dedicated-worker OPFS
// sync-access denial). Real WebKit meta-record evidence is the device storage bench; here webkit asserts the
// `idbfs` backend and annotates the gap rather than faking the phase.
test("attach over a recordless idb store boots idbfs and never creates opfs artefacts", async ({ page }, testInfo) => {
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
  // PERMANENCE: the granted engine home minted NOTHING in the OPFS commitment namespace — no candidate
  // directory, no sentinel. The idb store is still the one and only store at this path.
  const artefacts = await harnessCall(page, "opfsArtefacts", store);
  if (artefacts !== "unobservable") {
    expect(artefacts).toEqual({ sentinelPresent: false, storeDirectoryPresent: false });
  }
  expect(await harnessCall(page, "idbExists", store)).toBe(true);
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

// The SERVER-LANE permanence proof: a recordless idb store carrying the server registry's real local schema,
// booted by the sync-enabled granted worker (`server.sync.worker.ts`, elected engine, OPFS grant held) with a
// live fixture server behind it. This is the exact configuration under which a store would once have been
// migrated forward. It is not: the store stays idb-authoritative across the boot AND across a reload, its idb
// database survives untouched, and the OPFS commitment namespace stays empty. Nothing is ever reconstructed,
// nothing is ever deleted.
test("a recordless idb store stays idb-authoritative under a granted, sync-enabled home — across a reload", async ({
  page,
}, testInfo) => {
  test.skip(!PLACEMENT_SERVER_URL, "the server lane requires test:integration:placement");
  test.skip(testInfo.project.name === "webkit", "WebKitGTK does not grant the elected worker OPFS sync access");
  test.setTimeout(120_000);
  await page.goto("/");

  const store = uniqueStore("permanence-target");
  expect(await harnessCall(page, "seedServerIdbStore", store)).toMatchObject({ ok: true });
  expect(await harnessCall(page, "idbExists", store)).toBe(true);

  const booted = await harnessCall(page, "attachServer", { storePath: store, timeoutMs: 60_000 });
  expect(booted.ok, JSON.stringify(booted)).toBe(true);
  expect(await harnessCall(page, "serverMetaPhase", store)).toBe("idb-authoritative");
  expect(await harnessCall(page, "idbExists", store)).toBe(true);
  expect(await harnessCall(page, "opfsArtefacts", store)).toEqual({
    sentinelPresent: false,
    storeDirectoryPresent: false,
  });
  await expect
    .poll(
      async () => {
        const first = (await harnessCall(page, "bootReport", store)) as { report?: { storageBackend?: string } };
        return first.report?.storageBackend;
      },
      { timeout: 60_000 },
    )
    .toBe("idbfs");

  // A reload re-probes placement from scratch; the verdict is identical, because the backend is fixed at mint.
  await harnessCall(page, "serverStop", store);
  await page.reload();
  const reopened = await harnessCall(page, "attachServer", { storePath: store, timeoutMs: 60_000 });
  expect(reopened.ok, JSON.stringify(reopened)).toBe(true);
  expect(await harnessCall(page, "serverMetaPhase", store)).toBe("idb-authoritative");
  expect(await harnessCall(page, "idbExists", store)).toBe(true);
  expect(await harnessCall(page, "opfsArtefacts", store)).toEqual({
    sentinelPresent: false,
    storeDirectoryPresent: false,
  });

  await harnessCall(page, "serverStop", store);
  await harnessCall(page, "cleanup", store);
});
