import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";

// Board ADR-0010 "offline return" — the ADR's Proof bullet, run in the existing worker harness
// (`test:integration:worker`). This is the ONLY lane where the capability exists at all: registration is
// `import.meta.env.PROD`-gated (main.tsx), and this lane is the one that serves the BUILT app under
// `vite preview`, so the service worker is live here and nowhere else.
//
// The capability is deliberately RETURN, not first-visit offline: its precondition is one full online
// session. Each context below therefore boots online first, and only then flips the SAME browser context
// offline — same profile, so same PGlite store, same GoTrue session, same service-worker cache. Closing the
// page and opening a new one in that context is the "reopened the tab with no connectivity" journey; a
// reload would keep the old document alive and never exercise the navigation branch.
//
//   Context A — Admin (`lazy + persistent` chat):
//     (A1) online: activate chat, write, converge, and let the worker take the page
//     (A2) offline return: the shell replays from the service worker, the eager store paints the board, and
//          the PROMOTED chat serves its history — no connection-needed state for this role
//     (A3) a write made offline journals, then DRAINS to the backend once connectivity returns
//
//   Context B — Member (`lazy + ephemeral` chat):
//     (B1) online: the same surfaces work, and Context A's offline write is READ BACK from the server into a
//          brand-new store (the drain proof that a local journal could never fake)
//     (B2) offline return: the eager tables still serve, but the TEMP chat cluster left no durable trace by
//          design, so the channel takes the connection-needed state
//
//   Context C — signed out: sign-in offline takes the OTHER connection-needed surface (the login alert)
//
//   Context D — the COLD return (the maintainer's manual repro, and the regression this lane exists to hold):
//     ONE online session with no reload anywhere, close the tab, outlive the SharedWorker's extendedLifetime
//     grace so the engine is genuinely dead, then return offline. The new tab must cold-boot the engine from
//     the service-worker cache alone (worker script, pglite wasm/data) and still paint the board from the
//     local store. (A2)/(B2) reopen fast enough that a SURVIVING worker can answer; only this context proves
//     the boot path with nothing alive and nothing fetchable.
//
// The two role-split chat outcomes are the ADR's central claim: the offline data breadth is a consequence of
// the registry's declared retention, not a new promise.
//
// (B2)'s connection-needed state is derived from `isBackendUnreachable`, i.e. the runtime phase `degraded`.
// A network-level failure never reaches `onReadStreamError`: `@electric-sql/client` wraps every shape fetch
// in `createFetchWithBackoff` with `maxRetries: Infinity` ("Retry forever — clients may go offline and come
// back") and only re-throws non-retryable 4xx, so on a real outage nothing is ever thrown. The runtime
// instead reads the failed attempts themselves, through `backoffOptions.onFailedAttempt`
// (`packages/client/src/read-stream-stall.ts`), and enters `degraded` on the first one — within a second or
// so of the offline boot, well inside this spec's poll budgets.

test.describe.configure({ mode: "serial" });

// Seeded identities + teams (scripts/seed-board.ts). "Admin" is the ONE fixture carrying
// `app_metadata.roles: ["admin"]`, which is what makes its `message` entry the authoritative (persistent)
// one; Alice, Bob and the rest are Members, whose registry projects that same entry `asEphemeral`.
const ADMIN = "Admin";
const ALICE = "Alice Okafor";
const PLATFORM = "00000000-0000-4000-8000-0000000000a1";

// The ruled connection-needed copy (apps/board/src/connection-needed.ts), pinned VERBATIM rather than
// imported. These specs compile outside the board app's tsconfig (the mobile lane duplicates its fixtures for
// the same reason) — and more importantly, a spec that imported the constant could never catch a copy change.
// The literal IS the assertion: an edit to the shipped wording must fail here and be re-ruled deliberately.
const CONNECTION_NEEDED_CHAT = "Chat needs a connection to load. It will appear automatically when you're back online.";
const CONNECTION_NEEDED_SIGN_IN = "Signing in needs a connection. Reconnect and try again.";

// Deadlines, scaled per stretch (the config's CI-headroom discipline: same assertions, longer budget where a
// full store boot or a network-recovery window sits inside the wait).
const COLD_BOOT_MS = 90_000;
// An offline boot pays the same PGlite create/open as an online one, with every asset coming off the
// service-worker cache instead of the HTTP cache.
const OFFLINE_BOOT_MS = 90_000;
// The connection-needed state is meant to appear once the read path reports itself unreachable, which lags
// first paint (the booted runtime has to try to stream before it can know), so this is a poll budget rather
// than a sampled check — "Loading…" rendering first is correct behaviour, not flake.
const UNREACHABLE_MS = 60_000;
// Convergence after reconnect: the journal's jittered per-mutation backoff tops out at 30s and the worker's
// fallback convergence sweep is 15s, so a write can legitimately sit for the better part of a minute before
// its retry fires — and the journal row only clears once the ack AND the Electric echo have landed.
const CONVERGE_MS = 120_000;

// The board's dev handle on `window` in the VITE_E2E build (board-client-provider). The board has NO
// create-issue UI (see the mobile lane's note), so an issue fixture is minted through the same handle both
// existing lanes use; everything else in this spec is driven through the real UI.
interface BoardDevWindow {
  __boardClient?: {
    mutate: { create: (table: string, input: Record<string, unknown>) => Promise<void> };
  };
}

/** The sidebar team switcher (the AppShell navbar landmark). */
function teamNav(page: Page) {
  return page.getByRole("navigation");
}

/** The Sync Inspector drawer (Mantine Drawer → `dialog`, named by its title). */
function inspector(page: Page) {
  return page.getByRole("dialog", { name: "Sync inspector" });
}

/** The per-team Board/Chat switch. Picked out from the chat route's OTHER SegmentedControl (the below-`xs`
 * channel switcher, which stays in the DOM at desktop widths behind `hiddenFrom`) by the only word neither
 * control shares. */
function shellTabs(page: Page) {
  return page.getByRole("radiogroup").filter({ hasText: "Board" });
}

/** One segment of a Mantine SegmentedControl, by the `<label>` that owns its radio — not the segment text,
 * which Mantine nests inside a sliding `innerLabel` span that intercepts the hit test (mobile lane note). */
function segment(control: Locator, text: string): Locator {
  return control.locator("label").filter({ hasText: text });
}

/** Wait for the board shell to have painted the caller's synced team list — the read-path CATCH-UP signal
 * (identical to both existing lanes). Offline this is the sharper assertion of the two: the rows can only
 * have come from the local store, because nothing can be fetched. */
async function waitForBoardReady(page: Page, timeout?: number): Promise<void> {
  const budget = timeout != null ? { timeout } : {};
  await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeHidden(budget);
  await expect(teamNav(page).getByText("Platform", { exact: true })).toBeVisible(budget);
}

/** Sign in from the login screen as the given identity and wait for the board to be ready (cold boot). */
async function signIn(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name }).click();
  await waitForBoardReady(page, COLD_BOOT_MS);
}

/** Create an issue through the exposed live client, returning the unique title used. */
async function createIssue(page: Page, teamId: string): Promise<string> {
  const title = `offline-return ${crypto.randomUUID()}`;
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

/** Post a message through the chat composer (the real UI write path), returning the unique body used.
 * Opening a channel at all is what ACTIVATES the lazy `message` entry — for the Admin that activation is the
 * permanent promotion this whole lane hangs on. */
async function postMessage(page: Page, channelName: string): Promise<string> {
  const body = `offline-return ${crypto.randomUUID()}`;
  await page.getByRole("textbox", { name: `Message ${channelName}` }).fill(body);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(body)).toBeVisible();
  return body;
}

/**
 * Wait for the service worker's FIRST-SESSION capture to be complete. A first visit's entry assets are
 * requested during document parse, BEFORE the worker exists, so runtime capture structurally misses them;
 * the registration therefore posts the session's already-fetched same-origin URLs to the worker once it is
 * ready, and the worker backfills the ones it missed (sw.js `backfill`). ONE online session must be enough —
 * that is the ADR's stated precondition, and the maintainer's manual repro (login → close → return offline,
 * no reload anywhere) is exactly what a reload here would have papered over. The stylesheet is the
 * deterministic completion signal: it is always parse-time (pre-worker), so it can ONLY appear in the cache
 * through the backfill. Also asserts the page ended up controlled (`clients.claim()`), since live capture of
 * everything later — the engine's wasm above all — depends on it.
 */
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

/**
 * Open a NEW page in an ALREADY-OFFLINE context and prove the shell came from the service worker. The
 * explicit `fromServiceWorker()` assertion is the ADR's "the navigation is service-worker-served" claim; it
 * composes with `setOffline` because Playwright's Chromium context applies the offline emulation to its
 * service workers too, so the worker's own `fetch` fails and its cache fallback answers.
 */
async function openOfflineShell(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  const response = await page.goto("/");
  if (response == null) throw new Error("the offline navigation produced no response at all");
  expect(response.fromServiceWorker(), "the offline navigation was answered by the network, not the worker").toBe(true);
  return page;
}

// ─── Context A: the Admin — `lazy + persistent` chat, durably promoted on first use ────────────────────────
let adminContext: BrowserContext;
let adminPage: Page;
let adminIssueTitle: string;
let adminMessageBody: string;
// Context A's OFFLINE write. Context B reads it back through a different identity's freshly-created store,
// which is only possible if it reached Postgres — see (B1).
let offlineIssueTitle: string;

// ─── Context B: a Member — `lazy + ephemeral` chat, a TEMP cluster that leaves no durable trace ────────────
let memberContext: BrowserContext;
let memberPage: Page;
let memberMessageBody: string;

test.afterAll(async () => {
  await adminContext?.close();
  await memberContext?.close();
});

test("(A1) online: the Admin activates chat, writes, converges, and the worker takes the page", async ({ browser }) => {
  test.setTimeout(240_000);
  adminContext = await browser.newContext();
  adminPage = await adminContext.newPage();

  await adminPage.goto("/");
  await expect(adminPage.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
  await signIn(adminPage, ADMIN);
  // The admin bypass made visible: every Team syncs, not just the ones a membership row grants.
  await expect(teamNav(adminPage).getByText("Growth", { exact: true })).toBeVisible();
  await expect(teamNav(adminPage).getByText("Design", { exact: true })).toBeVisible();

  await adminPage.goto(`/team/${PLATFORM}/board`);
  await waitForBoardReady(adminPage);
  adminIssueTitle = await createIssue(adminPage, PLATFORM);
  await expect(adminPage.getByText(adminIssueTitle)).toBeVisible();

  // Opening the channel activates the lazy `message` entry. For the AUTHORITATIVE (Admin) registry entry that
  // activation is permanent: the table is promoted into the eager set and stays durable across boots.
  await segment(shellTabs(adminPage), "Chat").click();
  await expect(adminPage).toHaveURL(new RegExp(`/team/${PLATFORM}/chat`));
  adminMessageBody = await postMessage(adminPage, "general");
  // The seeded backlog came down with the activation — so the offline leg is asserting real history, not just
  // this session's own post.
  await expect(adminPage.getByText("No messages in this channel yet.")).toHaveCount(0);

  // Both writes must be fully CONVERGED before the network goes away: a journal row clears only once the
  // server acked it AND the Electric echo reconciled the overlay away, so an empty journal here means the two
  // rows the offline leg asserts are server-origin durable rows, not optimistic local state.
  await adminPage.getByRole("button", { name: "Inspector" }).click();
  await expect(inspector(adminPage)).toBeVisible();
  await expect(inspector(adminPage).getByText("All changes synced")).toBeVisible({ timeout: CONVERGE_MS });
  await adminPage.keyboard.press("Escape");
  await expect(inspector(adminPage)).toBeHidden();
  await expect(adminPage.getByText("Up to date", { exact: true })).toBeVisible();

  await waitForOfflineCapture(adminPage);
});

test("(A2) offline return: the shell replays from the worker and the promoted chat serves its history", async () => {
  test.setTimeout(240_000);
  // Close the page BEFORE going offline: this is a reopened tab, not a reload of a live one.
  await adminPage.close();
  await adminContext.setOffline(true);

  const page = await openOfflineShell(adminContext);
  adminPage = page;

  // Interactive offline: the GoTrue session restores from localStorage, the store opens, and the sidebar
  // paints the synced teams — every row of it read locally, since nothing can be fetched.
  await waitForBoardReady(page, OFFLINE_BOOT_MS);

  // NOT asserted here: the SyncBadge's own reading of the outage. That is (B2)'s subject, and the phase is
  // shared machinery — this context's claim is about DATA, not the indicator. The guard that the data plane
  // really IS offline, and not merely the document, is (A3): a write made now cannot leave the journal until
  // connectivity returns, which no still-connected engine could produce.

  // Eager tables serve for both roles: the issue written in the previous online session renders from the
  // local store, reached by ordinary client-side routing (which also has no network to lean on).
  await teamNav(page).getByText("Platform", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/team/${PLATFORM}/board`));
  await expect(page.getByText(adminIssueTitle)).toBeVisible({ timeout: OFFLINE_BOOT_MS });

  // The role-split claim, Admin half: `lazy + persistent`, activated online, is durably promoted — so chat
  // history is here offline like any eager shape, and the connection-needed state must NOT appear.
  await segment(shellTabs(page), "Chat").click();
  await expect(page).toHaveURL(new RegExp(`/team/${PLATFORM}/chat`));
  await expect(page.getByText(adminMessageBody)).toBeVisible({ timeout: OFFLINE_BOOT_MS });
  await expect(page.getByText("No messages in this channel yet.")).toHaveCount(0);
  await expect(page.getByText(CONNECTION_NEEDED_CHAT)).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("(A3) a write made offline journals, then drains once connectivity returns", async () => {
  test.setTimeout(240_000);
  const page = adminPage;

  await segment(shellTabs(page), "Board").click();
  await expect(page).toHaveURL(new RegExp(`/team/${PLATFORM}/board`));
  offlineIssueTitle = await createIssue(page, PLATFORM);
  // Optimistic local render: the overlay answers immediately, with no server involved.
  await expect(page.getByText(offlineIssueTitle)).toBeVisible();

  // It is genuinely owed to the server, not quietly dropped: the header's registry-wide mutation summary
  // (`useMutationSummary`, subscribed for the whole session — unlike the Inspector's own journal query, which
  // only runs while the drawer is open) counts it as unsettled, and the journal carries the `issue` row. (Its
  // status is `pending` or `failed` depending on whether a flush attempt has already bounced off the dead
  // network — both are the same retryable, still-owed state, which is what the counter groups.)
  await expect(page.getByText(/[1-9]\d* unsettled/)).toBeVisible();
  await page.getByRole("button", { name: "Inspector" }).click();
  await expect(inspector(page)).toBeVisible();
  await expect(inspector(page).getByText(/[1-9]\d* pending/)).toBeVisible();
  await expect(inspector(page).getByRole("row").filter({ hasText: "issue" }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inspector(page)).toBeHidden();

  await adminContext.setOffline(false);

  // The read path catches up on its own — the badge leaves `syncing` for `ready` with no reload and no
  // re-auth, so the whole offline window cost the session nothing…
  await expect(page.getByText("Up to date", { exact: true })).toBeVisible({ timeout: CONVERGE_MS });
  // …and the write drains with NO intervention — no Flush now, no reload. An empty journal is the honest
  // distinction the lane needs: a reload alone would prove nothing, because journal recovery re-shows an
  // undrained write exactly as if it had converged. The row leaves the journal only after the server acked it
  // and the echo reconciled it away.
  await page.getByRole("button", { name: "Inspector" }).click();
  await expect(inspector(page)).toBeVisible();
  await expect(inspector(page).getByText("All changes synced")).toBeVisible({ timeout: CONVERGE_MS });
  await page.keyboard.press("Escape");
  await expect(inspector(page)).toBeHidden();
});

test("(B1) online: a Member's chat loads, and the Admin's offline write is read back from the server", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  memberContext = await browser.newContext();
  memberPage = await memberContext.newPage();

  await memberPage.goto("/");
  await expect(memberPage.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
  await signIn(memberPage, ALICE);
  // Alice's scope: Platform + Growth, never Design (the read filter made visible).
  await expect(teamNav(memberPage).getByText("Growth", { exact: true })).toBeVisible();
  await expect(teamNav(memberPage).getByText("Design", { exact: true })).toHaveCount(0);

  await memberPage.goto(`/team/${PLATFORM}/board`);
  await waitForBoardReady(memberPage);
  // THE drain proof for (A3): a DIFFERENT identity in a DIFFERENT browser context, whose store was created
  // moments ago and synced from scratch, is rendering the issue the Admin wrote while offline. Nothing local
  // to Context A can produce that row here — it went to Postgres and came back down Alice's shape.
  await expect(memberPage.getByText(offlineIssueTitle)).toBeVisible({ timeout: COLD_BOOT_MS });

  // Chat works online for this role too — which is the whole point of the contrast in (B2): what changes
  // offline is retention, not permission.
  await segment(shellTabs(memberPage), "Chat").click();
  await expect(memberPage).toHaveURL(new RegExp(`/team/${PLATFORM}/chat`));
  memberMessageBody = await postMessage(memberPage, "general");
  await expect(memberPage.getByText(CONNECTION_NEEDED_CHAT)).toHaveCount(0);

  await waitForOfflineCapture(memberPage);
});

test("(B2) offline return: eager tables serve, but the ephemeral chat takes the connection-needed state", async () => {
  test.setTimeout(240_000);
  await memberPage.close();
  await memberContext.setOffline(true);

  const page = await openOfflineShell(memberContext);
  memberPage = page;

  await waitForBoardReady(page, OFFLINE_BOOT_MS);
  await expect(teamNav(page).getByText("Growth", { exact: true })).toBeVisible();

  // Every eager table serves offline for BOTH roles — the Member's board is as complete as the Admin's.
  await teamNav(page).getByText("Platform", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/team/${PLATFORM}/board`));
  await expect(page.getByText(offlineIssueTitle)).toBeVisible({ timeout: OFFLINE_BOOT_MS });

  // The role-split claim, Member half. `lazy + ephemeral` emits the whole local cluster as TEMP, so the store
  // that just reopened has no chat rows at all and no way to fetch them; the surface says exactly that
  // instead of spinning forever. Polled, not sampled: the ordinary "Loading…" renders first and is REPLACED
  // once the read path reports itself unreachable (see the file header for how it learns that).
  await segment(shellTabs(page), "Chat").click();
  await expect(page).toHaveURL(new RegExp(`/team/${PLATFORM}/chat`));
  await expect(
    page.getByRole("status"),
    "the chat pane never left 'Loading…': the read path never reported the backend unreachable, so " +
      "`isBackendUnreachable` stayed false and the connection-needed copy never rendered",
  ).toHaveText(CONNECTION_NEEDED_CHAT, { timeout: UNREACHABLE_MS });
  // And the message this identity posted online is genuinely gone — the TEMP cluster left no durable trace,
  // which is the declared lifecycle rather than a failure to persist.
  await expect(page.getByText(memberMessageBody)).toHaveCount(0);
});

test("(C) signed out: signing in offline takes the connection-needed alert", async ({ browser }) => {
  test.setTimeout(180_000);
  // Out of scope by definition (ADR-0010 non-goals): a signed-out visitor has nothing offline. What IS in
  // scope is saying so — the login screen must not present a dead button.
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
    // Deliberately no sign-in: only the login shell is captured.
    await waitForOfflineCapture(page);

    await context.setOffline(true);
    const response = await page.reload();
    if (response == null) throw new Error("the offline reload produced no response at all");
    expect(response.fromServiceWorker(), "the offline reload was answered by the network, not the worker").toBe(true);
    await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();

    await page.getByRole("button", { name: ALICE }).click();

    // supabase-js reports the rejected `fetch` as `AuthRetryableFetchError` with status 0, which `signInAs`
    // translates into a `SignInConnectionError` whose message IS the ruled copy. The auth-error vocabulary is
    // therefore an upgrade gate: a supabase-js bump that changes it fails here.
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("Connection needed");
    await expect(alert).toContainText(CONNECTION_NEEDED_SIGN_IN);
    // Yellow, not the red "Sign-in failed" branch: Mantine writes the resolved variant colour into the root's
    // inline custom properties, so the style attribute is where that distinction is actually observable.
    await expect(alert).toHaveAttribute("style", /yellow/);
    // The stack hint is advice for the OTHER failure (a stack that is up but unseeded), so this state drops it.
    await expect(page.getByText("Is the stack up")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("(D) cold return: the worker died, the engine cold-boots offline, the board still paints", async ({ browser }) => {
  test.setTimeout(300_000);
  // The maintainer's manual repro, verbatim: login, board synced, close the tab, wait ~30s, reopen offline.
  // ONE online session and NO reload — the first-session backfill is the only thing standing between the
  // entry assets and a dead offline shell. A fresh context (fresh profile) keeps this store's history out of
  // Contexts A/B and vice versa.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("/");
    await signIn(page, ALICE);
    await expect(teamNav(page).getByText("Growth", { exact: true })).toBeVisible();
    await waitForOfflineCapture(page);
    await page.close();

    // Outlive the SharedWorker's `extendedLifetime` grace (~30s in Chromium): the engine that served the
    // online session must be DEAD, so the offline page cannot adopt it — it has to cold-boot a fresh one
    // from the service-worker cache alone. This wait is the difference between this scenario and (A2)/(B2),
    // whose fast reopen a surviving worker can answer.
    await new Promise((resolve) => setTimeout(resolve, 40_000));

    await context.setOffline(true);
    const offlinePage = await openOfflineShell(context);

    // The full cold offline boot: session restored from localStorage, store reopened, engine worker script +
    // pglite wasm/data all served from the worker cache, board painted from local rows.
    await waitForBoardReady(offlinePage, OFFLINE_BOOT_MS);
    await expect(teamNav(offlinePage).getByText("Growth", { exact: true })).toBeVisible();

    // THE CONTENT, not just the sidebar. The maintainer's real-world failure was exactly here: the home
    // route's redirect was gated on `settled`, which can never become true offline (`hydrating` clears only
    // when the initial catch-up completes), so a signed-in offline return sat on the landing spinner forever
    // while the sidebar rendered — and this lane's earlier nav-only assertions called that a pass. The
    // landing redirect must complete offline off the local rows alone, and the kanban board itself must
    // render its columns.
    await expect(offlinePage).toHaveURL(/\/team\/[0-9a-f-]+\/board/, { timeout: OFFLINE_BOOT_MS });
    await expect(offlinePage.getByText("Backlog", { exact: true })).toBeVisible({ timeout: OFFLINE_BOOT_MS });

    // And the runtime tells the truth about the outage while doing it: the stall probe reports the read
    // path unreachable, so the badge shows the degraded state — on a COLD boot, proving the signal's whole
    // journey (engine realm → status broadcast → tab) with no surviving machinery to lean on.
    await expect(offlinePage.getByText("Sync error", { exact: true })).toBeVisible({ timeout: UNREACHABLE_MS });
  } finally {
    await context.close();
  }
});
