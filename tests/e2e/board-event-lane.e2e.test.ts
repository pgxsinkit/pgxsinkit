import { type BrowserContext, expect, type Page, test } from "@playwright/test";

// The **Event lane** in a real browser (pgxsinkit ADR-0053 decision 9), run in the existing worker harness
// (`test:integration:worker`). The lane's unit tiers already pin append validation, batch assembly, verdict
// settlement and backoff; what only a browser can prove is the pair of claims a consumer actually cares
// about:
//
//   (E1) an append made ONLINE reaches the server and leaves the Outbox — through the real UI, on the real
//        `board-write` deployment, with the engine in a SharedWorker;
//   (E2) an append made with NO CONNECTIVITY stages durably…
//   (E3) …survives the tab being closed and reopened with the network still cut (the Outbox is a real
//        durable table, not an in-memory buffer)…
//   (E4) …and drains on reconnect.
//
// (E4) is the sharp one, and it is why the offline order matters. The client NEVER deletes an Outbox row
// unilaterally — there is no attempt cap and no client-side quarantine (ADR-0053 decision 4), so a row is
// removed only on a per-event server verdict. An Outbox that goes from staged-across-a-reload to empty
// after reconnect therefore proves the round trip end-to-end; an "append online, observe empty" check could
// not, because empty is also the resting state.
//
// NOT asserted here — and deliberately: that the event reached the board's ARCHIVE table
// (`board_issue_view_event`). That requires the consumer runner process (`bun run dev:board:consumer`) to be
// running against the lane's stack and a Postgres client inside the spec; this lane owns neither (the board
// compose stack has no Bun service, and these specs run under Playwright's node runtime with no DB access).
// The consumer half is covered by the server unit tier and the pgmq container lane instead. What this lane
// proves is everything up to and including the server's verdict.
//
// The service-worker helpers below are duplicated from board-offline-return.e2e.test.ts rather than shared,
// for the reason that file already records for its own fixtures: these specs compile outside the board app's
// tsconfig, and a spec that reached into another spec's helpers would couple two independent journeys.

test.describe.configure({ mode: "serial" });

// A seeded identity + team (scripts/seed-board.ts). Any Member does; the lane is role-independent — both
// role registries register the same Event stream, precisely so a Member (who does most of the viewing) has
// an Event lane at all.
const ALICE = "Alice Okafor";
const PLATFORM = "00000000-0000-4000-8000-0000000000a1";

const COLD_BOOT_MS = 90_000;
const OFFLINE_BOOT_MS = 90_000;
// Reconnect → flush → verdict → row deleted → the drain signal's non-empty→empty transition. The lane backs
// off while the network is down (jittered, with a ceiling), so the first post-reconnect pass can be a few
// seconds out; the trigger's online signal fires a pass immediately, but a pass already in backoff waits.
const DRAIN_MS = 120_000;

/** The sidebar team switcher (the AppShell navbar landmark). */
function teamNav(page: Page) {
  return page.getByRole("navigation");
}

/** The Sync Inspector drawer (Mantine Drawer → `dialog`, named by its title). */
function inspector(page: Page) {
  return page.getByRole("dialog", { name: "Sync inspector" });
}

async function waitForBoardReady(page: Page, timeout?: number): Promise<void> {
  const budget = timeout != null ? { timeout } : {};
  await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeHidden(budget);
  await expect(teamNav(page).getByText("Platform", { exact: true })).toBeVisible(budget);
}

/**
 * Open an Issue's details through the REAL UI — the card's kebab menu, which on a pointer device is the
 * board's Issue detail surface — and close it again. Opening it is what appends `board_issue_viewed`
 * (apps/board/src/board/use-issue-view-events.ts); which Issue is immaterial to this lane, so the first
 * card on the board is used rather than a minted fixture.
 */
async function openAnIssue(page: Page): Promise<void> {
  const kebab = page.getByRole("button", { name: "Issue actions" }).first();
  await expect(kebab).toBeVisible();
  await kebab.click();
  // The Status submenu item proves the detail surface actually opened (and therefore that `onOpen` fired),
  // rather than the click landing on a card and starting a drag.
  await expect(page.getByText("Status", { exact: true }).first()).toBeVisible();
  await page.keyboard.press("Escape");
}

/** Read the Event lane's drain-signal badge out of the Inspector drawer, leaving the drawer closed again. */
async function expectOutbox(page: Page, label: "Outbox drained" | "Outbox staging", timeout: number): Promise<void> {
  await page.getByRole("button", { name: "Inspector" }).click();
  await expect(inspector(page)).toBeVisible();
  await expect(
    inspector(page).getByText(label, { exact: true }),
    `the Event lane readout never reached "${label}"`,
  ).toBeVisible({ timeout });
  await page.keyboard.press("Escape");
  await expect(inspector(page)).toBeHidden();
}

/** See board-offline-return.e2e.test.ts: one online session must be enough, so the first-session backfill is
 * the completion signal, and the page must have ended up controlled. */
async function waitForOfflineCapture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  expect(await page.evaluate(() => navigator.serviceWorker.controller != null)).toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const cache = await caches.open("board-runtime-v1");
          const keys = await cache.keys();
          return keys.some((request) => request.url.includes("/assets/") && request.url.endsWith(".css"));
        }),
      {
        timeout: 30_000,
        message: "the entry stylesheet never reached the service-worker cache: the first-session backfill did not run",
      },
    )
    .toBe(true);
}

/** Open a NEW page in an ALREADY-OFFLINE context, asserting the shell came from the service worker. */
async function openOfflineShell(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  const response = await page.goto("/");
  if (response == null) throw new Error("the offline navigation produced no response at all");
  expect(response.fromServiceWorker(), "the offline navigation was answered by the network, not the worker").toBe(true);
  return page;
}

let context: BrowserContext;
let page: Page;

test.afterAll(async () => {
  await context?.close();
});

test("(E1) online: opening an Issue appends an event that flushes and leaves the Outbox", async ({ browser }) => {
  test.setTimeout(240_000);
  context = await browser.newContext();
  page = await context.newPage();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
  await page.getByRole("button", { name: ALICE }).click();
  await waitForBoardReady(page, COLD_BOOT_MS);

  await page.goto(`/team/${PLATFORM}/board`);
  await waitForBoardReady(page, COLD_BOOT_MS);

  await openAnIssue(page);

  // The lane EXISTS and reports empty. "Outbox —" (the no-signal state) would fail this, so a client with
  // no Event lane at all — a registry whose streams the member projection dropped, say — cannot pass it.
  await expectOutbox(page, "Outbox drained", DRAIN_MS);

  // …and the server did not refuse, reject, or defer it: those are the only verdicts the lane reports, so a
  // clean report panel is the healthy path (`acked` is deliberately never reported — a high-volume lane
  // would drown the app in its own success). A `deferred` here would mean the deployed server does not know
  // this Event stream, which is exactly the rollout-skew case worth catching in a real deployment.
  await page.getByRole("button", { name: "Inspector" }).click();
  await expect(inspector(page)).toBeVisible();
  await expect(inspector(page).getByText(/refused|rejected|deferred/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(inspector(page)).toBeHidden();

  await waitForOfflineCapture(page);
});

test("(E2) offline: an append with no connectivity stages in the Outbox", async () => {
  test.setTimeout(240_000);
  await context.setOffline(true);

  await openAnIssue(page);

  // Staged, not sent, and not lost: the flush driver is attempting and failing against a dead network, and
  // the lane's answer is to keep the row and back off — never to discard it.
  await expectOutbox(page, "Outbox staging", OFFLINE_BOOT_MS);
});

test("(E3) the staged event survives closing the tab and returning with no connectivity", async () => {
  test.setTimeout(240_000);
  // Close the page BEFORE reopening: this is a reopened tab (a full document + engine boot), not a reload of
  // a live one, so nothing in memory can be carrying the event.
  await page.close();

  page = await openOfflineShell(context);
  await waitForBoardReady(page, OFFLINE_BOOT_MS);

  // The Outbox is a durable local TABLE (ADR-0053 decision 2), so the event written in (E2) is still owed —
  // read back from the store by a brand-new boot with nothing fetchable.
  await expectOutbox(page, "Outbox staging", OFFLINE_BOOT_MS);
});

test("(E4) reconnecting drains the Outbox — the row leaves only on a server verdict", async () => {
  test.setTimeout(240_000);
  await context.setOffline(false);

  // No intervention: no reload, no manual flush. The lane's own trigger fires a pass on the online signal,
  // the batch is POSTed to `board-write`'s /api/events, and the acked row is deleted — which is the only
  // way an Outbox row can disappear, since the client never discards without a server verdict.
  await expectOutbox(page, "Outbox drained", DRAIN_MS);
});
