import { type BrowserContext, expect, type Page, test } from "@playwright/test";

// ADR-0032 S3 browser lane — the sync engine end-to-end in a real Chromium against the local board stack
// (see playwright.config.ts for the origin/TLS/lifecycle rationale). Where the browser has `SharedWorker` the
// sync engine attaches through a per-store SharedWorker and storage is capability-decided (ADR-0049): on
// Chromium the SharedWorker probe is denied, so a tab-elected dedicated engine runs the store on
// `opfs-repacked`, and idbfs remains the capability-absence fallback / registry opt-out. Without
// `SharedWorker` the main-thread in-process engine boots instead. The lane is organised into isolated serial
// contexts:
//
//   Context A — the SharedWorker attach point on Chromium (elected opfs engine):
//     (a) cold visit → the engine boots, forwards its rail to the tab, and a write renders
//     (b) a second tab attaches the SAME SharedWorker (alreadyBooted); a write in tab A appears in tab B
//     (c) tab A closes; tab B keeps working (the SharedWorker outlives any single tab)
//
//   Context B — identity switching in one page realm attaches a distinct per-user SharedWorker/store
//   Context C — SharedWorker feature-detect off → the in-process fallback boots and the board still works
//   Context D — Delete local data: the wipe-on-boot flow completes and reports a clean wipe
//   Context E — Strict durability selected → the board boots and writes still work
//   Context F — human-paced login: sign-in AFTER the spare provision completes adopts the provisioned store
//
// The board's team list, issue cards, and cross-tab propagation are all LIVE-SYNCED through the worker
// bridge, so asserting on them proves the read path, the write path, and the fan-out — not a stub.

test.describe.configure({ mode: "serial" });

// Seeded identity + teams (scripts/seed-board.ts). Alice spans Platform + Growth, never Design — the
// read-scoping the team list makes visible.
const ALICE = "Alice Okafor";
const BOB = "Bob Nilsson";
const PLATFORM = "00000000-0000-4000-8000-0000000000a1";

// The dev handles the board exposes on `window` in the Vite dev build (board-client-provider): the live
// client (worker-attached or in-process) and, ONLY in in-process mode, the PGlite query profiler.
interface BoardDevWindow {
  __boardClient?: {
    bootReport: () => Promise<unknown>;
    mutate: { create: (table: string, input: Record<string, unknown>) => Promise<void> };
    stop: () => Promise<void>;
  };
  __boardProfiler?: unknown;
  __authenticatedShellPresentAtStop?: boolean;
}

/** The sidebar team switcher (the AppShell navbar landmark), scoped so team names never collide with a
 * team-board page heading or a login-screen identity note. */
function teamNav(page: Page) {
  return page.getByRole("navigation");
}

/** Wait for the board shell to have painted the caller's synced team list (the read-path CATCH-UP signal). */
async function waitForBoardReady(page: Page): Promise<void> {
  // First leave the login screen (its identity buttons carry team names in their notes, so asserting a
  // team name while still on login is ambiguous). Already-hidden on an auto-signed-in tab — resolves at once.
  await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeHidden();
  // ADR-0041 (Option B): the board shell now paints at attach = `localReadReady` (cached reads safe, no
  // network), so leaving the login screen no longer implies sync started, let alone caught up. The sidebar
  // team switcher renders exactly the teams the identity synced — it appears once the live `useTeams` query
  // resolves over the worker bridge (cached rows immediately on a warm store, or after group catch-up on a
  // fresh claim). Waiting on it is therefore the read-path CATCH-UP signal, distinct from the attach/paint
  // signal, and remains the meaningful assertion that the staged read path fully delivered.
  await expect(teamNav(page).getByText("Platform", { exact: true })).toBeVisible();
}

/** Sign in from the login screen as the given identity and wait for the board to be ready. */
async function signIn(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name }).click();
  await waitForBoardReady(page);
}

/** Create an issue through the exposed live client (worker-attached), returning the unique title used. */
async function createIssue(page: Page, teamId: string): Promise<string> {
  const title = `worker-lane ${crypto.randomUUID()}`;
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

/** A safe read used as the elected-engine succession barrier after the leader tab closes. */
async function workerClientResponds(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const client = (window as unknown as BoardDevWindow).__boardClient;
    if (client == null) return false;
    try {
      await client.bootReport();
      return true;
    } catch {
      // Reads may be rejected as not-dispatched while the old pipe is replaced; retrying them is safe.
      return false;
    }
  });
}

/**
 * Select the durability preference on the login screen and apply it (persists it to localStorage + reloads).
 * The SegmentedControl renders a `radiogroup`; it is disambiguated by the `aria-label` of its wrapping Stack,
 * and the segment label is looked up INSIDE that radiogroup so it never collides with the identical word in the
 * help copy below it.
 */
async function applyDurability(page: Page, durability: "relaxed" | "strict"): Promise<void> {
  await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
  const label = durability === "strict" ? "Strict" : "Relaxed";
  await page
    .locator('[aria-label="Durability preference"]')
    .getByRole("radiogroup")
    .getByText(label, { exact: true })
    .click();
  // Applying surfaces the "Apply & reload" button (the selection differs from the persisted value); clicking it
  // persists the choice and reloads.
  const reloaded = page.waitForEvent("domcontentloaded");
  await page.getByRole("button", { name: "Apply & reload" }).click();
  await reloaded;
  await expect.poll(() => page.evaluate(() => localStorage.getItem("board:durability-preference"))).toBe(durability);
  await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
  await expect(
    page
      .locator('[aria-label="Durability preference"]')
      .getByRole("radiogroup")
      .locator(`input[value="${durability}"]`),
  ).toBeChecked();
}

// ─── Context A: the SharedWorker engine on IndexedDB ───────────────────────────────────────────────────────
let idbContext: BrowserContext;
let idbTabA: Page;
let idbTabB: Page;
const idbTabAConsole: string[] = [];

test.afterAll(async () => {
  await idbContext?.close();
});

test("(a) default boot → the SharedWorker engine boots and forwards its rail", async ({ browser }) => {
  test.setTimeout(150_000);
  idbContext = await browser.newContext();
  idbTabA = await idbContext.newPage();
  // Collect tab A's console from birth so the SharedWorker rail (forwarded [pgxsinkit·w] lines) is captured.
  idbTabA.on("console", (message) => idbTabAConsole.push(message.text()));

  await idbTabA.goto("/");
  await expect(idbTabA.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
  // Feature-detected worker mode is the real posture in Chromium.
  expect(await idbTabA.evaluate(() => typeof SharedWorker !== "undefined")).toBe(true);

  await signIn(idbTabA, ALICE);
  // The synced team list is exactly Alice's scope: Platform + Growth, never Design (the read filter made visible).
  await expect(teamNav(idbTabA).getByText("Growth", { exact: true })).toBeVisible();
  await expect(teamNav(idbTabA).getByText("Design", { exact: true })).toHaveCount(0);

  // Worker mode: the live client is exposed, but the PGlite-bound profiler is NOT (PGlite is off-thread).
  expect(await idbTabA.evaluate(() => (window as unknown as BoardDevWindow).__boardClient != null)).toBe(true);
  expect(await idbTabA.evaluate(() => (window as unknown as BoardDevWindow).__boardProfiler == null)).toBe(true);

  // The e2e build sets `__pgxsinkitDebug` (VITE_E2E gate), so the SharedWorker's monotonic-stamped rail lines
  // (invisible in the worker's own console) are re-printed in the tab, origin-tagged `[pgxsinkit·w …ms]`.
  await expect.poll(() => idbTabAConsole.filter((line) => line.includes("[pgxsinkit·w")).length).toBeGreaterThan(0);

  // The write path works on the SharedWorker engine.
  await idbTabA.goto(`/team/${PLATFORM}/board`);
  await waitForBoardReady(idbTabA);
  const title = await createIssue(idbTabA, PLATFORM);
  await expect(idbTabA.getByText(title)).toBeVisible();
});

test("(b) second tab attaches the same SharedWorker; a write in tab A appears in tab B", async () => {
  idbTabB = await idbContext.newPage();

  // The GoTrue session persists in shared localStorage, so tab B opens already signed in as Alice and attaches
  // the SAME per-store SharedWorker (alreadyBooted) — one engine, one store, one connection set.
  await idbTabB.goto("/");
  await waitForBoardReady(idbTabB);

  // Pin both tabs to the same team board so a write is in view for both.
  await idbTabA.goto(`/team/${PLATFORM}/board`);
  await idbTabB.goto(`/team/${PLATFORM}/board`);
  await waitForBoardReady(idbTabA);
  await waitForBoardReady(idbTabB);

  // A write in tab A mutates the shared engine's store; tab B's live query (its own bridge subscription to the
  // one PGlite) fires — so the new issue appears in tab B without any per-tab engine.
  const title = await createIssue(idbTabA, PLATFORM);
  await expect(idbTabB.getByText(title)).toBeVisible();
});

test("(c) tab A closes; tab B keeps working (the SharedWorker outlives the tab)", async () => {
  await idbTabA.close();

  // Chromium elects a tab-owned dedicated engine, so closing its leader relocates the engine even though the
  // SharedWorker router survives. Wait for a SAFE read to answer from the successor before issuing a mutation:
  // a mutation dispatched during that handoff has an intentionally honest UNKNOWN outcome and must never be
  // blindly retried. This is a protocol-state barrier, not a timing delay.
  await expect.poll(() => workerClientResponds(idbTabB), { timeout: 15_000 }).toBe(true);

  // The successor engine is serving tab B: a write lands and renders locally.
  const title = await createIssue(idbTabB, PLATFORM);
  await expect(idbTabB.getByText(title)).toBeVisible();
});

test("(d) switching identities keeps the page realm and attaches the other user's store", async ({ browser }) => {
  test.setTimeout(150_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto("/");
    await signIn(page, ALICE);

    const realmToken = await page.evaluate(() => {
      const token = crypto.randomUUID();
      (window as typeof window & { __identitySwitchRealm?: string }).__identitySwitchRealm = token;
      return token;
    });

    await page.evaluate(() => {
      const dev = window as unknown as BoardDevWindow;
      const client = dev.__boardClient!;
      const originalStop = client.stop.bind(client);
      client.stop = async () => {
        dev.__authenticatedShellPresentAtStop = document.querySelector("[data-authenticated-shell]") != null;
        await originalStop();
      };
    });

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as BoardDevWindow).__authenticatedShellPresentAtStop)).toBe(
      false,
    );
    expect(
      await page.evaluate(() => (window as typeof window & { __identitySwitchRealm?: string }).__identitySwitchRealm),
    ).toBe(realmToken);

    await signIn(page, BOB);
    await expect(page.getByText("bob@board.local", { exact: true })).toBeVisible();
    const mappedStoreIds = await page.evaluate(() => {
      const raw = localStorage.getItem("pgxsinkit-board-stores");
      if (raw == null) return [];
      return Object.values((JSON.parse(raw) as { map: Record<string, string> }).map);
    });
    expect(new Set(mappedStoreIds).size).toBeGreaterThanOrEqual(2);
  } finally {
    await context.close();
  }
});

test("(C) SharedWorker feature-detect off → in-process fallback boots and the board works", async ({ browser }) => {
  test.setTimeout(150_000);
  // A fresh, isolated context (no shared session) with SharedWorker removed BEFORE any app module loads, so the
  // board's `boardWorkerMode` feature-detect resolves false and the in-process engine boots (ADR-0032 decision 2).
  const fallbackContext = await browser.newContext();
  await fallbackContext.addInitScript(() => {
    // @ts-expect-error — deleting the constructor forces the feature-detect to fall back.
    delete window.SharedWorker;
  });
  const page = await fallbackContext.newPage();
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
    expect(await page.evaluate(() => typeof SharedWorker === "undefined")).toBe(true);

    await signIn(page, ALICE);
    await expect(teamNav(page).getByText("Growth", { exact: true })).toBeVisible();

    // In-process mode: the board exposes the PGlite-bound profiler (set ONLY on the in-process path), proving the
    // fallback engine — not a worker — is running the store on the tab.
    expect(await page.evaluate(() => (window as unknown as BoardDevWindow).__boardProfiler != null)).toBe(true);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
    // Provider cleanup removes the old client handle synchronously, while its PGlite close may finish in the
    // background. The old client's token callback is identity-bound, so Bob can boot immediately without either
    // waiting for that close or exposing Bob's credentials to Alice's store.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as BoardDevWindow).__boardClient == null))
      .toBe(true);

    await signIn(page, BOB);
    await expect(page.getByText("bob@board.local", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as BoardDevWindow).__boardProfiler != null)).toBe(true);

    const mappedStoreIds = await page.evaluate(() => {
      const raw = localStorage.getItem("pgxsinkit-board-stores");
      if (raw == null) return [];
      return Object.values((JSON.parse(raw) as { map: Record<string, string> }).map);
    });
    expect(new Set(mappedStoreIds).size).toBeGreaterThanOrEqual(2);
  } finally {
    await fallbackContext.close();
  }
});

test("(D) Delete local data: the wipe-on-boot flow completes and reports a clean wipe", async ({ browser }) => {
  // The user-reported hang: an in-place wipe can never finish because the login page's OWN spare worker holds
  // the store (a tab cannot terminate a SharedWorker), so `deleteDatabase` blocks. The fix routes the wipe
  // through a flag + reload (local-data.ts): the reload kills this page's workers, the wipe runs at next boot
  // BEFORE any worker exists, and the outcome is reported on the login screen. This reproduces the original hang
  // condition exactly — a live provisioned spare worker — and asserts the flow now completes with a clean outcome.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const rail: string[] = [];
  page.on("console", (message) => rail.push(message.text()));
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
    // The hang precondition: wait until the spare store is provisioned (its worker now HOLDS the store's
    // IndexedDB connection) before asking for the wipe.
    await expect.poll(() => rail.some((line) => line.includes("boot spare store ensured"))).toBe(true);

    await page.getByRole("button", { name: "Delete local data…" }).click();
    await page.getByRole("button", { name: "Delete local data", exact: true }).click();

    // The flow reloads and runs the wipe at boot; a fully-clean wipe renders the green outcome alert.
    await expect(page.getByText("Local data deleted", { exact: true })).toBeVisible();
    // The relanded login screen is healthy: it minted a FRESH spare after the wipe (the wipe cleared the registry
    // bindings; ensureSpare re-provisions on the post-wipe mount).
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem("pgxsinkit-board-stores") != null))
      .toBe(true);
  } finally {
    await ctx.close();
  }
});

test("(E) strict durability selected → the board boots and writes still work", async ({ browser }) => {
  // The durability axis: `strict` forces the per-commit flush (cheap on opfs-repacked; on an idbfs fallback
  // ~100ms+/write — the toolkit names the slow combination rather than forbidding it). Only the durability mode
  // changes — placement stays capability-decided — and a write must still round-trip under the stricter flush.
  test.setTimeout(150_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleLines: string[] = [];
  page.on("console", (message) => consoleLines.push(message.text()));
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
    // Model a human-paced preference change: the login screen's elected spare has finished provisioning before
    // the user clicks Apply. This is the lifecycle boundary the old immediate-click lane skipped entirely.
    await expect
      .poll(() => consoleLines.some((line) => line.includes("worker store provisioned")), { timeout: 60_000 })
      .toBe(true);
    const provisionsBeforeReload = consoleLines.filter((line) => line.includes("worker store provisioned")).length;
    await applyDurability(page, "strict");
    // The reloaded page reads the persisted Strict selection before constructing its newly named spare worker.
    await expect
      .poll(() => consoleLines.filter((line) => line.includes("worker store provisioned")).length)
      .toBeGreaterThan(provisionsBeforeReload);

    await signIn(page, ALICE);
    await expect(teamNav(page).getByText("Growth", { exact: true })).toBeVisible();

    // The write path still works under the synchronous per-commit flush.
    await page.goto(`/team/${PLATFORM}/board`);
    await waitForBoardReady(page);
    const title = await createIssue(page, PLATFORM);
    await expect(page.getByText(title)).toBeVisible();
  } finally {
    await ctx.close();
  }
});

test("(F) sign-in after the spare provision completes adopts the provisioned store", async ({ browser }) => {
  // The login screen pre-provisions a spare store (~2.5s of PGlite create/initdb inside the elected worker). A
  // robot that clicks sign-in immediately races AHEAD of the provision ack and takes the fresh-attach path —
  // which is exactly how the provisioned-spare adoption stall shipped unnoticed: every lane clicked early, and
  // only human-paced logins (spare already complete) hit the claim → coordinator adoption → pipe handover.
  // This test IS the human: it waits for the worker's provision rail line before signing in, then proves the
  // boot ADOPTED the provisioned store (never a second initdb) and that the adopted engine serves writes.
  test.setTimeout(150_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleLines: string[] = [];
  page.on("console", (message) => consoleLines.push(message.text()));
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
    // The elected engine worker's console is page-visible; its rail line marks the spare's initdb settling.
    await expect
      .poll(() => consoleLines.some((line) => line.includes("worker store provisioned")), { timeout: 60_000 })
      .toBe(true);

    await signIn(page, ALICE);
    // The adoption rail line is the proof this boot rode the spare-claim path, not a fresh create.
    await expect
      .poll(() => consoleLines.some((line) => line.includes("worker adopting provisioned store")), {
        timeout: 30_000,
      })
      .toBe(true);

    // And the adopted engine actually serves the app: a write lands and renders.
    await page.goto(`/team/${PLATFORM}/board`);
    await waitForBoardReady(page);
    const title = await createIssue(page, PLATFORM);
    await expect(page.getByText(title)).toBeVisible();
  } finally {
    await ctx.close();
  }
});

/** Select BOTH storage axes on the login screen and apply them in one reload. Mirrors {@link applyDurability}
 * but drives the backend SegmentedControl too (disambiguated by its wrapping Stack's aria-label), so the
 * idbfs-forced + strict combination the wipe repro needs is set before sign-in. */
async function applyStoragePreferences(
  page: Page,
  backend: "opfs" | "idbfs",
  durability: "relaxed" | "strict",
): Promise<void> {
  await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
  await page
    .locator('[aria-label="Storage backend preference"]')
    .getByRole("radiogroup")
    .getByText(backend === "idbfs" ? "Force idbfs" : "OPFS (default)", { exact: true })
    .click();
  await page
    .locator('[aria-label="Durability preference"]')
    .getByRole("radiogroup")
    .getByText(durability === "strict" ? "Strict" : "Relaxed", { exact: true })
    .click();
  const reloaded = page.waitForEvent("domcontentloaded");
  await page.getByRole("button", { name: "Apply & reload" }).click();
  await reloaded;
  await expect.poll(() => page.evaluate(() => localStorage.getItem("board:backend-preference"))).toBe(backend);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("board:durability-preference"))).toBe(durability);
  await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
}

/** The `/pglite/*` IndexedDB database names present now (the board's PGlite stores live under this prefix). */
function pgliteDbNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const infos = await indexedDB.databases();
    return infos
      .map((info) => info.name)
      .filter((name): name is string => typeof name === "string" && name.startsWith("/pglite/"));
  });
}

test("(H) idbfs + strict: Delete local data converges via retained obsolete stores across reloads", async ({
  browser,
}) => {
  // The exact user-reported repro. Forcing idbfs pins the engine to IndexedDB (so the store IS a `/pglite/*`
  // db) and strict durability is the demo's slow combination; sign in to materialise the store, then wipe. The
  // signed-in store's SharedWorker is `extendedLifetime` and SURVIVES the wipe reload, so its idb delete first
  // BLOCKS — the wipe must report it as retained-for-retry (NOT strand it by clearing the registry) and the
  // boot-time `destroyObsoleteStores` must drain it on a later boot once the worker's grace period elapses.
  // Convergence here means the RETAINED old stores are gone: the pre-wipe idbfs databases no longer exist AND
  // the registry lists no remaining obsolete paths. (A fresh spare the post-wipe login screen mints is a new,
  // legitimate `/pglite/*` db and is deliberately NOT part of this assertion — see the note below.)
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto("/");
    await applyStoragePreferences(page, "idbfs", "strict");

    await signIn(page, ALICE);
    // The idbfs store now exists as a `/pglite/*` IndexedDB database — capture the pre-wipe set so convergence
    // can prove exactly these retained stores are destroyed (independent of any fresh spare minted afterwards).
    const preWipeDbs = await pgliteDbNames(page);
    expect(preWipeDbs.length).toBeGreaterThan(0);

    // Sign out (the store's extendedLifetime worker keeps holding it), then run the wipe-on-boot flow.
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
    await page.getByRole("button", { name: "Delete local data…" }).click();
    await page.getByRole("button", { name: "Delete local data", exact: true }).click();

    // After the wipe reload the login screen reports EITHER a clean wipe OR retained-for-retry failures — both
    // are valid outcomes of a single boot (the worker may or may not have exited within the deadline yet).
    const cleanAlert = page.getByText("Local data deleted", { exact: true });
    const retainedAlert = page.getByText("Some stores are still in use", { exact: true });
    await expect(cleanAlert.or(retainedAlert)).toBeVisible();

    // Convergence: `destroyObsoleteStores` (main.tsx, every boot) QUIESCES the surviving idbfs worker — tearing
    // its SW-direct host down so the IndexedDB connection releases (ADR-0050) — then destroys the artifacts, in
    // the BACKGROUND (fire-and-forget, off the sign-in path). It is not awaited, so it needs uninterrupted time
    // on ONE boot to finish the teardown + delete. So after a reload, POLL for convergence WITHOUT reloading
    // again (a reload would interrupt the in-flight cleanup); only reload a couple more times as a fallback.
    // Converged = none of the pre-wipe idbfs databases remain AND the registry lists no remaining obsolete path
    // (a fresh spare the post-wipe login screen mints is a new, legitimate db and is not part of this).
    const checkConverged = (pre: string[]): Promise<boolean> =>
      page.evaluate(async (names: string[]) => {
        const infos = await indexedDB.databases();
        const present = infos.map((info) => info.name).filter((name): name is string => typeof name === "string");
        const oldRemaining = names.filter((name) => present.includes(name));
        const raw = localStorage.getItem("pgxsinkit-board-stores");
        const parsed = raw == null ? {} : (JSON.parse(raw) as { obsolete?: string[] });
        const obsolete = parsed.obsolete ?? [];
        return oldRemaining.length === 0 && obsolete.length === 0;
      }, pre);

    // Poll convergence for up to `steps` × 750ms WITHOUT reloading (a reload interrupts the in-flight background
    // cleanup), so one boot's quiesce + destroy has a few uninterrupted seconds to finish.
    const pollConverged = async (steps: number): Promise<boolean> => {
      for (let i = 0; i < steps; i++) {
        if (await checkConverged(preWipeDbs)) return true;
        await page.waitForTimeout(750);
      }
      return checkConverged(preWipeDbs);
    };

    const MAX_RELOADS = 3;
    let converged = await checkConverged(preWipeDbs);
    for (let attempt = 0; attempt < MAX_RELOADS && !converged; attempt++) {
      await page.reload();
      await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
      // The background quiesce of a live-syncing idbfs store's host (stop sync + close engine) can take up to
      // ~20s; poll past that so a single boot's uninterrupted cleanup can finish before a fallback reload.
      converged = await pollConverged(40);
    }

    expect(converged, `Delete local data never converged after ${MAX_RELOADS} reloads.`).toBe(true);
  } finally {
    await ctx.close();
  }
});

test("(G) Strict + OPFS applied while spare provisioning is in flight reloads cleanly", async ({ browser }) => {
  test.setTimeout(150_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleLines: string[] = [];
  page.on("console", (message) => consoleLines.push(message.text()));
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in to the board" })).toBeVisible();
    // The spare id exists, so ensureSpare has constructed/provisioned its worker; deliberately do NOT wait for
    // `worker store provisioned`. Real Safari can spend >5s finishing that OPFS boot before processing teardown.
    await expect.poll(() => page.evaluate(() => localStorage.getItem("pgxsinkit-board-stores") != null)).toBe(true);
    await applyDurability(page, "strict");

    await expect(page.getByText("[pgxsinkit] timed out while retiring the SW-direct sync host.")).toHaveCount(0);
    await expect
      .poll(() => consoleLines.some((line) => line.includes("worker store provisioned")), { timeout: 60_000 })
      .toBe(true);
  } finally {
    await ctx.close();
  }
});
