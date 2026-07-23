import { rm } from "node:fs/promises";
import path from "node:path";

import { chromium, expect, type BrowserContext, type Page, test } from "@playwright/test";

interface HarnessResponse {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly name: string; readonly message: string; readonly storeCode?: string };
}

const PROFILE_DIR = path.resolve(process.cwd(), "tmp/opfs-repacked-browser-profile");

async function reset(page: Page, storeName: string): Promise<void> {
  await page.evaluate((name) => window.opfsRepackedHarness.reset(name), storeName);
}

async function start(
  page: Page,
  storeName: string,
  durability: "relaxed" | "strict",
  faultable = false,
): Promise<HarnessResponse> {
  return page.evaluate(
    ({ name, mode, withFaults }) => window.opfsRepackedHarness.start(name, { durability: mode, faultable: withFaults }),
    { name: storeName, mode: durability, withFaults: faultable },
  );
}

async function request(page: Page, command: string, value?: unknown): Promise<HarnessResponse> {
  return page.evaluate(
    ({ workerCommand, workerValue }) => window.opfsRepackedHarness.request(workerCommand, workerValue),
    { workerCommand: command, workerValue: value },
  );
}

async function seed(page: Page): Promise<void> {
  expect(
    await request(page, "exec", "CREATE TABLE IF NOT EXISTS browser_values (value integer NOT NULL)"),
  ).toMatchObject({
    ok: true,
  });
  expect(await request(page, "exec", "INSERT INTO browser_values VALUES (1)")).toMatchObject({ ok: true });
}

async function openPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4190");
  return page;
}

test.describe.configure({ mode: "serial" });

test("hard worker termination reopens the strict acknowledged state", async ({ page }) => {
  const store = "worker-termination";
  await page.goto("/");
  await reset(page, store);
  expect(await start(page, store, "strict")).toMatchObject({ ok: true });
  await seed(page);
  expect(await request(page, "count")).toMatchObject({ ok: true, value: "1" });

  await page.evaluate(() => window.opfsRepackedHarness.terminate());
  expect(await start(page, store, "strict")).toMatchObject({ ok: true });
  expect(await request(page, "count")).toMatchObject({ ok: true, value: "1" });
  expect(await request(page, "close")).toMatchObject({ ok: true });
});

test("tab close terminates its worker and another tab reopens exact state", async ({ context }) => {
  const store = "tab-termination";
  const first = await openPage(context);
  await reset(first, store);
  expect(await start(first, store, "strict")).toMatchObject({ ok: true });
  await seed(first);
  await first.close();

  const second = await openPage(context);
  expect(await start(second, store, "strict")).toMatchObject({ ok: true });
  expect(await request(second, "count")).toMatchObject({ ok: true, value: "1" });
  expect(await request(second, "close")).toMatchObject({ ok: true });
  await second.close();
});

test("persistent browser restart reopens state without an application close", async () => {
  const store = "browser-termination";
  await rm(PROFILE_DIR, { recursive: true, force: true });
  let firstContext = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
  const first = await openPage(firstContext);
  await reset(first, store);
  expect(await start(first, store, "strict")).toMatchObject({ ok: true });
  await seed(first);
  await firstContext.close();

  firstContext = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
  try {
    const second = await openPage(firstContext);
    expect(await start(second, store, "strict")).toMatchObject({ ok: true });
    expect(await request(second, "count")).toMatchObject({ ok: true, value: "1" });
    expect(await request(second, "close")).toMatchObject({ ok: true });
  } finally {
    await firstContext.close();
    await rm(PROFILE_DIR, { recursive: true, force: true });
  }
});

test("relaxed worker termination recovers an allowed operation prefix", async ({ page }) => {
  const store = "relaxed-prefix";
  await page.goto("/");
  await reset(page, store);
  expect(await start(page, store, "strict")).toMatchObject({ ok: true });
  await seed(page);
  expect(await request(page, "close")).toMatchObject({ ok: true });

  expect(await start(page, store, "relaxed")).toMatchObject({ ok: true });
  expect(await request(page, "exec", "INSERT INTO browser_values VALUES (2)")).toMatchObject({ ok: true });
  await page.evaluate(() => window.opfsRepackedHarness.terminate());

  expect(await start(page, store, "strict")).toMatchObject({ ok: true });
  const recovered = await request(page, "count");
  expect(recovered.ok).toBe(true);
  expect(["1", "2"]).toContain(recovered.value);
  expect(await request(page, "close")).toMatchObject({ ok: true });
});

test("real OPFS flush failure poisons the causing query and the next cache-only query", async ({ page }) => {
  const store = "poison-delivery";
  await page.goto("/");
  await reset(page, store);
  expect(await start(page, store, "strict", true)).toMatchObject({ ok: true });
  expect(await request(page, "exec", "SELECT 1")).toMatchObject({ ok: true });
  expect(await request(page, "fail-next-flush")).toMatchObject({ ok: true });

  const causing = await request(page, "exec", "CREATE TABLE poison_boundary (value integer NOT NULL)");
  expect(causing).toMatchObject({
    ok: false,
    error: { name: "Error", message: "forced browser OPFS flush failure" },
  });
  const next = await request(page, "exec", "SELECT 1");
  expect(next).toMatchObject({ ok: false, error: { name: "StoreFailedError", storeCode: "STORE_FAILED" } });
  const close = await request(page, "close");
  expect(close).toMatchObject({ ok: false, error: { name: "StoreFailedError", storeCode: "STORE_FAILED" } });
  await page.evaluate(() => window.opfsRepackedHarness.terminate());
});
