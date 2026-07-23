import { expect, test } from "@playwright/test";

import { harnessCall, PLACEMENT_SERVER_URL, serverCount, uniqueStore } from "./support";

test("a drained idb predecessor adopts to committed opfs and stays committed on reload", async ({ page }, testInfo) => {
  test.skip(!PLACEMENT_SERVER_URL, "server-backed adoption requires test:integration:placement");
  test.skip(testInfo.project.name === "webkit", "WebKitGTK does not grant the elected worker OPFS sync access");
  test.setTimeout(120_000);
  await page.goto("/");

  // Establish one server row that the adoption candidate must reconstruct through its online gate.
  const producer = uniqueStore("adoption-source");
  const before = await serverCount();
  expect((await harnessCall(page, "attachServer", { storePath: producer, timeoutMs: 30_000 })).ok).toBe(true);
  expect((await harnessCall(page, "serverCreate", producer, crypto.randomUUID(), "adoption-row", 20_000)).ok).toBe(
    true,
  );
  await expect.poll(() => serverCount(), { timeout: 30_000 }).toBeGreaterThan(before);
  await harnessCall(page, "serverStop", producer);

  const store = uniqueStore("adoption-target");
  expect(await harnessCall(page, "seedServerIdbStore", store)).toMatchObject({ ok: true });
  expect(await harnessCall(page, "idbExists", store)).toBe(true);

  const adopted = await harnessCall(page, "attachServer", { storePath: store, timeoutMs: 60_000 });
  expect(adopted.ok, JSON.stringify(adopted)).toBe(true);
  await expect.poll(() => harnessCall(page, "serverMetaPhase", store)).toBe("opfs-committed");
  await expect.poll(() => harnessCall(page, "serverLocalCount", store, 20_000)).toBeGreaterThan(0);
  expect(await harnessCall(page, "idbExists", store)).toBe(false);
  // attach resolves once the facade is usable; BootReport finalizes later, with initial sync. Poll the documented
  // eventually-available diagnostic instead of interpreting a successful `report:null` pull as failed adoption.
  await expect
    .poll(
      async () => {
        const first = (await harnessCall(page, "bootReport", store)) as {
          report?: { storageBackend?: string };
        };
        return first.report?.storageBackend;
      },
      { timeout: 60_000 },
    )
    .toBe("opfs-repacked");

  await harnessCall(page, "serverStop", store);
  await page.reload();
  const reopened = await harnessCall(page, "attachServer", { storePath: store, timeoutMs: 60_000 });
  expect(reopened.ok, JSON.stringify(reopened)).toBe(true);
  expect(await harnessCall(page, "serverMetaPhase", store)).toBe("opfs-committed");
  expect(await harnessCall(page, "idbExists", store)).toBe(false);

  await harnessCall(page, "serverStop", store);
  await harnessCall(page, "cleanup", store);
  await harnessCall(page, "cleanup", producer);
});
