import { rm } from "node:fs/promises";
import path from "node:path";

import { chromium, expect, type BrowserContext, type Page, test } from "@playwright/test";

interface HarnessResponse {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly name: string; readonly message: string; readonly storeCode?: string };
}

const PROFILE_DIR = path.resolve(process.cwd(), "tmp/opfs-repacked-browser-profile");
const CRASH_PROFILE_DIR = path.resolve(process.cwd(), "tmp/opfs-repacked-browser-crash-profile");

async function reset(page: Page, storeName: string): Promise<void> {
  await page.evaluate((name) => window.opfsRepackedHarness.reset(name), storeName);
}

async function start(
  page: Page,
  storeName: string,
  durability: "relaxed" | "strict",
  options: { faultable?: boolean; countFlushes?: boolean } = {},
): Promise<HarnessResponse> {
  return page.evaluate(
    ({ name, mode, extra }) => window.opfsRepackedHarness.start(name, { durability: mode, ...extra }),
    { name: storeName, mode: durability, extra: options },
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
  expect(await start(page, store, "strict", { faultable: true })).toMatchObject({ ok: true });
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

interface CrashRow {
  readonly id: number;
  readonly digest: string;
}

async function scanCrashRows(page: Page, via: "seq" | "index"): Promise<readonly CrashRow[]> {
  const settings =
    via === "seq"
      ? "SET enable_indexscan = off; SET enable_indexonlyscan = off; SET enable_bitmapscan = off;"
      : "SET enable_seqscan = off; SET enable_bitmapscan = off; SET enable_sort = off;";
  const query = "SELECT id, md5(payload) AS digest FROM crash_rows ORDER BY id";
  expect(await request(page, "exec", settings)).toMatchObject({ ok: true });
  const plan = await request(page, "query", `EXPLAIN ${query}`);
  expect(JSON.stringify(plan.value)).toContain(
    via === "seq" ? "Seq Scan on crash_rows" : "Index Scan using crash_rows_pkey",
  );
  const rows = await request(page, "query", query);
  expect(await request(page, "exec", "RESET ALL")).toMatchObject({ ok: true });
  expect(rows.ok).toBe(true);
  return rows.value as CrashRow[];
}

/**
 * The browser confirmation of the unit crash-and-reopen suite
 * (`tests/unit/pglite-opfs-repacked-crash-reopen.test.ts`), on OPFS on disk: a persistent profile, where
 * the sync access handles write real files (an off-the-record context keeps OPFS in the browser
 * process's memory). The storage worker is
 * terminated at one deterministic point — after the last of N relaxed commits returned and before any
 * strict boundary covered them — and a fresh worker reopens the store.
 */
test("relaxed worker termination after N commits and before the next sync reopens every returned commit on disk", async () => {
  const store = "relaxed-crash-reopen";
  const commits = 8;
  await rm(CRASH_PROFILE_DIR, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(CRASH_PROFILE_DIR, { headless: true });
  try {
    const page = await openPage(context);
    await reset(page, store);
    expect(await start(page, store, "strict")).toMatchObject({ ok: true });
    expect(
      await request(page, "exec", "CREATE TABLE crash_rows (id integer PRIMARY KEY, payload text NOT NULL)"),
    ).toMatchObject({ ok: true });
    expect(await request(page, "close")).toMatchObject({ ok: true });

    expect(await start(page, store, "relaxed", { countFlushes: true })).toMatchObject({ ok: true });
    const commit = async (id: number) =>
      expect(
        await request(page, "exec", `INSERT INTO crash_rows VALUES (${id}, repeat(md5('${id}'), 40))`),
      ).toMatchObject({ ok: true });
    // The first commit's host sync may run a repack the store has due (a strict boundary); every commit
    // after it is past the last one: the metadata files are not flushed again before the termination.
    await commit(1);
    const flushed = await request(page, "flushes");
    for (let id = 2; id <= commits; id += 1) await commit(id);
    const flushedAtTermination = await request(page, "flushes");
    const metadataFlushes = (response: HarnessResponse) => {
      const counts = response.value as Record<string, number>;
      return (counts["metadata-a.bin"] ?? 0) + (counts["metadata-b.bin"] ?? 0) + (counts["activation.bin"] ?? 0);
    };
    expect(metadataFlushes(flushedAtTermination)).toBe(metadataFlushes(flushed));

    await page.evaluate(() => window.opfsRepackedHarness.terminate());
    expect(await start(page, store, "relaxed")).toMatchObject({ ok: true });

    // The store opens, the engine recovers, and an index scan agrees with a sequential scan
    // (data_checksums=on: every page they read is checksum-verified).
    const bySeq = await scanCrashRows(page, "seq");
    expect(await scanCrashRows(page, "index")).toEqual(bySeq);
    // Relaxed promises only the strict boundary; a terminated worker leaves every write the platform
    // accepted, so — documenting, not promising — every commit that returned is there, each intact.
    expect(bySeq.map((row) => row.id)).toEqual(Array.from({ length: commits }, (_, index) => index + 1));
    const digests = await request(
      page,
      "query",
      "SELECT count(*)::int AS intact FROM crash_rows WHERE payload = repeat(md5(id::text), 40)",
    );
    expect(digests.value).toEqual([{ intact: commits }]);
    expect(await request(page, "close")).toMatchObject({ ok: true });
  } finally {
    await context.close();
    await rm(CRASH_PROFILE_DIR, { recursive: true, force: true });
  }
});
