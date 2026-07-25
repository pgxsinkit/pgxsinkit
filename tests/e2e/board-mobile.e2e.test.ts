import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";

// The mobile surface smoke (apps/board/docs/mobile.md, "Verification"). It runs ONLY in the emulated-phone
// projects — `chromium-mobile` (Pixel 7: real Chromium, `isMobile` + touch) and `webkit-mobile` (an iPhone
// descriptor over Playwright's WebKitGTK) — and it is the ONLY spec those projects run: re-testing the
// SharedWorker engine on the same two engines under a smaller viewport would buy no information the desktop
// suite has not already bought. What IS new here is the surface: the shell that swaps a header identity for a
// burger overlay, the snap columns, the bottom sheet that replaces drag, the chat channel SegmentedControl,
// the inspector's storage readout, and the database route's REPL notice.
//
// EMULATION HONESTY (docs/mobile.md): `webkit-mobile` is desktop WebKit with an iPhone viewport/UA/touch — not
// iOS. Both emulations DO report the board's capability gate `(hover: none) and (pointer: coarse)` (asserted
// below, so a future engine change that silently drops it fails loudly here rather than quietly turning every
// touch assertion into a desktop one), but real iOS storage placement and eviction only show up on hardware.
//
// SHARED-STATE DISCIPLINE: this runs in the SAME serial worker, against the SAME seeded backend, AFTER the
// desktop board-worker suite has already moved fixtures between columns — and then a second time for the
// second project. So it never assumes an issue's Status: it creates its own uniquely-titled issue, DERIVES
// which column that issue currently sits in, and moves it somewhere else.

test.describe.configure({ mode: "serial" });

// Seeded identity + teams (scripts/seed-board.ts). Alice spans Platform + Growth, never Design.
const ALICE = "Alice Okafor";
const ALICE_EMAIL = "alice@board.local";
const PLATFORM = "00000000-0000-4000-8000-0000000000a1";

// Mirrors apps/board/src/data.ts. Duplicated rather than imported: the e2e specs are compiled by Playwright
// outside the board app's tsconfig, and the desktop lane keeps its fixtures local for the same reason.
const STATUS_ORDER = ["backlog", "todo", "in_progress", "done"] as const;
const STATUS_LABEL: Record<(typeof STATUS_ORDER)[number], string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  done: "Done",
};

// The board's dev handle on `window` in the VITE_E2E build (board-client-provider) — the live client. The
// board has no create-issue UI, so a fixture this spec owns end-to-end is minted through the same handle the
// desktop lane uses, then driven entirely through the mobile UI from there.
interface BoardDevWindow {
  __boardClient?: {
    mutate: { create: (table: string, input: Record<string, unknown>) => Promise<void> };
  };
}

/** The AppShell header (`<header>` → `banner`), which on mobile sheds the identity and the Sign out button. */
function header(page: Page) {
  return page.getByRole("banner");
}

/** The AppShell navbar (`<nav>` → `navigation`) — below `xs` a full-width overlay the Burger toggles. */
function teamNav(page: Page) {
  return page.getByRole("navigation");
}

/** The Burger that toggles that overlay. */
function burger(page: Page) {
  return header(page).getByRole("button", { name: "Toggle navigation" });
}

/** A status column, by the `data-status` hook the board puts on each column Stack. */
function column(page: Page, status: (typeof STATUS_ORDER)[number]) {
  return page.locator(`[data-status="${status}"]`);
}

/** The Sync Inspector drawer (Mantine Drawer → `dialog`, named by its title). */
function inspector(page: Page) {
  return page.getByRole("dialog", { name: "Sync inspector" });
}

/**
 * One segment of a Mantine SegmentedControl, by the `<label>` it renders per item — the element that owns
 * the radio (`htmlFor`). Deliberately NOT the segment's text: a label's content can be richer than a string
 * (the channel switcher puts a Badge beside the channel name), and Mantine nests it inside a sliding
 * `innerLabel` span, which Chromium's hit test then reports as INTERCEPTING a tap aimed at that inner
 * content. The label is an ancestor of the interceptor, so aiming there is both correct and unambiguous.
 */
function segment(control: Locator, text: string): Locator {
  return control.locator("label").filter({ hasText: text });
}

// The one scaled deadline in this spec, for the one stretch that needs it (same discipline as the config's
// CI-headroom note: same assertions, scaled deadline). This spec clicks sign-in almost immediately after the
// login screen paints, so its FIRST boot regularly races AHEAD of the login screen's spare provision and pays
// a full cold store boot — PGlite create + initdb + schema + catch-up — which straddles the config's 15s local
// expect budget (measured 10s and 25s on consecutive runs of the same code). Every later assertion keeps the
// tight budget.
const COLD_BOOT_MS = 90_000;

/** Wait for the board shell to have painted the caller's synced team list (the read-path CATCH-UP signal).
 * Same signal as the desktop lane: the sidebar team switcher renders exactly the teams the identity synced.
 * The collapsed mobile navbar is translated off-screen rather than removed, so it still answers `toBeVisible`
 * — deliberately, so this stays the identical readiness barrier on both form factors. */
async function waitForBoardReady(page: Page, timeout?: number): Promise<void> {
  await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeHidden();
  await expect(teamNav(page).getByText("Platform", { exact: true })).toBeVisible({
    ...(timeout != null ? { timeout } : {}),
  });
}

/** Sign in from the login screen as the given identity and wait for the board to be ready (cold boot). */
async function signIn(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name }).click();
  await waitForBoardReady(page, COLD_BOOT_MS);
}

/** Create an issue through the exposed live client, returning the unique title used. */
async function createIssue(page: Page, teamId: string): Promise<string> {
  const title = `mobile-lane ${crypto.randomUUID()}`;
  await page.evaluate(
    async ([t, team, ttl]) => {
      const client = (window as unknown as BoardDevWindow).__boardClient;
      if (client == null) throw new Error("__boardClient not exposed — board not booted");
      await client.mutate.create(t, {
        id: crypto.randomUUID(),
        teamId: team,
        title: ttl,
        status: "todo",
        priority: "none",
      });
    },
    ["issue", teamId, title] as const,
  );
  return title;
}

/** Which column currently holds `title` — DERIVED, never assumed (see the shared-state note above). */
async function statusOf(page: Page, title: string): Promise<(typeof STATUS_ORDER)[number]> {
  for (const status of STATUS_ORDER) {
    if ((await column(page, status).getByText(title).count()) > 0) return status;
  }
  throw new Error(`No status column holds the issue "${title}"`);
}

/** Move `title` to a status it is not already in, through the bottom sheet, and return that target. */
async function moveViaSheet(page: Page, title: string): Promise<(typeof STATUS_ORDER)[number]> {
  const from = await statusOf(page, title);
  const to = STATUS_ORDER.find((status) => status !== from)!;

  // The tap IS the interaction under test: on a coarse pointer the whole card is the sheet's target and the
  // kebab menu is not rendered at all.
  await page.getByText(title).tap();
  const sheet = page.getByRole("dialog", { name: title });
  await expect(sheet).toBeVisible();

  // Flat Status rows (Mantine NavLink — an `<a>` with no href, so matched by its label, scoped to the sheet
  // so a status label never collides with the identically-named column header behind it).
  await sheet.getByText(STATUS_LABEL[to], { exact: true }).tap();
  await expect(sheet).toBeHidden();

  await expect(column(page, to).getByText(title)).toBeVisible();
  await expect(column(page, from).getByText(title)).toHaveCount(0);
  return to;
}

// One context for the whole file: signing in is a full store boot, and the flows are a single user journey
// (shell → board → inspector → chat → database), so they share one phone-sized realm in serial order.
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test("(1) mobile shell: the burger overlay carries the identity the header sheds", async () => {
  test.setTimeout(150_000);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();

  // The capability gate every touch branch below hangs off (apps/board/src/lib/use-touch.ts). Both emulated
  // projects report it today; asserting it means an emulation regression fails HERE, by name, instead of
  // silently downgrading the rest of this spec into a desktop run that still passes.
  expect(await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches)).toBe(true);

  await signIn(page, ALICE);

  // The phone header: Burger + brand + badges + Inspector. The identity and Sign out are gone from it.
  await expect(burger(page)).toBeVisible();
  await expect(header(page).getByText(ALICE_EMAIL, { exact: true })).toBeHidden();
  await expect(header(page).getByRole("button", { name: "Sign out" })).toBeHidden();
  await expect(header(page).getByRole("button", { name: "Inspector" })).toBeVisible();

  // The collapsed navbar is translated fully off-screen, so `toBeInViewport` — not `toBeVisible` — is the
  // assertion that actually distinguishes closed from open.
  await expect(teamNav(page)).not.toBeInViewport();
  await burger(page).tap();
  await expect(teamNav(page)).toBeInViewport();

  // …and it is where the identity + Sign out moved to.
  await expect(teamNav(page).getByText(`Signed in as ${ALICE_EMAIL}`)).toBeVisible();
  await expect(teamNav(page).getByRole("button", { name: "Sign out" })).toBeVisible();

  // Navigating from the overlay closes it — otherwise the tap would reveal a full-screen navbar, not the
  // Team it just opened.
  await teamNav(page).getByText("Platform", { exact: true }).tap();
  await expect(page).toHaveURL(new RegExp(`/team/${PLATFORM}/board`));
  await expect(teamNav(page)).not.toBeInViewport();
});

test("(2) board: tapping a card opens the bottom sheet, which changes its status", async () => {
  await waitForBoardReady(page);

  // All four status columns render (they are snap-scrolled ~80vw wide, so most are off to the right — present
  // and laid out, which is what the swipe affordance depends on).
  for (const status of STATUS_ORDER) {
    await expect(column(page, status)).toBeVisible();
    await expect(column(page, status).getByText(STATUS_LABEL[status], { exact: true })).toBeVisible();
  }

  // This spec's own fixture, so the assertions never depend on what the desktop suite left behind.
  const title = await createIssue(page, PLATFORM);
  await expect(page.getByText(title)).toBeVisible();

  await moveViaSheet(page, title);
});

test("(3) inspector: the storage readout, and an offline write that queues then drains", async () => {
  await header(page).getByRole("button", { name: "Inspector" }).tap();
  await expect(inspector(page)).toBeVisible();

  // The Storage readout (this stage's app change): what the engine ACTUALLY engaged for this boot.
  await expect(inspector(page).getByText("Storage", { exact: true })).toBeVisible();
  const engineHomeRow = inspector(page).getByText("Engine home", { exact: true }).locator("..");
  const backendRow = inspector(page).getByText("Backend", { exact: true }).locator("..");
  await expect(engineHomeRow).toContainText(/elected-worker|shared-worker|in-process|worker/);
  await expect(backendRow).toContainText(/opfs-repacked|idbfs|filesystem|memory|—/);
  // Project-aware: only Chromium's placement is settled evidence (docs/mobile.md, device-verified on Chrome
  // for Android 150 — the probe refuses sync-access handles in the SharedWorker and elects a tab-spawned
  // dedicated one, which is why the board's BYO mint leaves `storageBackend` absent and the readout derives
  // opfs-repacked from the home). WebKit's values are deliberately NOT asserted: Playwright's WebKitGTK has
  // no OPFS at all (it reports a DECLARED `idbfs`, so the derivation never fires there), which says nothing
  // about iOS Safari — expected to grant sync-access handles in the SharedWorker itself. That answer only
  // comes from hardware.
  if (test.info().project.name === "chromium-mobile") {
    await expect(engineHomeRow).toContainText("elected-worker");
  }

  // Offline: the header switch demotes into this drawer on mobile, so this copy is the ONLY one reachable.
  const onlineSwitch = inspector(page).getByRole("switch");
  await onlineSwitch.uncheck();
  await expect(onlineSwitch).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(inspector(page)).toBeHidden();

  // A write made while offline stages into the local journal instead of flushing.
  const title = await createIssue(page, PLATFORM);
  await expect(page.getByText(title)).toBeVisible();
  await moveViaSheet(page, title);

  await header(page).getByRole("button", { name: "Inspector" }).tap();
  await expect(inspector(page)).toBeVisible();
  await expect(
    inspector(page).getByRole("row").filter({ hasText: "issue" }).filter({ hasText: "pending" }).first(),
  ).toBeVisible();

  // Back online + an explicit flush: the journal drains to converged.
  await inspector(page).getByRole("switch").check();
  await inspector(page).getByRole("button", { name: "Flush now" }).tap();
  await expect(inspector(page).getByText("All changes synced")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(inspector(page)).toBeHidden();
  await expect(header(page).getByText("Up to date")).toBeVisible();
});

test("(4) chat: the channel SegmentedControl replaces the rail, and a message posts", async () => {
  // The Board/Chat switch is the only radiogroup on the board page.
  await segment(page.getByRole("radiogroup"), "Chat").tap();
  await expect(page).toHaveURL(new RegExp(`/team/${PLATFORM}/chat`));

  // The 200px channel rail is gone below `xs`; its two entries are a full-width SegmentedControl instead
  // (the Board/Chat control above it is the other radiogroup, so this one is picked out by its channels).
  await expect(page.getByText("Channels", { exact: true })).toBeHidden();
  const channels = page.getByRole("radiogroup").filter({ hasText: "general" });
  await expect(channels).toBeVisible();

  // Switching channels through it is the point of the control (the default segment is the global channel).
  await segment(channels, "platform").tap();
  await expect(channels.getByRole("radio", { name: "team platform" })).toBeChecked();

  const body = `mobile-lane hello ${crypto.randomUUID()}`;
  await page.getByRole("textbox", { name: "Message platform" }).fill(body);
  await page.getByRole("button", { name: "Send" }).tap();
  await expect(page.getByText(body)).toBeVisible();
});

test("(5) database: the REPL is replaced by a notice; the schema map stays", async () => {
  await burger(page).tap();
  await expect(teamNav(page)).toBeInViewport();
  await teamNav(page).getByText("Local database", { exact: true }).tap();
  await expect(page).toHaveURL(/\/database$/);
  await expect(teamNav(page)).not.toBeInViewport();

  await expect(page.getByText("needs a desktop browser")).toBeVisible();
  // …and the lazy CodeMirror chunk is never even fetched, so no editor surface exists in the DOM.
  await expect(page.locator(".cm-editor")).toHaveCount(0);
  // The schema map is NOT dropped on a phone — it is the part of this route that reads fine on one.
  await expect(page.getByRole("heading", { name: "Tables in your local store" })).toBeVisible();
});
