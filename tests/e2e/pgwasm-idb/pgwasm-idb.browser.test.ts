// Began as a port of `@electric-sql/pglite`'s web target tests (`tests/targets/web/base.js` and
// `idbfs-correctness.test.web.js`, taken under its PostgreSQL License option, © ElectricSQL — see
// NOTICE). Owned outright (ADR-0062); compatibility with PGlite is an anti-goal.

import { expect, type Page, test } from "@playwright/test";

import { CONTINUITY_BUILDS } from "./continuity-builds";

/**
 * pgwasm on the C build with `idb://` storage, in Chromium and WebKit: the storage kind that exists
 * only in a browser. The scenarios run in the page (`src.ts`); these tests drive and assert on them.
 * pg_dump and the REPL run here too, in memory: the REPL needs a DOM, and pg_dump's WebAssembly is
 * loaded as a browser loads it. On demand (`bun run test:browser:pgwasm-idb`), outside the commit path.
 */

const ORIGIN = "http://127.0.0.1:4191";

async function openHarness(page: Page): Promise<void> {
  await page.goto(ORIGIN);
  await page.waitForFunction(() => window.pgwasmIdb !== undefined);
}

const idAndName = [
  { name: "id", dataTypeID: 23 },
  { name: "name", dataTypeID: 25 },
];

test.describe("an idb:// database", () => {
  test.describe.configure({ mode: "serial" });

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openHarness(page);
    await page.evaluate(() => window.pgwasmIdb.deleteStore("base", "retry"));
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("creates a table, inserts and selects", async () => {
    const result = await page.evaluate(async () => {
      const h = window.pgwasmIdb;
      await h.open("base");
      await h.exec("CREATE TABLE IF NOT EXISTS test (id serial PRIMARY KEY, name text)");
      await h.exec("INSERT INTO test (name) VALUES ('test')");
      return h.query("SELECT * FROM test");
    });
    expect(result).toEqual({ affectedRows: 0, fields: idAndName, rows: [{ id: 1, name: "test" }] });
  });

  test("binds parameters", async () => {
    const result = await page.evaluate(async () => {
      const h = window.pgwasmIdb;
      await h.query("INSERT INTO test (name) VALUES ($1)", ["test2"]);
      return h.query("SELECT * FROM test ORDER BY id");
    });
    expect(result.rows).toEqual([
      { id: 1, name: "test" },
      { id: 2, name: "test2" },
    ]);
  });

  test("dumps its data directory gzipped, and the dump loads", async () => {
    const result = await page.evaluate(() => window.pgwasmIdb.dumpAndLoad("SELECT * FROM test ORDER BY id"));
    expect(result.fileName).toBe("base.tar.gz");
    expect(result.rows).toEqual([
      { id: 1, name: "test" },
      { id: 2, name: "test2" },
    ]);
  });

  test("closes", async () => {
    expect(await page.evaluate(() => window.pgwasmIdb.close())).toBeNull();
  });

  test("reopens with its data after a page reload", async () => {
    await page.reload();
    await page.waitForFunction(() => window.pgwasmIdb !== undefined);
    const result = await page.evaluate(async () => {
      const h = window.pgwasmIdb;
      await h.open("base");
      const rows = await h.query("SELECT * FROM test ORDER BY id");
      const closeError = await h.close();
      return { rows, closeError };
    });
    expect(result.closeError).toBeNull();
    expect(result.rows).toEqual({
      affectedRows: 0,
      fields: idAndName,
      rows: [
        { id: 1, name: "test" },
        { id: 2, name: "test2" },
      ],
    });
  });

  test("closes so that its IndexedDB database can be deleted", async () => {
    const closeError = await page.evaluate(async () => {
      const h = window.pgwasmIdb;
      await h.open("base");
      await h.query("SELECT 1");
      const error = await h.close();
      await h.deleteStore("base", "retry");
      return error;
    });
    expect(closeError).toBeNull();
  });
});

test.describe("IndexedDB storage correctness", () => {
  test("refuses a second open of a store and releases it on close", async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(() => window.pgwasmIdb.secondOwner("ownership"));
    expect(result.contender).toEqual({
      name: "StorageInUseError",
      message: 'The IndexedDB store "ownership" is already open.',
    });
    expect(result.blocked).toBe(false);
  });

  test("refuses an open from another tab while one tab holds the store", async ({ context }) => {
    const holder = await context.newPage();
    await openHarness(holder);
    await holder.evaluate(async () => {
      await window.pgwasmIdb.deleteStore("cross-tab", "retry");
      await window.pgwasmIdb.hold("cross-tab");
    });
    const contender = await context.newPage();
    await openHarness(contender);
    expect(await contender.evaluate(() => window.pgwasmIdb.contend("cross-tab"))).toMatchObject({
      name: "StorageInUseError",
    });
    expect(await holder.evaluate(() => window.pgwasmIdb.close())).toBeNull();
    // Released: the other tab opens it now.
    expect(await contender.evaluate(() => window.pgwasmIdb.contend("cross-tab"))).toBeNull();
    await contender.evaluate(() => window.pgwasmIdb.deleteStore("cross-tab", "retry"));
  });

  test("releases the store when a boot fails before Postgres starts", async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(() => window.pgwasmIdb.failedBootReleases("failed-boot"));
    expect(result.bootError?.message).toMatch(/^Invalid filesystem bundle size: 1 !== \d+$/);
    expect(result.blocked).toBe(false);
  });

  test("closes the IndexedDB connection when a boot fails after starting, with a persist in flight", async ({
    page,
  }) => {
    await openHarness(page);
    const result = await page.evaluate(() => window.pgwasmIdb.lateBootFailure("late-boot-failure"));
    expect(result.bootError).toEqual({ name: "Error", message: "forced late initialization failure" });
    expect(result.blocked).toBe(false);
  });

  // Relaxed durability deliberately does not hold statements behind an in-flight snapshot: doing so
  // made every statement pay the whole-directory IndexedDB snapshot (measured: relaxed as slow as
  // strict, ~80 ms per statement). The price is relaxed durability's documented loss window.
  test("runs the next relaxed statement while a snapshot is in flight", async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(() => window.pgwasmIdb.relaxedRunsBesideSnapshot("relaxed-snapshot"));
    expect(result.completedBeforeRelease).toBe(true);
  });

  test("holds a strict statement until the clock can advance past its sync", async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(() => window.pgwasmIdb.strictWaitsForClock("clock"));
    expect(result.completedBeforeClockAdvance).toBe(false);
    expect(result.persisted).toEqual([{ value: 1 }]);
  });

  test("reports a background persist failure once, and recovers it with the final persist", async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(() => window.pgwasmIdb.relaxedFailureRecoveredOnClose("relaxed-failure"));
    expect(result.statementError).toEqual({ name: "Error", message: "forced sync failure" });
    expect(result.closeError).toBeNull();
    expect(result.persisted).toEqual([{ value: 1 }]);
  });

  test("shuts down, persists and releases the store when an extension's close hook throws", async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(() => window.pgwasmIdb.extensionCloseFailure("extension-close"));
    expect(result).toEqual({
      closeError: { name: "Error", message: "forced extension close failure" },
      finalPersistRequested: true,
      exitHooksRan: true,
      queryWhileClosing: { name: "PgwasmClosedError", message: "pgwasm is closing" },
      queryAfterClose: { name: "PgwasmClosedError", message: "pgwasm is closed" },
      blocked: false,
    });
  });

  test("reports a failed final persist ahead of a failed close hook", async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(() => window.pgwasmIdb.finalPersistFailureFirst("final-persist"));
    expect(result.closeError).toEqual({ name: "Error", message: "forced final sync failure" });
  });

  test("shuts down cleanly, so the next open runs no crash recovery", async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(() => window.pgwasmIdb.cleanShutdown("clean-shutdown"));
    expect(result).toEqual({
      cleanRecovery: false,
      crashRecovery: true,
      persistedAfterCrash: [{ value: 1 }, { value: 2 }],
    });
  });
});

test.describe("pg_dump and the REPL", () => {
  test("pg_dump dumps a database created from the prepopulated data directory", async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(() => window.pgwasmIdb.pgDumpRoundTrip());
    expect(result.name).toBe("dump.sql");
    expect(result.type).toMatch(/^text\/plain/);
    expect(result.insert).toBe(true);
    expect(result.restored).toEqual([{ id: 1, note: "in a browser" }]);
  });

  test("the REPL runs what is typed on Enter, and its stylesheet is in the page once", async ({ page }) => {
    await openHarness(page);
    await page.evaluate(() => window.pgwasmIdb.mountRepl());
    const input = page.locator("#first-repl .cm-content");
    await expect(input).toHaveAttribute("contenteditable", "true");
    await input.click();
    await page.keyboard.type("select 1 as one");
    await page.keyboard.press("Enter");
    await expect(page.locator("#first-repl .pgwasm-repl-table th")).toHaveText("one");
    await expect(page.locator("#first-repl .pgwasm-repl-table td")).toHaveText("1");
    // Two REPLs are mounted; React inserted their stylesheet into the head once.
    await expect(page.locator("#second-repl .pgwasm-repl-root")).toHaveCount(1);
    expect(await page.locator('head style[data-href="pgwasm-repl"]').count()).toBe(1);
    await page.evaluate(() => window.pgwasmIdb.unmountRepl());
  });
});

test.describe("an idb:// store an earlier build wrote", () => {
  const BUILD_MARKER = '{"pgwasm":1,"build":"c","dataFormat":1}\n';

  for (const { tag } of CONTINUITY_BUILDS) {
    for (const marker of ["marked", "unmarked"] as const) {
      test(`opens with the current build, reads back and writes: pgwasm-postgres ${tag}, ${marker}`, async ({
        page,
      }) => {
        await openHarness(page);
        const result = await page.evaluate(([build, store, kind]) => window.pgwasmIdb.continuity(build, store, kind), [
          tag,
          `continuity-${tag}-${marker}`,
          marker,
        ] as const);
        // The earlier release's engine wrote the store (its version() names it), and the current one read it.
        expect(result.earlierVersion).toContain(`(pgwasm-postgres ${tag})`);
        expect(result.currentVersion).not.toBe(result.earlierVersion);
        // The earlier build wrote what the test meant it to: a bytea and a ~640 kB text, beside plain rows.
        expect(result.written).toMatchObject([
          { id: 1, label: "plain", payload_bytes: null, body_chars: null },
          { id: 2, label: "bytes", payload_bytes: 8, body_chars: 9 },
          { id: 3, label: "large", payload_bytes: 320_000, body_chars: 640_000 },
        ]);
        // The current build reads every row back identically: Postgres' own sizes and digests, and every value.
        expect(result.read).toEqual(result.written);
        expect(result.identical).toBe(true);
        expect(result.markerWritten).toBe(BUILD_MARKER);
        if (marker === "marked") {
          expect(result.markerRead).toBe(BUILD_MARKER);
          expect(result.refusedWithoutClaim).toBeNull();
        } else {
          // ADR-0063: an unmarked store is adopted as the C build's, and never backfilled; a build that does
          // not claim unmarked directories refuses it.
          expect(result.markerRead).toBeNull();
          expect(result.refusedWithoutClaim).toMatchObject({ name: "BuildMismatchError" });
        }
        expect(result.markerAfterWrite).toBe(result.markerRead);
        expect(result.afterWrite).toEqual([
          { id: 1, label: "plain", body_chars: null },
          { id: 2, label: "bytes", body_chars: 9 },
          { id: 3, label: "large", body_chars: 640_000 },
          { id: 4, label: "after", body_chars: 28 },
        ]);
        expect(result.blocked).toBe(false);
      });
    }
  }
});
